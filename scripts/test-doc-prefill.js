/**
 * test-doc-prefill.js
 * Creates a Google Doc via Drive API, then pre-fills it via Docs API batchUpdate.
 * Mirrors exactly what provision-docs does — run this to debug without touching sessions.
 *
 *   node scripts/test-doc-prefill.js
 */
require('dotenv').config();

async function getOAuthToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));
  console.log('✓ OAuth token obtained');
  console.log('  Scopes granted:', data.scope || '(not returned in refresh response)');
  return data.access_token;
}

async function run() {
  console.log('\n=== Doc Pre-fill Test ===\n');

  const token = await getOAuthToken();
  const parentFolderId = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;

  // Step 1: Create doc via Drive API
  console.log('\n1. Creating Google Doc via Drive API...');
  const docBody = {
    name: '[TEST] Pre-fill test — delete me',
    mimeType: 'application/vnd.google-apps.document',
  };
  if (parentFolderId) docBody.parents = [parentFolderId];

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(docBody),
  });
  const createData = await createRes.json();
  if (!createRes.ok) {
    console.log('  FAIL ✗', createRes.status, JSON.stringify(createData?.error?.message));
    return;
  }
  const docId = createData.id;
  console.log('  OK ✓ docId:', docId);
  console.log('  URL: https://docs.google.com/document/d/' + docId + '/edit');

  // Step 2: Set anyone-can-edit permission
  console.log('\n2. Setting anyone-can-edit permission...');
  const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${docId}/permissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ role: 'writer', type: 'anyone' }),
  });
  console.log(permRes.ok ? '  OK ✓' : `  FAIL ✗ (${permRes.status})`);

  // Step 3: Pre-fill via Docs API batchUpdate
  console.log('\n3. Pre-filling content via Docs API batchUpdate...');
  const prefillRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      requests: [{
        insertText: {
          location: { index: 1 },
          text: 'Task: Fix Code Issues\n\nThe AIShoppingRecommendationPanel component has a stale closure bug.\n\n---\n\nYour answer:\n\n',
        }
      }]
    }),
  });
  const prefillText = await prefillRes.text();
  if (prefillRes.ok) {
    console.log('  OK ✓ Content pre-filled successfully!');
  } else {
    console.log('  FAIL ✗', prefillRes.status);
    console.log('  Error:', prefillText.slice(0, 500));
  }

  // Cleanup
  console.log('\n4. Deleting test doc...');
  await fetch(`https://www.googleapis.com/drive/v3/files/${docId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  console.log('  Done\n');
  console.log('=== Result:', prefillRes.ok ? 'PASS ✓' : 'FAIL ✗', '===\n');
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
