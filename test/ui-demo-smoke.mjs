// "Try it" demo UI smoke: drives the FULL visitor flow in a real browser
// against a self-started throwaway instance (scratch DB): landing -> start ->
// form -> submit -> live timeline -> done view. The run is a REAL sponsored
// anchor + ZK proof on Midnight preview, so the test takes a few minutes.
//
//   node test/ui-demo-smoke.mjs [--db <scratch.db>] [--port 4020]
//
// With --db pointing at a prior zz-demo-e2e scratch DB the sponsor wallet is
// already warm; without it the sponsor cold-syncs first (adds ~1 min).
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt('--port', '4020'));
const BASE = `http://localhost:${PORT}`;
const OUT = resolve(ROOT, 'test/screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dbArg = opt('--db', '');
const scratchDb = dbArg ? resolve(dbArg) : join(mkdtempSync(join(tmpdir(), 'nightpass-demo-ui-')), 'demo.db');

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

const env = {
  ...process.env,
  PORT: String(PORT),
  cds_requires_db_credentials_database: scratchDb,
  NIGHTGATE_NETWORK: 'preview',
  NIGHTGATE_SIGNING_KEY_RATE_LIMIT: '1000',
  NODE_OPTIONS: '--max-old-space-size=12288',
  PASSPORT_CONTRACT_ADDRESS: process.env.PASSPORT_CONTRACT_ADDRESS
    || 'f7c755235cc9408bc6664f7cae88b445798726ccdf9a6a560e7c873c807aabe1',
  PASSPORT_FEE_SPONSOR_WALLET: 'default',
  DEMO_ENABLED: 'true',
  PASSPORT_PUBLISH_URL: '',
};

if (!dbArg) {
  console.log(`[deploy] fresh scratch ${scratchDb}`);
  execSync('npm run deploy', { cwd: ROOT, env, stdio: 'ignore' });
} else {
  console.log(`[db] reusing ${scratchDb}`);
}

console.log(`[server] starting on :${PORT}...`);
const child = spawn('npx', ['cds-tsx', 'serve'], { env, cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });
const killServer = () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ } };
process.on('exit', killServer);

for (let i = 0; i < 60; i++) {
  await sleep(2000);
  try {
    const r = await fetch(`${BASE}/api/v1/demo/demoInfo()`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) break;
  } catch { /* booting */ }
  if (i === 59) { console.error('server did not come up:\n' + serverLog.slice(-2000)); process.exit(1); }
}
console.log('[server] up');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });

try {
  console.log('\n== landing ==');
  await page.goto(`${BASE}/demo/`);
  await page.locator('#btnStart').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !document.getElementById('btnStart').disabled, { timeout: 20000 });
  check('landing renders with an enabled start button', true);
  check('daily budget shown', /left today/.test(await page.locator('#landingInfo').textContent()));
  await page.screenshot({ path: join(OUT, 'demo-landing.png') });

  console.log('== start tester ==');
  await page.locator('#btnStart').click();
  await page.locator('#viewForm:not([hidden])').waitFor({ timeout: 30000 });
  const night = await page.locator('#idNight').textContent();
  check('fresh wallet identity shown (mn_addr_...)', night.startsWith('mn_addr_'));
  await page.screenshot({ path: join(OUT, 'demo-form.png') });

  console.log('== submit passport ==');
  await page.locator('#fModel').fill('UISmoke EV-1');
  await page.locator('#fManufacturer').fill('SmokeWorks');
  await page.locator('#passportForm button[type=submit]').click();
  await page.locator('#viewRun:not([hidden])').waitFor({ timeout: 30000 });
  const pid = await page.locator('#runPassportId').textContent();
  check('run view shows a BAT-TRY passport id', pid.startsWith('BAT-TRY-'));
  await page.locator('#timeline li').first().waitFor({ timeout: 20000 });
  await page.screenshot({ path: join(OUT, 'demo-run.png') });

  console.log('== waiting for the sponsored run (a few minutes of real chain work) ==');
  const t0 = Date.now();
  await page.locator('#viewDone:not([hidden])').waitFor({ timeout: 30 * 60_000 });
  const min = ((Date.now() - t0) / 60000).toFixed(1);
  check(`done view reached (${min} min)`, true);
  const doneId = await page.locator('#donePassportId').textContent();
  check('done view shows the passport id', doneId === pid);
  const proofLink = await page.locator('#doneLinks a').count();
  check('done view links the ZK proof tx', proofLink >= 1);
  await page.screenshot({ path: join(OUT, 'demo-done.png') });

  // The run view rendered succeeded steps along the way; re-check via API.
  const runId = await page.evaluate(() => localStorage.getItem('nightpass-demo-runId'));
  const st = await (await fetch(`${BASE}/api/v1/demo/demoRunStatus(runId=${runId})`)).json();
  const steps = JSON.parse(st.stepsJson);
  const ok = (k, s) => steps.find((x) => x.kind === k)?.status === s;
  check('timeline: sync succeeded', ok('sync', 'succeeded'));
  check('timeline: attest succeeded with tx', ok('attest', 'succeeded'));
  check('timeline: bindPassport succeeded', ok('bindPassport', 'succeeded'));
  check('timeline: anchorContentRoot succeeded', ok('anchorContentRoot', 'succeeded'));
  check('timeline: provePredicate succeeded', ok('provePredicate', 'succeeded'));
  check('timeline: publish skipped (no publish env in the test)', ok('publish', 'skipped'));
} catch (e) {
  check(`flow crashed: ${String(e.message || e).slice(0, 200)}`, false);
  await page.screenshot({ path: join(OUT, 'demo-failed.png') }).catch(() => {});
  console.error('server log tail:\n' + serverLog.slice(-3000));
} finally {
  await browser.close();
  killServer();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
