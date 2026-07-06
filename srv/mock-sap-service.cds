using { mocksap } from '../db/mock-sap-schema';

/**
 * MockSapService (T21). A stand-in ERP goods-receipt feed.
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
    @readonly entity GoodsReceipts as projection on mocksap.GoodsReceipts;

    /**
     * Emit `count` fresh goods-receipts (default 1) via the deterministic
     * generator and persist them. Returns the new batch/passport ids so a caller
     * can immediately feed them into `generatePassport`.
     */
    action triggerGoodsReceipt(count: Integer) returns array of {
        batchId:    String;
        passportId: String;
    };
}
