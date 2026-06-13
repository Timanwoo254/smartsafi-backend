const express=require('express'),router=express.Router(),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken');
const {body,validationResult}=require('express-validator'),rateLimit=require('express-rate-limit');
const {query,getClient}=require('../../utils/db'),{authenticate,auditLog}=require('../../middleware/auth.middleware');
const authLimiter=rateLimit({windowMs:15*60*1000,max:5,skipSuccessfulRequests:true,message:{success:false,message:'Too many attempts'}});
async function generateToken(user){
  let lm=null;
  if(user.role==='laundromat'){const r=await query('SELECT laundromat_id FROM laundromat_users WHERE user_id=$1 AND is_active=true LIMIT 1',[user.id]);lm=r.rows[0]?.laundromat_id||null;}
  return jwt.sign({id:user.id,email:user.email,name:user.name,role:user.role,laundromat_id:lm,tokenVersion:user.token_version},process.env.JWT_SECRET,{expiresIn:process.env.JWT_EXPIRES_IN||'7d'});
}
function normalizePhone(p){p=p.replace(/[\s\-()]/g,'');if(p.startsWith('0'))return'+254'+p.slice(1);if(p.startsWith('254'))return'+'+p;if(!p.startsWith('+'))return'+254'+p;return p;}
router.post('/register',authLimiter,[body('name').trim().notEmpty(),body('email').isEmail().normalizeEmail(),body('phone').notEmpty(),body('password').isLength({min:8})],async(req,res)=>{
  const errors=validationResult(req);if(!errors.isEmpty())return res.status(400).json({success:false,message:errors.array()[0].msg});
  const{name,email,phone,password}=req.body,nPhone=normalizePhone(phone);
  try{
    const ex=await query('SELECT id FROM users WHERE email=$1 OR phone=$2',[email,nPhone]);
    if(ex.rows.length)return res.status(409).json({success:false,message:'Email or phone already registered'});
    const hash=await bcrypt.hash(password,12);
    const r=await query('INSERT INTO users(name,email,phone,password_hash,role)VALUES($1,$2,$3,$4,$5)RETURNING id,name,email,phone,role,token_version',[name.trim(),email,nPhone,hash,'client']);
    const u=r.rows[0],token=await generateToken(u);
    await auditLog(u.id,'client','REGISTER','users',u.id,req);
    res.status(201).json({success:true,data:{user:{id:u.id,name:u.name,email:u.email,phone:u.phone,role:u.role},token}});
  }catch(e){console.error('Register:',e.message);res.status(500).json({success:false,message:'Registration failed'});}
});
// Laundromat partner self sign-up: creates a laundromat-role user + a pending laundromat (awaiting admin approval) + owner link, atomically.
router.post('/register-laundromat',authLimiter,[body('name').trim().notEmpty(),body('businessName').trim().notEmpty(),body('email').isEmail().normalizeEmail(),body('phone').notEmpty(),body('password').isLength({min:8}),body('address').trim().notEmpty()],async(req,res)=>{
  const errors=validationResult(req);if(!errors.isEmpty())return res.status(400).json({success:false,message:errors.array()[0].msg});
  const{name,businessName,email,phone,password,address,area}=req.body,nPhone=normalizePhone(phone);
  const client=await getClient();
  try{
    await client.query('BEGIN');
    const exU=await client.query('SELECT id FROM users WHERE email=$1 OR phone=$2',[email,nPhone]);
    if(exU.rows.length){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'Email or phone already registered'});}
    const exL=await client.query('SELECT id FROM laundromats WHERE email=$1 OR phone=$2',[email,nPhone]);
    if(exL.rows.length){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'A laundromat with this email or phone already exists'});}
    const hash=await bcrypt.hash(password,12);
    const ur=await client.query('INSERT INTO users(name,email,phone,password_hash,role)VALUES($1,$2,$3,$4,$5)RETURNING id,name,email,phone,role,token_version',[name.trim(),email,nPhone,hash,'laundromat']);
    const u=ur.rows[0];
    const lr=await client.query('INSERT INTO laundromats(name,owner_name,email,phone,address,area,status)VALUES($1,$2,$3,$4,$5,$6,$7)RETURNING id,name,status,commission_rate,admin_fee_rate',[businessName.trim(),name.trim(),email,nPhone,address.trim(),area?.trim()||null,'pending']);
    const lm=lr.rows[0];
    await client.query('INSERT INTO laundromat_users(laundromat_id,user_id,staff_role)VALUES($1,$2,$3)',[lm.id,u.id,'owner']);
    await client.query('COMMIT');
    const token=await generateToken(u);
    await auditLog(u.id,'laundromat','REGISTER','laundromats',lm.id,req);
    res.status(201).json({success:true,data:{user:{id:u.id,name:u.name,email:u.email,phone:u.phone,role:u.role},laundromat:lm,token}});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error('Register-laundromat:',e.message);res.status(500).json({success:false,message:'Registration failed'});}
  finally{client.release();}
});
router.post('/login',authLimiter,[body('email').isEmail().normalizeEmail(),body('password').notEmpty()],async(req,res)=>{
  const errors=validationResult(req);if(!errors.isEmpty())return res.status(400).json({success:false,message:'Invalid credentials'});
  const{email,password}=req.body;
  try{
    const r=await query('SELECT id,name,email,phone,password_hash,role,is_active,locked_until,failed_login_count,token_version FROM users WHERE email=$1',[email]);
    const E={success:false,message:'Invalid email or password'};
    if(!r.rows.length)return res.status(401).json(E);
    const u=r.rows[0];
    if(!u.is_active)return res.status(403).json({success:false,message:'Account suspended'});
    if(u.locked_until&&new Date(u.locked_until)>new Date())return res.status(403).json({success:false,message:'Account locked. Try later.'});
    const ok=await bcrypt.compare(password,u.password_hash);
    if(!ok){const n=u.failed_login_count+1;await query('UPDATE users SET failed_login_count=$1,locked_until=$2 WHERE id=$3',[n,n>=10?new Date(Date.now()+30*60*1000):null,u.id]);return res.status(401).json(E);}
    await query("UPDATE users SET failed_login_count=0,locked_until=NULL,last_login_at=NOW() WHERE id=$1",[u.id]);
    const token=await generateToken(u);
    await auditLog(u.id,u.role,'LOGIN','users',u.id,req);
    res.json({success:true,data:{user:{id:u.id,name:u.name,email:u.email,phone:u.phone,role:u.role},token}});
  }catch(e){console.error('Login:',e.message);res.status(500).json({success:false,message:'Login failed'});}
});
router.get('/me',authenticate,async(req,res)=>{
  try{
    const r=await query('SELECT id,name,email,phone,role,created_at FROM users WHERE id=$1',[req.user.id]);
    if(!r.rows.length)return res.status(404).json({success:false,message:'Not found'});
    let laundromat=null;
    if(req.user.laundromat_id){const lr=await query('SELECT id,name,status,commission_rate,admin_fee_rate FROM laundromats WHERE id=$1',[req.user.laundromat_id]);laundromat=lr.rows[0]||null;}
    res.json({success:true,data:{...r.rows[0],laundromat}});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});
router.post('/logout',authenticate,async(req,res)=>{
  await query('UPDATE users SET token_version=token_version+1 WHERE id=$1',[req.user.id]).catch(()=>{});
  res.json({success:true});
});
router.post('/fcm-token',authenticate,async(req,res)=>{
  const{fcmToken}=req.body;
  await query('UPDATE users SET fcm_token=$1 WHERE id=$2',[fcmToken,req.user.id]).catch(()=>{});
  res.json({success:true});
});
module.exports=router;