const express=require('express'),router=express.Router();
const {authenticate,requireRole}=require('../../middleware/auth.middleware');
const svc=require('./subscription.service');

// Public list of plans (also used by the laundromat app).
router.get('/plans',async(req,res)=>{
  try{res.json({success:true,data:await svc.listPlans()});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});

// Current laundromat's subscription.
router.get('/me',authenticate,requireRole('laundromat','admin','superadmin'),async(req,res)=>{
  try{res.json({success:true,data:await svc.getForLaundromat(req.user.laundromat_id)});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});

// Subscribe / change plan — initiates a provider payment for the plan price.
router.post('/subscribe',authenticate,requireRole('laundromat'),async(req,res)=>{
  const{planId,phone}=req.body;
  if(!planId||!phone)return res.status(400).json({success:false,message:'planId and phone required'});
  if(!req.user.laundromat_id)return res.status(400).json({success:false,message:'No laundromat linked to your account'});
  try{
    const out=await svc.subscribe(req.user.laundromat_id,planId,phone);
    res.json({success:true,message:out.userMessage||'Payment initiated',data:{reference:out.reference,plan:out.plan.name,amount:out.plan.price,providerRef:out.providerRef}});
  }catch(e){console.error('Subscribe:',e.response?.data||e.message);res.status(500).json({success:false,message:e.message||'Failed'});}
});

module.exports=router;
