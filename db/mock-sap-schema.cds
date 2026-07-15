using { managed } from '@sap/cds/common';

namespace mocksap;

/**
 * Mock SAP goods-receipt source.
 *
 * Stands in for an ERP goods-receipt feed: each row is one inbound batch event
 * (public Point-1 header + the shielded Annex XIII payload as JSON). The
 * NIGHTPASS PassportService `generatePassport(batchId)` reads a row here and
 * mints the passport; `MockSapService.triggerGoodsReceipt` emits fresh rows on
 * demand via the deterministic generator (srv/lib/goods-receipt.ts). Not a
 * static fixture: the stream is generated, not hard-coded.
 */
entity GoodsReceipts : managed {
    key batchId     : String(64);              // ERP batch id (e.g. BATCH-GR-0007)
    passportId      : String(64);              // battery id the passport will carry (Point 1)
    manufacturerId  : String(200);             // Point 1
    batteryCategory : String(20);              // EV | INDUSTRIAL | LMT
    model           : String(200);             // Point 1
    manufactureDate : Date;                    // Point 1
    weightKg        : Decimal(10, 3);          // Point 1
    performanceClass: String(1);               // Point 1
    payloadJson     : LargeString;             // shielded Annex XIII payload (batteries/recycled/diligence)
    status          : String(20) default 'new';// new | consumed (once a passport was generated)
    receivedAt      : Timestamp;               // when the ERP emitted the receipt
}
