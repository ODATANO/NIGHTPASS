#!/usr/bin/env node
// Refresh the BatteryPass-Ready Keycloak session and print a fresh access token.
// Reads and rewrites secrets/batterypass-ready-token.json (gitignored).
// Usage: node scripts/bp-ready-token.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TOKEN_FILE = resolve(import.meta.dirname, '../secrets/batterypass-ready-token.json');
const TOKEN_URL = 'https://batterypass-ready.gefeg.com/auth/realms/batterypass/protocol/openid-connect/token';

const stored = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));

const res = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: 'batterypass-ui',
    refresh_token: stored.refresh_token,
  }),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`refresh failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  console.error('Refresh token likely expired (30 min lifetime). Grab a new token JSON from the browser (DevTools > Network > token > Antwort) into secrets/batterypass-ready-token.json.');
  process.exit(1);
}

const fresh = await res.json();
writeFileSync(TOKEN_FILE, JSON.stringify(fresh, null, 2));
process.stdout.write(fresh.access_token);
