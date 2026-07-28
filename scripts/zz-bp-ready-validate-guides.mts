#!/usr/bin/env node --import tsx
// Validate synthetic passports (built through the REAL production mappers:
// defaultGuideAttributes + buildGuideDocument) against the official
// BatteryPass-Ready validator, one run per guide. Iteration harness for
// roadmap task 0.1 (5/5 guides) and report generator.
//
// Usage:
//   node --import tsx scripts/zz-bp-ready-validate-guides.mts [CATEGORY ...]
//   node --import tsx scripts/zz-bp-ready-validate-guides.mts --save   # write reports to docs/batterypass-ready/
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// srv/lib compiles to CommonJS; named ESM imports don't resolve under tsx.
const require = createRequire(import.meta.url);
const { defaultGuideAttributes } = require('../srv/lib/guide-attribute-defaults');
const { buildGuideDocument } = require('../srv/lib/guide-document');

const ROOT = resolve(import.meta.dirname, '..');
const TOKEN_FILE = resolve(ROOT, 'secrets/batterypass-ready-token.json');
const VALIDATE_URL = 'https://batterypass-ready.gefeg.com/automation-console/api/ValidateJSON';
const TOKEN_URL = 'https://batterypass-ready.gefeg.com/auth/realms/batterypass/protocol/openid-connect/token';

// category -> guide tag (mirror of GUIDE_BY_CATEGORY in srv/lib/bp-ready-validate.ts;
// the two new ones are what this harness is iterating on)
const GUIDES: Record<string, string> = {
    EV: 'EV_Guide',
    LMT: 'LMT_Guide',
    INDUSTRIAL: 'Other_Industrial_2kWh_Guide',
    STATIONARY: 'Stationary_Industrial_2kWh_Guide',
    INDUSTRIAL_NO_BMS: 'Industrial_Without_BMS_Guide',
};

// Synthetic rows shaped like createPassport output (cf. CATEGORY_EXAMPLES in
// Producer.controller.js). The two new categories start INDUSTRIAL-shaped.
function exampleRow(category: string) {
    const base = {
        EV: { model: 'PowerCell EV-75', manufacturerId: 'DE-CELLCO-001', weightKg: 432.5, chem: 'NMC-811', kwh: 75, co2: 3412.75, cycles: 4200, rte: 92.5 },
        LMT: { model: 'CityCharge LMT-15', manufacturerId: 'DE-CITYCHARGE-003', weightKg: 9.8, chem: 'NMC-622', kwh: 1.5, co2: 78.4, cycles: 1200, rte: 94.0 },
        INDUSTRIAL: { model: 'BetaVolt IND-120', manufacturerId: 'DE-BETAVOLT-002', weightKg: 985.0, chem: 'LFP', kwh: 120, co2: 5150.25, cycles: 6000, rte: 88.0 },
        STATIONARY: { model: 'GridVault ST-200', manufacturerId: 'DE-GRIDVAULT-004', weightKg: 1620.0, chem: 'LFP', kwh: 200, co2: 7800.5, cycles: 8000, rte: 90.0 },
        INDUSTRIAL_NO_BMS: { model: 'RailCell RB-40', manufacturerId: 'DE-RAILCELL-005', weightKg: 310.0, chem: 'Pb', kwh: 40, co2: 1550.0, cycles: 1500, rte: 82.0 },
    }[category]!;
    const pid = `BAT-ZZ-${category}`;
    const passport = {
        passportId: pid,
        model: base.model,
        manufacturerId: base.manufacturerId,
        manufactureDate: '2026-03-15',
        batteryCategory: category,
        weightKg: base.weightKg,
        performanceClass: 'B',
        modifiedAt: '2026-07-26T08:00:00Z',
    };
    const batteries = [{
        serialNumber: `SN-ZZ-${category}`,
        cellChemistry: base.chem,
        capacityKwh: base.kwh,
        carbonFootprintKgCO2: base.co2,
        cycleLife: base.cycles,
        roundTripEfficiencyPct: base.rte,
    }];
    // Mirror the per-category recycled rows of CATEGORY_EXAMPLES in
    // Producer.controller.js (STATIONARY has no Co row -> the pushed default
    // attribute must cover the required cobalt share; NO_BMS is lead-acid).
    const recycled = {
        EV: [
            { material: 'Co', recycledPercentage: 16.5 },
            { material: 'Li', recycledPercentage: 8.25 },
            { material: 'Ni', recycledPercentage: 12.0 },
        ],
        LMT: [{ material: 'Co', recycledPercentage: 16.9 }],
        INDUSTRIAL: [
            { material: 'Li', recycledPercentage: 6.8 },
            { material: 'Ni', recycledPercentage: 4.1 },
        ],
        STATIONARY: [
            { material: 'Li', recycledPercentage: 7.2 },
            { material: 'Ni', recycledPercentage: 5.0 },
        ],
        INDUSTRIAL_NO_BMS: [{ material: 'Pb', recycledPercentage: 72.0 }],
    }[category]!;
    return { passport, batteries, recycled };
}

async function accessToken(): Promise<string> {
    const refresh = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')).refresh_token;
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'batterypass-ui', refresh_token: refresh }),
    });
    if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);
    const j: any = await res.json();
    return j.access_token;
}

function parseIssues(xml: string): Array<{ path: string; message: string }> {
    const issues: Array<{ path: string; message: string }> = [];
    for (const b of xml.match(/<Error\b[\s\S]*?<\/Error>/g) ?? []) {
        const path = (b.match(/<XPath>([\s\S]*?)<\/XPath>/)?.[1] ?? '').trim();
        const message = (b.match(/<Message>([\s\S]*?)<\/Message>/)?.[1] ?? '').trim()
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        if (message) issues.push({ path, message });
    }
    return issues;
}

const save = process.argv.includes('--save');
const cats = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const categories = cats.length ? cats : Object.keys(GUIDES);

const token = await accessToken();
let failed = 0;
const reports: any[] = [];
for (const category of categories) {
    const guide = GUIDES[category];
    if (!guide) { console.error(`unknown category ${category}`); process.exit(1); }
    const { passport, batteries, recycled } = exampleRow(category);
    const attrs = defaultGuideAttributes(passport);
    const doc = buildGuideDocument(passport as any, batteries, recycled, attrs);
    const url = `${VALIDATE_URL}?tag=${encodeURIComponent(guide)}&version=1.0&variant=%22%22&language=en`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: JSON.stringify(doc),
    });
    if (!res.ok) { console.error(`${guide}: HTTP ${res.status} ${await res.text()}`); failed++; continue; }
    const body: any = await res.json();
    const issues = parseIssues(String(body?.validationLogXml ?? ''));
    console.log(`\n=== ${category} -> ${guide}: ${issues.length === 0 ? 'VALID (0 errors)' : issues.length + ' errors'} ===`);
    for (const i of issues) console.log(`  - [${i.path}] ${i.message}`);
    if (issues.length) failed++;
    reports.push({ category, guide, valid: issues.length === 0, errorCount: issues.length, issues, attributeCount: attrs.length });
}

if (save) {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const file = resolve(ROOT, `docs/batterypass-ready/validation-report-${stamp}-all-guides.json`);
    writeFileSync(file, JSON.stringify({ checkedAt: new Date().toISOString(), results: reports }, null, 2));
    console.log(`\nreport written: ${file}`);
}
process.exit(failed ? 1 : 0);
