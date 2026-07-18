/**
 * Render a NIGHTPASS passport (typed fields + PassportAttributes rows) as a
 * BatteryPass-Ready guide document (`Battery_Passport` root, DIN DKE SPEC
 * 99100 shape). Pure: takes plain row objects, touches no database. Runtime
 * twin of scripts/bp-ready-payload.mjs (which feeds the validation upload);
 * the mapping rules must stay in sync with that script.
 */

export interface PassportRow {
    passportId: string;
    model?: string | null;
    manufacturerId?: string | null;
    batteryCategory?: string | null;
    manufactureDate?: string | null;
    weightKg?: number | null;
    performanceClass?: string | null;
    modifiedAt?: string | null;
    status?: string | null;
}
export interface BatteryRow {
    serialNumber?: string | null;
    cellChemistry?: string | null;
    capacityKwh?: number | null;
    carbonFootprintKgCO2?: number | null;
    cycleLife?: number | null;
    roundTripEfficiencyPct?: number | null;
}
export interface RecycledRow { material?: string | null; recycledPercentage?: number | null }
export interface AttributeRow { section?: string | null; attribute?: string | null; valueJson?: string | null }

const CATEGORY_LABEL: Record<string, string> = {
    EV: 'electric vehicle battery',
    // Enum value of the Other_Industrial_2kWh_Guide (the guide INDUSTRIAL
    // passports validate against); plain "industrial battery" is rejected.
    INDUSTRIAL: 'industrial/non-stationary battery',
    LMT: 'LMT battery',
};

const CHEMISTRY_CODES = ['Li-ion LCO', 'Li-ion LFP', 'Li-ion LMO', 'Li-ion NCA', 'Li-ion NMC', 'Li-metal', 'Na-ion', 'Ni-Cd', 'Ni-MH', 'Pb'];
function chemistryCode(raw: string): Record<string, string> {
    const exact = CHEMISTRY_CODES.find((c) => c.toLowerCase() === raw.toLowerCase());
    if (exact) return { chemicalCodeValue: exact };
    const family = CHEMISTRY_CODES.find((c) => raw.toUpperCase().includes(c.split(' ').pop()!.toUpperCase()));
    return family ? { chemicalCodeValue: family, additionallyPossibleValue: raw } : { chemicalCodeValue: raw };
}

const pct = (v: number) => ({ percentageValue: Number(v), percent: '%' });

export function guideDppId(passportId: string): string {
    return `urn:odatano:passport:${passportId}`;
}

export function buildGuideDocument(
    p: PassportRow, batteries: BatteryRow[], recycled: RecycledRow[], attrs: AttributeRow[],
): Record<string, unknown> {
    const b = batteries[0] ?? {};
    const shareByMaterial: Record<string, number> = {};
    for (const r of recycled) if (r.material && r.recycledPercentage != null) shareByMaterial[r.material] = Number(r.recycledPercentage);

    const identifiers: Record<string, unknown> = {
        DPPSchemaVersion: '1.0.0',
        DPPStatus: { dppStatusValue: 'Active' },
        DPPGranularity: 'BatteryUnit',
        'Date-timeOfLatestUpdateOfDPP': new Date(p.modifiedAt ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        BatteryModelIdentifier: p.model ?? undefined,
        UniqueBatteryPassportIdentifierUniqueDPPIdentifier: guideDppId(p.passportId),
        UniqueBatteryIdentifierUniqueProductIdentifier: `urn:odatano:battery:${p.passportId}`,
        ...(b.serialNumber ? { BatterySerialNumber: b.serialNumber } : {}),
        UniqueManufacturerIdentifier: p.manufacturerId ?? undefined,
        ...(p.manufactureDate ? { ManufacturingDate: p.manufactureDate } : {}),
        ...(p.batteryCategory
            ? { BatteryCategory: { batteryCategoryValue: CATEGORY_LABEL[p.batteryCategory] ?? p.batteryCategory } }
            : {}),
        ...(p.weightKg != null ? { BatteryMass: { gramKgValue: Number(p.weightKg), gramKg: 'kg' } } : {}),
    };

    const performance: Record<string, unknown> = {
        // Usable-energy is an EV-guide attribute; the LMT and industrial
        // guides reject it, so it is only emitted for EV passports.
        ...(b.capacityKwh != null && (p.batteryCategory ?? 'EV') === 'EV'
            ? { CertifiedUsableBatteryEnergy: { kilowattHourValue: Number(b.capacityKwh), kilowattHour: 'kWh' } }
            : {}),
        ...(b.roundTripEfficiencyPct != null ? { InitialRoundTripEnergyEfficiency: pct(b.roundTripEfficiencyPct) } : {}),
        ...(b.cycleLife != null ? { 'ExpectedLifetime-NumberOfCharge-dischargeCycles': Number(b.cycleLife) } : {}),
    };

    const carbon: Record<string, unknown> = {
        ...(b.carbonFootprintKgCO2 != null && b.capacityKwh
            ? {
                BatteryCarbonFootprintPerFunctionalUnit: {
                    'kgCO2-equivalentPerKilowattHourValue':
                        Math.round((Number(b.carbonFootprintKgCO2) / Number(b.capacityKwh)) * 10) / 10,
                    'kgCO2-equivalentPerKilowattHour': 'kgCO2-eq/kWh',
                },
            }
            : {}),
        ...(p.performanceClass ? { CarbonFootprintPerformanceClass: p.performanceClass } : {}),
        ...(b.carbonFootprintKgCO2 != null
            ? {
                AbsoluteBatteryCarbonFootprint: {
                    'kgCO2-equivalentValue': Math.round(Number(b.carbonFootprintKgCO2)),
                    'kgCO2-equivalent': 'kgCO2-eq',
                },
            }
            : {}),
    };

    const materials: Record<string, unknown> = {
        ...(b.cellChemistry ? { BatteryChemistry: chemistryCode(b.cellChemistry) } : {}),
    };

    const circularity: Record<string, unknown> = {
        ...(shareByMaterial.Ni != null ? { 'Post-consumerRecycledNickelShare': pct(shareByMaterial.Ni) } : {}),
        ...(shareByMaterial.Co != null ? { 'Post-consumerRecycledCobaltShare': pct(shareByMaterial.Co) } : {}),
        ...(shareByMaterial.Li != null ? { 'Post-consumerRecycledLithiumShare': pct(shareByMaterial.Li) } : {}),
        ...(shareByMaterial.Pb != null ? { RecycledLeadShare: pct(shareByMaterial.Pb) } : {}),
    };

    const sections: Record<string, Record<string, unknown>> = {
        IdentifiersAndProductData: identifiers,
        PerformanceAndDurability: performance,
        BatteryCarbonFootprint: carbon,
        BatteryMaterialsAndComposition: materials,
        CircularityAndResourceEfficiency: circularity,
        SupplyChainDueDiligence: {},
        SymbolsLabelsAndDocumentationOfConformity: {},
    };
    for (const a of attrs) {
        if (!a.section || !a.attribute || a.valueJson == null) continue;
        const target = (sections[a.section] ??= {});
        if (!(a.attribute in target)) {
            try { target[a.attribute] = JSON.parse(a.valueJson); } catch { /* skip malformed row */ }
        }
    }

    const bp: Record<string, unknown> = {};
    for (const [name, sec] of Object.entries(sections)) {
        if (Object.keys(sec).length) bp[name] = sec;
    }
    // Drop undefined leaves for a clean document.
    return JSON.parse(JSON.stringify({ Battery_Passport: bp }));
}
