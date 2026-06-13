const express=require('express');
const {query}=require('../../utils/db'),{authenticate}=require('../../middleware/auth.middleware');

const servicesRouter=express.Router();
servicesRouter.get('/',async(req,res)=>{
  try{const r=await query("SELECT * FROM services WHERE is_active=true ORDER BY category,sort_order");res.json({success:true,data:{standard:r.rows.filter(s=>s.category==='standard'),special:r.rows.filter(s=>s.category==='special')}});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});

const scheduleRouter=express.Router();
scheduleRouter.get('/slots',authenticate,async(req,res)=>{
  const{date,type='pickup'}=req.query;if(!date)return res.status(400).json({success:false,message:'Date required'});
  try{const r=await query("SELECT id,slot_date,slot_time,slot_type,max_capacity,booked_count,(max_capacity-booked_count)AS available_spots,(booked_count<max_capacity)AS is_available FROM schedule_slots WHERE slot_date=$1 AND slot_type=$2 ORDER BY slot_time",[date,type]);res.json({success:true,data:r.rows});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});
scheduleRouter.get('/available-dates',authenticate,async(req,res)=>{
  const{type='pickup'}=req.query;
  try{const r=await query("SELECT slot_date,SUM(CASE WHEN booked_count<max_capacity THEN 1 ELSE 0 END)::INT AS available_slots FROM schedule_slots WHERE slot_date>=CURRENT_DATE AND slot_date<=CURRENT_DATE+14 AND slot_type=$1 GROUP BY slot_date HAVING SUM(CASE WHEN booked_count<max_capacity THEN 1 ELSE 0 END)>0 ORDER BY slot_date",[type]);res.json({success:true,data:r.rows});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});

const supportRouter=express.Router();
supportRouter.use(authenticate);
supportRouter.post('/conversations',async(req,res)=>{
  const{orderId}=req.body;
  try{
    const ex=await query("SELECT * FROM support_conversations WHERE user_id=$1 AND order_id=$2 AND status='open' LIMIT 1",[req.user.id,orderId||null]);
    if(ex.rows.length)return res.json({success:true,data:ex.rows[0]});
    const r=await query('INSERT INTO support_conversations(user_id,order_id)VALUES($1,$2)RETURNING *',[req.user.id,orderId||null]);
    res.status(201).json({success:true,data:r.rows[0]});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});
supportRouter.get('/conversations/:id/messages',async(req,res)=>{
  try{const r=await query('SELECT * FROM support_messages WHERE conversation_id=$1 ORDER BY created_at ASC',[req.params.id]);res.json({success:true,data:r.rows});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});
supportRouter.post('/conversations/:id/messages',async(req,res)=>{
  const{message}=req.body;if(!message?.trim())return res.status(400).json({success:false,message:'Message required'});
  try{
    const r=await query("INSERT INTO support_messages(conversation_id,sender_type,sender_id,message)VALUES($1,'client',$2,$3)RETURNING *",[req.params.id,req.user.id,message.trim()]);
    await query('UPDATE support_conversations SET updated_at=NOW() WHERE id=$1',[req.params.id]);
    res.status(201).json({success:true,data:r.rows[0]});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});

const usersRouter=express.Router();
usersRouter.use(authenticate);
usersRouter.get('/profile',async(req,res)=>{
  try{const r=await query('SELECT id,name,email,phone,role,created_at FROM users WHERE id=$1',[req.user.id]);res.json({success:true,data:r.rows[0]});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});
usersRouter.patch('/profile',async(req,res)=>{
  const{name}=req.body;
  try{const r=await query('UPDATE users SET name=COALESCE($1,name),updated_at=NOW() WHERE id=$2 RETURNING id,name,email,phone',[name||null,req.user.id]);res.json({success:true,data:r.rows[0]});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});
usersRouter.get('/addresses',async(req,res)=>{
  try{const r=await query('SELECT * FROM addresses WHERE user_id=$1 ORDER BY is_default DESC,created_at DESC',[req.user.id]);res.json({success:true,data:r.rows});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});
usersRouter.post('/addresses',async(req,res)=>{
  const{label,street,area,city,latitude,longitude,isDefault}=req.body;
  if(!label||!street||!area)return res.status(400).json({success:false,message:'label,street,area required'});
  try{
    if(isDefault)await query('UPDATE addresses SET is_default=false WHERE user_id=$1',[req.user.id]);
    const r=await query('INSERT INTO addresses(user_id,label,street,area,city,latitude,longitude,is_default)VALUES($1,$2,$3,$4,$5,$6,$7,$8)RETURNING *',[req.user.id,label,street,area,city||'Nairobi',latitude,longitude,isDefault||false]);
    res.status(201).json({success:true,data:r.rows[0]});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});
usersRouter.delete('/addresses/:id',async(req,res)=>{
  try{await query('DELETE FROM addresses WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);res.json({success:true});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});

const reviewsRouter=express.Router();
reviewsRouter.use(authenticate);
reviewsRouter.post('/',async(req,res)=>{
  const{orderId,rating,comment}=req.body;
  if(!orderId||!rating||rating<1||rating>5)return res.status(400).json({success:false,message:'orderId and rating(1-5) required'});
  try{
    const oc=await query("SELECT laundromat_id FROM orders WHERE id=$1 AND user_id=$2 AND status='delivered'",[orderId,req.user.id]);
    if(!oc.rows.length)return res.status(400).json({success:false,message:'Can only review delivered orders'});
    const r=await query('INSERT INTO reviews(order_id,client_id,laundromat_id,rating,comment)VALUES($1,$2,$3,$4,$5)ON CONFLICT(order_id)DO UPDATE SET rating=$4,comment=$5 RETURNING *',[orderId,req.user.id,oc.rows[0].laundromat_id,rating,comment||null]);
    res.status(201).json({success:true,data:r.rows[0]});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});

module.exports={servicesRouter,scheduleRouter,supportRouter,usersRouter,reviewsRouter};