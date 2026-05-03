/**
 * cleanup-drive.js
 * Lists and deletes ALL files owned by the service account in Google Drive.
 * Run from: backend/ directory
 *   node scripts/cleanup-drive.js
 *   node scripts/cleanup-drive.js --dry-run   (list only, no delete)
 */
require('dotenv').config();
const crypto = require('crypto');

const DRY_RUN = process.argv.includes('--dry-run');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getToken(sa, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = base64url(Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: scopes.join(' '),
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })));
  const sigInput = `${header}.${claims}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  sign.end();
  const jwt = `${sigInput}.${base64url(sign.sign(sa.private_key))}`;

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function listAllFiles(token) {
  let files = [];
  let pageToken = null;
  do {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,createdTime)');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.error) throw new Error('List failed: ' + JSON.stringify(data.error));
    files = files.concat(data.files || []);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

async function deleteFile(token, fileId, name) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 204) {
    console.log(`  ✓ Deleted: ${name} (${fileId})`);
  } else {
    const text = await res.text();
    console.warn(`  ✗ Failed to delete ${name}: ${res.status} ${text.slice(0, 100)}`);
  }
}

async function main() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  console.log(`\nService account: ${sa.client_email}`);
  console.log(DRY_RUN ? '[DRY RUN — no files will be deleted]\n' : '[LIVE — files WILL be deleted]\n');

  const token = await getToken(sa, ['https://www.googleapis.com/auth/drive']);

  console.log('Listing files...');
  const files = await listAllFiles(token);
  console.log(`Found ${files.length} file(s).\n`);

  if (files.length === 0) {
    console.log('Nothing to delete. Drive is clean.');
    return;
  }

  // Print summary table
  let totalBytes = 0;
  for (const f of files) {
    const bytes = parseInt(f.size || '0', 10);
    totalBytes += bytes;
    const sizeStr = bytes ? `${(bytes / 1024).toFixed(1)} KB` : '(Google file)';
    console.log(`  ${f.mimeType.padEnd(45)} ${f.createdTime.slice(0, 10)}  ${sizeStr.padStart(12)}  ${f.name}`);
  }
  const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
  console.log(`\nTotal stored: ${totalMB} MB (Google Workspace files don't count toward quota)\n`);

  if (DRY_RUN) {
    console.log('Re-run without --dry-run to delete all files.');
    return;
  }

  console.log('Deleting all files...');
  for (const f of files) {
    await deleteFile(token, f.id, f.name);
  }

  // Empty trash to actually free quota
  console.log('\nEmptying trash...');
  const trashRes = await fetch('https://www.googleapis.com/drive/v3/files/trash', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(trashRes.status === 204 ? '✓ Trash emptied' : `Trash: ${trashRes.status}`);
  console.log('\nDone! Try provisioning a new Doc/Sheet now.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
