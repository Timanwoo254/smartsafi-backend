const express=require('express'),router=express.Router();
const {authenticate,isStaff,ownLaundromat}=require('../../middleware/auth.middleware');
const {getEarnings}=require('./commission.service');
router.get('/:laundromat_id',authenticate,isStaff,ownLaundromat,async(req,res)=>{
  try{const data=await getEarnings(req.params.laundromat_id,req.query.period);res.json({success:true,data});}
  catch{res.status(500).json({success:false,message:'Failed'});}
});
module.exports=router;