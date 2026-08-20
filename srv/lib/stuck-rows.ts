/**
 * Boot-time sweep decisions for stranded in-flight rows. Extracted to
 * @odatano/dpp-sdk; this shim keeps the historical import path stable.
 * The SDK exports its own ChainVerdict type, structurally identical to
 * chain-verify's.
 */
export * from '@odatano/dpp-sdk/battery/stuck-rows';
