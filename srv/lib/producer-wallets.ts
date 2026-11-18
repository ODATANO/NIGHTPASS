/**
 * Registry of the SERVER-side producer wallets the cockpit can sign with.
 *
 * The cockpit offers two login modes: an in-browser Lace wallet (the user signs
 * every tx themselves) or one of these server wallets (this server holds the
 * key, builds and signs; the NIGHTGATE API pays the fee and submits). Each
 * entry is one independent identity, so a demo can show N producers.
 *
 * Configuration is env-only; secrets never leave the server:
 *
 *   PRODUCER_WALLETS=A,B,C                 ids of the configured wallets
 *   PRODUCER_A_WALLET_MNEMONIC=...         signing secret (never served)
 *   PRODUCER_A_SHIELDED_ADDRESS=...        the wallet's identity = passport `owner`
 *   PRODUCER_A_LABEL=CellCo GmbH           optional display name
 *
 * The single-wallet config (`PRODUCER_WALLET_MNEMONIC`, optionally
 * `PRODUCER_SHIELDED_ADDRESS`) surfaces as the wallet id `default`.
 */
import { mnemonicToSeedSync, validateMnemonic } from 'bip39';

export interface ProducerWallet {
    id: string;
    label: string;
    /** Shielded address; the passport `owner` this wallet's rows are scoped to. */
    owner: string;
    /** True when the signing secret is present (i.e. this wallet can anchor). */
    signingReady: boolean;
    /** Optional attester id (64-hex) from `PRODUCER_<ID>_ATTESTER_ID`; unset = derived from the seed. */
    attesterId?: string;
}

interface ProducerWalletSecrets extends ProducerWallet {
    mnemonic?: string;
}

const LEGACY_ID = 'default';

/** All configured server wallets, secrets included. Server-internal only. */
function registry(): ProducerWalletSecrets[] {
    const out: ProducerWalletSecrets[] = [];

    const ids = String(process.env.PRODUCER_WALLETS ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of ids) {
        const key = id.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
        const mnemonic = process.env[`PRODUCER_${key}_WALLET_MNEMONIC`]?.trim();
        out.push({
            id,
            label: process.env[`PRODUCER_${key}_LABEL`]?.trim() || `Producer ${id}`,
            owner: process.env[`PRODUCER_${key}_SHIELDED_ADDRESS`]?.trim() || '',
            signingReady: !!mnemonic,
            attesterId: process.env[`PRODUCER_${key}_ATTESTER_ID`]?.trim() || undefined,
            mnemonic
        });
    }

    // Single-wallet env, the one the ERP ingest path uses.
    const legacyMnemonic = process.env.PRODUCER_WALLET_MNEMONIC?.trim();
    if (legacyMnemonic && !out.some((w) => w.id === LEGACY_ID)) {
        out.push({
            id: LEGACY_ID,
            label: process.env.PRODUCER_LABEL?.trim() || 'Server wallet',
            owner: process.env.PRODUCER_SHIELDED_ADDRESS?.trim() || '',
            signingReady: true,
            attesterId: process.env.PRODUCER_ATTESTER_ID?.trim() || undefined,
            mnemonic: legacyMnemonic
        });
    }
    return out;
}

/** Public view of the configured server wallets (no secrets). */
export function listProducerWallets(): ProducerWallet[] {
    return registry().map(({ id, label, owner, signingReady }) => ({ id, label, owner, signingReady }));
}

/** Secrets for one wallet id, or undefined. Never leaves the server. */
export function producerWalletSecrets(walletId?: string | null):
    { id: string; mnemonic: string; owner: string; attesterId?: string } | undefined {
    const all = registry();
    const wanted = String(walletId ?? '').trim();
    // No id given: the legacy/default wallet, else the only configured one.
    const w = wanted
        ? all.find((x) => x.id === wanted)
        : (all.find((x) => x.id === LEGACY_ID) ?? (all.length === 1 ? all[0] : undefined));
    if (!w?.mnemonic) return undefined;
    return { id: w.id, mnemonic: w.mnemonic, owner: w.owner, attesterId: w.attesterId };
}

/** The 64-byte BIP39 seed of a mnemonic as hex: what the transaction builder signs with. */
export function producerSeedHex(mnemonic: string): string {
    if (!validateMnemonic(mnemonic)) throw new Error('server wallet mnemonic is not a valid BIP39 phrase');
    return mnemonicToSeedSync(mnemonic).toString('hex');
}
