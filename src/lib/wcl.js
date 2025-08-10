import fetch from 'node-fetch';

const WCL_BASE = 'https://classic.warcraftlogs.com';
const TOKEN_URL = `${WCL_BASE}/oauth/token`;
const GRAPHQL_URL = `${WCL_BASE}/api/v2/client`;

let cached = { token: null, exp: 0 };

async function getToken() {
  const now = Date.now();
  if (cached.token && now < cached.exp - 60_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.WCL_CLIENT_ID || '',
    client_secret: process.env.WCL_CLIENT_SECRET || ''
  });

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error(`WCL token failed: ${r.status} ${await r.text()}`);
  const json = await r.json();
  cached = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

export async function wclQuery(query, variables) {
  const token = await getToken();
  const r = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const json = await r.json();
  if (json.errors) throw new Error(`WCL error: ${JSON.stringify(json.errors)}`);
  return json.data;
}
