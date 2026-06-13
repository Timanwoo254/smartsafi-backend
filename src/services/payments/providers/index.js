// Payment provider registry. PAYMENT_PROVIDER selects the default engine for new
// payments; webhooks resolve the provider by name from the URL. M-Pesa stays available
// as a fallback so nothing breaks before MulaFlow credentials are configured.
const mpesa = require('./mpesa.provider');
const mulaflow = require('./mulaflow.provider');
const PROVIDERS = { mpesa, mulaflow };
function getProvider(name) {
  const key = String(name || process.env.PAYMENT_PROVIDER || 'mpesa').toLowerCase();
  return PROVIDERS[key] || mpesa;
}
module.exports = { getProvider, PROVIDERS };
