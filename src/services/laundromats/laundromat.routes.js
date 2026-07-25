const express=require('express'),router=express.Router();
const {query}=require('../../utils/db'),{authenticate,isAdmin,isStaff,ownLaundromat,auditLog}=require('../../middleware/auth.middleware');
function haversine(la1,lo1,la2,lo2){const R=6371,dL=(la2-la1)*Math.PI/180,dO=(lo2-lo1)*Math.PI/180;const a=Math.sin(dL/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dO/2)**2;return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
router.get('/',async(req,res)=>{
  const{lat,lng,radius=20,area,city}=req.query;
  try{
    let where="WHERE l.status='active'",params=[];
    if(area){params.push('%'+area+'%');where+=` AND l.area ILIKE $${params.length}`;}
    if(city){params.push('%'+city+'%');where+=` AND l.city ILIKE $${params.length}`;}
    const r=await query(`SELECT l.id,l.name,l.address,l.area,l.city,l.latitude,l.longitude,l.rating_avg,l.rating_count,l.description,l.logo_url,l.operating_hours,l.commission_rate FROM laundromats l ${where} ORDER BY l.rating_avg DESC NULLS LAST`,params);
    let rows=r.rows;
    if(lat&&lng){rows=rows.map(r=>({...r,distance_km:r.latitude&&r.longitude?haversine(parseFloat(lat),parseFloat(lng),parseFloat(r.latitude),parseFloat(r.longitude)):null})).filter(r=>!r.distance_km||r.distance_km<=parseFloat(radius)).sort((a,b)=>(a.distance_km||999)-(b.distance_km||999));}
    res.json({success:true,data:rows});
  }catch(e){console.error('List:',e.message);res.status(500).json({success:false,message:'Failed'});}
});
router.get('/:id',async(req,res)=>{
  try{
    const lm=await query("SELECT l.id,l.name,l.owner_name,l.address,l.area,l.city,l.latitude,l.longitude,l.rating_avg,l.rating_count,l.description,l.logo_url,l.operating_hours,l.phone FROM laundromats l WHERE l.id=$1 AND l.status='active'",[req.params.id]);
    if(!lm.rows.length)return res.status(404).json({success:false,message:'Not found'});
    const sv=await query("SELECT s.id,s.name,s.description,s.category,s.unit,COALESCE(ls.price_override,s.price_per_unit)AS price_per_unit FROM services s LEFT JOIN laundromat_services ls ON ls.service_id=s.id AND ls.laundromat_id=$1 WHERE s.is_active=true AND(ls.is_active IS NULL OR ls.is_active=true)ORDER BY s.category,s.sort_order",[req.params.id]);
    const rv=await query("SELECT r.rating,r.comment,r.created_at,u.name AS client_name FROM reviews r JOIN users u ON u.id=r.client_id WHERE r.laundromat_id=$1 AND r.is_flagged=false ORDER BY r.created_at DESC LIMIT 10",[req.params.id]);
    res.json({success:true,data:{...lm.rows[0],services:sv.rows,reviews:rv.rows}});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});
router.post('/',authenticate,async(req,res)=>{
  const{name,owner_name,email,phone,address,area,city,latitude,longitude,commission_rate=15,admin_fee_rate=5,mpesa_till,description}=req.body;
  if(!name||!owner_name||!email||!phone||!address)return res.status(400).json({success:false,message:'Required fields missing'});
  let np=phone.replace(/\s+/g,'');if(np.startsWith('0'))np='+254'+np.slice(1);
  try{
    const ex=await query('SELECT id FROM laundromats WHERE email=$1 OR phone=$2',[email,np]);
    if(ex.rows.length)return res.status(409).json({success:false,message:'Already registered'});
    const status='pending';
    const r=await query("INSERT INTO laundromats(name,owner_name,email,phone,address,area,city,latitude,longitude,commission_rate,admin_fee_rate,mpesa_till,description,status)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)RETURNING *",[name,owner_name,email,np,address,area,city||'Nairobi',latitude,longitude,commission_rate,admin_fee_rate,mpesa_till,description,status]);
    const laundromat=r.rows[0];
    if(!['admin','superadmin'].includes(req.user.role)){
      await query('INSERT INTO laundromat_users(laundromat_id,user_id,staff_role,is_active)VALUES($1,$2,$3,false)ON CONFLICT(laundromat_id,user_id)DO UPDATE SET staff_role=$3,is_active=false RETURNING *',[laundromat.id,req.user.id,'owner']);
      await query('UPDATE users SET role=\'laundromat\' WHERE id=$1 AND role!=\'laundromat\' AND role!=\'admin\' AND role!=\'superadmin\'',[req.user.id]);
    }
    await auditLog(req.user.id,req.user.role,'LAUNDROMAT_CREATED','laundromats',laundromat.id,req);
    res.status(201).json({success:true,data:laundromat,message:'Laundromat created and is pending admin approval'});
  }catch(e){console.error('Create:',e.message);res.status(500).json({success:false,message:'Failed'});}
});
router.patch('/:id',authenticate,isStaff,ownLaundromat,async(req,res)=>{
  const{name,owner_name,address,area,mpesa_till,description,operating_hours,status}=req.body;
  const ao={};
  if(['admin','superadmin'].includes(req.user.role)){if(status!==undefined)ao.status=status;if(req.body.commission_rate!==undefined)ao.commission_rate=req.body.commission_rate;if(req.body.admin_fee_rate!==undefined)ao.admin_fee_rate=req.body.admin_fee_rate;}
  try{
    const r=await query(`UPDATE laundromats SET name=COALESCE($1,name),owner_name=COALESCE($2,owner_name),address=COALESCE($3,address),area=COALESCE($4,area),mpesa_till=COALESCE($5,mpesa_till),description=COALESCE($6,description),operating_hours=COALESCE($7::jsonb,operating_hours),status=COALESCE($8,status),commission_rate=COALESCE($9,commission_rate),admin_fee_rate=COALESCE($10,admin_fee_rate),updated_at=NOW() WHERE id=$11 RETURNING *`,[name,owner_name,address,area,mpesa_till,description,operating_hours?JSON.stringify(operating_hours):null,ao.status||null,ao.commission_rate||null,ao.admin_fee_rate||null,req.params.id]);
    if(!r.rows.length)return res.status(404).json({success:false,message:'Not found'});
    if(['admin','superadmin'].includes(req.user.role)&&status==='active'){
      await query('UPDATE laundromat_users SET is_active=true WHERE laundromat_id=$1 AND staff_role=\'owner\'',[req.params.id]);
    }
    if(['admin','superadmin'].includes(req.user.role)&&status!=='active'){
      await query('UPDATE laundromat_users SET is_active=false WHERE laundromat_id=$1 AND staff_role=\'owner\'',[req.params.id]);
    }
    res.json({success:true,data:r.rows[0]});
  }catch(e){console.error('Patch:',e.message);res.status(500).json({success:false,message:'Failed'});}
});
router.get('/:laundromat_id/orders',authenticate,isStaff,ownLaundromat,async(req,res)=>{
  const{status,page=1,limit=20}=req.query,offset=(page-1)*limit;
  const params=[req.params.laundromat_id];let where='WHERE o.laundromat_id=$1';
  if(status){params.push(status);where+=` AND o.status=$${params.length}`;}
  try{
    const r=await query(`SELECT o.*,u.name AS client_name,u.phone AS client_phone,pa.street AS pickup_street,pa.area AS pickup_area,(SELECT COUNT(*) FROM order_items WHERE order_id=o.id)::INT AS item_count FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN addresses pa ON pa.id=o.pickup_address_id ${where} ORDER BY o.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset]);
    res.json({success:true,data:r.rows});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});
router.post('/:id/staff',authenticate,isAdmin,async(req,res)=>{
  const{user_id,staff_role='staff'}=req.body;
  try{
    await query('INSERT INTO laundromat_users(laundromat_id,user_id,staff_role)VALUES($1,$2,$3)ON CONFLICT(laundromat_id,user_id)DO UPDATE SET staff_role=$3,is_active=true',[req.params.id,user_id,staff_role]);
    await query("UPDATE users SET role='laundromat',updated_at=NOW() WHERE id=$1",[user_id]);
    res.status(201).json({success:true,message:'Staff added'});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});

router.post('/:id/staff/invite',authenticate,isStaff,ownLaundromat,async(req,res)=>{
  const{name,email,phone,password,staff_role='staff'}=req.body;
  if(!name||!email||!phone||!password)return res.status(400).json({success:false,message:'Required fields missing'});
  let np=phone.replace(/\s+/g,'');if(np.startsWith('0'))np='+254'+np.slice(1);
  try{
    const ex=await query('SELECT id FROM users WHERE email=$1 OR phone=$2',[email,np]);
    if(ex.rows.length)return res.status(409).json({success:false,message:'Email or phone already registered'});
    const bcrypt=require('bcryptjs');
    const hash=await bcrypt.hash(password,12);
    const userResult=await query('INSERT INTO users(name,email,phone,password_hash,role)VALUES($1,$2,$3,$4,$5)RETURNING id,name,email,phone,role,token_version',[name.trim(),email,np,hash,'laundromat']);
    const user=userResult.rows[0];
    await query('INSERT INTO laundromat_users(laundromat_id,user_id,staff_role)VALUES($1,$2,$3)ON CONFLICT(laundromat_id,user_id)DO UPDATE SET staff_role=$3,is_active=true',[req.params.id,user.id,staff_role]);
    await auditLog(req.user.id,req.user.role,'STAFF_INVITED','laundromat_users',null,req,{laundromat_id:req.params.id,user_id:user.id,staff_role});
    res.status(201).json({success:true,message:'Staff invited successfully',data:{user_id:user.id,email:user.email}});
  }catch(e){console.error('Staff invite:',e.message);res.status(500).json({success:false,message:'Failed to invite staff'});}
});

router.get('/:id/staff',authenticate,isStaff,ownLaundromat,async(req,res)=>{
  try{
    const r=await query(`SELECT u.id,u.name,u.email,u.phone,u.role,u.is_active,u.created_at,lu.staff_role,lu.is_active AS staff_is_active FROM users u JOIN laundromat_users lu ON lu.user_id=u.id WHERE lu.laundromat_id=$1 ORDER BY u.created_at DESC`,[req.params.id]);
    res.json({success:true,data:r.rows});
  }catch(e){console.error('Get staff:',e.message);res.status(500).json({success:false,message:'Failed'});}
});

router.patch('/:id/staff/:user_id',authenticate,isStaff,ownLaundromat,async(req,res)=>{
  const{is_active,staff_role}=req.body;
  try{
    const r=await query('UPDATE laundromat_users SET is_active=COALESCE($1,is_active),staff_role=COALESCE($2,staff_role) WHERE laundromat_id=$3 AND user_id=$4 RETURNING *',[is_active,staff_role,req.params.id,req.params.user_id]);
    if(!r.rows.length)return res.status(404).json({success:false,message:'Staff not found'});
    await auditLog(req.user.id,req.user.role,'STAFF_UPDATED','laundromat_users',r.rows[0].id,req,{is_active,staff_role});
    res.json({success:true,data:r.rows[0]});
  }catch(e){console.error('Update staff:',e.message);res.status(500).json({success:false,message:'Failed'});}
});

module.exports=router;