const express=require('express'),router=express.Router();
const {query,getClient}=require('../../utils/db'),{authenticate,isAdmin,isStaff,ownLaundromat,auditLog}=require('../../middleware/auth.middleware');
const bcrypt=require('bcryptjs');

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

// UPDATED: now optionally creates the owner's login account atomically alongside the laundromat record.
// If `password` is provided in the request body, a `users` row (role='laundromat') and a
// `laundromat_users` row (staff_role='owner') are created in the SAME transaction. If `password`
// is omitted, behavior is unchanged -- just the business record is created, and staff can be
// added afterward via POST /:laundromat_id/staff/invite.
router.post('/',authenticate,isAdmin,async(req,res)=>{
  const{name,owner_name,email,phone,address,area,city,latitude,longitude,commission_rate=15,admin_fee_rate=5,mpesa_till,description,password}=req.body;
  if(!name||!owner_name||!email||!phone||!address)return res.status(400).json({success:false,message:'Required fields missing'});
  let np=phone.replace(/\s+/g,'');if(np.startsWith('0'))np='+254'+np.slice(1);else if(np.startsWith('254'))np='+'+np;else if(!np.startsWith('+'))np='+254'+np;

  if(password && password.length<8) return res.status(400).json({success:false,message:'Password must be at least 8 characters'});

  const client = await getClient();
  try{
    await client.query('BEGIN');

    const exLm = await client.query('SELECT id FROM laundromats WHERE email=$1 OR phone=$2',[email,np]);
    if(exLm.rows.length){ await client.query('ROLLBACK'); return res.status(409).json({success:false,message:'A laundromat with this email or phone already exists'}); }

    if(password){
      const exUser = await client.query('SELECT id FROM users WHERE email=$1 OR phone=$2',[email,np]);
      if(exUser.rows.length){ await client.query('ROLLBACK'); return res.status(409).json({success:false,message:'A user account with this email or phone already exists'}); }
    }

    const lm = await client.query(
      "INSERT INTO laundromats(name,owner_name,email,phone,address,area,city,latitude,longitude,commission_rate,admin_fee_rate,mpesa_till,description,status)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')RETURNING *",
      [name,owner_name,email,np,address,area,city||'Nairobi',latitude,longitude,commission_rate,admin_fee_rate,mpesa_till,description]
    );

    let ownerAccount = null;
    if(password){
      const hash = await bcrypt.hash(password,12);
      const ur = await client.query(
        "INSERT INTO users(name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,'laundromat') RETURNING id,name,email,phone",
        [owner_name.trim(),email,np,hash]
      );
      ownerAccount = ur.rows[0];
      await client.query(
        "INSERT INTO laundromat_users(laundromat_id,user_id,staff_role) VALUES($1,$2,'owner')",
        [lm.rows[0].id, ownerAccount.id]
      );
    }

    await client.query('COMMIT');
    await auditLog(req.user.id,'admin','LAUNDROMAT_CREATED','laundromats',lm.rows[0].id,req,{owner_account_created: !!ownerAccount});
    res.status(201).json({success:true,data:{...lm.rows[0], owner_account: ownerAccount}});
  }catch(e){
    await client.query('ROLLBACK');
    console.error('Create:',e.message);
    res.status(500).json({success:false,message:'Failed'});
  }finally{
    client.release();
  }
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

async function isStaffManager(req, res, next) {
  if (['admin', 'superadmin'].includes(req.user.role)) return next();
  try {
    const r = await query(
      "SELECT staff_role FROM laundromat_users WHERE laundromat_id=$1 AND user_id=$2 AND is_active=true",
      [req.params.laundromat_id, req.user.id]
    );
    if (!r.rows.length || !['owner', 'manager'].includes(r.rows[0].staff_role)) {
      return res.status(403).json({ success: false, message: 'Only laundromat owners or managers can manage staff' });
    }
    next();
  } catch (e) {
    console.error('isStaffManager check failed:', e.message);
    res.status(500).json({ success: false, message: 'Authorization check failed' });
  }
}

router.get('/:laundromat_id/staff', authenticate, isStaff, ownLaundromat, async (req, res) => {
  try {
    const r = await query(
      `SELECT lu.id, lu.staff_role, lu.is_active AS staff_is_active, lu.created_at AS joined_at,
              u.id AS user_id, u.name, u.email, u.phone, u.is_active
       FROM laundromat_users lu
       JOIN users u ON u.id = lu.user_id
       WHERE lu.laundromat_id = $1
       ORDER BY lu.created_at ASC`,
      [req.params.laundromat_id]
    );
    res.json({ success: true, data: r.rows });
  } catch (e) {
    console.error('Get staff:', e.message);
    res.status(500).json({ success: false, message: 'Failed to load staff' });
  }
});

router.post('/:laundromat_id/staff/invite', authenticate, isStaff, ownLaundromat, isStaffManager, async (req, res) => {
  const client = await getClient();
  const { name, email, phone, password, staff_role = 'staff' } = req.body;
  if (!name || !email || !phone || !password) return res.status(400).json({ success: false, message: 'name, email, phone and password are required' });
  if (!['staff', 'manager', 'owner'].includes(staff_role)) return res.status(400).json({ success: false, message: 'Invalid staff role' });
  if (password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  let np = phone.replace(/[\s\-()]/g, '');
  if (np.startsWith('0')) np = '+254' + np.slice(1);
  else if (np.startsWith('254')) np = '+' + np;
  else if (!np.startsWith('+')) np = '+254' + np;
  try {
    await client.query('BEGIN');
    const ex = await client.query('SELECT id FROM users WHERE email=$1 OR phone=$2', [email, np]);
    if (ex.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ success: false, message: 'A user with this email or phone already exists' }); }
    const hash = await bcrypt.hash(password, 12);
    const ur = await client.query(
      "INSERT INTO users(name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,'laundromat') RETURNING id,name,email,phone",
      [name.trim(), email, np, hash]
    );
    const newUser = ur.rows[0];
    const lr = await client.query(
      "INSERT INTO laundromat_users(laundromat_id,user_id,staff_role) VALUES($1,$2,$3) RETURNING id,staff_role,is_active,created_at",
      [req.params.laundromat_id, newUser.id, staff_role]
    );
    await client.query('COMMIT');
    await auditLog(req.user.id, req.user.role, 'STAFF_INVITED', 'laundromat_users', lr.rows[0].id, req, { laundromat_id: req.params.laundromat_id, invited_user: newUser.id });
    res.status(201).json({ success: true, message: 'Staff invited', data: { ...lr.rows[0], name: newUser.name, email: newUser.email, phone: newUser.phone, user_id: newUser.id, staff_is_active: lr.rows[0].is_active } });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Invite staff:', e.message);
    res.status(500).json({ success: false, message: 'Failed to invite staff' });
  } finally {
    client.release();
  }
});

router.patch('/:laundromat_id/staff/:staffId', authenticate, isStaff, ownLaundromat, isStaffManager, async (req, res) => {
  const { is_active, staff_role } = req.body;
  if (staff_role && !['staff', 'manager', 'owner'].includes(staff_role)) return res.status(400).json({ success: false, message: 'Invalid staff role' });
  try {
    const cur = await query('SELECT lu.*, u.id as uid FROM laundromat_users lu JOIN users u ON u.id=lu.user_id WHERE lu.id=$1 AND lu.laundromat_id=$2', [req.params.staffId, req.params.laundromat_id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, message: 'Staff member not found' });
    if ((is_active === false || staff_role) && cur.rows[0].staff_role === 'owner') {
      const owners = await query("SELECT COUNT(*)::int AS c FROM laundromat_users WHERE laundromat_id=$1 AND staff_role='owner' AND is_active=true", [req.params.laundromat_id]);
      const wouldRemoveLastOwner = owners.rows[0].c <= 1 && (is_active === false || (staff_role && staff_role !== 'owner'));
      if (wouldRemoveLastOwner) return res.status(400).json({ success: false, message: 'Cannot remove the last active owner of this laundromat' });
    }
    const r = await query(
      'UPDATE laundromat_users SET staff_role=COALESCE($1,staff_role), is_active=COALESCE($2,is_active) WHERE id=$3 RETURNING id,staff_role,is_active',
      [staff_role || null, is_active === undefined ? null : is_active, req.params.staffId]
    );
    if (is_active === false) {
      await query('UPDATE users SET token_version=token_version+1 WHERE id=$1', [cur.rows[0].uid]);
    }
    await auditLog(req.user.id, req.user.role, 'STAFF_UPDATED', 'laundromat_users', req.params.staffId, req, { is_active, staff_role });
    res.json({ success: true, data: r.rows[0] });
  } catch (e) {
    console.error('Update staff:', e.message);
    res.status(500).json({ success: false, message: 'Failed to update staff' });
  }
});

module.exports=router;
