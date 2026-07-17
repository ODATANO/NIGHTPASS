#!/usr/bin/env node
// Run the official BatteryPass-Ready test scenarios against a publicly
// reachable NIGHTPASS instance with DPP_API_ENABLED=true.
// Usage: node scripts/bp-ready-run-scenarios.mjs <publicBaseUrl> [testName ...]
// Requires a live session in secrets/batterypass-ready-token.json
// (refresh via scripts/bp-ready-token.mjs happens automatically) and the
// locally fetched scenario catalog under docs/batterypass-ready/ (gitignored;
// pull it from the test executor's GetTests endpoint).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const base = process.argv[2]?.replace(/\/+$/, '');
if (!base) {
  console.error('usage: node scripts/bp-ready-run-scenarios.mjs <publicBaseUrl> [testName ...]');
  process.exit(1);
}
const only = process.argv.slice(3);

const EXECUTOR = 'https://batterypass-ready.gefeg.com/test-executor/api';
const testURL = `${base}/dpp-api/v1`;
const testAdapterURL = `${base}/dpp-api/adapter`;

// Auth: an API key (X-Api-Key) wins when configured; otherwise the Keycloak
// session from secrets/batterypass-ready-token.json is refreshed per call.
// BP_READY_API_KEY can come from the environment or secrets/batterypass-ready.env.
function apiKey() {
  if (process.env.BP_READY_API_KEY) return process.env.BP_READY_API_KEY;
  try {
    const env = readFileSync(resolve(import.meta.dirname, '../secrets/batterypass-ready.env'), 'utf8');
    const m = /^BP_READY_API_KEY=(.+)$/m.exec(env);
    if (m) return m[1].trim();
  } catch { /* no env file */ }
  return null;
}
const token = () =>
  execFileSync(process.execPath, [resolve(import.meta.dirname, 'bp-ready-token.mjs')], { encoding: 'utf8' }).trim();
const authHeaders = () => {
  const key = apiKey();
  return key ? { 'X-Api-Key': key } : { Authorization: `Bearer ${token()}` };
};

const tests = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../docs/batterypass-ready/gettests.json'), 'utf8'),
);

const results = [];
for (const t of tests) {
  if (only.length && !only.includes(t.name)) continue;
  const qs = new URLSearchParams({ testURL, testAdapterURL });
  // The live executor wants a single category enum plus a testcaseType field
  // (accepted as free text); its OpenAPI (v1.4) lags behind on both.
  const category = Array.isArray(t.category) ? t.category[0] : t.category;
  const body = {
    name: t.name,
    category: category || 'EconomicOperator',
    testcaseType: category || 'EconomicOperator',
    parameters: (t.parameters ?? []).map((p) => ({
      name: p.name,
      value: p.defaultValue != null ? String(p.defaultValue) : '',
    })),
  };
  const startedAt = new Date().toISOString();
  process.stdout.write(`${t.name} ... `);
  let outcome;
  try {
    const res = await fetch(`${EXECUTOR}/ExecTest?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    outcome = res.ok ? await res.json() : { httpError: res.status, body: (await res.text()).slice(0, 500) };
  } catch (e) {
    outcome = { error: String(e) };
  }
  // Response shape: { testCase, testId, state, steps: [{name, executed, result: {data: {state, ...}}}] }
  const verdict = outcome?.state ?? 'error';
  const stepStates = (outcome?.steps ?? []).map((s) => `${s.name}:${s.result?.data?.state ?? s.state ?? '?'}`);
  console.log(verdict, stepStates.length ? `(${stepStates.join(', ')})` : JSON.stringify(outcome).slice(0, 160));
  results.push({ name: t.name, verdict, startedAt, outcome });
}

const ok = results.filter((r) => r.verdict === 'success').length;
console.log(`\n${ok}/${results.length} scenarios green`);
const out = resolve(import.meta.dirname, '../docs/batterypass-ready/scenario-results.json');
writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), base, results }, null, 2));
console.log(`report: ${out}`);
process.exit(ok === results.length ? 0 : 1);
