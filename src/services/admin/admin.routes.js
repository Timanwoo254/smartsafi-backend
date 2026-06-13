const express=require('express'),router=express.Router();
const {query}=require('../../utils/db'),{authenticate,isAdmin,auditLog}=require('../../middleware/auth.middleware');
const {generateMonthlyAdminFees,collectAdminFee,getPlatformAnalytics}=require('../commission/commission.service');
router.use(authenticate,isAdmin);
router.get('/analytics',async(req,res)=>{
  try{
    const analytics=await getPlatformAnalytics(req.query.period);
    const[us,os,ls]=await Promise.all([
      query("SELECT COUNT(*)::INT AS total_users,COUNT(*) FILTER(WHERE role='client')::INT AS clients,COUNT(*) FILTER(WHERE role='laundromat')::INT AS laundromat_staff,COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '30 days')::INT AS new_this_month FROM users"),
      query("SELECT COUNT(*)::INT AS total_orders,COUNT(*) FILTER(WHERE status='delivered')::INT AS delivered,COUNT(*) FILTER(WHERE status='cancelled')::INT AS cancelled,COUNT(*) FILTER(WHERE status NOT IN('delivered','cancelled'))::INT AS active FROM orders"),
      query("SELECT COUNT(*)::INT AS total,COUNT(*) FILTER(WHERE status='active')::INT AS active,COUNT(*) FILTER(WHERE status='pending')::INT AS pending_approval FROM laundromats"),
    ]);
    res.json({success:true,data:{...analytics,users:us.rows[0],orders:os.rows[0],laundromats:ls.rows[0]}});
  }catch(e){console.error('Analytics:',e.message);res.status(500).json({success:false,message:'Failed'});}
});
router.get('/disbursements',async(req,res)=>{
  const{status,laundromat_id,page=1,limit=50}=req.query,offset=(page-1)*limit;
  const params=[];let where='WHERE 1=1';
  if(status){params.push(status);where+=` AND d.status=$${params.length}`;}
  if(laundromat_id){params.push(laundromat_id);where+=` AND d.laundromat_id=$${params.length}`;}
  try{const r=await query(`SELECT d.*,l.name AS laundromat_name,o.order_number FROM disbursements d JOIN laundromats l ON l.id=d.laundromat_id JOIN orders o ON o.id=d.order_id ${where} ORDER BY d.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset]);res.json({success:true,data:r.rows});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});
router.get('/admin-fees',async(req,res)=>{
  const{billing_period,status,page=1,limit=50}=req.query,offset=(page-1)*limit;
  const params=[];let where='WHERE 1=1';
  if(billing_period){params.push(billing_period);where+=` AND i.billing_period=$${params.length}`;}
  if(status){params.push(status);where+=` AND i.status=$${params.length}`;}
  try{const r=await query(`SELECT i.*,l.name AS laundromat_name,l.mpesa_till FROM admin_fee_invoices i JOIN laundromats l ON l.id=i.laundromat_id ${where} ORDER BY i.billing_period DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset]);res.json({success:true,data:r.rows});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});
router.post('/admin-fees/generate',async(req,res)=>{
  const{billing_period}=req.body;
  if(!billing_period||!/^\d{4}-\d{2}$/.test(billing_period))return res.status(400).json({success:false,message:'billing_period must be YYYY-MM'});
  try{const count=await generateMonthlyAdminFees(billing_period);await auditLog(req.user.id,'admin','ADMIN_FEES_GENERATED','admin_fee_invoices',null,req,{billing_period,count});res.json({success:true,message:`Generated ${count} invoices for ${billing_period}`});}
  catch(e){res.status(500).json({success:false,message:e.message});}
});
router.post('/admin-fees/:id/collect',async(req,res)=>{
  try{await collectAdminFee(req.params.id);await auditLog(req.user.id,'admin','ADMIN_FEE_COLLECT','admin_fee_invoices',req.params.id,req);res.json({success:true,message:'Collection initiated'});}
  catch(e){res.status(500).json({success:false,message:e.message});}
});
router.patch('/admin-fees/:id/waive',async(req,res)=>{
  try{await query("UPDATE admin_fee_invoices SET status='waived' WHERE id=$1",[req.params.id]);await auditLog(req.user.id,'admin','ADMIN_FEE_WAIVED','admin_fee_invoices',req.params.id,req);res.json({success:true});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});
router.get('/users',async(req,res)=>{
  const{role,page=1,limit=50}=req.query,offset=(page-1)*limit;
  const params=[];let where='WHERE 1=1';
  if(role){params.push(role);where+=` AND u.role=$${params.length}`;}
  try{const r=await query(`SELECT u.id,u.name,u.email,u.phone,u.role,u.is_active,u.created_at,u.last_login_at,lu.laundromat_id,l.name AS laundromat_name FROM users u LEFT JOIN laundromat_users lu ON lu.user_id=u.id AND lu.is_active=true LEFT JOIN laundromats l ON l.id=lu.laundromat_id ${where} ORDER BY u.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset]);res.json({success:true,data:r.rows});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});
router.patch('/users/:id',async(req,res)=>{
  const{is_active,role}=req.body;
  if((role==='admin'||role==='superadmin')&&req.user.role!=='superadmin')return res.status(403).json({success:false,message:'Only superadmin can assign admin roles'});
  try{
    const r=await query('UPDATE users SET is_active=COALESCE($1,is_active),role=COALESCE($2,role),token_version=token_version+1,updated_at=NOW() WHERE id=$3 RETURNING id,name,email,role,is_active',[is_active,role||null,req.params.id]);
    if(!r.rows.length)return res.status(404).json({success:false,message:'Not found'});
    await auditLog(req.user.id,'admin','USER_UPDATED','users',req.params.id,req,{is_active,role});
    res.json({success:true,data:r.rows[0]});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});
router.get('/laundromats',async(req,res)=>{
  const{status}=req.query;const params=[];let where='WHERE 1=1';
  if(status){params.push(status);where+=` AND l.status=$${params.length}`;}
  try{
    const r=await query(`SELECT l.*,(SELECT COUNT(*) FROM orders WHERE laundromat_id=l.id AND status='delivered')::INT AS completed_orders,(SELECT COALESCE(SUM(gross_amount),0) FROM disbursements WHERE laundromat_id=l.id)::DECIMAL AS total_gmv,(SELECT COALESCE(SUM(commission_amount),0) FROM disbursements WHERE laundromat_id=l.id)::DECIMAL AS total_commission,(SELECT COALESCE(SUM(admin_fee_amount),0) FROM admin_fee_invoices WHERE laundromat_id=l.id AND status='paid')::DECIMAL AS total_admin_fees_collected FROM laundromats l ${where} ORDER BY l.created_at DESC`,params);
    res.json({success:true,data:r.rows});
  }catch(e){console.error('Admin laundromats:',e.message);res.status(500).json({success:false,message:'Failed'});}
});
router.get('/audit-log',async(req,res)=>{
  const{page=1,limit=100}=req.query,offset=(page-1)*limit;
  try{const r=await query('SELECT a.*,u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT $1 OFFSET $2',[limit,offset]);res.json({success:true,data:r.rows});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});
router.get('/subscriptions',async(req,res)=>{
  try{const{listAll}=require('../subscriptions/subscription.service');res.json({success:true,data:await listAll()});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});
module.exports=router;