// Periodic batch re-anchor (re-anchoring policy): walk all anchored passports,
// check for content drift (accumulated telemetry etc.) and re-anchor the
// drifted ones onto a fresh payload hash. Sequential with a poll per passport;
// superseded versions stay verifiable. Run manually or from a cron; there is
// deliberately no built-in timer (no unattended chain spend).
//
// Run: node --import tsx scripts/zz-reanchor-batch.mts
// Env: NIGHTPASS_BASE   (default http://localhost:4004)
//      PRODUCER_AUTH    (default producer:producer)
//      WALLET_ID        server wallet that signs (MUST be the wallet holding
//                       the current binding of each passport; default 'default')
//      REASON           batch-telemetry | status-change | data-correction (default batch-telemetry)
//      DRY_RUN          '1' = only report drift, do not re-anchor
//      LIMIT            max passports to re-anchor in one run (default 10)

const BASE = process.env.NIGHTPASS_BASE ?? 'http://localhost:4004';
const AUTH = 'Basic ' + Buffer.from(process.env.PRODUCER_AUTH ?? 'producer:producer').toString('base64');
const WALLET_ID = process.env.WALLET_ID ?? 'default';
const REASON = process.env.REASON ?? 'batch-telemetry';
const DRY_RUN = process.env.DRY_RUN === '1';
const LIMIT = Math.max(1, Number(process.env.LIMIT ?? 10) || 10);
const POLL_MS = 10_000;
const POLL_CAP = 90; // 15 min per passport

const headers = { authorization: AUTH, accept: 'application/json' };

async function get(path: string): Promise<any> {
    const r = await fetch(`${BASE}${path}`, { headers });
    if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
    return r.json();
}
async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(`${BASE}${path}`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
}
const q = (s: string) => encodeURIComponent(`'${s.replace(/'/g, "''")}'`);

const anchored = await get(`/api/v1/producer/Passports?$filter=status eq 'anchored'&$select=passportId&$orderby=createdAt&$top=500`);
const pids: string[] = (anchored?.value ?? []).map((r: any) => String(r.passportId));
console.log(`${pids.length} anchored passport(s); checking drift...`);

let reanchored = 0, failed = 0, drifted = 0;
for (const pid of pids) {
    const drift = await get(`/api/v1/producer/passportDrift(passportId=${q(pid)})`);
    if (!drift?.drifted) continue;
    drifted++;
    console.log(`${pid}: drifted (${String(drift.currentHash).slice(0, 12)}... -> ${String(drift.recomputedHash).slice(0, 12)}...)`);
    if (DRY_RUN) continue;
    if (reanchored + failed >= LIMIT) { console.log(`limit ${LIMIT} reached, stopping`); break; }

    const res = await post('/api/v1/producer/reanchorPassport', { passportId: pid, reason: REASON, walletId: WALLET_ID });
    if (res.status !== 200) { console.error(`${pid}: reanchor -> ${res.status} ${res.body?.error?.message ?? ''}`); failed++; continue; }
    console.log(`${pid}: anchoring v${(res.body.archivedVersion ?? 0) + 1} (${res.body.payloadHash?.slice(0, 12)}...)` +
        ((res.body.grantsToRegrant ?? []).length ? `; ${res.body.grantsToRegrant.length} grant(s) to re-grant` : ''));

    let done = false;
    for (let i = 0; i < POLL_CAP; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const row = (await get(`/api/v1/producer/Passports?$filter=passportId eq ${q(pid)}&$select=status`))?.value?.[0];
        if (row?.status === 'anchored') { console.log(`${pid}: anchored`); reanchored++; done = true; break; }
        if (row?.status === 'failed') { console.error(`${pid}: anchor FAILED (see Transactions tab)`); failed++; done = true; break; }
        process.stdout.write('.');
    }
    if (!done) { console.error(`${pid}: poll timeout`); failed++; }
}
console.log(`\ndone: ${drifted} drifted, ${reanchored} re-anchored, ${failed} failed${DRY_RUN ? ' (dry run)' : ''}`);
process.exit(failed ? 1 : 0);
