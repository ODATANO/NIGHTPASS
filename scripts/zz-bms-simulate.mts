// Drive the BMS telemetry webhook end-to-end against a running instance:
// generates deterministic telemetry frames (srv/lib/bms-simulator.ts) and
// POSTs them HMAC-signed to /api/v1/passport/telemetry, resuming the aging
// tick from the passport's attribute history.
//
// Run: node --import tsx scripts/zz-bms-simulate.mts
// Env: NIGHTPASS_BASE (default http://localhost:4004)
//      TELEMETRY_WEBHOOK_SECRET (required, must match the server)
//      PASSPORT_ID (required)
//      TICKS (default 3)
//      PRODUCER_AUTH (default producer:producer, for the OData reads)
import crypto from 'node:crypto';
import { generateTelemetry } from '../srv/lib/bms-simulator';

const BASE = process.env.NIGHTPASS_BASE ?? 'http://localhost:4004';
const SECRET = process.env.TELEMETRY_WEBHOOK_SECRET ?? '';
const PASSPORT_ID = process.env.PASSPORT_ID ?? '';
const TICKS = Math.max(1, Number(process.env.TICKS ?? 3) || 3);
const AUTH = 'Basic ' + Buffer.from(process.env.PRODUCER_AUTH ?? 'producer:producer').toString('base64');

if (!SECRET || !PASSPORT_ID) {
    console.error('TELEMETRY_WEBHOOK_SECRET and PASSPORT_ID are required');
    process.exit(1);
}

async function odata(path: string): Promise<any> {
    const res = await fetch(`${BASE}${path}`, { headers: { authorization: AUTH, accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return res.json();
}

const enc = encodeURIComponent;
const passports = await odata(`/api/v1/producer/Passports?$filter=passportId eq '${enc(PASSPORT_ID)}'&$select=ID`);
const rowId = passports?.value?.[0]?.ID;
if (!rowId) { console.error(`passport '${PASSPORT_ID}' not found`); process.exit(1); }

const attrs = await odata(`/api/v1/producer/PassportAttributes?$filter=passport_ID eq ${rowId}&$select=attribute&$top=200`);
const present: string[] = (attrs?.value ?? []).map((r: any) => String(r.attribute));

const hist = await odata(`/api/v1/producer/PassportAttributeHistory?$filter=passport_ID eq ${rowId}&$select=version&$top=5000`);
let lastTick = 0;
for (const h of hist?.value ?? []) lastTick = Math.max(lastTick, Number(h.version ?? 0));

console.log(`passport ${PASSPORT_ID}: ${present.length} attributes, resuming at tick ${lastTick + 1}, ${TICKS} tick(s)`);

for (let tick = lastTick + 1; tick <= lastTick + TICKS; tick++) {
    const updates = generateTelemetry(PASSPORT_ID, tick, present);
    const body = Buffer.from(JSON.stringify({ passportId: PASSPORT_ID, source: 'bms', updates }));
    // The timestamp is signed with the body (replay protection); the server
    // rejects a frame whose stamp is missing, unsigned or older than 5 minutes.
    const stamp = new Date().toISOString();
    const signature = 'sha256=' + crypto.createHmac('sha256', SECRET)
        .update(stamp).update('.').update(body).digest('hex');
    const res = await fetch(`${BASE}/api/v1/passport/telemetry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bms-signature': signature, 'x-bms-timestamp': stamp },
        body,
    });
    const out: any = await res.json().catch(() => ({}));
    if (!res.ok) { console.error(`tick ${tick}: ${res.status} ${out?.error ?? ''}`); process.exit(1); }
    console.log(`tick ${tick}: ${out.updated} attribute(s) updated`);
}
console.log('done');
