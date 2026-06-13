const express=require('express'),router=express.Router();
const {query,getClient}=require('../../utils/db');
const {authenticate,requireRole,ownOrder,auditLog}=require('../../middleware/auth.middleware');
const DELIVERY_FEE=100;
const TRANSITIONS={confirmed:['picked_up'],picked_up:['washing'],washing:['ironing','ready'],ironing:['ready'],ready:['out_for_delivery'],out_for_delivery:['delivered']};
function genOrderNum(){return'SS'+Date.now().toString(36).toUpperCase().slice(-5)+Math.random().toString(36).toUpperCase().slice(2,5);}

router.post('/',authenticate,requireRole('client'),async(req,res)=>{
  const dbClient=await getClient();
  try{
    await dbClient.query('BEGIN');
    const{items,pickupAddressId,deliveryAddressId,pickupTime,specialInstructions,laundromatId,idempotencyKey}=req.body;
    if(!items?.length)return res.status(400).json({success:false,message:'At least one service required'});
    if(idempotencyKey){const ex=await dbClient.query('SELECT id,order_number,total_amount FROM orders WHERE idempotency_key=$1',[idempotencyKey]);if(ex.rows.length){await dbClient.query('ROLLBACK');return res.json({success:true,data:ex.rows[0],idempotent:true});}}
    let lmId=laundromatId;
    if(!lmId){const lm=await dbClient.query("SELECT id FROM laundromats WHERE status='active' ORDER BY rating_avg DESC LIMIT 1");lmId=lm.rows[0]?.id;}
    if(!lmId)return res.status(400).json({success:false,message:'No active laundromat'});
    const lr=await dbClient.query('SELECT commission_rate FROM laundromats WHERE id=$1',[lmId]);
    if(!lr.rows.length)return res.status(404).json({success:false,message:'Laundromat not found'});
    const commRate=parseFloat(lr.rows[0].commission_rate);
    const svcIds=items.map(i=>i.serviceId);
    const sv=await dbClient.query('SELECT s.id,s.name,s.unit,COALESCE(ls.price_override,s.price_per_unit) AS price_per_unit FROM services s LEFT JOIN laundromat_services ls ON ls.service_id=s.id AND ls.laundromat_id=$2 WHERE s.id=ANY($1) AND s.is_active=true',[svcIds,lmId]);
    const svcMap=Object.fromEntries(sv.rows.map(s=>[s.id,s]));
    let subtotal=0;
    const orderItems=items.map(item=>{const svc=svcMap[item.serviceId];if(!svc)throw new Error(`Service ${item.serviceId} not found`);const lt=parseFloat((svc.price_per_unit*item.quantity).toFixed(2));subtotal+=lt;return{...item,serviceName:svc.name,unitPrice:svc.price_per_unit,lineTotal:lt};});
    subtotal=parseFloat(subtotal.toFixed(2));
    const feeAmt=parseFloat((subtotal*commRate/100).toFixed(2));
    const total=parseFloat((subtotal+DELIVERY_FEE).toFixed(2));
    const oNum=genOrderNum();
    const or=await dbClient.query('INSERT INTO orders(order_number,user_id,laundromat_id,pickup_address_id,delivery_address_id,pickup_time,subtotal,platform_fee_pct,platform_fee_amount,delivery_fee,total_amount,special_instructions,idempotency_key)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)RETURNING *',[oNum,req.user.id,lmId,pickupAddressId,deliveryAddressId||pickupAddressId,pickupTime,subtotal,commRate,feeAmt,DELIVERY_FEE,total,specialInstructions||null,idempotencyKey||null]);
    const order=or.rows[0];
    for(const item of orderItems)await dbClient.query('INSERT INTO order_items(order_id,service_id,service_name,quantity,unit_price,special_instructions,line_total)VALUES($1,$2,$3,$4,$5,$6,$7)',[order.id,item.serviceId,item.serviceName,item.quantity,item.unitPrice,item.specialInstructions||null,item.lineTotal]);
    await dbClient.query('INSERT INTO order_status_history(order_id,status,changed_by,note)VALUES($1,$2,$3,$4)',[order.id,'pending',req.user.id,'Order placed']);
    await dbClient.query('COMMIT');
    await auditLog(req.user.id,'client','ORDER_CREATED','orders',order.id,req,{total});
    res.status(201).json({success:true,data:order});
  }catch(e){await dbClient.query('ROLLBACK');console.error('Create order:',e.message);res.status(500).json({success:false,message:e.message.includes('not found')?e.message:'Failed to create order'});}
  finally{dbClient.release();}
});

router.get('/',authenticate,async(req,res)=>{
  const{status,page=1,limit=20}=req.query,offset=(page-1)*limit;
  const params=[];let where='WHERE 1=1';
  if(req.user.role==='client'){params.push(req.user.id);where+=` AND o.user_id=$${params.length}`;}
  else if(req.user.role==='laundromat'){params.push(req.user.laundromat_id);where+=` AND o.laundromat_id=$${params.length}`;}
  if(status){params.push(status);where+=` AND o.status=$${params.length}`;}
  try{
    const r=await query(`SELECT o.*,u.name AS client_name,u.phone AS client_phone,l.name AS laundromat_name,pa.street AS pickup_street,pa.area AS pickup_area,(SELECT COUNT(*) FROM order_items WHERE order_id=o.id)::INT AS item_count FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN laundromats l ON l.id=o.laundromat_id LEFT JOIN addresses pa ON pa.id=o.pickup_address_id ${where} ORDER BY o.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset]);
    res.json({success:true,data:r.rows});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});

router.get('/:id',authenticate,ownOrder,async(req,res)=>{
  try{
    const[or,ir,hr,pr]=await Promise.all([
      query(`SELECT o.*,u.name AS client_name,u.phone AS client_phone,l.name AS laundromat_name,l.phone AS laundromat_phone,pa.street AS pickup_street,pa.area AS pickup_area,pa.city AS pickup_city,da.street AS delivery_street,da.area AS delivery_area FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN laundromats l ON l.id=o.laundromat_id LEFT JOIN addresses pa ON pa.id=o.pickup_address_id LEFT JOIN addresses da ON da.id=o.delivery_address_id WHERE o.id=$1`,[req.params.id]),
      query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY created_at',[req.params.id]),
      query('SELECT * FROM order_status_history WHERE order_id=$1 ORDER BY changed_at',[req.params.id]),
      query('SELECT * FROM payments WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1',[req.params.id]),
    ]);
    if(!or.rows.length)return res.status(404).json({success:false,message:'Not found'});
    res.json({success:true,data:{...or.rows[0],items:ir.rows,history:hr.rows,payment:pr.rows[0]||null}});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});

router.patch('/:id/status',authenticate,ownOrder,async(req,res)=>{
  const{status,note,driverName,driverPhone}=req.body;
  if(req.user.role==='laundromat'){const allowed=TRANSITIONS[req.order?.status]||[];if(!allowed.includes(status))return res.status(400).json({success:false,message:`Cannot go from '${req.order?.status}' to '${status}'`});}
  try{
    const r=await query(`UPDATE orders SET status=$1,driver_name=COALESCE($2,driver_name),driver_phone=COALESCE($3,driver_phone),delivery_time=CASE WHEN $1='delivered' THEN NOW() ELSE delivery_time END,updated_at=NOW() WHERE id=$4 RETURNING *`,[status,driverName||null,driverPhone||null,req.params.id]);
    if(!r.rows.length)return res.status(404).json({success:false,message:'Not found'});
    await query('INSERT INTO order_status_history(order_id,status,changed_by,note)VALUES($1,$2,$3,$4)',[req.params.id,status,req.user.id,note||null]);
    const io=req.app.get('io');if(io)io.to(`order_${req.params.id}`).emit('order_update',{status,ts:new Date()});
    if(status==='delivered'){const{createDisbursement}=require('../commission/commission.service');createDisbursement(req.params.id,req.user.id).catch(e=>console.error('Disbursement:',e.message));}
    res.json({success:true,data:r.rows[0]});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});

router.patch('/:id/cancel',authenticate,requireRole('client','admin','superadmin'),async(req,res)=>{
  try{
    const r=await query(`UPDATE orders SET status='cancelled',updated_at=NOW() WHERE id=$1 AND (user_id=$2 OR $3=ANY(ARRAY['admin','superadmin'])) AND status IN ('pending','confirmed') RETURNING *`,[req.params.id,req.user.id,req.user.role]);
    if(!r.rows.length)return res.status(400).json({success:false,message:'Cannot cancel'});
    await query('INSERT INTO order_status_history(order_id,status,changed_by,note)VALUES($1,$2,$3,$4)',[req.params.id,'cancelled',req.user.id,'Cancelled']);
    res.json({success:true,data:r.rows[0]});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});

module.exports=router;