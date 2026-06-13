const express=require('express'),router=express.Router();
const {query}=require('../../utils/db'),{authenticate,auditLog}=require('../../middleware/auth.middleware');
const {getProvider,PROVIDERS}=require('./providers');
const {notifyNewOrder}=require('../../utils/notify');

function validateSafaricomIP(req,res,next){
  if(process.env.NODE_ENV!=='production')return next();
  const allowed=(process.env.MPESA_SAFARICOM_IPS||'').split(',').map(ip=>ip.trim());
  const ip=req.headers['x-forwarded-for']?.split(',')[0]?.trim()||req.ip;
  if(!allowed.includes(ip)){console.warn('SECURITY: Unauthorized callback IP:',ip);return res.status(403).json({ResultCode:1,ResultDesc:'Rejected'});}
  next();
}

// Mark an order confirmed after a successful (online or cash) payment.
async function confirmOrder(orderId,note){
  const r=await query("UPDATE orders SET status='confirmed',updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING *",[orderId]);
  if(!r.rows.length)return null;
  await query("INSERT INTO order_status_history(order_id,status,note)VALUES($1,'confirmed',$2)",[orderId,note||'Payment received']);
  return r.rows[0];
}

// Shared initiation: pick a provider, call it, record a pending payment row.
async function initiatePayment(provider,order,userId){
  const out=await provider.initiate({amount:order.total_amount,phone:order._phone,reference:order.order_number,description:`SmartSafi ${order.order_number}`});
  await query("INSERT INTO payments(order_id,user_id,amount,method,status,mpesa_checkout_request_id,transaction_reference)VALUES($1,$2,$3,$4,'pending',$5,$6)",
    [order.id,userId,order.total_amount,provider.name,provider.name==='mpesa'?out.providerRef:null,out.providerRef]);
  return out;
}
async function loadPayableOrder(orderId,userId){
  const or=await query('SELECT * FROM orders WHERE id=$1 AND user_id=$2',[orderId,userId]);
  if(!or.rows.length)return{err:404};
  if(or.rows[0].status!=='pending')return{err:'paid',order:or.rows[0]};
  return{order:or.rows[0]};
}

// Generic, provider-agnostic payment initiation for an order.
router.post('/initiate',authenticate,async(req,res)=>{
  const{orderId,phone}=req.body;
  if(!orderId||!phone)return res.status(400).json({success:false,message:'orderId and phone required'});
  try{
    const {err,order}=await loadPayableOrder(orderId,req.user.id);
    if(err===404)return res.status(404).json({success:false,message:'Order not found'});
    if(err==='paid')return res.status(400).json({success:false,message:'Order already paid'});
    const provider=getProvider();order._phone=phone;
    const out=await initiatePayment(provider,order,req.user.id);
    await auditLog(req.user.id,'client','PAYMENT_INITIATED','payments',null,req,{orderId,provider:provider.name});
    res.json({success:true,message:out.userMessage||'Payment initiated',data:{provider:provider.name,reference:order.order_number,providerRef:out.providerRef}});
  }catch(e){console.error('Initiate payment:',e.response?.data||e.message);res.status(500).json({success:false,message:'Payment initiation failed'});}
});

// Back-compat: legacy M-Pesa-specific endpoint, always uses the M-Pesa provider.
router.post('/mpesa/stk-push',authenticate,async(req,res)=>{
  const{orderId,phone}=req.body;
  if(!orderId||!phone)return res.status(400).json({success:false,message:'orderId and phone required'});
  try{
    const {err,order}=await loadPayableOrder(orderId,req.user.id);
    if(err===404)return res.status(404).json({success:false,message:'Order not found'});
    if(err==='paid')return res.status(400).json({success:false,message:'Order already paid'});
    order._phone=phone;
    const out=await initiatePayment(PROVIDERS.mpesa,order,req.user.id);
    await auditLog(req.user.id,'client','PAYMENT_INITIATED','payments',null,req,{orderId,provider:'mpesa'});
    res.json({success:true,message:'Check your phone for M-Pesa prompt',data:{checkoutRequestId:out.providerRef}});
  }catch(e){console.error('STK push:',e.response?.data||e.message);res.status(500).json({success:false,message:'Payment initiation failed'});}
});

// Cash on delivery / "pay later": confirm the order immediately so it reaches the laundromat.
router.post('/cash',authenticate,async(req,res)=>{
  const{orderId}=req.body;
  if(!orderId)return res.status(400).json({success:false,message:'orderId required'});
  try{
    const {err,order}=await loadPayableOrder(orderId,req.user.id);
    if(err===404)return res.status(404).json({success:false,message:'Order not found'});
    if(err==='paid')return res.json({success:true,data:order});
    await query("INSERT INTO payments(order_id,user_id,amount,method,status)VALUES($1,$2,$3,'cash','pending')",[orderId,req.user.id,order.total_amount]);
    const confirmed=await confirmOrder(orderId,'Cash on delivery');
    notifyNewOrder(req.app.get('io'),confirmed||order);
    await auditLog(req.user.id,'client','ORDER_COD','orders',orderId,req,{});
    res.json({success:true,data:confirmed||order});
  }catch(e){console.error('Cash order:',e.message);res.status(500).json({success:false,message:'Failed'});}
});

// Unified webhook: /webhook/mpesa, /webhook/mulaflow, ...
router.post('/webhook/:provider',validateSafaricomIP,async(req,res)=>{
  res.json({ResultCode:0,ResultDesc:'Accepted',received:true});
  try{await processWebhook(req.params.provider,req);}catch(e){console.error('Webhook:',e.message);}
});
// Back-compat M-Pesa callback path.
router.post('/mpesa/callback',validateSafaricomIP,async(req,res)=>{
  res.json({ResultCode:0,ResultDesc:'Accepted'});
  try{await processWebhook('mpesa',req);}catch(e){console.error('Callback:',e.message);}
});

async function processWebhook(providerName,req){
  const provider=getProvider(providerName);
  const parsed=provider.parseWebhook(req);
  if(!parsed||parsed.invalid)return;
  // Subscription payments use a SUB-<id> reference, handled by the subscription service.
  if(parsed.reference&&String(parsed.reference).startsWith('SUB-')){
    const sub=require('../subscriptions/subscription.service');await sub.handlePaymentWebhook(parsed);return;
  }
  const ref=parsed.providerRef;
  if(parsed.status==='completed'){
    const pr=await query("UPDATE payments SET status='completed',mpesa_receipt_number=COALESCE($1,mpesa_receipt_number),transaction_reference=COALESCE(transaction_reference,$2),paid_at=NOW(),callback_received_at=NOW() WHERE mpesa_checkout_request_id=$2 OR transaction_reference=$2 RETURNING order_id",[parsed.receipt,ref]);
    if(pr.rows.length){
      const order=await confirmOrder(pr.rows[0].order_id,parsed.receipt?`Paid — ref: ${parsed.receipt}`:'Payment received');
      if(order)notifyNewOrder(req.app.get('io'),order);
    }
  }else if(parsed.status==='failed'){
    await query("UPDATE payments SET status='failed',callback_received_at=NOW() WHERE mpesa_checkout_request_id=$1 OR transaction_reference=$1",[ref]);
  }
}

router.post('/mpesa/b2c-result',validateSafaricomIP,(req,res)=>{const{handleB2CResult}=require('../commission/commission.service');return handleB2CResult(req,res);});
router.post('/mpesa/b2c-timeout',(req,res)=>res.json({ResultCode:0,ResultDesc:'Accepted'}));
router.get('/order/:orderId',authenticate,async(req,res)=>{
  try{const r=await query('SELECT * FROM payments WHERE order_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1',[req.params.orderId,req.user.id]);res.json({success:true,data:r.rows[0]||null});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});

// Reconcile a payment by querying the provider — used when the async callback can't reach us
// (e.g. a LAN dev box). Idempotent: returns the current status whether or not it changed.
router.post('/reconcile',authenticate,async(req,res)=>{
  const{orderId}=req.body;
  if(!orderId)return res.status(400).json({success:false,message:'orderId required'});
  try{
    const pr=await query('SELECT * FROM payments WHERE order_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1',[orderId,req.user.id]);
    const pay=pr.rows[0];
    if(!pay)return res.json({success:true,data:{status:'none'}});
    // Terminal states are authoritative — don't re-query (avoids sandbox status flip-flop).
    if(pay.status==='completed'||pay.status==='failed')return res.json({success:true,data:{status:pay.status}});
    const provider=getProvider(pay.method);
    const ref=pay.mpesa_checkout_request_id||pay.transaction_reference;
    if(!ref||typeof provider.query!=='function')return res.json({success:true,data:{status:pay.status}});
    const q=await provider.query(ref);
    if(q.status==='completed'){
      await query("UPDATE payments SET status='completed',paid_at=NOW() WHERE id=$1",[pay.id]);
      const order=await confirmOrder(orderId,'Payment received');
      if(order)notifyNewOrder(req.app.get('io'),order);
    }else if(q.status==='failed'){
      await query("UPDATE payments SET status='failed' WHERE id=$1",[pay.id]);
    }
    res.json({success:true,data:{status:q.status}});
  }catch(e){console.error('Reconcile:',e.message);res.status(500).json({success:false,message:'Failed'});}
});
module.exports=router;
