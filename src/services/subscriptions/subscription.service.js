// Laundromat partner subscriptions, billed through the payment engine.
const {query}=require('../../utils/db');
const {getProvider}=require('../payments/providers');

async function listPlans(){
  const r=await query('SELECT * FROM subscription_plans WHERE is_active=true ORDER BY sort_order,price');
  return r.rows;
}

async function getForLaundromat(laundromatId){
  if(!laundromatId)return null;
  const r=await query('SELECT s.*,p.name AS plan_name,p.price AS plan_price,p.interval AS plan_interval,p.features FROM laundromat_subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.laundromat_id=$1',[laundromatId]);
  return r.rows[0]||null;
}

// Create/reuse the laundromat's subscription (pending), then initiate a provider payment.
async function subscribe(laundromatId,planId,phone){
  const pl=await query('SELECT * FROM subscription_plans WHERE id=$1 AND is_active=true',[planId]);
  if(!pl.rows.length)throw new Error('Plan not found');
  const plan=pl.rows[0];
  const sub=await query(`INSERT INTO laundromat_subscriptions(laundromat_id,plan_id,status)VALUES($1,$2,'pending')
    ON CONFLICT(laundromat_id)DO UPDATE SET plan_id=$2,updated_at=NOW() RETURNING *`,[laundromatId,planId]);
  const subscription=sub.rows[0];
  const period=new Date().toISOString().slice(0,7);
  const provider=getProvider();
  const sp=await query("INSERT INTO subscription_payments(subscription_id,amount,provider,status,period)VALUES($1,$2,$3,'pending',$4)RETURNING *",[subscription.id,plan.price,provider.name,period]);
  const reference=`SUB-${sp.rows[0].id}`;
  const out=await provider.initiate({amount:plan.price,phone,reference,description:`SmartSafi ${plan.name} subscription`});
  await query('UPDATE subscription_payments SET provider_ref=$1 WHERE id=$2',[out.providerRef,sp.rows[0].id]);
  return {subscription,plan,reference,providerRef:out.providerRef,userMessage:out.userMessage};
}

// Called from the unified payment webhook for SUB-* references (or matched by provider_ref).
async function handlePaymentWebhook(parsed){
  let spRow;
  if(parsed.reference&&String(parsed.reference).startsWith('SUB-')){
    const r=await query('SELECT * FROM subscription_payments WHERE id=$1',[parsed.reference.slice(4)]);spRow=r.rows[0];
  }
  if(!spRow&&parsed.providerRef){
    const r=await query('SELECT * FROM subscription_payments WHERE provider_ref=$1',[parsed.providerRef]);spRow=r.rows[0];
  }
  if(!spRow)return;
  if(parsed.status==='completed'){
    await query("UPDATE subscription_payments SET status='completed',paid_at=NOW(),provider_ref=COALESCE(provider_ref,$2) WHERE id=$1",[spRow.id,parsed.providerRef]);
    const sub=await query('SELECT s.id,p.interval FROM laundromat_subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=$1',[spRow.subscription_id]);
    if(sub.rows.length){
      const intv=sub.rows[0].interval==='year'?'1 year':'1 month';
      await query(`UPDATE laundromat_subscriptions SET status='active',current_period_start=NOW(),current_period_end=NOW()+INTERVAL '${intv}',last_payment_id=$2,updated_at=NOW() WHERE id=$1`,[spRow.subscription_id,spRow.id]);
    }
  }else if(parsed.status==='failed'){
    await query("UPDATE subscription_payments SET status='failed' WHERE id=$1",[spRow.id]);
  }
}

async function listAll(){
  const r=await query(`SELECT s.*,l.name AS laundromat_name,p.name AS plan_name,p.price AS plan_price FROM laundromat_subscriptions s JOIN laundromats l ON l.id=s.laundromat_id JOIN subscription_plans p ON p.id=s.plan_id ORDER BY s.updated_at DESC`);
  return r.rows;
}

// Cron: flip active subscriptions whose period has lapsed to past_due.
async function markPastDue(){
  const r=await query("UPDATE laundromat_subscriptions SET status='past_due',updated_at=NOW() WHERE status='active' AND current_period_end<NOW() RETURNING id");
  return r.rowCount;
}

module.exports={listPlans,getForLaundromat,subscribe,handlePaymentWebhook,listAll,markPastDue};
