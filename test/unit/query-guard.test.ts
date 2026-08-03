import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probingRefs, restrictedProbe } from '../../srv/lib/query-guard';

const RESTRICTED = ['carbonFootprintKgCO2', 'supplierName'];

// CQN shapes as the CAP OData adapter produces them.
const whereFilter = (col: string) => ({
    columns: [{ ref: ['ID'] }],
    where: [{ ref: [col] }, '<', { val: 3000 }],
});

describe('probingRefs', () => {
    it('ignores a bare column in the projection ($select is redaction-safe)', () => {
        const refs = probingRefs([{ ref: ['carbonFootprintKgCO2'] }], true);
        assert.equal(refs.has('carbonFootprintKgCO2'), false);
    });

    it('catches a column referenced inside an aggregate ($apply)', () => {
        const refs = probingRefs(
            [{ func: 'sum', args: [{ ref: ['carbonFootprintKgCO2'] }], as: 'total' }], true);
        assert.equal(refs.has('carbonFootprintKgCO2'), true);
    });

    it('catches nested expression references', () => {
        const refs = probingRefs(
            [{ xpr: [{ ref: ['a'] }, 'and', { xpr: [{ ref: ['supplierName'] }, '=', { val: 'x' }] }] }]);
        assert.equal(refs.has('supplierName'), true);
    });

    it('resolves an association path to its last segment', () => {
        const refs = probingRefs([{ ref: ['battery', 'carbonFootprintKgCO2'] }, '<', { val: 1 }]);
        assert.equal(refs.has('carbonFootprintKgCO2'), true);
    });
});

describe('restrictedProbe', () => {
    it('flags the count oracle: $filter on a restricted column', () => {
        assert.equal(restrictedProbe(whereFilter('carbonFootprintKgCO2'), RESTRICTED), 'carbonFootprintKgCO2');
    });

    it('flags $orderby on a restricted column (sorting leaks the order)', () => {
        const select = { columns: [{ ref: ['ID'] }], orderBy: [{ ref: ['supplierName'], sort: 'asc' }] };
        assert.equal(restrictedProbe(select, RESTRICTED), 'supplierName');
    });

    it('flags groupBy and having', () => {
        assert.equal(restrictedProbe({ groupBy: [{ ref: ['supplierName'] }] }, RESTRICTED), 'supplierName');
        assert.equal(
            restrictedProbe({ having: [{ ref: ['carbonFootprintKgCO2'] }, '>', { val: 1 }] }, RESTRICTED),
            'carbonFootprintKgCO2');
    });

    it('allows an unrestricted filter and a plain projection', () => {
        assert.equal(restrictedProbe(whereFilter('cellChemistry'), RESTRICTED), undefined);
        assert.equal(
            restrictedProbe({ columns: [{ ref: ['carbonFootprintKgCO2'] }, { ref: ['serialNumber'] }] }, RESTRICTED),
            undefined);
    });

    it('is a no-op on a missing or non-object select', () => {
        assert.equal(restrictedProbe(undefined, RESTRICTED), undefined);
        assert.equal(restrictedProbe(null, RESTRICTED), undefined);
    });
});
