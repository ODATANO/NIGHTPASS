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
}
