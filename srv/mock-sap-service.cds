using {mocksap} from '../db/mock-sap-schema';

/**
 * A stand-in ERP goods-receipt feed.
 *
 * Demonstrates the integration pattern: an external system emits goods-receipt
 * events, and NIGHTPASS `generatePassport(batchId)` turns one into a battery
 * passport. The feed is generated on demand (not a static fixture): call
 * `triggerGoodsReceipt` to emit fresh batches, then list them here or pass a
 * batchId to `PassportService.generatePassport`.
 */
@path: '/api/v1/mock-sap'
service MockSapService {

    // Emitted goods-receipts (read-only view of the ERP feed).
    @readonly
    entity GoodsReceipts as projection on mocksap.GoodsReceipts;

    /**
     * Emit `count` fresh goods-receipts (default 1) via the deterministic
     * generator and persist them. Returns the new batch/passport ids so a caller
     * can immediately feed them into `generatePassport`.
     *
     * Producer-gated: the feed is a write path and must not be triggerable by
     * anonymous visitors on a public demo host.
     */
    @(requires: 'producer')
    action triggerGoodsReceipt(count: Integer) returns array of {
        batchId    : String;
        passportId : String;
    };

    /**
     * Emit `ticks` deterministic BMS telemetry frames (default 1, max 20) for a
     * passport and apply them via ProducerService.updateDynamicAttributes. The
     * aging step continues where the passport's attribute history left off, so
     * repeated calls keep degrading the same battery. A stand-in for a real BMS
     * feed; the HTTP twin is POST /api/v1/passport/telemetry.
     */
    @(requires: 'producer')
    action triggerBmsTelemetry(passportId: String, ticks: Integer) returns {
        passportId   : String;
        fromTick     : Integer;
        ticksApplied : Integer;
        updated      : Integer; // attribute updates applied across all ticks
    };
}
