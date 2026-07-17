#!/usr/bin/env node
// Recover the server wallets after a Midnight testnet reset, end to end:
//
//   1. Detect a chain reset (block hash at the last-known height changed or
//      vanished; marker in secrets/preview-chain-marker.json).
//   2. On reset (or --force-wipe): back up + wipe midnight_WalletSyncStates
//      and midnight_WalletSessions. Stale sync blobs point at the old chain
//      and must never be replayed against a new one.
//   3. Boot a throwaway server with the wallet registry (same env loading as
//      scripts/start-with-wallets.mjs).
//   4. Per wallet (Main + A/B/C): connect a signing session, wait for the
//      wallet sync (prewarm job), read the NIGHT balance. If funded and not
//      yet dust-registered, run registerForDustGeneration and wait for the tx.
//   5. Store the new chain marker and print a summary.
//
// Usage: node scripts/preview-reset-recovery.mjs [--force-wipe] [--port 4011]
//        [--network preview] [--only A,B]
// Notes: needs the faucet/transfer funding done first (NIGHT on the wallets'
// mn_addr_... addresses). Registration works with DUST=0; fees come from the
// registered UTXO's future generation.
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const PORT = Number(opt('--port', '4011'));
const NETWORK = opt('--network', 'preview');
const ONLY = (opt('--only', '') || '').split(',').filter(Boolean);
const BASE = `http://localhost:${PORT}`;
const AUTH = 'Basic ' + Buffer.from('authority:authority').toString('base64');
const INDEXER = process.env.NIGHTGATE_INDEXER_HTTP_URL
    || `https://indexer.${NETWORK}.midnight.network/api/v4/graphql`;
const MARKER_FILE = resolve(ROOT, `secrets/${NETWORK}-chain-marker.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- wallet definitions ---------------------------------------------------

function parseEnvFile(path) {
    const out = {};
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z_0-9]+)\s*=\s*(.*)$/);
        if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1').trim();
    }
    return out;
}

const secretsEnv = parseEnvFile(resolve(ROOT, 'secrets/producer-wallets.env'));
const dotEnv = parseEnvFile(resolve(ROOT, '.env'));

const wallets = [];
if (dotEnv.PRODUCER_WALLET_MNEMONIC) {
    wallets.push({
        id: 'default', label: dotEnv.PRODUCER_LABEL || secretsEnv.PRODUCER_LABEL || 'Main wallet',
        mnemonic: dotEnv.PRODUCER_WALLET_MNEMONIC, viewingKey: dotEnv.PRODUCER_VIEWING_KEY,
        nightAddress: '(derived)',
    });
}
for (const key of Object.keys(secretsEnv)) {
    const m = key.match(/^PRODUCER_([A-Z0-9]+)_WALLET_MNEMONIC$/);
    if (!m) continue;
    wallets.push({
        id: m[1],
        label: secretsEnv[`PRODUCER_${m[1]}_LABEL`] || `Producer ${m[1]}`,
        mnemonic: secretsEnv[key],
        viewingKey: secretsEnv[`PRODUCER_${m[1]}_VIEWING_KEY`],
        nightAddress: secretsEnv[`PRODUCER_${m[1]}_NIGHT_ADDRESS`] || '?',
    });
}
const selected = ONLY.length ? wallets.filter((w) => ONLY.includes(w.id)) : wallets;
if (!selected.length) { console.error('no wallets found (secrets/producer-wallets.env / .env)'); process.exit(1); }

// ---- 1) chain reset detection --------------------------------------------

async function gql(query) {
    const res = await fetch(INDEXER, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }), signal: AbortSignal.timeout(20000),
    });
    return (await res.json()).data;
}

async function detectReset() {
    const tip = (await gql('{ block { height hash } }')).block;
    let reset = false;
    if (existsSync(MARKER_FILE)) {
        const marker = JSON.parse(readFileSync(MARKER_FILE, 'utf8'));
        const at = (await gql(`{ block(offset: {height: ${marker.height}}) { hash } }`))?.block;
        reset = !at || at.hash !== marker.hash;
        console.log(`[marker] stored h=${marker.height} ${marker.hash.slice(0, 12)}… → chain ${reset ? 'RESET detected' : 'unchanged'}`);
    } else {
        console.log('[marker] none stored yet (first run); use --force-wipe if the chain was reset');
    }
    return { reset, tip };
}

// ---- 2) sync-state wipe ---------------------------------------------------

async function wipeSyncState() {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(resolve(ROOT, 'db/passport.db'));
    db.pragma('busy_timeout = 10000');
    const backup = {
        at: new Date().toISOString(),
        syncStates: db.prepare('SELECT * FROM midnight_WalletSyncStates').all(),
        sessions: db.prepare('SELECT * FROM midnight_WalletSessions').all(),
    };
    const stamp = backup.at.replace(/[:.]/g, '-');
    writeFileSync(resolve(ROOT, `secrets/wipe-backup-${stamp}.json`), JSON.stringify(backup));
    const a = db.prepare('DELETE FROM midnight_WalletSyncStates').run().changes;
    const b = db.prepare('DELETE FROM midnight_WalletSessions').run().changes;
    db.close();
    console.log(`[wipe] removed ${a} sync state(s) + ${b} session(s); backup secrets/wipe-backup-${stamp}.json`);
}

// ---- server + API helpers -------------------------------------------------

async function api(method, path, body) {
    const res = await fetch(`${BASE}/api/v1/nightgate/${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: AUTH },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return json;
}

async function pollJob(jobId, sessionId, label, timeoutMin = 45) {
    const started = Date.now();
    for (;;) {
        const j = await api('POST', 'getJobStatus', { jobId, sessionId });
        if (j.status === 'succeeded') return j;
        if (j.status === 'failed') throw new Error(`${label} failed: ${j.errorCode} ${j.errorMessage}`);
        const min = (Date.now() - started) / 60000;
        if (min > timeoutMin) throw new Error(`${label} timed out after ${timeoutMin} min`);
        if (Math.floor(min * 6) % 6 === 0) process.stdout.write(`\r[${label}] ${j.status} ${min.toFixed(1)} min…   `);
        await sleep(10000);
    }
}

// ---- main -----------------------------------------------------------------

const { reset, tip } = await detectReset();
if (reset || flag('--force-wipe')) await wipeSyncState();
else console.log('[wipe] skipped (no reset detected)');

console.log(`[server] starting on :${PORT} (${NETWORK})…`);
const env = {
    ...process.env, ...secretsEnv,
    PORT: String(PORT),
    NIGHTGATE_NETWORK: NETWORK,
    NIGHTGATE_SIGNING_KEY_RATE_LIMIT: '1000',
    NODE_OPTIONS: '--max-old-space-size=12288',
};
if (!env.PRODUCER_WALLETS) {
    env.PRODUCER_WALLETS = wallets.filter((w) => w.id !== 'default').map((w) => w.id).join(',');
}
const child = spawn('npx', ['cds-tsx', 'serve'], { env, cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });
const killServer = () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ } };
process.on('exit', killServer);

for (let i = 0; i < 60; i++) {
    await sleep(2000);
    try { await api('GET', '../passport/Passports?$top=1'); break; } catch { /* booting */ }
    if (i === 59) { console.error('server did not come up; log tail:\n' + serverLog.slice(-2000)); process.exit(1); }
}
console.log('[server] up');

const summary = [];
for (const w of selected) {
    console.log(`\n=== ${w.label} (${w.id}) | ${w.nightAddress}`);
    try {
        // Two-step session: connectWallet(viewingKey) creates the session,
        // connectWalletForSigning upgrades it with the signing secret.
        const base = await api('POST', 'connectWallet', { viewingKey: w.viewingKey });
        const conn = await api('POST', 'connectWalletForSigning', { sessionId: base.sessionId, mnemonic: w.mnemonic });
        const sessionId = conn.sessionId || base.sessionId;
        console.log(`[${w.id}] session ${sessionId}; waiting for wallet sync…`);
        if (conn.prewarmJobId) await pollJob(conn.prewarmJobId, sessionId, `${w.id} sync`);
        console.log(`\n[${w.id}] synced`);

        let bal = await api('GET', `getWalletBalance(sessionId=${sessionId})`);
        console.log(`[${w.id}] NIGHT unshielded=${bal.unshieldedNight} shielded=${bal.shieldedNight} dust=${bal.dustBalance} registered=${bal.registeredNightUtxoCount}/${bal.totalNightUtxoCount}`);

        if (bal.unshieldedNight === '0' && bal.totalNightUtxoCount === 0) {
            summary.push({ id: w.id, night: '0', registered: 'SKIPPED - fund ' + w.nightAddress });
            continue;
        }
        if (bal.registeredNightUtxoCount >= bal.totalNightUtxoCount && bal.totalNightUtxoCount > 0) {
            summary.push({ id: w.id, night: bal.unshieldedNight, registered: `already ${bal.registeredNightUtxoCount}/${bal.totalNightUtxoCount}` });
            continue;
        }
        const reg = await api('POST', 'registerForDustGeneration', { sessionId });
        const job = await pollJob(reg.jobId, sessionId, `${w.id} dust-register`);
        const result = JSON.parse(job.result || '{}');
        console.log(`\n[${w.id}] dust registration tx ${result.txId} (${result.registeredCount}/${result.totalNightUtxos} UTXOs)`);
        bal = await api('GET', `getWalletBalance(sessionId=${sessionId})`);
        summary.push({ id: w.id, night: bal.unshieldedNight, registered: `${bal.registeredNightUtxoCount}/${bal.totalNightUtxoCount} tx=${String(result.txId).slice(0, 16)}…` });
    } catch (e) {
        console.error(`[${w.id}] ERROR: ${String(e.message || e).slice(0, 300)}`);
        summary.push({ id: w.id, night: '?', registered: 'ERROR: ' + String(e.message || e).slice(0, 120) });
    }
}

const allOk = summary.every((s) => !String(s.registered).startsWith('ERROR'));
if (allOk) {
    writeFileSync(MARKER_FILE, JSON.stringify({ height: tip.height, hash: tip.hash, storedAt: new Date().toISOString() }, null, 2));
    console.log(`\n[marker] stored ${NETWORK} h=${tip.height}`);
} else {
    console.log('\n[marker] NOT stored (errors above); rerun after fixing');
}
console.log('\n==== SUMMARY ====');
for (const s of summary) console.log(`${s.id.padEnd(8)} NIGHT=${String(s.night).padEnd(14)} ${s.registered}`);
killServer();
process.exit(allOk ? 0 : 1);
