import cds from '@sap/cds';
import { GoodsReceipts } from '#cds-models/mocksap';
import { generateGoodsReceipt, goodsReceiptToRow, PREVIEW_RECEIPT, type GoodsReceipt } from './lib/goods-receipt';
import { generateTelemetry } from './lib/bms-simulator';

const { INSERT, SELECT } = cds.ql;

/**
 * MockSapService: a stand-in ERP goods-receipt feed. See mock-sap-service.cds.
 *
 * The feed is generated, not a static fixture: `triggerGoodsReceipt` emits fresh
 * batches through the deterministic generator (srv/lib/goods-receipt.ts), and a
 * one-time seed makes sure the demo is never empty (the canonical
 * BATCH-PREVIEW-0001 plus a few generated batches).
 */
export default class MockSapService extends cds.ApplicationService {
    override async init(): Promise<void> {
        this.on('triggerGoodsReceipt', this.triggerGoodsReceipt);
        this.on('triggerBmsTelemetry', this.triggerBmsTelemetry);
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

    /**
     * Apply `ticks` simulated BMS telemetry frames to a passport. The aging
     * step resumes from the passport's attribute-history high-water mark (max
     * version), so the battery keeps degrading across calls. Bare `send` on
     * ProducerService joins the ambient request tx: all ticks of one call land
     * atomically, and the producer gate on this action provides the principal.
     */
    private triggerBmsTelemetry = async (req: cds.Request) => {
        const { passportId, ticks } = req.data as { passportId?: string; ticks?: number };
        const pid = String(passportId ?? '').trim();
        if (!pid) return req.reject(400, 'passportId is required');
        const rawTicks = Number(ticks ?? 1);
        const count = Math.max(1, Math.min(20, Number.isFinite(rawTicks) ? Math.floor(rawTicks) : 1));

        const passport = await cds.run(
            SELECT.one.from('passport.Passports').columns('ID').where({ passportId: pid })
        ) as { ID?: string } | undefined;
        if (!passport?.ID) return req.reject(404, `passport '${pid}' not found`);

        const attrRows = await cds.run(
            SELECT.from('passport.PassportAttributes').columns('attribute').where({ passport_ID: passport.ID })
        ) as { attribute?: string }[];
        const present = (attrRows ?? []).map((r) => String(r.attribute ?? '')).filter(Boolean);

        const histRows = await cds.run(
            SELECT.from('passport.PassportAttributeHistory').columns('version').where({ passport_ID: passport.ID })
        ) as { version?: number }[];
        let lastTick = 0;
        for (const h of histRows ?? []) lastTick = Math.max(lastTick, Number(h.version ?? 0));

        const producer = await cds.connect.to('ProducerService');
        const fromTick = lastTick + 1;
        let updated = 0;
        for (let tick = fromTick; tick < fromTick + count; tick++) {
            const frame = generateTelemetry(pid, tick, present);
            if (!frame.length) return req.reject(400, `passport '${pid}' has no simulatable dynamic attributes`);
            const result = await (producer as any).send('updateDynamicAttributes', {
                passportId: pid, updatesJson: JSON.stringify(frame), source: 'bms'
            });
            updated += Number(result?.updated ?? 0);
        }
        return { passportId: pid, fromTick, ticksApplied: count, updated };
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
