// Producer cockpit offline-path smoke test. Run against a running server:
//   npm start          (in one terminal)
//   node test/integration/producer-smoke.mjs
//
// Exercises the ProducerService actions in offline mode (no wallet session):
// createPassport → read back → grantPassportDisclosure → provePassportValue,
// asserting the rows + tracking-log entries land. Mirrors test/ui-smoke.mjs style
// (standalone fetch script; NIGHTPASS has no unit-test framework).

const BASE = process.env.NIGHTPASS_BASE || 'http://localhost:4004';
const SVC = `${BASE}/api/v1/producer`;
const AUTH = 'Basic ' + Buffer.from('producer:producer').toString('base64');
const H = { Authorization: AUTH, 'Content-Type': 'application/json' };

let failures = 0;
function ok(cond, msg) { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) failures++; }

async function post(action, body) {
  const r = await fetch(`${SVC}/${action}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${action} -> ${r.status}: ${t}`);
  return JSON.parse(t);
}
async function get(path) {
  const r = await fetch(`${SVC}/${path}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

async function main() {
  const passportId = `BAT-PROD-SMOKE-${Date.now()}`;
  const grantee = 'ab'.repeat(32);

  // 1. create (offline)
  const created = await post('createPassport', {
    submit: false,
    passportJson: JSON.stringify({
      passportId, manufacturerId: 'DE-CELLCO-001', batteryCategory: 'EV', model: 'PowerCell EV-75',
      manufactureDate: '2026-03-15', weightKg: 432.5, performanceClass: 'B',
      batteries: [{ serialNumber: 'SN-1', cellChemistry: 'NMC-811', capacityKwh: 75, carbonFootprintKgCO2: 3412.75, supplierName: 'CathodeWorks' }],
      recycledMaterials: [{ material: 'Co', recycledPercentage: 16.5, sourceSupplierName: 'ReCobalt' }],
      diligenceDocs: [{ docType: 'dd-report' }]
    })
  });
  ok(created.passportId === passportId, `createPassport returns id (${created.passportId})`);
  ok(created.mode === 'offline', `createPassport mode offline`);
  ok(/^[0-9a-f]{64}$/.test(created.payloadHash), `payloadHash is 64-hex`);

  // 2. row + tx-log
  const rows = await get(`Passports?$filter=passportId eq '${passportId}'&$select=passportId,status`);
  ok(rows.value.length === 1 && rows.value[0].status === 'draft', `passport row present, status draft`);
  const ID = (await get(`Passports?$filter=passportId eq '${passportId}'&$select=ID`)).value[0].ID;
  const txs = await get(`PassportTransactions?$filter=passport_ID eq ${ID}&$select=kind,status`);
  ok(txs.value.some((t) => t.kind === 'attest' && t.status === 'offline'), `offline attest tx logged`);

  // 3. grant (offline)
  const g = await post('grantPassportDisclosure', { passportId, grantee, level: 2 });
  ok(g.mode === 'offline', `grant mode offline`);
  const gl = await get(`DisclosureGrantLog?$filter=passport_ID eq ${ID}&$select=op,level,status`);
  ok(gl.value.some((r) => r.op === 'grant' && r.level === 2 && r.status === 'offline'), `disclosure grant logged`);

  // 4. prove (offline); value pulled from carbonFootprintKgCO2, threshold scaled x1000
  const p = await post('provePassportValue', { passportId, sourceField: 'carbonFootprintKgCO2', predicate: 'lessOrEqual', threshold: 4000, unit: 'milli-kg CO2/kWh' });
  ok(p.mode === 'offline', `prove mode offline`);
  const pl = await get(`PredicateProofLog?$filter=passport_ID eq ${ID}&$select=sourceField,threshold,status`);
  ok(pl.value.some((r) => r.sourceField === 'carbonFootprintKgCO2' && r.threshold === 4000000 && r.status === 'offline'), `predicate proof logged (threshold scaled ×1000)`);

  console.log(failures ? `\n${failures} check(s) FAILED` : `\nAll producer offline-path checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('SMOKE ERROR:', e.message); process.exit(1); });
