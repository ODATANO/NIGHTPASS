import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    generateGoodsReceipt, goodsReceiptToRow, rowToBatch, PREVIEW_RECEIPT,
    type GoodsReceipt
} from '../../srv/lib/goods-receipt';

describe('generateGoodsReceipt', () => {
    it('is deterministic: same seq gives a byte-identical receipt', () => {
        assert.deepEqual(generateGoodsReceipt(7), generateGoodsReceipt(7));
    });

    it('distinct seqs give distinct batch and passport ids', () => {
        const a = generateGoodsReceipt(1);
        const b = generateGoodsReceipt(2);
        assert.notEqual(a.batchId, b.batchId);
        assert.notEqual(a.passportId, b.passportId);
    });

    it('emits a varied stream (not one static batch)', () => {
        const models = new Set<string>();
        const chems = new Set<string>();
        for (let i = 1; i <= 10; i++) {
            const gr = generateGoodsReceipt(i);
            models.add(gr.public.model);
            chems.add(gr.payload.batteries[0].cellChemistry);
        }
        assert.ok(models.size > 1, 'models should vary across the stream');
        assert.ok(chems.size > 1, 'cell chemistries should vary across the stream');
    });

    it('ids are zero-padded and consistent (BATCH-GR-#### / BAT-GR-####)', () => {
        const gr = generateGoodsReceipt(42);
        assert.equal(gr.batchId, 'BATCH-GR-0042');
        assert.equal(gr.passportId, 'BAT-GR-0042');
    });

    it('produces regulation-valid header fields', () => {
        for (let i = 1; i <= 20; i++) {
            const gr = generateGoodsReceipt(i);
            assert.ok(['EV', 'INDUSTRIAL', 'LMT'].includes(gr.public.batteryCategory));
            assert.match(gr.public.performanceClass, /^[A-G]$/);
            assert.match(gr.public.manufactureDate, /^2026-\d{2}-\d{2}$/);
            assert.ok(gr.public.weightKg > 0);
            assert.equal(gr.payload.recycledMaterials.length, 3);
        }
    });

    it('rejects a non-positive or non-integer seq', () => {
        assert.throws(() => generateGoodsReceipt(0));
        assert.throws(() => generateGoodsReceipt(-1));
        assert.throws(() => generateGoodsReceipt(1.5));
    });
});

describe('goodsReceiptToRow / rowToBatch', () => {
    it('round-trips a receipt through the persisted row shape', () => {
        const gr = generateGoodsReceipt(3);
        const back = rowToBatch(goodsReceiptToRow(gr));
        assert.deepEqual(back, gr);
    });

    it('defaults status to "new" and serializes the shielded payload as JSON', () => {
        const row = goodsReceiptToRow(generateGoodsReceipt(1));
        assert.equal(row.status, 'new');
        assert.doesNotThrow(() => JSON.parse(row.payloadJson));
    });

    it('rowToBatch throws on invalid payloadJson', () => {
        const row = { ...goodsReceiptToRow(generateGoodsReceipt(1)), payloadJson: '{not json' };
        assert.throws(() => rowToBatch(row), /invalid payloadJson/);
    });
});

describe('PREVIEW_RECEIPT', () => {
    it('keeps the canonical demo ids', () => {
        assert.equal(PREVIEW_RECEIPT.batchId, 'BATCH-PREVIEW-0001');
        assert.equal(PREVIEW_RECEIPT.passportId, 'BAT-PREVIEW-0001');
    });

    it('keeps the byte-stable legacy payload (guards passportHash drift)', () => {
        const b = PREVIEW_RECEIPT.payload.batteries[0];
        assert.equal(b.serialNumber, 'SN-AX-0001');
        assert.equal(b.carbonFootprintKgCO2, 3412.75);
        assert.equal(b.capacityKwh, 75.0);
        assert.equal(PREVIEW_RECEIPT.public.weightKg, 432.5);
        const co = PREVIEW_RECEIPT.payload.recycledMaterials.find((m) => m.material === 'Co');
        assert.equal(co?.recycledPercentage, 16.5);
    });

    it('round-trips like any generated receipt', () => {
        const back: GoodsReceipt = rowToBatch(goodsReceiptToRow(PREVIEW_RECEIPT));
        assert.deepEqual(back, PREVIEW_RECEIPT);
    });
});
