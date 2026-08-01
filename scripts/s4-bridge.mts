// S/4HANA -> NIGHTPASS goods-receipt bridge (Sprint 2 "real SAP lane").
//
// Polls API_MATERIAL_DOCUMENT_SRV for new goods-receipt items (movement type
// 101 by default), maps each to a PassportInput via the product master
// (srv/lib/s4-material-document.ts) and POSTs it as an HMAC-signed CloudEvent
// to the existing webhook POST /api/v1/passport/erp-events. The webhook is
// idempotent on passportId, so at-least-once delivery is safe; the local
// state file only avoids re-sending on every poll cycle.
//
// Run: node --import tsx scripts/s4-bridge.mts --once     (single cycle)
//      node --import tsx scripts/s4-bridge.mts            (poll loop)
//
// Env: S4_BASE_URL            required, e.g. https://sandbox.api.sap.com/s4hanacloud
//                             or https://<host>:<port> of a trial/CAL system
//      S4_API_KEY             sandbox APIKey header (api.sap.com), OR
//      S4_USER / S4_PASSWORD  basic auth (trial/CAL)
//      S4_MOVEMENT_TYPES      default '101' (comma separated)
//      S4_TOP                 page size per poll, default 50
//      S4_PRODUCT_MASTER      path to the product-master JSON,
//                             default config/s4-product-master.json
//      S4_STATE_FILE          default secrets/s4-bridge-state.json
//      S4_POLL_INTERVAL_MS    default 60000 (loop mode)
//      S4_SOURCE              CloudEvent source, default urn:odatano:s4-bridge
//      NIGHTPASS_BASE         default http://localhost:4004
//      ERP_WEBHOOK_SECRET     required (same value the NIGHTPASS server runs with)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    goodsReceiptItems, materialDocumentToPassportInput, toCloudEvent,
    signErpEventBody, docItemKey
} from '../srv/lib/s4-material-document';
import { s4ConfigFromEnv, fetchMaterialDocuments, enrichMaster, loadProductMaster } from '../srv/lib/s4-client';

const ONCE = process.argv.includes('--once');

const cfg = s4ConfigFromEnv();
const NIGHTPASS_BASE = process.env.NIGHTPASS_BASE ?? 'http://localhost:4004';
const SECRET = process.env.ERP_WEBHOOK_SECRET ?? '';
const STATE_PATH = process.env.S4_STATE_FILE ?? 'secrets/s4-bridge-state.json';
const INTERVAL_MS = Math.max(5_000, Number(process.env.S4_POLL_INTERVAL_MS ?? 60_000) || 60_000);
const SOURCE = process.env.S4_SOURCE ?? 'urn:odatano:s4-bridge';
const POST_DELAY_MS = Math.max(0, Number(process.env.S4_POST_DELAY_MS ?? 0) || 0);

if (!cfg) { console.error('S4_BASE_URL is required'); process.exit(1); }
if (!SECRET) { console.error('ERP_WEBHOOK_SECRET is required'); process.exit(1); }

const master = loadProductMaster(cfg);
console.log(`[s4-bridge] product master: ${Object.keys(master).length} materials from ${cfg.masterPath}`);

// --- seen-state (bounded, best effort; the webhook stays the idempotency truth)

interface BridgeState { seen: string[] }
const SEEN_CAP = 2000;

function loadState(): BridgeState {
    try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
    catch { return { seen: [] }; }
}
function saveState(state: BridgeState): void {
    state.seen = state.seen.slice(-SEEN_CAP);
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
}

// --- webhook post ------------------------------------------------------------

async function postEvent(data: ReturnType<typeof materialDocumentToPassportInput>): Promise<string> {
    const event = toCloudEvent(data, {
        source: SOURCE,
        id: crypto.randomUUID(),
        time: new Date().toISOString()
    });
    const raw = JSON.stringify(event);
    const res = await fetch(`${NIGHTPASS_BASE}/api/v1/passport/erp-events`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/cloudevents+json',
            'x-equinox-signature': signErpEventBody(raw, SECRET)
        },
        body: raw,
        signal: AbortSignal.timeout(120_000)
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 201) return `created (mode ${body?.mode ?? '?'})`;
    if (res.status === 200 && body?.status === 'duplicate') return 'duplicate';
    throw new Error(`webhook -> ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
}

// --- poll cycle --------------------------------------------------------------

async function cycle(state: BridgeState): Promise<void> {
    const headers = await fetchMaterialDocuments(cfg);
    const receipts = goodsReceiptItems(headers, cfg.movementTypes);
    const seen = new Set(state.seen);
    let posted = 0, skipped = 0;

    for (const r of receipts) {
        const key = docItemKey(r.item);
        if (seen.has(key)) continue;
        try {
            const input = materialDocumentToPassportInput(r, resolvedMaster);
            if (posted > 0 && POST_DELAY_MS > 0) await new Promise(res => setTimeout(res, POST_DELAY_MS));
            const outcome = await postEvent(input);
            console.log(`[s4-bridge] ${key} material=${r.item.Material} -> ${input.passportId}: ${outcome}`);
            posted++;
        } catch (e: any) {
            // Not every received material is a battery; unknown materials are
            // expected and skipped for good. Webhook failures are NOT marked
            // seen, so the next cycle retries them.
            if (String(e?.message).startsWith('no product-master entry')) {
                skipped++;
            } else {
                console.error(`[s4-bridge] ${key} failed, will retry: ${e?.message ?? e}`);
                continue;
            }
        }
        seen.add(key);
        state.seen.push(key);
    }
    saveState(state);
    console.log(`[s4-bridge] cycle done: ${receipts.length} receipt items, ${posted} posted, ${skipped} non-battery skipped`);
}

const state = loadState();
const resolvedMaster = await enrichMaster(cfg, master, (material, entry, product) => {
    if (product) {
        console.log(`[s4-bridge] enriched ${material}: weightKg=${entry.weightKg}`
            + ` (S/4 ${product.NetWeight ?? product.GrossWeight ?? '?'} ${product.WeightUnit ?? ''})`
            + (product.description ? ` desc="${product.description}"` : ''));
    } else {
        console.log(`[s4-bridge] no S/4 product data for ${material}, using configured values`);
    }
});
console.log(`[s4-bridge] polling ${cfg.baseUrl} (movement types ${cfg.movementTypes.join(',')}) -> ${NIGHTPASS_BASE}`);

if (ONCE) {
    await cycle(state);
} else {
    for (;;) {
        try { await cycle(state); }
        catch (e: any) { console.error(`[s4-bridge] cycle failed: ${e?.message ?? e}`); }
        await new Promise(r => setTimeout(r, INTERVAL_MS));
    }
}
