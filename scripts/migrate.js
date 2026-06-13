// Applies schema.sql to the database pointed to by DATABASE_URL.
//
// schema.sql is written to be idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX
// IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING, CREATE OR REPLACE FUNCTION), so
// running this on every deploy is safe and converges the live schema to the file.
//
// Run on Railway as a release/predeploy step:  node scripts/migrate.js
// SSL handling mirrors src/utils/db.js so it works against Railway's public proxy too.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) { console.error('[migrate] DATABASE_URL required'); process.exit(1); }

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const isRailwayInternal = /\.railway\.internal[:/]/.test(url);
const sslMode = (process.env.DB_SSL || '').toLowerCase();
let ssl;
if (sslMode === 'disable' || sslMode === 'false') ssl = false;
else if (sslMode === 'require' || sslMode === 'true') ssl = { rejectUnauthorized: false };
else if (isLocal || isRailwayInternal) ssl = false;
else ssl = { rejectUnauthorized: false };

async function main() {
  const client = new Client({ connectionString: url, ssl, statement_timeout: 120000 });
  await client.connect();
  try {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    console.log('[migrate] applying schema.sql...');
    // Wrap in a transaction so a mid-file failure leaves no partial state.
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('COMMIT');
    console.log('[migrate] schema applied successfully.');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error('[migrate] failed:', e.message); process.exit(1); });
