/**
 * Registry of the SERVER-side producer wallets the cockpit can sign with.
 *
 * The cockpit offers two login modes: an in-browser Lace wallet (the user signs
 * every tx themselves) or one of these server wallets (NIGHTGATE holds the key
 * and signs on the server). Each entry is one independent Midnight account, so
 * a demo can show N producers, each anchoring under its own identity.
 *
 * Configuration is env-only; secrets never leave the server:
 *
 *   PRODUCER_WALLETS=A,B,C                 ids of the configured wallets
 *   PRODUCER_A_WALLET_MNEMONIC=...         signing secret (never served)
 *   PRODUCER_A_VIEWING_KEY=...             session key (never served)
 *   PRODUCER_A_SHIELDED_ADDRESS=...        the wallet's identity = passport `owner`
 *   PRODUCER_A_LABEL=CellCo GmbH           optional display name
 *
 * The legacy single-wallet config (`PRODUCER_WALLET_MNEMONIC` /
 * `PRODUCER_VIEWING_KEY`, optionally `PRODUCER_SHIELDED_ADDRESS`) stays
 * supported and surfaces as the wallet id `default`.
 *
 * Addresses come from the env rather than deriving them at runtime on purpose:
 * NIGHTGATE rate-limits the secret-carrying surface (deriveWalletInfo /
 * connectWalletForSigning share a 5-per-hour limiter), so a boot-time derivation
 * of every wallet would eat the budget the signing sessions need.
 * `scripts/make-wallets` writes all four values per wallet.
 */

export interface ProducerWallet {
    id: string;
    label: string;
    /** Shielded address; the passport `owner` this wallet's rows are scoped to. */
    owner: string;
    /** True when both signing secrets are present (i.e. this wallet can anchor). */
    signingReady: boolean;
}

interface ProducerWalletSecrets extends ProducerWallet {
    mnemonic?: string;
    viewingKey?: string;
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
        const viewingKey = process.env[`PRODUCER_${key}_VIEWING_KEY`]?.trim();
        out.push({
            id,
            label: process.env[`PRODUCER_${key}_LABEL`]?.trim() || `Producer ${id}`,
            owner: process.env[`PRODUCER_${key}_SHIELDED_ADDRESS`]?.trim() || '',
            signingReady: !!(mnemonic && viewingKey),
            mnemonic,
            viewingKey
        });
    }

    // Legacy single-wallet env, still the one the ERP ingest path uses.
    const legacyMnemonic = process.env.PRODUCER_WALLET_MNEMONIC?.trim();
    const legacyViewingKey = process.env.PRODUCER_VIEWING_KEY?.trim();
    if (legacyMnemonic && legacyViewingKey && !out.some((w) => w.id === LEGACY_ID)) {
        out.push({
            id: LEGACY_ID,
            label: process.env.PRODUCER_LABEL?.trim() || 'Server wallet',
            owner: process.env.PRODUCER_SHIELDED_ADDRESS?.trim() || '',
            signingReady: true,
            mnemonic: legacyMnemonic,
            viewingKey: legacyViewingKey
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
    { id: string; mnemonic: string; viewingKey: string; owner: string } | undefined {
    const all = registry();
    const wanted = String(walletId ?? '').trim();
    // No id given: the legacy/default wallet, else the only configured one.
    const w = wanted
        ? all.find((x) => x.id === wanted)
        : (all.find((x) => x.id === LEGACY_ID) ?? (all.length === 1 ? all[0] : undefined));
    if (!w?.mnemonic || !w.viewingKey) return undefined;
    return { id: w.id, mnemonic: w.mnemonic, viewingKey: w.viewingKey, owner: w.owner };
}
