const jwt = require('jsonwebtoken');
const { query } = require('../utils/db');

async function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ success:false, message:'Authentication required' });
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    const r = await query('SELECT id,role,token_version,is_active,locked_until FROM users WHERE id=$1', [decoded.id]);
    if (!r.rows.length) return res.status(401).json({ success:false, message:'Account not found' });
    const u = r.rows[0];
    if (!u.is_active) return res.status(403).json({ success:false, message:'Account suspended' });
    if (u.locked_until && new Date(u.locked_until) > new Date()) return res.status(403).json({ success:false, message:'Account temporarily locked' });
    if (u.token_version !== decoded.tokenVersion) return res.status(401).json({ success:false, message:'Session expired. Please log in again.' });
    req.user = { ...decoded, role: u.role };
    next();
  } catch { return res.status(401).json({ success:false, message:'Invalid or expired token' }); }
}

function requireRole(...roles) {
  return (req,res,next) => {
    if (!req.user) return res.status(401).json({ success:false, message:'Not authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ success:false, message:'Insufficient permissions' });
    next();
  };
}

async function ownLaundromat(req,res,next) {
  if (['admin','superadmin'].includes(req.user.role)) return next();
  const lmId = req.params.laundromat_id || req.params.id;
  if (!lmId) return res.status(400).json({ success:false, message:'Laundromat ID required' });
  try {
    const r = await query('SELECT 1 FROM laundromat_users WHERE laundromat_id=$1 AND user_id=$2 AND is_active=true', [lmId, req.user.id]);
    if (!r.rows.length) return res.status(403).json({ success:false, message:'Access denied' });
    req.user.laundromat_id = lmId; next();
  } catch { res.status(500).json({ success:false, message:'Authorisation check failed' }); }
}

async function ownOrder(req,res,next) {
  if (['admin','superadmin'].includes(req.user.role)) return next();
  const orderId = req.params.id || req.params.order_id;
  try {
    const r = await query('SELECT user_id, laundromat_id, status FROM orders WHERE id=$1', [orderId]);
    if (!r.rows.length) return res.status(404).json({ success:false, message:'Order not found' });
    const o = r.rows[0];
    if (req.user.role==='client' && o.user_id !== req.user.id) return res.status(403).json({ success:false, message:'Access denied' });
    if (req.user.role==='laundromat' && o.laundromat_id !== req.user.laundromat_id) return res.status(403).json({ success:false, message:'Access denied' });
    req.order = o; next();
  } catch { res.status(500).json({ success:false, message:'Authorisation check failed' }); }
}

async function auditLog(actorId,actorRole,action,resource,resourceId,req,details={}) {
  try {
    const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0];
    await query(
      'INSERT INTO audit_log (actor_id,actor_role,action,resource,resource_id,ip_address,user_agent,details) VALUES ($1,$2,$3,$4,$5,$6::inet,$7,$8)',
      [actorId,actorRole,action,resource,resourceId,ip,req.headers['user-agent']?.substring(0,200),JSON.stringify(details)]
    );
  } catch(e) { console.error('Audit log failed:', e.message); }
}

const isClient    = requireRole('client');
const isLaundromat= requireRole('laundromat');
const isAdmin     = requireRole('admin','superadmin');
const isStaff     = requireRole('laundromat','admin','superadmin');
module.exports = { authenticate, requireRole, ownLaundromat, ownOrder, auditLog, isClient, isLaundromat, isAdmin, isStaff };
