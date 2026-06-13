// Loads schema.sql into the dev database and seeds test users (admin,
// laundromat staff, client) with real bcrypt password hashes so all three
// apps can authenticate against the local backend.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const CONN = process.env.SEED_DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/postgres';

// Test accounts (also referenced by the admin app's PIN auto-login).
const USERS = [
  { name: 'Smart-Safi Admin', email: 'admin@smartsafi.co.ke', phone: '+254700000001', password: 'Admin1234', role: 'superadmin' },
  { name: 'Quicklean Staff',  email: 'staff@quicklean.co.ke', phone: '+254710141772', password: 'Staff1234', role: 'laundromat' },
  { name: 'Test Client',      email: 'client@smartsafi.co.ke', phone: '+254700000003', password: 'Client1234', role: 'client' },
];

async function main() {
  const client = new Client({ connectionString: CONN });
  await client.connect();

  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  console.log('[seed] applying schema.sql...');
  await client.query(schema);

  console.log('[seed] creating test users...');
  for (const u of USERS) {
    const hash = await bcrypt.hash(u.password, 12);
    await client.query(
      `INSERT INTO users(name,email,phone,password_hash,role,is_active)
       VALUES($1,$2,$3,$4,$5,true)
       ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role=EXCLUDED.role, is_active=true`,
      [u.name, u.email, u.phone, hash, u.role]
    );
  }

  // Link the laundromat staff user to the seeded Quicklean laundromat (as owner).
  await client.query(`
    INSERT INTO laundromat_users(laundromat_id, user_id, staff_role, is_active)
    SELECT l.id, u.id, 'owner', true
    FROM laundromats l, users u
    WHERE l.email='ops@quicklean.co.ke' AND u.email='staff@quicklean.co.ke'
    ON CONFLICT (laundromat_id, user_id) DO NOTHING
  `);

  // Make the seeded Quicklean laundromat chargeable so analytics/fees behave realistically.
  await client.query(`UPDATE laundromats SET commission_rate=15.00, admin_fee_rate=5.00 WHERE email='ops@quicklean.co.ke' AND commission_rate=0`);

  const counts = await client.query('SELECT role, COUNT(*)::int AS n FROM users GROUP BY role ORDER BY role');
  console.log('[seed] users by role:', counts.rows.map(r => `${r.role}=${r.n}`).join(', '));
  console.log('[seed] done. Login credentials:');
  USERS.forEach(u => console.log(`         ${u.role.padEnd(11)} ${u.email} / ${u.password}`));

  await client.end();
}

main().catch((e) => { console.error('[seed] failed:', e.message); process.exit(1); });
