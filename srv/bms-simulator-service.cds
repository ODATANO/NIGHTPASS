/**
 * BmsSimulatorService: simulated BMS telemetry for demos and tests. Real ERP
 * ingestion runs through the HMAC webhooks (/erp-events, /api/v1/passport/
 * telemetry) and the S/4 bridge; this service only fabricates telemetry
 * frames for existing passports.
 */
@path: '/api/v1/bms-sim'
service BmsSimulatorService {

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
