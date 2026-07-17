#!/usr/bin/env node
// Emit a BatteryPass-Ready validation payload (GEFEG Battery_Passport guide format,
// EV_Guide 1.0) from a NIGHTPASS passport row. Only fields NIGHTPASS actually holds
// are emitted; the official validator then enumerates the true gap backlog.
// Usage: node scripts/bp-ready-payload.mjs <passportId> [> out.json]
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const passportId = process.argv[2];
if (!passportId) {
  console.error('usage: node scripts/bp-ready-payload.mjs <passportId>');
  process.exit(1);
}

const db = new Database(resolve(import.meta.dirname, '../db/passport.db'), { readonly: true });
const p = db.prepare('SELECT * FROM passport_Passports WHERE passportId = ?').get(passportId);
if (!p) {
  console.error(`passport ${passportId} not found`);
  process.exit(1);
}
const batteries = db.prepare('SELECT * FROM passport_Batteries WHERE passport_ID = ?').all(p.ID);
const recycled = db.prepare('SELECT * FROM passport_RecycledMaterials WHERE passport_ID = ?').all(p.ID);
const kvAttrs = db.prepare('SELECT section, attribute, valueJson FROM passport_PassportAttributes WHERE passport_ID = ?').all(p.ID);
const b = batteries[0] ?? {};

const CATEGORY_LABEL = {
  EV: 'electric vehicle battery',
  INDUSTRIAL: 'industrial battery',
  LMT: 'LMT battery',
};

// The guide restricts chemicalCodeValue to a closed list; our free-text
// cellChemistry (e.g. "NMC-811") maps to the family code, detail goes to
// additionallyPossibleValue.
const CHEMISTRY_CODES = ['Li-ion LCO', 'Li-ion LFP', 'Li-ion LMO', 'Li-ion NCA', 'Li-ion NMC', 'Li-metal', 'Na-ion', 'Ni-Cd', 'Ni-MH', 'Pb'];
function chemistryCode(raw) {
  const s = String(raw);
  const exact = CHEMISTRY_CODES.find((c) => c.toLowerCase() === s.toLowerCase());
  if (exact) return { chemicalCodeValue: exact };
  const family = CHEMISTRY_CODES.find((c) => s.toUpperCase().includes(c.split(' ').pop().toUpperCase()));
  return family
    ? { chemicalCodeValue: family, additionallyPossibleValue: s }
    : { chemicalCodeValue: s };
}

const pct = (v) => ({ percentageValue: Number(v), percent: '%' });

// Post-consumer recycled shares per material (Art. 8). Our RecycledMaterials rows
// hold one share per material; the guide format wants one attribute per material.
const shareByMaterial = {};
for (const r of recycled) shareByMaterial[r.material] = r.recycledPercentage;

const identifiers = {
  DPPSchemaVersion: '1.0.0',
  DPPStatus: { dppStatusValue: 'Active' },
  DPPGranularity: 'BatteryUnit',
  'Date-timeOfLatestUpdateOfDPP': new Date(p.modifiedAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  BatteryModelIdentifier: p.model,
  UniqueBatteryPassportIdentifierUniqueDPPIdentifier: `urn:odatano:passport:${p.passportId}`,
  UniqueBatteryIdentifierUniqueProductIdentifier: `urn:odatano:battery:${p.passportId}`,
  ...(b.serialNumber ? { BatterySerialNumber: b.serialNumber } : {}),
  UniqueManufacturerIdentifier: p.manufacturerId,
  ...(p.manufactureDate ? { ManufacturingDate: p.manufactureDate } : {}),
  ...(p.batteryCategory
    ? { BatteryCategory: { batteryCategoryValue: CATEGORY_LABEL[p.batteryCategory] ?? p.batteryCategory } }
    : {}),
  ...(p.weightKg != null ? { BatteryMass: { gramKgValue: Number(p.weightKg), gramKg: 'kg' } } : {}),
};

const performance = {
  ...(b.capacityKwh != null
    ? { CertifiedUsableBatteryEnergy: { kilowattHourValue: Number(b.capacityKwh), kilowattHour: 'kWh' } }
    : {}),
  ...(b.roundTripEfficiencyPct != null
    ? { InitialRoundTripEnergyEfficiency: pct(b.roundTripEfficiencyPct) }
    : {}),
  ...(b.cycleLife != null
    ? { 'ExpectedLifetime-NumberOfCharge-dischargeCycles': Number(b.cycleLife) }
    : {}),
};

const carbon = {
  ...(b.carbonFootprintKgCO2 != null && b.capacityKwh
    ? {
        BatteryCarbonFootprintPerFunctionalUnit: {
          'kgCO2-equivalentPerKilowattHourValue': Math.round((Number(b.carbonFootprintKgCO2) / Number(b.capacityKwh)) * 10) / 10,
          'kgCO2-equivalentPerKilowattHour': 'kgCO2-eq/kWh',
        },
      }
    : {}),
  ...(p.performanceClass ? { CarbonFootprintPerformanceClass: p.performanceClass } : {}),
  ...(b.carbonFootprintKgCO2 != null
    ? {
        AbsoluteBatteryCarbonFootprint: {
          // guide type is integer
          'kgCO2-equivalentValue': Math.round(Number(b.carbonFootprintKgCO2)),
          'kgCO2-equivalent': 'kgCO2-eq',
        },
      }
    : {}),
};

const materials = {
  ...(b.cellChemistry ? { BatteryChemistry: chemistryCode(b.cellChemistry) } : {}),
};

const circularity = {
  ...(shareByMaterial.Ni != null ? { 'Post-consumerRecycledNickelShare': pct(shareByMaterial.Ni) } : {}),
  ...(shareByMaterial.Co != null ? { 'Post-consumerRecycledCobaltShare': pct(shareByMaterial.Co) } : {}),
  ...(shareByMaterial.Li != null ? { 'Post-consumerRecycledLithiumShare': pct(shareByMaterial.Li) } : {}),
  ...(shareByMaterial.Pb != null ? { RecycledLeadShare: pct(shareByMaterial.Pb) } : {}),
};

// Merge guide-attribute rows (passport_PassportAttributes) into their sections.
// Typed fields above are the source of truth and keep precedence.
const sections = {
  IdentifiersAndProductData: identifiers,
  PerformanceAndDurability: performance,
  BatteryCarbonFootprint: carbon,
  BatteryMaterialsAndComposition: materials,
  CircularityAndResourceEfficiency: circularity,
  SupplyChainDueDiligence: {},
  SymbolsLabelsAndDocumentationOfConformity: {},
};
for (const { section, attribute, valueJson } of kvAttrs) {
  const target = (sections[section] ??= {});
  if (!(attribute in target)) target[attribute] = JSON.parse(valueJson);
}

const strip = (o) => (Object.keys(o).length ? o : undefined);

const payload = {
  Battery_Passport: JSON.parse(
    JSON.stringify({
      IdentifiersAndProductData: sections.IdentifiersAndProductData,
      PerformanceAndDurability: strip(sections.PerformanceAndDurability),
      BatteryCarbonFootprint: strip(sections.BatteryCarbonFootprint),
      BatteryMaterialsAndComposition: strip(sections.BatteryMaterialsAndComposition),
      CircularityAndResourceEfficiency: strip(sections.CircularityAndResourceEfficiency),
      SupplyChainDueDiligence: strip(sections.SupplyChainDueDiligence),
      SymbolsLabelsAndDocumentationOfConformity: strip(sections.SymbolsLabelsAndDocumentationOfConformity),
    }),
  ),
};

process.stdout.write(JSON.stringify(payload, null, 2));
