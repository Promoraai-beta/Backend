/**
 * check-db.js — diagnose pgweb status for a session
 *
 * Usage:
 *   node scripts/check-db.js SESSION_CODE
 *
 * Prints:
 *   - Whether pgweb process is running inside the container
 *   - Contents of /tmp/pgweb.log (crash output)
 *   - Local ping to localhost:5050 from within the container
 */
require('dotenv').config();

const SESSION_CODE = process.argv[2];
if (!SESSION_CODE) {
  console.error('Usage: node scripts/check-db.js SESSION_CODE');
  process.exit(1);
}

const API_BASE = `http://localhost:${process.env.PORT || 5001}`;

async function run() {
  // 1. Find session
  const sessRes = await fetch(`${API_BASE}/api/sessions/code/${SESSION_CODE}`);
  if (!sessRes.ok) {
    // Try via session ID directly
    console.error(`Could not find session ${SESSION_CODE}`);
    process.exit(1);
  }
  const sess = await sessRes.json();
  const sessionId = sess?.data?.id || sess?.id;
  if (!sessionId) { console.error('No session id'); process.exit(1); }

  console.log(`\n=== DB Diagnostics for ${SESSION_CODE} (${sessionId}) ===\n`);

  // 2. Hit diagnostics endpoint
  const diagRes = await fetch(`${API_BASE}/api/sessions/${sessionId}/db/diagnostics`);
  const diag = await diagRes.json();

  console.log('pgweb process (ps aux):\n', diag.pgwebProcess || '(empty — not running!)');
  console.log('\npgweb local ping (curl localhost:5050):', diag.pgwebLocalPing);
  console.log('\n/tmp/pgweb.log:\n', diag.pgwebLog);
}

run().catch(e => { console.error(e.message); process.exit(1); });
