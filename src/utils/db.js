const { Pool } = require('pg');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');

const url = process.env.DATABASE_URL;

// SSL policy:
//  - Local databases (dev/testing) on localhost/127.0.0.1 → no SSL.
//  - Railway INTERNAL networking (*.railway.internal) → private network, no SSL needed.
//  - Everything else (Railway public proxy *.proxy.rlwy.net / *.up.railway.app, Supabase,
//    other managed providers) → require SSL.
// Railway's Postgres proxy presents a cert that does not chain to a public CA, so we cannot
// fully verify it. We pin TLS on (encrypt in transit) but allow self-signed via
// rejectUnauthorized:false — documented and intentional. Override with DB_SSL=disable/require.
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const isRailwayInternal = /\.railway\.internal[:/]/.test(url);

let ssl;
const sslMode = (process.env.DB_SSL || '').toLowerCase();
if (sslMode === 'disable' || sslMode === 'false') ssl = false;
else if (sslMode === 'require' || sslMode === 'true') ssl = { rejectUnauthorized: false };
else if (isLocal || isRailwayInternal) ssl = false;
else ssl = { rejectUnauthorized: false }; // public managed proxy: encrypt, allow self-signed

const pool = new Pool({
  connectionString: url,
  ssl,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
  query_timeout: 30000,
});

// An unhandled 'error' event on an idle client (e.g. the DB drops the connection,
// or Railway recycles the instance) would otherwise crash the process. Log and let
// pg evict the bad client; new queries get a fresh connection from the pool.
pool.on('error', err => console.error('DB pool error (idle client):', err.message));

async function connectDB() {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    console.log('PostgreSQL connected');
  } finally {
    client.release();
  }
}

// Lightweight connectivity probe for the /health endpoint. Returns true/false,
// never throws, so the health route can degrade gracefully.
async function ping() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    console.error('DB ping failed:', err.message);
    return false;
  }
}

async function query(text, params = []) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error('DB error:', err.message.substring(0, 200));
    throw new Error('Database operation failed');
  }
}

async function getClient() { return pool.connect(); }

module.exports = { connectDB, query, getClient, ping, pool };
