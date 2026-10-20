import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    BATTERY_DOCUMENT, DocumentStore, filterDocument, roleLevel, mergePatch, splitElementPath,
    getElement, patchElement, productIdOf,
} from '../../srv/lib/dpp-store';
import { canRead } from '@odatano/dpp-sdk/access';

/**
 * Pure logic of the BatteryPass-Ready conformance adapter: versioned store
 * semantics (new active version per update, archived/deleted invisible to
 * normal reads), RFC 7396 merge patch, element-path resolution and the
 * role-based document filtering that mirrors the longlist access classes.
 */

const DOC = {
    Battery_Passport: {
        IdentifiersAndProductData: {
            UniqueBatteryIdentifierUniqueProductIdentifier: 'urn:x:prod-1',
            BatteryModelIdentifier: 'Model X',
            BatteryStatus: { batteryStatusValues: 'original' },
        },
        PerformanceAndDurability: {
            RatedCapacity: { amperehourMiliamperehourValue: 200 },
            StateOfChargeSoC: { percentageValue: 64 },
        },
        SymbolsLabelsAndDocumentationOfConformity: {
            EUDeclarationOfConformity: 'urn:x:doc',
            ResultsOfTestReportsProvingCompliance: 'urn:x:secret',
        },
    },
};

describe('role filtering', () => {
    it('public sees only public attributes', () => {
        const f = filterDocument(BATTERY_DOCUMENT, DOC, roleLevel('public')) as any;
        const bp = f.Battery_Passport;
        assert.equal(bp.IdentifiersAndProductData.BatteryModelIdentifier, 'Model X');
        assert.equal(bp.IdentifiersAndProductData.BatteryStatus, undefined);
        assert.equal(bp.PerformanceAndDurability.StateOfChargeSoC, undefined);
        assert.equal(bp.PerformanceAndDurability.RatedCapacity.amperehourMiliamperehourValue, 200);
        assert.equal(bp.SymbolsLabelsAndDocumentationOfConformity.ResultsOfTestReportsProvingCompliance, undefined);
    });
    it('legitimate_interest sees LI but not authority-only', () => {
        const f = filterDocument(BATTERY_DOCUMENT, DOC, roleLevel('legitimate_interest')) as any;
        const bp = f.Battery_Passport;
        assert.ok(bp.IdentifiersAndProductData.BatteryStatus);
        assert.ok(bp.PerformanceAndDurability.StateOfChargeSoC);
        assert.equal(bp.SymbolsLabelsAndDocumentationOfConformity.ResultsOfTestReportsProvingCompliance, undefined);
    });
    it('authority and commission see everything', () => {
        for (const role of ['authority', 'commission'] as const) {
            const f = filterDocument(BATTERY_DOCUMENT, DOC, roleLevel(role)) as any;
            assert.equal(
                f.Battery_Passport.SymbolsLabelsAndDocumentationOfConformity.ResultsOfTestReportsProvingCompliance,
                'urn:x:secret',
            );
        }
    });
    it('role to access-class matrix', () => {
        assert.equal(canRead(roleLevel('public'), 'public'), true);
        assert.equal(canRead(roleLevel('public'), 'legitimateInterest'), false);
        assert.equal(canRead(roleLevel('legitimate_interest'), 'authority'), false);
        assert.equal(canRead(roleLevel('commission'), 'authority'), true);
    });
});

describe('merge patch (RFC 7396)', () => {
    it('merges nested objects, null deletes, scalars replace', () => {
        const out = mergePatch({ a: { b: 1, c: 2 }, d: 3 }, { a: { b: 9, c: null }, e: 4 }) as any;
        assert.deepEqual(out, { a: { b: 9 }, d: 3, e: 4 });
    });
    it('replaces arrays and non-objects wholesale', () => {
        assert.deepEqual(mergePatch({ a: [1, 2] }, { a: [3] }), { a: [3] });
        assert.equal(mergePatch({ x: 1 }, 5), 5);
    });
});

describe('element paths', () => {
    it('splits on /, . and : and tolerates the wrapper segment', () => {
        assert.deepEqual(splitElementPath('Battery_Passport/PerformanceAndDurability/RatedCapacity'),
            ['Battery_Passport', 'PerformanceAndDurability', 'RatedCapacity']);
        const viaDots = getElement(BATTERY_DOCUMENT, DOC, splitElementPath('PerformanceAndDurability.RatedCapacity'));
        const viaWrapper = getElement(BATTERY_DOCUMENT, DOC, splitElementPath('Battery_Passport/PerformanceAndDurability/RatedCapacity'));
        assert.deepEqual(viaDots, viaWrapper);
    });
    it('patchElement creates a new document and can delete via null', () => {
        const patched = patchElement(BATTERY_DOCUMENT, DOC, ['PerformanceAndDurability', 'RatedCapacity'], { amperehourMiliamperehourValue: 180 }) as any;
        assert.equal(patched.Battery_Passport.PerformanceAndDurability.RatedCapacity.amperehourMiliamperehourValue, 180);
        assert.equal((DOC as any).Battery_Passport.PerformanceAndDurability.RatedCapacity.amperehourMiliamperehourValue, 200);
        const deleted = patchElement(BATTERY_DOCUMENT, DOC, ['PerformanceAndDurability'], { StateOfChargeSoC: null }) as any;
        assert.equal(deleted.Battery_Passport.PerformanceAndDurability.StateOfChargeSoC, undefined);
    });
    it('productIdOf reads the guide identifier', () => {
        assert.equal(productIdOf(BATTERY_DOCUMENT, DOC), 'urn:x:prod-1');
    });
});

describe('DocumentStore versioning', () => {
    it('update supersedes with a new active version; history stays readable by date', () => {
        const s = new DocumentStore(BATTERY_DOCUMENT);
        const v1 = s.insert({ dppId: 'dpp-1', productId: 'p-1', document: { a: 1 }, at: '2026-01-01T00:00:00Z' });
        assert.equal(v1.version, 1);
        const v2 = s.update('dpp-1', { a: 2 }, '2026-06-01T00:00:00Z');
        assert.equal(v2?.version, 2);
        assert.deepEqual(s.current('dpp-1')?.document, { a: 2 });
        assert.deepEqual(s.byProductAndDate('p-1', '2026-03-01T00:00:00Z')?.document, { a: 1 });
        assert.deepEqual(s.byProductAndDate('p-1', '2026-07-01T00:00:00Z')?.document, { a: 2 });
    });
    it('archived and deleted DPPs 404 on normal reads', () => {
        const s = new DocumentStore(BATTERY_DOCUMENT);
        s.insert({ dppId: 'dpp-a', productId: 'p-a', status: 'archived', document: {} });
        assert.equal(s.current('dpp-a'), undefined);
        s.insert({ dppId: 'dpp-d', productId: 'p-d', document: {} });
        assert.equal(s.delete('dpp-d')?.status, 'deleted');
        assert.equal(s.current('dpp-d'), undefined);
        assert.equal(s.activeByProduct('p-d'), undefined);
        assert.equal(s.update('dpp-d', { x: 1 }), undefined);
    });
    it('bringBatteryToMarket activates a draft by product id', () => {
        const s = new DocumentStore(BATTERY_DOCUMENT);
        s.insert({ dppId: 'dpp-m', productId: 'p-m', status: 'draft', document: { ok: true } });
        assert.equal(s.activeByProduct('p-m'), undefined);
        const row = s.activateByProduct('p-m');
        assert.equal(row?.status, 'active');
        assert.deepEqual(s.activeByProduct('p-m')?.document, { ok: true });
    });
    it('insert derives the product id from the document when omitted', () => {
        const s = new DocumentStore(BATTERY_DOCUMENT);
        const row = s.insert({ document: DOC });
        assert.equal(row.productId, 'urn:x:prod-1');
        assert.ok(row.dppId.startsWith('urn:odatano:dpp:'));
    });
});
