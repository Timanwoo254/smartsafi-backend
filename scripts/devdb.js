// Local userspace PostgreSQL for development/testing.
// Runs a real Postgres cluster (via embedded-postgres) without needing root,
// Docker, or a system Postgres install. Keeps running until the process is stopped.
const path = require('path');
const fs = require('fs');
const net = require('net');
const EmbeddedPostgres = require('embedded-postgres').default;

const DATA_DIR = path.join(__dirname, '..', '.devdb');
const PORT = Number(process.env.DEVDB_PORT || 5432);

// Check whether something is already listening on the port (i.e. a cluster is
// already running). Resolves true if the port is in use.
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1500, () => { sock.destroy(); resolve(false); });
  });
}

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  authMethod: 'password',
  persistent: true,
  onLog: () => {},      // keep output quiet; errors still surface below
  onError: (e) => console.error('[devdb]', e?.stack || e?.message || e),
});

async function main() {
  // If a cluster is already serving this port, reuse it instead of crashing.
  if (await portInUse(PORT)) {
    console.log(`[devdb] PostgreSQL is already running on localhost:${PORT} — reusing it.`);
    console.log('[devdb] Nothing to do. Run `npm run seed` then `npm start` if you haven\'t.');
    return; // exit 0
  }

  const alreadyInit = fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'));
  if (!alreadyInit) {
    console.log('[devdb] initialising new cluster at', DATA_DIR);
    await pg.initialise();
  } else {
    // A leftover pid file from an unclean shutdown stops Postgres from starting.
    // Safe to remove here because we already confirmed nothing is on the port.
    const pidFile = path.join(DATA_DIR, 'postmaster.pid');
    if (fs.existsSync(pidFile)) { try { fs.unlinkSync(pidFile); console.log('[devdb] removed stale postmaster.pid'); } catch {} }
  }

  await pg.start();
  console.log(`[devdb] PostgreSQL ready on localhost:${PORT} (user=postgres db=postgres)`);

  const shutdown = async () => {
    console.log('\n[devdb] stopping...');
    try { await pg.stop(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Keep the event loop alive so the cluster stays up.
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  console.error('[devdb] failed:', e?.stack || e?.message || (e && JSON.stringify(e)) || 'unknown error (the port may be in use or the data dir locked)');
  process.exit(1);
});
