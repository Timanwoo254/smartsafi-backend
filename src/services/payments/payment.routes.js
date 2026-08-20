const express=require('express'),router=express.Router(),axios=require('axios');
const {query}=require('../../utils/db'),{authenticate,auditLog}=require('../../middleware/auth.middleware');

// Strips accidental wrapping quotes and whitespace from an env var. Protects
// against the exact class of bug where a value copied from a .env file or
// JSON response (already wrapped in quotes) gets pasted into Railway's UI
// with those quotes included literally -- which silently corrupts anything
// built from that value (like the STK Push password hash) without ever
// throwing an error, making it very hard to spot.
function cleanEnv(v){
  if(!v) return v;
  let s=String(v).trim();
  if(s.length>1 && s.startsWith('"') && s.endsWith('"')) s=s.slice(1,-1);
  return s;
}

function validateSafaricomIP(req,res,next){
  if(process.env.NODE_ENV!=='production')return next();
  const allowed=(process.env.MPESA_SAFARICOM_IPS||'').split(',').map(ip=>ip.trim());
  const ip=req.headers['x-forwarded-for']?.split(',')[0]?.trim()||req.ip;
  if(!allowed.includes(ip)){console.warn('SECURITY: Unauthorized callback IP:',ip);return res.status(403).json({ResultCode:1,ResultDesc:'Rejected'});}
  next();
}

async function getMpesaToken(){
  const consumerKey=cleanEnv(process.env.MPESA_CONSUMER_KEY);
  const consumerSecret=cleanEnv(process.env.MPESA_CONSUMER_SECRET);
  if(!consumerKey||!consumerSecret)throw new Error('MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET missing');
  const auth=Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const base=process.env.MPESA_ENV==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
  const res=await axios.get(`${base}/oauth/v1/generate?grant_type=client_credentials`,{headers:{Authorization:`Basic ${auth}`}});
  return res.data.access_token;
}

function buildStkPassword(shortcode,timestamp){
  const passkey=cleanEnv(process.env.MPESA_PASSKEY);
  if(!passkey)throw new Error('MPESA_PASSKEY missing');
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

router.post('/mpesa/stk-push',authenticate,async(req,res)=>{
  const{orderId,phone}=req.body;
  if(!orderId||!phone)return res.status(400).json({success:false,message:'orderId and phone required'});
  try{
    const or=await query('SELECT * FROM orders WHERE id=$1 AND user_id=$2',[orderId,req.user.id]);
    if(!or.rows.length)return res.status(404).json({success:false,message:'Order not found'});
    if(or.rows[0].status!=='pending')return res.status(400).json({success:false,message:'Order already paid'});
    let p=phone.replace(/\s+/g,'');if(p.startsWith('+'))p=p.slice(1);if(p.startsWith('0'))p='254'+p.slice(1);
    const token=await getMpesaToken();
    const ts=new Date().toISOString().replace(/[-T:.Z]/g,'').slice(0,14);
    const shortcode=cleanEnv(process.env.MPESA_SHORTCODE);
    const pwd=buildStkPassword(shortcode,ts);
    const base=process.env.MPESA_ENV==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
    const callbackUrl=cleanEnv(process.env.MPESA_CALLBACK_URL);
    const resp=await axios.post(`${base}/mpesa/stkpush/v1/processrequest`,{BusinessShortCode:shortcode,Password:pwd,Timestamp:ts,TransactionType:'CustomerPayBillOnline',Amount:Math.ceil(or.rows[0].total_amount),PartyA:p,PartyB:shortcode,PhoneNumber:p,CallBackURL:callbackUrl,AccountReference:or.rows[0].order_number,TransactionDesc:`SmartSafi ${or.rows[0].order_number}`},{headers:{Authorization:`Bearer ${token}`}});
    await query("INSERT INTO payments(order_id,user_id,amount,method,status,mpesa_checkout_request_id)VALUES($1,$2,$3,'mpesa','pending',$4)",[orderId,req.user.id,or.rows[0].total_amount,resp.data.CheckoutRequestID]);
    console.log(`STK push: ${p.slice(0,5)}***${p.slice(-3)} order=${or.rows[0].order_number}`);
    await auditLog(req.user.id,'client','PAYMENT_INITIATED','payments',null,req,{orderId});
    res.json({success:true,message:'Check your phone for M-Pesa prompt',data:{checkoutRequestId:resp.data.CheckoutRequestID}});
  }catch(e){console.error('STK push:',e.response?.data||e.message);res.status(500).json({success:false,message:e.response?.data?.errorMessage||'Payment initiation failed'});}
});

// Handles BOTH order-payment STK callbacks AND admin-fee-collection STK
// callbacks -- discriminated by which table the CheckoutRequestID actually
// matches, since both flows share the same Safaricom callback shape.
router.post('/mpesa/callback',validateSafaricomIP,async(req,res)=>{
  res.json({ResultCode:0,ResultDesc:'Accepted'});
  try{
    const cb=req.body?.Body?.stkCallback;if(!cb)return;
    const{CheckoutRequestID,ResultCode,CallbackMetadata}=cb;

    const pr=await query('SELECT order_id FROM payments WHERE mpesa_checkout_request_id=$1',[CheckoutRequestID]);
    if(pr.rows.length){
      if(ResultCode===0){
        const meta=CallbackMetadata?.Item||[];
        const receipt=meta.find(i=>i.Name==='MpesaReceiptNumber')?.Value;
        await query("UPDATE payments SET status='completed',mpesa_receipt_number=$1,paid_at=NOW() WHERE mpesa_checkout_request_id=$2",[receipt,CheckoutRequestID]);
        await query("UPDATE orders SET status='confirmed',updated_at=NOW() WHERE id=$1",[pr.rows[0].order_id]);
        await query("INSERT INTO order_status_history(order_id,status,note)VALUES($1,'confirmed',$2)",[pr.rows[0].order_id,`Paid — ref: ${receipt}`]);
      }else{
        await query("UPDATE payments SET status='failed' WHERE mpesa_checkout_request_id=$1",[CheckoutRequestID]);
      }
      return;
    }

    const ir=await query('SELECT id,laundromat_id FROM admin_fee_invoices WHERE checkout_request_id=$1',[CheckoutRequestID]);
    if(ir.rows.length){
      if(ResultCode===0){
        const meta=CallbackMetadata?.Item||[];
        const receipt=meta.find(i=>i.Name==='MpesaReceiptNumber')?.Value;
        await query("UPDATE admin_fee_invoices SET status='paid',mpesa_reference=$1,paid_at=NOW() WHERE checkout_request_id=$2",[receipt,CheckoutRequestID]);
        console.log(`Admin fee collected: invoice=${ir.rows[0].id} ref=${receipt}`);
      }else{
        await query("UPDATE admin_fee_invoices SET status='pending' WHERE checkout_request_id=$1",[CheckoutRequestID]);
      }
      return;
    }

    console.warn('Callback CheckoutRequestID matched neither payments nor admin_fee_invoices:',CheckoutRequestID);
  }catch(e){console.error('Callback:',e.message);}
});

router.post('/mpesa/b2c-result',validateSafaricomIP,(req,res)=>{const{handleB2CResult}=require('../commission/commission.service');return handleB2CResult(req,res);});
router.post('/mpesa/b2c-timeout',(req,res)=>res.json({ResultCode:0,ResultDesc:'Accepted'}));

router.get('/order/:orderId',authenticate,async(req,res)=>{
  try{const r=await query('SELECT * FROM payments WHERE order_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1',[req.params.orderId,req.user.id]);res.json({success:true,data:r.rows[0]||null});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});

module.exports=router;
