/**
 * google-auth.ts
 * Dual-mode Google authentication:
 *
 * LOCAL DEV  → Service account JSON key (GOOGLE_SERVICE_ACCOUNT_JSON in .env)
 * AZURE PROD → Workload Identity Federation via Azure managed identity
 *              (no secrets stored — Azure token exchanged for Google token)
 *
 * Required env vars:
 *   Always:
 *     GOOGLE_SERVICE_ACCOUNT_EMAIL   e.g. promora-assessments@promoraai.iam.gserviceaccount.com
 *
 *   Local dev only:
 *     GOOGLE_SERVICE_ACCOUNT_JSON    full service account JSON (single line)
 *
 *   Azure prod only (set these in azure-provisioner env vars):
 *     GOOGLE_WORKLOAD_IDENTITY_AUDIENCE
 *       = //iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/
 *         workloadIdentityPools/POOL_ID/providers/PROVIDER_ID
 *     (IDENTITY_ENDPOINT and IDENTITY_HEADER are set automatically by Azure)
 */

import * as crypto from 'crypto';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function post(url: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${url} failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return res.json();
}

async function postJson(url: string, body: object, authToken: string): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${url} failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return res.json();
}

// ─── Path A: Service Account JWT (local dev) ──────────────────────────────────

async function getTokenViaServiceAccountKey(
  serviceAccount: ServiceAccount,
  scopes: string[],
): Promise<string> {
  const tokenUri = serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: scopes.join(' '),
    aud: tokenUri,
    exp: now + 3600,
    iat: now,
  }));

  const signingInput = `${header}.${claims}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  sign.end();
  const jwt = `${signingInput}.${base64url(sign.sign(serviceAccount.private_key))}`;

  const data = await post(tokenUri, {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  if (!data.access_token) throw new Error('Service account token exchange returned no access_token');
  return data.access_token;
}

// ─── Path B: Azure Managed Identity → Google WIF (Azure prod) ─────────────────

async function getAzureManagedIdentityToken(): Promise<string> {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header   = process.env.IDENTITY_HEADER;

  if (!endpoint || !header) {
    throw new Error(
      'Azure managed identity env vars (IDENTITY_ENDPOINT, IDENTITY_HEADER) not found. ' +
      'Make sure the container has a system-assigned managed identity enabled.',
    );
  }

  // Audience must match what you configured in the WIF provider
  const audience = process.env.GOOGLE_WORKLOAD_IDENTITY_AUDIENCE_AZURE_AD
    || 'api://AzureADTokenV2';

  const url = `${endpoint}?resource=${encodeURIComponent(audience)}&api-version=2019-08-01`;
  const res = await fetch(url, { headers: { 'X-IDENTITY-HEADER': header } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Azure IMDS token fetch failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

async function exchangeAzureTokenForGoogle(azureToken: string): Promise<string> {
  const audience = process.env.GOOGLE_WORKLOAD_IDENTITY_AUDIENCE;
  if (!audience) {
    throw new Error(
      'GOOGLE_WORKLOAD_IDENTITY_AUDIENCE is not set. ' +
      'Format: //iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/' +
      'workloadIdentityPools/POOL_ID/providers/PROVIDER_ID',
    );
  }

  // Step 1: Exchange Azure JWT for a Google federated token via STS
  const stsData = await post('https://sts.googleapis.com/v1/token', {
    audience,
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    subject_token: azureToken,
  });

  const federatedToken: string = stsData.access_token;

  // Step 2: Use federated token to impersonate the service account and get scoped token
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (!serviceAccountEmail) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL is not set.');
  }

  // We return the federated token here — it already has cloud-platform scope.
  // The caller can use generateAccessToken if narrower scopes are needed.
  return federatedToken;
}

async function getTokenViaAzureWIF(scopes: string[]): Promise<string> {
  const azureToken = await getAzureManagedIdentityToken();
  const federatedToken = await exchangeAzureTokenForGoogle(azureToken);

  // Generate a scoped access token via service account impersonation
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (!serviceAccountEmail) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL is not set.');

  const tokenData = await postJson(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`,
    { scope: scopes, lifetime: '3600s' },
    federatedToken,
  );

  if (!tokenData.accessToken) {
    throw new Error('generateAccessToken returned no accessToken');
  }
  return tokenData.accessToken;
}

// ─── Path C: OAuth Refresh Token (real user account, has Drive storage) ──────

/**
 * Exchange a refresh token for a short-lived access token.
 * Use this for Google Drive / Docs / Sheets provisioning — service accounts
 * have zero Drive storage quota and cannot own files.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 */
export async function getOAuthAccessToken(): Promise<string> {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'OAuth credentials not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ' +
      'and GOOGLE_REFRESH_TOKEN in backend/.env\n' +
      '  Generate a refresh token by running: node scripts/get-google-refresh-token.js',
    );
  }

  const data = await post('https://oauth2.googleapis.com/token', {
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  });

  if (!data.access_token) {
    throw new Error('OAuth token refresh failed: ' + JSON.stringify(data));
  }
  return data.access_token;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Lock a Google Drive file to read-only for "anyone with link".
 * Called when a session ends — candidate can no longer edit, recruiter views only.
 */
export async function lockGoogleFile(fileId: string): Promise<void> {
  const scopes = [
    'https://www.googleapis.com/auth/drive',
  ];

  let token: string;
  try {
    token = await createGoogleAccessToken(null, scopes);
  } catch {
    console.warn(`[google-auth] Could not get token to lock file ${fileId} — skipping`);
    return;
  }

  // Find the existing "anyone" permission ID first
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=permissions(id,type,role)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!listRes.ok) {
    console.warn(`[google-auth] Could not list permissions for ${fileId}`);
    return;
  }

  const { permissions = [] } = await listRes.json() as { permissions: Array<{ id: string; type: string; role: string }> };
  const anyonePerm = permissions.find(p => p.type === 'anyone');

  if (!anyonePerm) return; // No public permission — nothing to lock

  if (anyonePerm.role === 'reader') return; // Already read-only

  // Downgrade from writer → reader
  const patchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${anyonePerm.id}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader' }),
    },
  );

  if (patchRes.ok) {
    console.log(`[google-auth] Locked file ${fileId} to read-only`);
  } else {
    console.warn(`[google-auth] Failed to lock file ${fileId}: ${patchRes.status}`);
  }
}

/**
 * Returns a short-lived Bearer token for Google APIs.
 *
 * Auto-detects environment:
 *   - Azure (IDENTITY_ENDPOINT set) → Workload Identity Federation, no stored secrets
 *   - Local dev (GOOGLE_SERVICE_ACCOUNT_JSON set) → Service account JWT
 */
export async function createGoogleAccessToken(
  serviceAccountOrNull: ServiceAccount | null,
  scopes: string[],
): Promise<string> {
  // Azure prod: IDENTITY_ENDPOINT is injected automatically by Azure into every
  // container that has a managed identity enabled.
  if (process.env.IDENTITY_ENDPOINT) {
    console.log('[google-auth] Using Azure Workload Identity Federation');
    return getTokenViaAzureWIF(scopes);
  }

  // Local dev: fall back to service account JSON key
  const jsonEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sa: ServiceAccount | null = serviceAccountOrNull
    ?? (jsonEnv ? JSON.parse(jsonEnv) : null);

  if (!sa?.private_key || !sa?.client_email) {
    throw new Error(
      'No Google credentials found.\n' +
      '  Local dev: set GOOGLE_SERVICE_ACCOUNT_JSON in backend/.env\n' +
      '  Azure prod: enable system-assigned managed identity on the container and set\n' +
      '    GOOGLE_WORKLOAD_IDENTITY_AUDIENCE and GOOGLE_SERVICE_ACCOUNT_EMAIL',
    );
  }

  console.log('[google-auth] Using service account JSON key (local dev)');
  return getTokenViaServiceAccountKey(sa, scopes);
}
