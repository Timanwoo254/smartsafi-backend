// MulaFlow payment provider (https://mulaflow.com) — the official payment engine.
//
// MulaFlow does not publish a public API spec, so the request/response/webhook shapes
// below are sensible assumptions. Each unknown is marked TODO(mulaflow); once the real
// API docs/sandbox keys are available, only this file + .env should need changes.
const axios = require('axios');
const crypto = require('crypto');
const apiBase = () => (process.env.MULAFLOW_BASE_URL || 'https://api.mulaflow.com').replace(/\/$/, '');
module.exports = {
  name: 'mulaflow',
  // Initiate a collection (M-Pesa/card/bank are selected by MulaFlow based on the payer).
  async initiate({ amount, phone, reference, description, callbackUrl }) {
    // TODO(mulaflow): confirm endpoint path, field names and auth scheme against the dashboard docs.
    const resp = await axios.post(`${apiBase()}/v1/payments`, {
      amount: Math.ceil(amount), currency: 'KES', phone, reference,
      description: description || reference, callback_url: callbackUrl || process.env.MULAFLOW_CALLBACK_URL,
    }, { headers: { Authorization: `Bearer ${process.env.MULAFLOW_API_KEY}`, 'Content-Type': 'application/json' } });
    const d = resp.data || {};
    // TODO(mulaflow): confirm which field carries the provider transaction id.
    return { providerRef: d.id || d.transaction_id || d.reference || reference, raw: d, userMessage: 'Complete the payment prompt on your phone' };
  },
  // HMAC-SHA256 over the raw body using the shared webhook secret. Skipped in dev when unset.
  verifySignature(req) {
    const secret = process.env.MULAFLOW_WEBHOOK_SECRET;
    if (!secret) return true; // dev convenience — set the secret in production
    const sig = req.headers['x-mulaflow-signature'] || '';
    const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body || {})).digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
  },
  // Normalize a webhook into { reference, providerRef, status, receipt, raw } (or { invalid:true }).
  parseWebhook(req) {
    if (!this.verifySignature(req)) return { invalid: true };
    const b = req.body || {};
    // TODO(mulaflow): confirm webhook payload field names and status vocabulary.
    const status = String(b.status || b.state || '').toLowerCase();
    const norm = ['success', 'completed', 'paid', 'successful'].includes(status) ? 'completed'
      : (['failed', 'cancelled', 'canceled', 'declined', 'error'].includes(status) ? 'failed' : 'pending');
    return {
      providerRef: b.id || b.transaction_id || b.payment_id || null,
      reference: b.reference || b.account_reference || b.merchant_reference || null,
      status: norm, receipt: b.receipt || b.mpesa_receipt || b.transaction_id || null, raw: b,
    };
  },
};
