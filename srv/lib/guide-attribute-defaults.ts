/**
 * Default BatteryPass-Ready guide attributes + hashableAttributes. Extracted
 * to @odatano/dpp-sdk (payload v2 hashing depends on it); this shim keeps the
 * historical import path stable. Keep the SDK module in sync with
 * scripts/bp-ready-seed-attributes.mjs.
 */
export * from '@odatano/dpp-sdk/battery/guide-defaults';
