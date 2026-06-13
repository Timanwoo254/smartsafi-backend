require('dotenv').config();
const express=require('express'),http=require('http'),cors=require('cors'),helmet=require('helmet'),morgan=require('morgan');
const rateLimit=require('express-rate-limit'),{Server}=require('socket.io'),cron=require('node-cron');
const {connectDB,ping}=require('./utils/db');
const authRoutes=require('./services/auth/auth.routes');
const laundromatRoutes=require('./services/laundromats/laundromat.routes');
const orderRoutes=require('./services/orders/order.routes');
const paymentRoutes=require('./services/payments/payment.routes');
const commissionRoutes=require('./services/commission/commission.routes');
const adminRoutes=require('./services/admin/admin.routes');
const trackingRoutes=require('./services/tracking/tracking.routes');
const subscriptionRoutes=require('./services/subscriptions/subscription.routes');
const {servicesRouter,scheduleRouter,supportRouter,usersRouter,reviewsRouter}=require('./services/support/misc.routes');

const app=express(),server=http.createServer(app);
// Railway (and most PaaS) put one reverse proxy in front of the app. Trust exactly
// one hop so req.ip / X-Forwarded-For reflect the real client — required for the
// M-Pesa callback IP allowlist and per-IP rate limiting to be trustworthy.
app.set('trust proxy',1);
const io=new Server(server,{cors:{origin:'*',methods:['GET','POST']}});
app.set('io',io);
io.on('connection',socket=>{
  socket.on('join_order',orderId=>socket.join(`order_${orderId}`));
  socket.on('leave_order',orderId=>socket.leave(`order_${orderId}`));
  socket.on('driver_location',({orderId,latitude,longitude})=>io.to(`order_${orderId}`).emit('location_update',{latitude,longitude,ts:Date.now()}));
});

app.use(helmet({crossOriginEmbedderPolicy:false,contentSecurityPolicy:false}));
const origins=process.env.NODE_ENV==='production'?(process.env.ALLOWED_ORIGINS||'*').split(',').map(o=>o.trim()):'*';
app.use(cors({origin:origins,methods:['GET','POST','PATCH','DELETE','OPTIONS'],allowedHeaders:['Content-Type','Authorization'],credentials:true}));
app.use(express.json({limit:'50kb'}));
app.use(express.urlencoded({extended:true,limit:'50kb'}));
app.use(morgan('dev'));
app.use('/api',rateLimit({windowMs:15*60*1000,max:300,standardHeaders:true,legacyHeaders:false,message:{success:false,message:'Too many requests'}}));

// Railway gates the deploy on this. Verify DB connectivity so a healthy app with a
// dead database does not get promoted to serving traffic. Cheap SELECT 1, never throws.
app.get('/health',async(req,res)=>{
  const db=await ping();
  res.status(db?200:503).json({status:db?'ok':'degraded',db:db?'up':'down',app:'Smart-Safi API',version:'2.0.0',ts:new Date().toISOString()});
});

app.use('/api/auth',authRoutes);
app.use('/api/users',usersRouter);
app.use('/api/services',servicesRouter);
app.use('/api/schedule',scheduleRouter);
app.use('/api/laundromats',laundromatRoutes);
app.use('/api/orders',orderRoutes);
app.use('/api/payments',paymentRoutes);
app.use('/api/tracking',trackingRoutes);
app.use('/api/support',supportRouter);
app.use('/api/earnings',commissionRoutes);
app.use('/api/reviews',reviewsRouter);
app.use('/api/subscriptions',subscriptionRoutes);
app.use('/api/admin',adminRoutes);

app.use((err,req,res,next)=>{console.error('Unhandled:',err.message);const dev=process.env.NODE_ENV==='development';res.status(err.status||500).json({success:false,message:dev?err.message:'An unexpected error occurred'});});
app.use((req,res)=>res.status(404).json({success:false,message:'Route not found'}));

// Cron: generate monthly admin fee invoices on 1st of each month at 01:00
cron.schedule('0 1 1 * *',async()=>{
  const{generateMonthlyAdminFees}=require('./services/commission/commission.service');
  const now=new Date(),prev=new Date(now.getFullYear(),now.getMonth()-1,1);
  const period=`${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`;
  try{const n=await generateMonthlyAdminFees(period);console.log(`[CRON] Generated ${n} admin fee invoices for ${period}`);}
  catch(e){console.error('[CRON] Admin fee gen failed:',e.message);}
});

// Cron: flag lapsed partner subscriptions as past_due, daily at 02:00
cron.schedule('0 2 * * *',async()=>{
  const{markPastDue}=require('./services/subscriptions/subscription.service');
  try{const n=await markPastDue();if(n)console.log(`[CRON] ${n} subscriptions marked past_due`);}
  catch(e){console.error('[CRON] Subscription sweep failed:',e.message);}
});

// Cron: refresh schedule slots daily at midnight
cron.schedule('0 0 * * *',async()=>{
  const{query}=require('./utils/db');
  const times=['08:00','09:00','10:00','11:00','14:00','15:00','16:00','17:00'];
  try{
    for(let i=1;i<=14;i++){
      const d=new Date();d.setDate(d.getDate()+i);if(d.getDay()===0)continue;
      const ds=d.toISOString().split('T')[0];
      for(const t of times)await query("INSERT INTO schedule_slots(slot_date,slot_time,slot_type,max_capacity)VALUES($1,$2,'pickup',8),($1,$2,'delivery',8)ON CONFLICT DO NOTHING",[ds,t]);
    }
    console.log('[CRON] Slots refreshed');
  }catch(e){console.error('[CRON] Slot refresh failed:',e.message);}
});

const PORT=process.env.PORT||5000;
async function start(){
  try{await connectDB();server.listen(PORT,()=>console.log(`✅ Smart-Safi API running on port ${PORT}`));}
  catch(e){console.error('Failed to start:',e.message);process.exit(1);}
}
start();
