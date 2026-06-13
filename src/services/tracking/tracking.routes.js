const express=require('express'),router=express.Router();
const {query}=require('../../utils/db'),{authenticate}=require('../../middleware/auth.middleware');
router.get('/:orderId',authenticate,async(req,res)=>{
  try{
    const[or,hr]=await Promise.all([
      query('SELECT o.id,o.order_number,o.status,o.pickup_time,o.delivery_time,o.driver_name,o.driver_phone,pa.street AS pickup_street,pa.area AS pickup_area,da.street AS delivery_street,da.area AS delivery_area,l.name AS laundromat_name,l.phone AS laundromat_phone FROM orders o LEFT JOIN addresses pa ON pa.id=o.pickup_address_id LEFT JOIN addresses da ON da.id=o.delivery_address_id LEFT JOIN laundromats l ON l.id=o.laundromat_id WHERE o.id=$1',[req.params.orderId]),
      query('SELECT status,note,changed_at FROM order_status_history WHERE order_id=$1 ORDER BY changed_at ASC',[req.params.orderId]),
    ]);
    if(!or.rows.length)return res.status(404).json({success:false,message:'Not found'});
    res.json({success:true,data:{order:or.rows[0],history:hr.rows}});
  }catch{res.status(500).json({success:false,message:'Failed'});}
});
module.exports=router;