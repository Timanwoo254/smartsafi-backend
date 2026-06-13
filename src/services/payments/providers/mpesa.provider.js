// Safaricom Daraja (M-Pesa STK Push) provider. Kept as the fallback engine.
const axios = require('axios');
const apiBase = () => (process.env.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');
function normPhone(phone) { let p = String(phone).replace(/\s+/g, ''); if (p.startsWith('+')) p = p.slice(1); if (p.startsWith('0')) p = '254' + p.slice(1); return p; }
async function getToken() {
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const r = await axios.get(`${apiBase()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  return r.data.access_token;
}
module.exports = {
  name: 'mpesa',
  // Initiates an STK push. Returns a normalized { providerRef, raw, userMessage }.
  async initiate({ amount, phone, reference, description, callbackUrl }) {
    const token = await getToken();
    const ts = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
    const pwd = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${ts}`).toString('base64');
    const p = normPhone(phone);
    const resp = await axios.post(`${apiBase()}/mpesa/stkpush/v1/processrequest`, {
      BusinessShortCode: process.env.MPESA_SHORTCODE, Password: pwd, Timestamp: ts, TransactionType: 'CustomerPayBillOnline',
      Amount: Math.ceil(amount), PartyA: p, PartyB: process.env.MPESA_SHORTCODE, PhoneNumber: p,
      CallBackURL: callbackUrl || process.env.MPESA_CALLBACK_URL, AccountReference: reference, TransactionDesc: description || reference,
    }, { headers: { Authorization: `Bearer ${token}` } });
    return { providerRef: resp.data.CheckoutRequestID, raw: resp.data, userMessage: 'Check your phone for the M-Pesa prompt' };
  },
  // Query the status of an STK push (used to reconcile when the async callback can't reach us,
  // e.g. a LAN dev box). Returns normalized { status: 'completed'|'failed'|'pending', raw }.
  async query(checkoutRequestId){
    const token=await getToken();
    const ts=new Date().toISOString().replace(/[-T:.Z]/g,'').slice(0,14);
    const pwd=Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${ts}`).toString('base64');
    try{
      const resp=await axios.post(`${apiBase()}/mpesa/stkpushquery/v1/query`,{BusinessShortCode:process.env.MPESA_SHORTCODE,Password:pwd,Timestamp:ts,CheckoutRequestID:checkoutRequestId},{headers:{Authorization:`Bearer ${token}`}});
      const code=resp.data&&resp.data.ResultCode;
      const status=String(code)==='0'?'completed':(code!=null?'failed':'pending');
      return{status,raw:resp.data};
    }catch(e){
      // Daraja returns an error body (e.g. "transaction is being processed") while pending.
      return{status:'pending',raw:e.response?.data||{error:e.message}};
    }
  },
  // Maps an STK callback into the normalized shape. M-Pesa identifies the txn by CheckoutRequestID.
  parseWebhook(req) {
    const cb = req.body && req.body.Body && req.body.Body.stkCallback;
    if (!cb) return null;
    const ok = cb.ResultCode === 0;
    const meta = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
    const receipt = (meta.find(i => i.Name === 'MpesaReceiptNumber') || {}).Value || null;
    return { providerRef: cb.CheckoutRequestID, reference: null, status: ok ? 'completed' : 'failed', receipt, raw: cb };
  },
};
