import cds from '@sap/cds';
import { generateTelemetry } from './lib/bms-simulator';

const { SELECT } = cds.ql;

/**
 * BmsSimulatorService: simulated BMS telemetry. See bms-simulator-service.cds.
 */
export default class BmsSimulatorService extends cds.ApplicationService {
    override async init(): Promise<void> {
        this.on('triggerBmsTelemetry', this.triggerBmsTelemetry);
        return super.init();
    }

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
}
