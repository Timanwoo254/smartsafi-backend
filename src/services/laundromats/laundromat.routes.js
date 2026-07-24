const express=require('express'),router=express.Router();
const bcrypt=require('bcryptjs');
const {query,getClient}=require('../../utils/db'),{authenticate,isAdmin,isStaff,ownLaundromat,auditLog}=require('../../middleware/auth.middleware');
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
router.post('/',authenticate,isAdmin,async(req,res)=>{
  const{name,owner_name,email,phone,address,area,city,latitude,longitude,commission_rate=15,admin_fee_rate=5,mpesa_till,description,owner_email,password}=req.body;
  if(!name||!owner_name||!email||!phone||!address||!owner_email||!password)return res.status(400).json({success:false,message:'Required fields missing: name, owner_name, email, phone, address, owner_email, and password are required'});
  let np=phone.replace(/\s+/g,'');if(np.startsWith('0'))np='+254'+np.slice(1);
  const client=await getClient();
  try{
    await client.query('BEGIN');
    const ex=await client.query('SELECT id FROM laundromats WHERE email=$1 OR phone=$2',[email,np]);
    if(ex.rows.length){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'Already registered'});}
    const r=await client.query("INSERT INTO laundromats(name,owner_name,email,phone,address,area,city,latitude,longitude,commission_rate,admin_fee_rate,mpesa_till,description,status)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')RETURNING *",[name,owner_name,email,np,address,area,city||'Nairobi',latitude,longitude,commission_rate,admin_fee_rate,mpesa_till,description]);
    const laundromat=r.rows[0];
    const exUser=await client.query('SELECT id FROM users WHERE email=$1 OR phone=$2',[owner_email,np]);
    if(exUser.rows.length){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'Owner email or phone already exists'});}
    const hash=await bcrypt.hash(password,12);
    const userResult=await client.query('INSERT INTO users(name,email,phone,password_hash,role)VALUES($1,$2,$3,$4,$5)RETURNING id,name,email,phone,role,token_version',[owner_name,owner_email,np,hash,'laundromat']);
    const user=userResult.rows[0];
    await client.query('INSERT INTO laundromat_users(laundromat_id,user_id,staff_role)VALUES($1,$2,$3)',[laundromat.id,user.id,'owner']);
    await client.query('COMMIT');
    await auditLog(req.user.id,'admin','LAUNDROMAT_CREATED','laundromats',laundromat.id,req);
    res.status(201).json({success:true,data:{...laundromat,owner_email,owner_user_id:user.id}});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error('Create:',e.message);res.status(500).json({success:false,message:'Failed'});}
  finally{client.release();}
});
router.patch('/:id',authenticate,isStaff,ownLaundromat,async(req,res)=>{
  const{name,owner_name,address,area,mpesa_till,description,operating_hours}=req.body;
  const ao={};
  if(['admin','superadmin'].includes(req.user.role)){if(req.body.status!==undefined)ao.status=req.body.status;if(req.body.commission_rate!==undefined)ao.commission_rate=req.body.commission_rate;if(req.body.admin_fee_rate!==undefined)ao.admin_fee_rate=req.body.admin_fee_rate;}
  try{
    const r=await query(`UPDATE laundromats SET name=COALESCE($1,name),owner_name=COALESCE($2,owner_name),address=COALESCE($3,address),area=COALESCE($4,area),mpesa_till=COALESCE($5,mpesa_till),description=COALESCE($6,description),operating_hours=COALESCE($7::jsonb,operating_hours),status=COALESCE($8,status),commission_rate=COALESCE($9,commission_rate),admin_fee_rate=COALESCE($10,admin_fee_rate),updated_at=NOW() WHERE id=$11 RETURNING *`,[name,owner_name,address,area,mpesa_till,description,operating_hours?JSON.stringify(operating_hours):null,ao.status||null,ao.commission_rate||null,ao.admin_fee_rate||null,req.params.id]);
    if(!r.rows.length)return res.status(404).json({success:false,message:'Not found'});
    res.json({success:true,data:r.rows[0]});
  }catch{res.status(500).json({success:false,message:'Failed'});}
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
module.exports=router;