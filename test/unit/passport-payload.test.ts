import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { payloadFromDb, PAYLOAD_VERSION } from '../../srv/lib/passport-payload';
import { hashPayload } from '../../srv/lib/passport-anchor';
import { defaultGuideAttributes } from '../../srv/lib/guide-attribute-defaults';

const attrs = defaultGuideAttributes({ passportId: 'BAT-RE-01', batteryCategory: 'EV' });

const baseInputs = () => ({
    batteries: [{
        serialNumber: 'SN-1', cellChemistry: 'NMC-811', capacityKwh: 75, carbonFootprintKgCO2: 3412.75,
        supplierName: 'CathodeWorks GmbH', recycledContentPct: 12.5, cycleLife: 1800,
        roundTripEfficiencyPct: 96, leadContentPpm: 0.4,
    }],
    recycledMaterials: [
        { material: 'Li', recycledPercentage: 8.25, sourceSupplierName: 'LiLoop Recycling BV' },
        { material: 'Co', recycledPercentage: 16.5, sourceSupplierName: 'ReCobalt Recyclers SA' },
    ],
    diligenceDocs: [{ docType: 'supply-chain-due-diligence-report' }],
    attributes: attrs,
});

describe('payloadFromDb (projection v2)', () => {
    it('carries the version marker and is deterministic', () => {
        const a = payloadFromDb(baseInputs());
        const b = payloadFromDb(baseInputs());
        assert.equal(a.payloadVersion, PAYLOAD_VERSION);
        assert.equal(hashPayload(a).payloadHash, hashPayload(b).payloadHash);
    });

    it('hashes sqlite numbers and pg decimal strings identically', () => {
        const fromSqlite = payloadFromDb(baseInputs());
        const pg = baseInputs();
        pg.batteries[0].capacityKwh = '75.000' as unknown as number;
        pg.batteries[0].carbonFootprintKgCO2 = '3412.750' as unknown as number;
        pg.recycledMaterials[0].recycledPercentage = '8.25' as unknown as number;
        const fromPg = payloadFromDb(pg);
        assert.equal(hashPayload(fromSqlite).payloadHash, hashPayload(fromPg).payloadHash);
    });

    it('is row-order independent (stable business-key sort)', () => {
        const shuffled = baseInputs();
        shuffled.recycledMaterials.reverse();
        assert.equal(
            hashPayload(payloadFromDb(baseInputs())).payloadHash,
            hashPayload(payloadFromDb(shuffled)).payloadHash,
        );
    });

    it('omits null and empty fields instead of hashing them', () => {
        const withNulls = baseInputs();
        (withNulls.batteries[0] as Record<string, unknown>).leadContentPpm = null;
        (withNulls.batteries[0] as Record<string, unknown>).supplierName = '';
        const doc = payloadFromDb(withNulls);
        const battery = (doc.batteries as Record<string, unknown>[])[0];
        assert.equal('leadContentPpm' in battery, false);
        assert.equal('supplierName' in battery, false);
    });

    it('changes the hash when an attribute value changes (telemetry drift)', () => {
        const before = hashPayload(payloadFromDb(baseInputs())).payloadHash;
        const drifted = baseInputs();
        drifted.attributes = drifted.attributes.map((a) =>
            a.attribute === 'CapacityFade' ? { ...a, valueJson: '{"percentageValue":9.9,"percent":"%"}' } : a);
        const after = hashPayload(payloadFromDb(drifted)).payloadHash;
        assert.notEqual(before, after);
    });

    it('changes the hash when uploaded evidence (sha256) is added', () => {
        const before = hashPayload(payloadFromDb(baseInputs())).payloadHash;
        const withEvidence = baseInputs();
        withEvidence.diligenceDocs = [{
            docType: 'supply-chain-due-diligence-report',
            fileName: 'report.pdf', sha256: 'a'.repeat(64),
        } as Record<string, unknown>];
        const after = hashPayload(payloadFromDb(withEvidence)).payloadHash;
        assert.notEqual(before, after);
    });

    // createPassport hashes payloadFromDb over the INPUT-shaped rows before
    // inserting them; the drift check later recomputes over DB-read rows.
    // Pin the equivalence the create-time v2 hash relies on: missing input
    // keys (undefined) and DB nulls project identically.
    it('projects input-shaped rows (undefined fields) and db-read rows (nulls) identically', () => {
        const fromInput = baseInputs();
        delete (fromInput.batteries[0] as Record<string, unknown>).leadContentPpm;
        delete (fromInput.recycledMaterials[1] as Record<string, unknown>).sourceSupplierName;
        const fromDbRead = baseInputs();
        (fromDbRead.batteries[0] as Record<string, unknown>).leadContentPpm = null;
        (fromDbRead.recycledMaterials[1] as Record<string, unknown>).sourceSupplierName = null;
        assert.equal(
            hashPayload(payloadFromDb(fromInput)).payloadHash,
            hashPayload(payloadFromDb(fromDbRead)).payloadHash,
        );
    });

    it('never collides with a v1 hash of the same content (version marker)', () => {
        const inputs = baseInputs();
        const v1Shaped = {
            batteries: inputs.batteries, recycledMaterials: inputs.recycledMaterials,
            diligenceDocs: inputs.diligenceDocs, attributes: inputs.attributes,
        };
        assert.notEqual(
            hashPayload(payloadFromDb(inputs)).payloadHash,
            hashPayload(v1Shaped).payloadHash,
        );
    });
});
