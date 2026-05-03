/**
 * One-time: get a Google OAuth refresh token so the backend can copy sheets into YOUR Drive (your 2TB).
 * 1. Create OAuth credentials: Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID (Desktop).
 * 2. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.
 * 3. Run from backend: node scripts/get-google-refresh-token.js
 * 4. Open the printed URL in the browser, sign in with the SAME account that OWNS or has Editor access to the template sheet.
 * 5. After authorizing, set GOOGLE_AUTH_CODE=... and re-run, or run the command shown on the redirect page.
 * 6. Add GOOGLE_REFRESH_TOKEN to .env. Backend will then use this account for Drive copies.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const http = require("http");
const { URL } = require("url");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const AUTH_CODE = process.env.GOOGLE_AUTH_CODE;

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/userinfo.email"
].join(" ");

const REDIRECT_URI = "http://localhost:3333/oauth2callback";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env");
  process.exit(1);
}

if (AUTH_CODE) {
  (async () => {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: AUTH_CODE,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code"
      }).toString()
    });
    const data = await res.json();
    if (data.error) {
      console.error("Token exchange failed:", data);
      process.exit(1);
    }
    console.log("\nAdd to .env:\nGOOGLE_REFRESH_TOKEN=" + data.refresh_token + "\n");
    if (data.access_token) {
      const meRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: "Bearer " + data.access_token }
      });
      const me = await meRes.json();
      console.log("Authenticated as:", me.email);
    }
  })();
  return;
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent"
  }).toString();

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "", "http://localhost:3333");
  const code = u.searchParams.get("code");
  if (code) {
    res.end(
      `<p>Code received. Run:</p><pre>GOOGLE_AUTH_CODE=${code} node scripts/get-google-refresh-token.js</pre><p>Or set GOOGLE_AUTH_CODE in .env and run the script again.</p>`
    );
    server.close();
  } else {
    res.end("<p>No code in URL. Use the link printed in the terminal.</p>");
  }
});

server.listen(3333, () => {
  console.log("Open this URL in the browser (use the account that OWNS the template sheet):\n");
  console.log(authUrl);
  console.log("\nAfter authorizing you will be redirected to localhost:3333 with ?code=... — paste that code into GOOGLE_AUTH_CODE and re-run.");
});
