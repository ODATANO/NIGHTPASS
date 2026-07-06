import cds from '@sap/cds';

/**
 * Structural verification of a client-reported transaction hash against the
 * NIGHTGATE chain indexer.
 *
 * The wallet-driven cockpit callbacks (recordWalletAttest / recordWalletDisclosure
 * / recordWalletPredicate) receive a txHash from the browser. That claim must not
 * be trusted on its own. Before a passport is marked anchored, a grant honored, or
 * a proof recorded, the tx has to be found on-chain, have succeeded, and actually
 * touch the expected AttestationVault contract.
 *
 * The indexer tables are the plugin's own (`midnight.*`), read from the shared DB
 * exactly like the disclosure gate reads `midnight.DisclosureGrants`. When the
 * crawler is disabled (the demo default) these tables stay empty, so a tx can not
 * be confirmed here. That is by design: the verdict is then `unknown`, and the
 * caller keeps the row PENDING rather than claiming a false success.
 */

export type ChainVerdict = 'confirmed' | 'failed' | 'unknown';

export interface ChainCheckOpts {
    /** AttestationVault deployment the tx must act on (hex, 0x optional). */
    contractAddress?: string | null;
    /** Expected circuit / entry point (e.g. 'attest', 'grantDisclosure'). */
    circuit?: string;
}

const norm = (h?: string | null): string => String(h ?? '').replace(/^0x/, '').toLowerCase();

async function readOne(entity: string, where: Record<string, unknown>, columns: string[]): Promise<Record<string, unknown> | null> {
    const rows: unknown = await cds.db.read(entity).columns(...columns).where(where);
    if (Array.isArray(rows)) return (rows[0] as Record<string, unknown>) ?? null;
    return (rows as Record<string, unknown>) ?? null;
}

/**
 * Verify that `txHash` is an on-chain, succeeded call to the expected contract.
 *
 *   'confirmed': indexed, result SUCCESS/PARTIAL_SUCCESS, and (when given) it
 *                touches the expected contract / circuit.
 *   'failed':    indexed but the result is FAILURE, or the tx does not touch the
 *                expected contract / circuit (a mismatched or unrelated tx).
 *   'unknown':   not indexed yet, or the indexer is disabled. The caller keeps
 *                the row pending and a tracker re-checks later.
 */
export async function verifyContractTx(txHash: string | null | undefined, opts: ChainCheckOpts = {}): Promise<ChainVerdict> {
    const hash = norm(txHash);
    if (!hash) return 'unknown';

    let tx: Record<string, unknown> | null;
    try {
        tx = await readOne('midnight.Transactions', { hash }, ['ID', 'hash', 'contractAddress', 'circuitName']);
    } catch {
        return 'unknown'; // plugin indexer tables absent
    }
    if (!tx) return 'unknown'; // not indexed (crawler disabled or lagging)

    // Result status must be recorded and successful.
    let status = '';
    try {
        const res = await readOne('midnight.TransactionResults', { transaction_ID: tx.ID }, ['status']);
        status = String(res?.status ?? '');
    } catch { /* no result row */ }
    if (!status) return 'unknown';                       // indexed head, result not written yet
    if (status === 'FAILURE') return 'failed';
    if (status !== 'SUCCESS' && status !== 'PARTIAL_SUCCESS') return 'unknown';

    // The tx must act on the expected contract (and circuit, when supplied).
    const want = norm(opts.contractAddress);
    if (want) {
        let touches = norm(tx.contractAddress as string) === want
            && (!opts.circuit || !tx.circuitName || String(tx.circuitName) === opts.circuit);
        if (!touches) {
            try {
                const acts = await cds.db.read('midnight.ContractActions')
                    .columns('address', 'entryPoint').where({ transaction_ID: tx.ID });
                touches = (acts as Record<string, unknown>[]).some((a) =>
                    norm(a.address as string) === want
                    && (!opts.circuit || !a.entryPoint || String(a.entryPoint) === opts.circuit));
            } catch { /* no contract-action rows indexed */ }
        }
        if (!touches) return 'failed';
    }
    return 'confirmed';
}
