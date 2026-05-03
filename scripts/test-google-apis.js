/**
 * test-google-apis.js
 * Quick smoke-test for Google Sheets + Docs provisioning via service account.
 * Run from backend/ directory AFTER running cleanup-drive.js to free quota.
 *
 *   node scripts/test-google-apis.js
 */
require('dotenv').config();
const crypto = require('crypto');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getToken(sa, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = base64url(Buffer.from(JSON.stringify({
    iss: sa.client_email, scope: scopes.join(' '),
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  })));
  const sigInput = `${header}.${claims}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigInput); sign.end();
  const jwt = `${sigInput}.${base64url(sign.sign(sa.private_key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function deleteFile(token, fileId) {
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
}

const PARENT_FOLDER_ID = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;

async function testSheets(token) {
  process.stdout.write('  Creating Google Sheet via Sheets API... ');
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ properties: { title: '[TEST] Promora Sheet — delete me' } }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.log(`FAIL ✗\n    ${res.status}: ${JSON.stringify(data?.error?.message || data)}`);
    return false;
  }
  const sheetId = data.spreadsheetId;
  console.log(`OK ✓  → https://docs.google.com/spreadsheets/d/${sheetId}/edit`);

  // Move into parent folder if set
  if (PARENT_FOLDER_ID) {
    process.stdout.write('  Moving sheet into parent folder...     ');
    const mv = await fetch(`https://www.googleapis.com/drive/v3/files/${sheetId}?addParents=${PARENT_FOLDER_ID}&removeParents=root&fields=id`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    });
    console.log(mv.ok ? 'OK ✓' : `FAIL ✗ (${mv.status})`);
  }

  await deleteFile(token, sheetId);
  process.stdout.write('  Cleanup (delete test sheet)... done\n');
  return true;
}

async function testDocs(token) {
  process.stdout.write('  Creating Google Doc via Drive API...   ');
  const docBody = { name: '[TEST] Promora Doc — delete me', mimeType: 'application/vnd.google-apps.document' };
  if (PARENT_FOLDER_ID) docBody.parents = [PARENT_FOLDER_ID];
  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(docBody),
  });
  const data = await res.json();
  if (!res.ok) {
    console.log(`FAIL ✗\n    ${res.status}: ${JSON.stringify(data?.error?.message || data)}`);
    return false;
  }
  console.log(`OK ✓  → https://docs.google.com/document/d/${data.id}/edit`);

  // Also test setting "anyone can edit" permission
  process.stdout.write('  Setting anyone-can-edit permission...  ');
  const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ role: 'writer', type: 'anyone' }),
  });
  if (!permRes.ok) {
    const t = await permRes.text();
    console.log(`FAIL ✗  ${permRes.status}: ${t.slice(0, 100)}`);
  } else {
    console.log('OK ✓');
  }

  await deleteFile(token, data.id);
  process.stdout.write('  Cleanup (delete test doc)... done\n');
  return true;
}

async function testQuota(token) {
  process.stdout.write('  Checking Drive storage quota...        ');
  const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) { console.log('FAIL ✗'); return; }
  const q = data.storageQuota;
  const usedMB  = q.usage       ? (parseInt(q.usage)       / 1024 / 1024).toFixed(1) : '?';
  const limitMB = q.limit       ? (parseInt(q.limit)       / 1024 / 1024).toFixed(1) : 'unlimited';
  const driveMB = q.usageInDrive ? (parseInt(q.usageInDrive) / 1024 / 1024).toFixed(1) : '?';
  console.log(`used=${usedMB}MB / limit=${limitMB}MB  (Drive files: ${driveMB}MB)`);
}

async function getOAuthToken() {
  const { client_id, client_secret, refresh_token } = {
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  };
  if (!client_id || !client_secret || !refresh_token) throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN in .env');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth refresh failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function main() {
  console.log(`\n=== Google API Test ===`);

  // Try OAuth token first (real user account, has Drive storage)
  let token;
  try {
    token = await getOAuthToken();
    console.log('OAuth token (refresh_token): OK ✓');
  } catch (e) {
    console.log('OAuth token: SKIP —', e.message);
    // Fall back to service account
    const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    console.log(`Falling back to service account: ${sa.client_email}`);
    token = await getToken(sa, ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/drive']);
    console.log('Service account token: OK ✓');
  }
  console.log('');

  await testQuota(token);
  console.log('');

  const sheetOk = await testSheets(token);
  console.log('');
  const docOk   = await testDocs(token);

  console.log(`\n=== Summary ===`);
  console.log(`  Sheets: ${sheetOk ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`  Docs:   ${docOk   ? 'PASS ✓' : 'FAIL ✗'}`);
  if (!sheetOk || !docOk) {
    console.log(`\n  If quota exceeded: run  node scripts/cleanup-drive.js  first.`);
    console.log(`  If PERMISSION_DENIED on token: check that the service account key in .env is valid.`);
  }
  console.log('');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
