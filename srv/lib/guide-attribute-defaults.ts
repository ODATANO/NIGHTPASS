/**
 * Default BatteryPass-Ready guide attributes for a newly created passport.
 * One entry per attribute of the official Battery Passport Data Attribute
 * Longlist v1.2 (DIN DKE SPEC 99100) that the typed schema does not model;
 * access classes carry the longlist classification. Values are plausible
 * demo placeholders parameterized by the passport; producers overwrite them
 * with real data via PassportAttributes.
 *
 * Keep in sync with scripts/bp-ready-seed-attributes.mjs (standalone seeder
 * for pre-existing passports).
 */

export interface GuideAttributeRow {
    section: string;
    attribute: string;
    valueJson: string;
    accessClass: 'public' | 'legitimateInterest' | 'authority';
}

const ID = 'IdentifiersAndProductData';
const PERF = 'PerformanceAndDurability';
const CF = 'BatteryCarbonFootprint';
const MAT = 'BatteryMaterialsAndComposition';
const CIRC = 'CircularityAndResourceEfficiency';
const SCDD = 'SupplyChainDueDiligence';
const SYM = 'SymbolsLabelsAndDocumentationOfConformity';

const PUB = 'public' as const;
const LI = 'legitimateInterest' as const;
const AUTH = 'authority' as const;

const pct = (v: number) => ({ percentageValue: v, percent: '%' });
const kgCO2kWh = (v: number) => ({ 'kgCO2-equivalentPerKilowattHourValue': v, 'kgCO2-equivalentPerKilowattHour': 'kgCO2-eq/kWh' });
const celsius = (v: number) => ({ celsiusValue: v, degreeCelsius: '°C' });
const volt = (v: number) => ({ voltValue: v, volt: 'V' });

export function defaultGuideAttributes(p: {
    passportId: string;
    model?: string | null;
    performanceClass?: string | null;
}): GuideAttributeRow[] {
    const pid = p.passportId;
    const urn = (kind: string, rest: string) => `urn:odatano:${kind}:${rest}`;
    const rows: Array<[string, string, unknown, GuideAttributeRow['accessClass']]> = [
        // Identifiers and product data (longlist #3-11)
        [ID, 'UniqueEconomicOperatorIdentifier', 'EORI-DE-CELLCO-001', PUB],
        [ID, 'UniqueFacilityIdentifier', 'GLN-FAC-4098765432101', PUB],
        [ID, 'EconomicOperatorInformation', {
            name: 'CellCo_GmbH',
            registeredTradeNameOrRegisteredTrademark: 'CellCo',
            postalAddress: 'Zellstraße 12, 01067 Dresden, Germany',
            webAddress: 'https://www.cellco.example',
            'e-mailAddress': 'compliance@cellco.example',
        }, PUB],
        [ID, 'ManufacturerInformation', {
            name: 'CellCo_Manufacturing_GmbH',
            registeredTradeNameOrRegisteredTrademark: 'CellCo Manufacturing',
            postalAddress: 'Werkallee 3, 01069 Dresden, Germany',
            webAddress: 'https://www.cellco-manufacturing.example',
        }, PUB],
        [ID, 'ManufacturingPlace', 'Dresden, Germany', PUB],
        [ID, 'WarrantyPeriodOfTheBattery', '2034-07-01', PUB],
        [ID, 'BatteryStatus', { batteryStatusValues: 'original' }, LI],

        // Performance and durability (longlist #52-93)
        [PERF, 'RatedCapacity', { amperehourMiliamperehourValue: 200, ampereHourMiliamperehour: 'Ah' }, PUB],
        [PERF, 'CapacityFade', pct(0.8), LI],
        [PERF, 'StateOfCertifiedEnergySOCE', pct(99.2), LI],
        [PERF, 'StateOfChargeSoC', pct(64.0), LI],
        [PERF, 'MinimumVoltage', volt(280.0), PUB],
        [PERF, 'MaximumVoltage', volt(420.0), PUB],
        [PERF, 'NominalVoltage', volt(370.0), PUB],
        [PERF, 'OriginalPowerCapability', { wattValueAt80SoC: 150000, wattValueAt20SoC: 120000, watt: 'W' }, PUB],
        [PERF, 'PowerFade', pct(0.9), LI],
        [PERF, 'MaximumPermittedBatteryPower', { wattValue: 150000, watt: 'W' }, PUB],
        [PERF, 'InitialRoundTripEnergyEfficiency', pct(96.0), PUB],
        [PERF, 'RoundTripEnergyEfficiencyAt50OfCycleLife', pct(94.2), PUB],
        [PERF, 'EnergyRoundTripEfficiencyFade', pct(0.4), LI],
        [PERF, 'InitialInternalResistanceOfBatteryCellAndPackModuleRecommended', { ohmValue: 14, ohm: 'Ohm' }, PUB],
        [PERF, 'InternalResistanceIncreaseOfPackCellAndModuleRecommended', pct(2.1), LI],
        [PERF, 'ExpectedLifetimeInCalendarYears', 12, LI],
        [PERF, 'ExpectedLifetime-NumberOfCharge-dischargeCycles', 1800, PUB],
        [PERF, 'NumberOfFullChargingAndDischargingCycles', 14, LI],
        [PERF, 'Cycle-lifeReferenceTest', 'IEC 62660-1:2018 / UN 38.3', PUB],
        [PERF, 'C-rateOfRelevantCycle-lifeTest', { amperePerAmpereHourValue: 0.5, amperePerAmpereHour: 'A/Ah' }, PUB],
        [PERF, 'CapacityThresholdForExhaustion', pct(80.0), PUB],
        [PERF, 'TemperatureInformation', celsius(23), LI],
        [PERF, 'TemperatureRangeIdleStateLowerBoundary', celsius(-20), PUB],
        [PERF, 'TemperatureRangeIdleStateUpperBoundary', celsius(55), PUB],
        [PERF, 'InformationOnAccidents', urn('accidents', pid), LI],

        // Carbon footprint (longlist #20-25)
        [CF, 'ContributionOfRawMaterialAcquisitionAndPre-processingLifecycleStage', kgCO2kWh(21.3), PUB],
        [CF, 'ContributionOfMainProductProductionLifecycleStage', kgCO2kWh(17.4), PUB],
        [CF, 'ContributionOfDistributionLifecycleStage', kgCO2kWh(2.6), PUB],
        [CF, 'ContributionOfEndOfLifeAndRecyclingLifecycleStage', kgCO2kWh(4.2), PUB],
        [CF, 'WebLinkToPublicCarbonFootprintStudy', urn('docs', `carbon-footprint-study-${pid}`), PUB],

        // Materials and composition (longlist #32-35)
        [MAT, 'CriticalRawMaterials', 'Cobalt (Co), Lithium (Li), Nickel (Ni), Natural graphite', PUB],
        [MAT, 'HazardousSubstances', 'Lithium hexafluorophosphate (LiPF6) electrolyte salt', PUB],
        [MAT, 'MaterialsUsedInCathodeAnodeAndElectrolyte', 'Cathode: NMC 811; Anode: Synthetic graphite; Electrolyte: LiPF6 in EC/EMC', LI],
        [MAT, 'ImpactOfSubstancesOnEnvironmentHumanHealthSafetyPersons', 'Contains substances of very high concern; see safety data sheet for handling and end-of-life guidance.', PUB],

        // Circularity and resource efficiency (longlist #36-51)
        [CIRC, 'DismantlingInformation-ManualsForTheRemovalAndTheDisassemblyOfTheBatteryPack', urn('docs', `disassembly-manual-${pid}`), LI],
        [CIRC, 'PartNumbersForComponents', urn('parts', String(p.model ?? pid).replaceAll(' ', '-')), LI],
        [CIRC, 'InformationOnSourcesOfSpareParts', urn('parts', 'spares-info'), LI],
        [CIRC, 'SafetyMeasures', urn('docs', `safety-measures-${pid}`), LI],
        [CIRC, 'Pre-consumerRecycledNickelShare', pct(4.0), PUB],
        [CIRC, 'Pre-consumerRecycledCobaltShare', pct(3.5), PUB],
        [CIRC, 'Pre-consumerRecycledLithiumShare', pct(2.0), PUB],
        [CIRC, 'Post-consumerRecycledNickelShare', pct(6.1), PUB],
        [CIRC, 'Post-consumerRecycledLithiumShare', pct(7.9), PUB],
        [CIRC, 'RecycledLeadShare', pct(0.0), PUB],
        [CIRC, 'RenewableContentShare', pct(0.0), PUB],
        [CIRC, 'InformationOnTheRoleOfEnd-usersInContributingToWastePrevention', urn('docs', 'enduser-waste-prevention'), PUB],
        [CIRC, 'InformationOnTheRoleOfEnd-usersInContributingToTheSeparateCollectionOfWasteBatteries', urn('docs', 'enduser-separate-collection'), PUB],
        [CIRC, 'InformationOnBatteryCollectionPreparationForSecondLifeAndOnTreatmentAtEndOfLife', urn('docs', 'enduser-end-of-life-treatment'), PUB],

        // Supply chain due diligence (longlist #28-30)
        [SCDD, 'InformationOfDueDiligenceReport', urn('docs', `supply-chain-due-diligence-${pid}`), PUB],
        [SCDD, 'ThirdPartyAssurancesOfRecognisedSchemes', 'Cobalt: Responsible Minerals Initiative (RMI) audited', PUB],
        [SCDD, 'SupplyChainIndices', 'Cobalt origin: Australia (60%), Canada (40%)', PUB],

        // Symbols, labels, conformity (longlist #12-18)
        [SYM, 'SeparateCollectionSymbol', urn('labels', 'weee-symbol'), PUB],
        [SYM, 'SymbolsForCadmiumAndLead', urn('labels', 'cadmium-lead-symbol'), PUB],
        [SYM, 'CarbonFootprintLabel', urn('labels', `carbon-footprint-class-${p.performanceClass ?? 'B'}`), PUB],
        [SYM, 'ExtinguishingAgent', { agentFireClass: 'Class B / Class E', extinguishingAgent: 'CO2 or dry powder; water fog acceptable for cooling' }, PUB],
        [SYM, 'MeaningOfLabelsAndSymbols', 'Label legend at https://www.cellco.example/labels', PUB],
        [SYM, 'EUDeclarationOfConformity', urn('compliance', `EU-DoC-${pid}`), PUB],
        [SYM, 'ResultsOfTestReportsProvingCompliance', urn('compliance', `test-reports-${pid}`), AUTH],
    ];
    return rows.map(([section, attribute, value, accessClass]) => ({
        section, attribute, valueJson: JSON.stringify(value), accessClass,
    }));
}

/**
 * Canonical, order-stable projection of attribute rows for the anchored
 * payload hash: sorted by attribute name so INSERT order never changes the
 * hash. Including accessClass makes the classification itself tamper-evident.
 */
export function hashableAttributes(rows: GuideAttributeRow[]): GuideAttributeRow[] {
    return [...rows]
        .map(({ section, attribute, valueJson, accessClass }) => ({ section, attribute, valueJson, accessClass }))
        .sort((a, b) => a.attribute.localeCompare(b.attribute));
}
