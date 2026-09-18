const {query,getClient}=require('../../utils/db'),axios=require('axios');

function cleanEnv(v){
  if(!v) return v;
  let s=String(v).trim();
  if(s.length>1 && s.startsWith('"') && s.endsWith('"')) s=s.slice(1,-1);
  return s;
}

function normalizePhoneForMpesa(phone){
  let p=phone.replace(/\s+/g,'');
  if(p.startsWith('+'))p=p.slice(1);
  if(p.startsWith('0'))p='254'+p.slice(1);
  return p;
}

async function getMpesaToken(){
  const consumerKey=cleanEnv(process.env.MPESA_CONSUMER_KEY);
  const consumerSecret=cleanEnv(process.env.MPESA_CONSUMER_SECRET);
  const auth=Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const base=process.env.MPESA_ENV==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
  const res=await axios.get(`${base}/oauth/v1/generate?grant_type=client_credentials`,{headers:{Authorization:`Basic ${auth}`}});
  return res.data.access_token;
}

// FEE: 15% per-order from client payment + 5% monthly admin fee charged to laundromat
async function createDisbursement(orderId,triggeredBy=null){
  const client=await getClient();
  try{
    await client.query('BEGIN');
    const or=await client.query('SELECT o.id,o.order_number,o.subtotal,o.user_id,o.laundromat_id,o.platform_fee_pct,l.commission_rate,l.mpesa_till,l.name AS lm_name FROM orders o JOIN laundromats l ON l.id=o.laundromat_id WHERE o.id=$1 FOR UPDATE',[orderId]);
    if(!or.rows.length)throw new Error('Order not found');
    const o=or.rows[0];
    const ex=await client.query('SELECT id FROM disbursements WHERE order_id=$1',[orderId]);
    if(ex.rows.length){await client.query('ROLLBACK');return null;}
    const gross=parseFloat(o.subtotal),rate=parseFloat(o.platform_fee_pct||o.commission_rate||15);
    const comm=parseFloat((gross*rate/100).toFixed(2)),payout=parseFloat((gross-comm).toFixed(2));
    const dr=await client.query('INSERT INTO disbursements(order_id,laundromat_id,gross_amount,commission_rate,commission_amount,payout_amount,status)VALUES($1,$2,$3,$4,$5,$6,$7)RETURNING *',[orderId,o.laundromat_id,gross,rate,comm,payout,'pending']);
    await client.query('COMMIT');
    console.log(`Disbursement: order=${o.order_number} gross=${gross} comm=${comm} payout=${payout}`);
    executePayout(dr.rows[0].id).catch(e=>console.error('Payout:',e.message));
    return dr.rows[0];
  }catch(e){await client.query('ROLLBACK');throw e;}
  finally{client.release();}
}

async function executePayout(disbId){
  const r=await query(`SELECT d.*, l.name, l.mpesa_till,
                              l.payout_method, l.payout_number, l.payout_account_ref, l.payout_verified
                       FROM disbursements d JOIN laundromats l ON l.id=d.laundromat_id
                       WHERE d.id=$1`,[disbId]);
  if(!r.rows.length)return;
  const d=r.rows[0];

  // Never send money to an unchecked destination. A wrong till or phone number
  // means the payout lands in a stranger's wallet and is not recoverable, so a
  // human has to have verified it first.
  if(!d.payout_verified||!d.payout_method||!d.payout_number){
    await query("UPDATE disbursements SET status='on_hold',failure_reason=$1 WHERE id=$2",
      ['Payout destination not verified by admin',d.id]);
    console.warn(`Payout held: ${d.name} has no verified payout destination`);
    return;
  }

  await query("UPDATE disbursements SET status='processing',initiated_at=NOW() WHERE id=$1",[d.id]);
  try{
    const token=await getMpesaToken();
    const base=process.env.MPESA_ENV==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
    const shortcode=cleanEnv(process.env.MPESA_SHORTCODE);
    const common={
      InitiatorName:cleanEnv(process.env.MPESA_INITIATOR_NAME),
      SecurityCredential:cleanEnv(process.env.MPESA_SECURITY_CREDENTIAL),
      Amount:Math.floor(d.payout_amount),
      PartyA:shortcode,
      Remarks:`SmartSafi payout ${d.order_id}`,
      QueueTimeOutURL:cleanEnv(process.env.MPESA_B2C_TIMEOUT_URL),
      ResultURL:cleanEnv(process.env.MPESA_B2C_RESULT_URL),
    };

    let url,payload;
    if(d.payout_method==='mpesa_phone'){
      // B2C: pays an individual's M-Pesa wallet. PartyB must be an MSISDN in
      // 2547XXXXXXXX form (no leading +).
      url=`${base}/mpesa/b2c/v3/paymentrequest`;
      payload={...common,CommandID:'BusinessPayment',PartyB:String(d.payout_number).replace(/^\+/,''),Occasion:d.id};
    }else{
      // B2B: pays another BUSINESS's till or paybill. Different endpoint and a
      // different CommandID -- sending a till through the B2C endpoint fails.
      url=`${base}/mpesa/b2b/v1/paymentrequest`;
      payload={...common,
        CommandID:d.payout_method==='paybill'?'BusinessPayBill':'BusinessBuyGoods',
        SenderIdentifierType:'4',
        RecieverIdentifierType:'4',
        PartyB:String(d.payout_number),
        AccountReference:d.payout_account_ref||d.order_id,
      };
    }

    const res=await axios.post(url,payload,{headers:{Authorization:`Bearer ${token}`}});
    await query('UPDATE disbursements SET mpesa_reference=$1 WHERE id=$2',[res.data.ConversationID,d.id]);
    console.log(`Payout sent via ${d.payout_method}: ${d.name} KES${Math.floor(d.payout_amount)}`);
  }catch(e){
    await query("UPDATE disbursements SET status='failed',failure_reason=$1 WHERE id=$2",
      [(e.response?.data?.errorMessage||e.message).substring(0,200),d.id]);
    console.error('Payout failed:',e.response?.data||e.message);
  }
}

async function handleB2CResult(req,res){
  res.json({ResultCode:0,ResultDesc:'Accepted'});
  try{
    const r=req.body.Result;if(!r)return;
    const receipt=r.ResultParameters?.ResultParameter?.find(p=>p.Key==='TransactionID')?.Value;
    if(r.ResultCode===0&&receipt)await query("UPDATE disbursements SET status='paid',mpesa_reference=$1,paid_at=NOW() WHERE id=$2",[receipt,r.OriginatorConversationID]);
    else await query("UPDATE disbursements SET status='failed',failure_reason=$1 WHERE id=$2",[r.ResultDesc?.substring(0,200),r.OriginatorConversationID]);
  }catch(e){console.error('B2C result:',e.message);}
}

async function generateMonthlyAdminFees(billingPeriod){
  const r=await query('SELECT generate_monthly_admin_fees($1)',[billingPeriod]);
  return r.rows[0].generate_monthly_admin_fees;
}

// REAL implementation (was previously a stub that never moved money).
// Sends an STK Push to the LAUNDROMAT'S OWN PHONE (not a customer) --
// the owner receives a normal M-Pesa PIN prompt and pays the 5% monthly
// fee directly into the platform's paybill. The resulting
// CheckoutRequestID is saved on the invoice so the shared /mpesa/callback
// handler can mark it paid once Safaricom confirms completion.
async function collectAdminFee(invoiceId){
  const r=await query(
    `SELECT i.*, l.phone AS laundromat_phone, l.name AS laundromat_name
     FROM admin_fee_invoices i JOIN laundromats l ON l.id=i.laundromat_id
     WHERE i.id=$1 AND i.status='pending'`,
    [invoiceId]
  );
  if(!r.rows.length)throw new Error('Invoice not found or not pending');
  const inv=r.rows[0];

  await query("UPDATE admin_fee_invoices SET status='processing' WHERE id=$1",[invoiceId]);

  try{
    const token=await getMpesaToken();
    const ts=new Date().toISOString().replace(/[-T:.Z]/g,'').slice(0,14);
    const shortcode=cleanEnv(process.env.MPESA_SHORTCODE);
    const passkey=cleanEnv(process.env.MPESA_PASSKEY);
    const pwd=Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');
    const base=process.env.MPESA_ENV==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
    const phone=normalizePhoneForMpesa(inv.laundromat_phone);

    const resp=await axios.post(`${base}/mpesa/stkpush/v1/processrequest`,{
      BusinessShortCode:shortcode,
      Password:pwd,
      Timestamp:ts,
      TransactionType:'CustomerPayBillOnline',
      Amount:Math.ceil(inv.admin_fee_amount),
      PartyA:phone,
      PartyB:shortcode,
      PhoneNumber:phone,
      CallBackURL:cleanEnv(process.env.MPESA_CALLBACK_URL),
      AccountReference:`AdminFee-${inv.billing_period}`,
      TransactionDesc:`SmartSafi admin fee ${inv.billing_period}`,
    },{headers:{Authorization:`Bearer ${token}`}});

    await query("UPDATE admin_fee_invoices SET checkout_request_id=$1 WHERE id=$2",[resp.data.CheckoutRequestID,invoiceId]);
    console.log(`Admin fee STK push sent: ${inv.laundromat_name} KES${inv.admin_fee_amount} for ${inv.billing_period}`);
    return{checkoutRequestId:resp.data.CheckoutRequestID};
  }catch(e){
    await query("UPDATE admin_fee_invoices SET status='pending' WHERE id=$1",[invoiceId]);
    console.error('Admin fee collection failed:',e.response?.data||e.message);
    throw new Error(e.response?.data?.errorMessage||'Failed to initiate admin fee collection');
  }
}

async function getEarnings(laundromatId,period='month'){
  const periodSQL={today:'CURRENT_DATE',week:"DATE_TRUNC('week',NOW())",month:"DATE_TRUNC('month',NOW())"}[period]||"DATE_TRUNC('month',NOW())";
  const[dr,fr,hr]=await Promise.all([
    query(`SELECT COUNT(*)::INT AS total_orders,COALESCE(SUM(gross_amount),0)::DECIMAL AS gross_revenue,COALESCE(SUM(commission_amount),0)::DECIMAL AS order_commission,COALESCE(SUM(payout_amount),0)::DECIMAL AS order_payout,COALESCE(SUM(CASE WHEN status='paid' THEN payout_amount ELSE 0 END),0)::DECIMAL AS paid_out,COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN payout_amount ELSE 0 END),0)::DECIMAL AS pending_payout FROM disbursements WHERE laundromat_id=$1 AND created_at>=${periodSQL}`,[laundromatId]),
    query(`SELECT COALESCE(SUM(admin_fee_amount),0)::DECIMAL AS admin_fee_this_month,COALESCE(SUM(CASE WHEN status='paid' THEN admin_fee_amount ELSE 0 END),0)::DECIMAL AS admin_fee_paid FROM admin_fee_invoices WHERE laundromat_id=$1 AND billing_period=TO_CHAR(NOW(),'YYYY-MM')`,[laundromatId]),
    query('SELECT d.*,o.order_number FROM disbursements d JOIN orders o ON o.id=d.order_id WHERE d.laundromat_id=$1 ORDER BY d.created_at DESC LIMIT 50',[laundromatId]),
  ]);
  const s=dr.rows[0],f=fr.rows[0];
  return{summary:{...s,admin_fee_this_month:f.admin_fee_this_month,admin_fee_paid:f.admin_fee_paid,true_net:parseFloat(s.order_payout)-parseFloat(f.admin_fee_this_month)},history:hr.rows};
}

async function getPlatformAnalytics(period='month'){
  const periodSQL={today:'CURRENT_DATE',week:"DATE_TRUNC('week',NOW())",month:"DATE_TRUNC('month',NOW())"}[period]||"DATE_TRUNC('month',NOW())";
  const[rev,fees,top]=await Promise.all([
    query(`SELECT COUNT(*)::INT AS total_orders,COALESCE(SUM(gross_amount),0)::DECIMAL AS total_gmv,COALESCE(SUM(commission_amount),0)::DECIMAL AS commission_revenue,COALESCE(SUM(payout_amount),0)::DECIMAL AS total_payouts FROM disbursements WHERE created_at>=${periodSQL}`),
    query(`SELECT COALESCE(SUM(admin_fee_amount),0)::DECIMAL AS admin_fee_revenue FROM admin_fee_invoices WHERE billing_period=TO_CHAR(NOW(),'YYYY-MM') AND status='paid'`),
    query(`SELECT l.name,l.area,COUNT(d.id)::INT AS orders,COALESCE(SUM(d.gross_amount),0)::DECIMAL AS gmv,COALESCE(SUM(d.commission_amount),0)::DECIMAL AS commission FROM disbursements d JOIN laundromats l ON l.id=d.laundromat_id WHERE d.created_at>=${periodSQL} GROUP BY l.id,l.name,l.area ORDER BY gmv DESC LIMIT 10`),
  ]);
  const r=rev.rows[0],f=fees.rows[0];
  return{total_gmv:parseFloat(r.total_gmv),total_orders:r.total_orders,commission_revenue:parseFloat(r.commission_revenue),admin_fee_revenue:parseFloat(f.admin_fee_revenue),total_platform_revenue:parseFloat(r.commission_revenue)+parseFloat(f.admin_fee_revenue),total_payouts:parseFloat(r.total_payouts),top_laundromats:top.rows};
}

module.exports={createDisbursement,executePayout,handleB2CResult,generateMonthlyAdminFees,collectAdminFee,getEarnings,getPlatformAnalytics};
