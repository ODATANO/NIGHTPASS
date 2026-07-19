namespace demo;

using { cuid, managed } from '@sap/cds/common';

/**
 * "Try it" live demo: anonymous testers anchor a small sponsored passport.
 * Tester wallet secrets are encrypted at rest (AES-256-GCM, HKDF from
 * ENCRYPTION_KEY); nothing here is ever exposed through a service entity.
 */
entity Testers : cuid, managed {
    /** Opaque bearer handle the browser stores; independent of the row key. */
    testerId        : String(36);
    nickname        : String(24);
    /** Encrypted 64-byte BIP39 seed hex (the wallet's signing secret). */
    encSeedHex      : LargeString;
    /** Encrypted NIGHTGATE viewing key (zswap encryption public key hex). */
    encViewingKey   : LargeString;
    shieldedAddress : String(200);
    nightAddress    : String(200);
    /** Hashed client IP, the per-IP cap key. */
    clientKey       : String(64);
    passportCount   : Integer default 0;
}

/** One demo run = one passport lifecycle; feeds the UI timeline. */
entity Runs : cuid, managed {
    tester     : Association to Testers;
    passportId : String(60);
    /** queued | wallet | anchoring | proving | publishing | done | failed */
    state      : String(20);
    /** JSON array of { kind, label, txHash?, explorerUrl?, status } steps. */
    stepsJson  : LargeString;
    error      : String(500);
    /** Scaled (milli-unit) threshold of the CO2 claim. */
    threshold  : Integer64;
    clientKey  : String(64);
}
