import cds from '@sap/cds';
import { GoodsReceipts } from '#cds-models/mocksap';
import { generateGoodsReceipt, goodsReceiptToRow, PREVIEW_RECEIPT, type GoodsReceipt } from './lib/goods-receipt';

const { INSERT, SELECT } = cds.ql;

/**
 * MockSapService (T21). A stand-in ERP goods-receipt feed. See mock-sap-service.cds.
 *
 * The feed is generated, not a static fixture: `triggerGoodsReceipt` emits fresh
 * batches through the deterministic generator (srv/lib/goods-receipt.ts), and a
 * one-time seed makes sure the demo is never empty (the canonical
 * BATCH-PREVIEW-0001 plus a few generated batches).
 */
export default class MockSapService extends cds.ApplicationService {
    override async init(): Promise<void> {
        this.on('triggerGoodsReceipt', this.triggerGoodsReceipt);
        // Seed once, after the DB is up. Best-effort: a seeding failure must not
        // block serving (e.g. tables not deployed yet in some dev flows).
        cds.once('served', () => {
            this.seedIfEmpty().catch((e) => cds.log('mock-sap').warn('seed skipped:', (e as Error)?.message));
        });
        return super.init();
    }

    /** Highest emitted BATCH-GR-#### sequence, 0 if none yet. */
    private async lastSeq(): Promise<number> {
        const rows = await SELECT.from(GoodsReceipts).columns('batchId') as { batchId?: string }[];
        let max = 0;
        for (const r of rows ?? []) {
            const m = /^BATCH-GR-(\d+)$/.exec(String(r.batchId ?? ''));
            if (m) max = Math.max(max, Number(m[1]));
        }
        return max;
    }

    private async insertReceipt(gr: GoodsReceipt): Promise<void> {
        // Cast on entries: cds-typer types `manufactureDate` as a template-literal
        // date, which a plain ISO string does not satisfy. Same pattern as the
        // other CAP inserts in this codebase.
        await INSERT.into(GoodsReceipts).entries({
            ...goodsReceiptToRow(gr),
            receivedAt: new Date().toISOString()
        } as any);
    }

    private triggerGoodsReceipt = async (req: cds.Request) => {
        const raw = Number((req.data as { count?: number }).count ?? 1);
        const count = Math.max(1, Math.min(50, Number.isFinite(raw) ? Math.floor(raw) : 1));
        const start = (await this.lastSeq()) + 1;
        const out: { batchId: string; passportId: string }[] = [];
        for (let k = 0; k < count; k++) {
            const gr = generateGoodsReceipt(start + k);
            await this.insertReceipt(gr);
            out.push({ batchId: gr.batchId, passportId: gr.passportId });
        }
        return out;
    };

    /** Populate a baseline feed on first boot so the demo is exercisable. */
    private async seedIfEmpty(): Promise<void> {
        const existing = await SELECT.one.from(GoodsReceipts).columns('batchId');
        if (existing) return;
        await this.insertReceipt(PREVIEW_RECEIPT);
        for (let seq = 1; seq <= 3; seq++) await this.insertReceipt(generateGoodsReceipt(seq));
        cds.log('mock-sap').info('seeded goods-receipt feed (BATCH-PREVIEW-0001 + 3 generated)');
    }
}
