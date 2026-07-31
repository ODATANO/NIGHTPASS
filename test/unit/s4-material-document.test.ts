import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseS4Date, itemsOf, goodsReceiptItems, passportIdFor, docItemKey,
    materialDocumentToPassportInput, toCloudEvent, signErpEventBody,
    applyProductData, ERP_EVENT_TYPE,
    type S4MaterialDocumentHeader, type ProductMaster
} from '../../srv/lib/s4-material-document';
import crypto from 'node:crypto';

// Shape mirrors an API_MATERIAL_DOCUMENT_SRV V2 response (d.results envelope
// stripped by the bridge; nav property keeps its { results } wrapper).
const HEADERS: S4MaterialDocumentHeader[] = [
    {
        MaterialDocumentYear: '2026',
        MaterialDocument: '4900000001',
        PostingDate: '/Date(1753833600000)/',
        DocumentDate: '/Date(1753747200000)/',
        to_MaterialDocumentItem: {
            results: [
                {
                    MaterialDocumentYear: '2026',
                    MaterialDocument: '4900000001',
                    MaterialDocumentItem: '0001',
                    Material: 'EV-BATTERY-75',
                    Plant: '1010',
                    Batch: 'CH-2026-07A',
                    Supplier: '10300001',
                    GoodsMovementType: '101',
                    QuantityInEntryUnit: '1.000',
                    EntryUnit: 'PC'
                },
                {
                    MaterialDocumentYear: '2026',
                    MaterialDocument: '4900000001',
                    MaterialDocumentItem: '0002',
                    Material: 'PACKAGING-FOIL',
                    GoodsMovementType: '101',
                    QuantityInEntryUnit: '400.000',
                    EntryUnit: 'M'
                },
                {
                    MaterialDocumentYear: '2026',
                    MaterialDocument: '4900000001',
                    MaterialDocumentItem: '0003',
                    Material: 'EV-BATTERY-75',
                    GoodsMovementType: '561',
                    QuantityInEntryUnit: '1.000'
                }
            ]
        }
    },
    {
        MaterialDocumentYear: '2026',
        MaterialDocument: '4900000002',
        PostingDate: '/Date(1753920000000)/',
        to_MaterialDocumentItem: {
            results: [
                {
                    MaterialDocumentYear: '2026',
                    MaterialDocument: '4900000002',
                    MaterialDocumentItem: '0001',
                    Material: 'EV-BATTERY-75',
                    GoodsMovementType: '101',
                    GoodsMovementIsCancelled: true
                }
            ]
        }
    }
];

const MASTER: ProductMaster = {
    'EV-BATTERY-75': {
        manufacturerId: 'DE-CELLCO-001',
        batteryCategory: 'EV',
        model: 'PowerCell EV-75',
        performanceClass: 'B',
        weightKg: 432.5,
        battery: {
            cellChemistry: 'NMC-811',
            capacityKwh: 75.0,
            carbonFootprintKgCO2: 3412.75,
            supplierName: 'CathodeWorks GmbH'
        },
        recycledMaterials: [
            { material: 'Co', recycledPercentage: 16.5, sourceSupplierName: 'ReCobalt Recyclers SA' }
        ]
    }
};

describe('parseS4Date', () => {
    it('parses the V2 /Date(ms)/ wrapper to YYYY-MM-DD', () => {
        assert.equal(parseS4Date('/Date(1753833600000)/'), '2025-07-30');
    });
    it('parses the wrapper with a timezone offset suffix', () => {
        assert.equal(parseS4Date('/Date(1753833600000+0000)/'), '2025-07-30');
    });
    it('parses plain ISO dates', () => {
        assert.equal(parseS4Date('2026-03-15'), '2026-03-15');
        assert.equal(parseS4Date('2026-03-15T08:30:00Z'), '2026-03-15');
    });
    it('returns null for absent or garbage input', () => {
        assert.equal(parseS4Date(null), null);
        assert.equal(parseS4Date(undefined), null);
        assert.equal(parseS4Date('not-a-date'), null);
    });
});

describe('goodsReceiptItems', () => {
    it('keeps movement type 101 only and drops cancelled items', () => {
        const items = goodsReceiptItems(HEADERS);
        assert.equal(items.length, 2);
        assert.deepEqual(items.map(r => r.item.MaterialDocumentItem), ['0001', '0002']);
        assert.ok(items.every(r => r.item.GoodsMovementType === '101'));
    });
    it('respects a custom movement-type list', () => {
        const items = goodsReceiptItems(HEADERS, ['561']);
        assert.equal(items.length, 1);
        assert.equal(items[0].item.MaterialDocumentItem, '0003');
    });
    it('handles headers without items and plain-array navs', () => {
        assert.deepEqual(goodsReceiptItems([{ MaterialDocumentYear: '2026', MaterialDocument: '1' }]), []);
        const plain: S4MaterialDocumentHeader = {
            MaterialDocumentYear: '2026', MaterialDocument: '2',
            to_MaterialDocumentItem: [HEADERS[0].to_MaterialDocumentItem!['results' as never][0]] as never
        };
        assert.equal(itemsOf(plain).length, 1);
    });
});

describe('materialDocumentToPassportInput', () => {
    const receipt = goodsReceiptItems(HEADERS)[0];

    it('maps ERP facts plus product master to the flat PassportInput', () => {
        const input = materialDocumentToPassportInput(receipt, MASTER);
        assert.equal(input.passportId, 'BAT-EVBATTERY75-49000000010001');
        assert.equal(input.manufacturerId, 'DE-CELLCO-001');
        assert.equal(input.batteryCategory, 'EV');
        assert.equal(input.model, 'PowerCell EV-75');
        assert.equal(input.manufactureDate, '2025-07-30');
        assert.equal(input.weightKg, 432.5);
        assert.equal(input.performanceClass, 'B');
        assert.equal(input.batteries.length, 1);
        assert.equal(input.batteries[0].serialNumber, 'SN-CH202607A');
        assert.equal(input.batteries[0].cellChemistry, 'NMC-811');
        assert.equal(input.recycledMaterials.length, 1);
        assert.deepEqual(input.diligenceDocs, [{ docType: 'supply-chain-due-diligence-report' }]);
    });

    it('is deterministic: same document maps to the same passportId', () => {
        const a = materialDocumentToPassportInput(receipt, MASTER);
        const b = materialDocumentToPassportInput(receipt, MASTER);
        assert.deepEqual(a, b);
    });

    it('falls back to document/item for the serial when there is no batch', () => {
        const noBatch = { header: receipt.header, item: { ...receipt.item, Batch: undefined } };
        const input = materialDocumentToPassportInput(noBatch, MASTER);
        assert.equal(input.batteries[0].serialNumber, 'SN-4900000001-0001');
    });

    it('prefers the item ManufactureDate over the posting date', () => {
        const withMfg = { header: receipt.header, item: { ...receipt.item, ManufactureDate: '2026-03-15' } };
        assert.equal(materialDocumentToPassportInput(withMfg, MASTER).manufactureDate, '2026-03-15');
    });

    it('throws for materials without a product-master entry', () => {
        const foil = goodsReceiptItems(HEADERS)[1];
        assert.throws(() => materialDocumentToPassportInput(foil, MASTER), /no product-master entry/);
    });

    it('throws when no date source is usable', () => {
        const dateless = {
            header: { ...receipt.header, PostingDate: null, DocumentDate: null },
            item: receipt.item
        };
        assert.throws(() => materialDocumentToPassportInput(dateless, MASTER), /no usable/);
    });
});

describe('cloud event envelope', () => {
    it('produces the exact wire contract the webhook checks', () => {
        const input = materialDocumentToPassportInput(goodsReceiptItems(HEADERS)[0], MASTER);
        const ev = toCloudEvent(input, { source: 'urn:test', id: 'id-1', time: '2026-07-31T00:00:00Z' });
        assert.equal(ev.specversion, '1.0');
        assert.equal(ev.type, ERP_EVENT_TYPE);
        assert.equal(ev.type, 'com.odatano.equinox.goodsreceipt.created');
        assert.equal(ev.data.passportId, input.passportId);
    });

    it('signs the raw body exactly like the server verifies it', () => {
        const raw = JSON.stringify({ hello: 'world' });
        const expected = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(Buffer.from(raw)).digest('hex');
        assert.equal(signErpEventBody(raw, 's3cret'), expected);
    });
});

describe('applyProductData', () => {
    const entry = MASTER['EV-BATTERY-75'];

    it('lets the S/4 net weight win over the configured weight', () => {
        const e = applyProductData(entry, { NetWeight: '5.276', GrossWeight: '5.926', WeightUnit: 'KG' });
        assert.equal(e.weightKg, 5.276);
        assert.equal(e.model, entry.model);
    });

    it('falls back to gross weight and converts grams', () => {
        assert.equal(applyProductData(entry, { GrossWeight: '5926', WeightUnit: 'G' }).weightKg, 5.926);
    });

    it('keeps configured values when S/4 has no usable weight', () => {
        assert.equal(applyProductData(entry, { NetWeight: '0.000', WeightUnit: 'KG' }).weightKg, entry.weightKg);
        assert.equal(applyProductData(entry, { NetWeight: '5', WeightUnit: 'TO' }).weightKg, entry.weightKg);
        assert.equal(applyProductData(entry, null).weightKg, entry.weightKg);
    });

    it('fills a missing model from the product description only', () => {
        const noModel = { ...entry, model: undefined };
        assert.equal(applyProductData(noModel, { description: 'Frame 900' }).model, 'Frame 900');
        assert.equal(applyProductData(entry, { description: 'Frame 900' }).model, entry.model);
    });

    it('mapping rejects an unresolved entry (no model/weight from either side)', () => {
        const receipt = goodsReceiptItems(HEADERS)[0];
        const unresolved: ProductMaster = { 'EV-BATTERY-75': { ...entry, weightKg: undefined } };
        assert.throws(() => materialDocumentToPassportInput(receipt, unresolved), /missing model\/weightKg/);
    });
});

describe('ids and keys', () => {
    const item = goodsReceiptItems(HEADERS)[0].item;
    it('passportIdFor stays inside the safe charset and length budget', () => {
        const id = passportIdFor(item);
        assert.match(id, /^BAT-[A-Z0-9]+-[A-Z0-9]+$/);
        assert.ok(id.length <= 42, `id too long for the 50-char UPI budget: ${id}`);
    });
    it('docItemKey is unique per (year, doc, item)', () => {
        assert.equal(docItemKey(item), '2026/4900000001/0001');
    });
});
