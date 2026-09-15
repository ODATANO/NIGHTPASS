/**
 * The plugin lane: an in-process NIGHTGATE wallet session proves, signs and
 * submits; an optional sponsor session pays the dust (per-tx sponsoring).
 */
import type cds from '@sap/cds';
import { CONTRACT_REF, runChainStep, sendDetached, waitForJob, waitForJobResult } from './passport-anchor';
import { claimValidUntil } from './proof-plan';
import {
    claimIdsByKey, ProofCartError,
    type AnchorTxInput, type ChainLane, type ClaimVerifyInput, type LaneTx, type ProofCartInput, type ProofCartOutcome
} from './chain-lane';

export class PluginLane implements ChainLane {
    readonly kind = 'plugin' as const;

    constructor(
        private readonly nightgate: cds.Service,
        private readonly sessionId: string,
        private readonly user?: unknown,
        private readonly sponsorSessionId?: string
    ) {}

    private sponsored(): Record<string, string> {
        return this.sponsorSessionId ? { sponsorSessionId: this.sponsorSessionId } : {};
    }

    async submitAnchorTx({ contractAddress, tx }: AnchorTxInput): Promise<LaneTx> {
        let jobId = '';
        const txHash = await runChainStep(tx.label, async () => {
            const single = tx.calls.length === 1 ? tx.calls[0] : null;
            const res: any = single
                ? await sendDetached(this.nightgate, 'submitContractCall', {
                    contractAddress,
                    circuit: single.circuit,
                    compiledArtifactRef: CONTRACT_REF,
                    sessionId: this.sessionId,
                    args: JSON.stringify(single.args),
                    ...this.sponsored()
                }, this.user)
                : await sendDetached(this.nightgate, 'submitContractCallBatch', {
                    contractAddress,
                    compiledArtifactRef: CONTRACT_REF,
                    sessionId: this.sessionId,
                    calls: JSON.stringify(tx.calls),
                    ...this.sponsored()
                }, this.user);
            jobId = String(res.jobId ?? '');
            return waitForJob(this.nightgate, res.jobId, this.sessionId, this.user);
        });
        return { txHash, jobId };
    }

    async submitProofCart(input: ProofCartInput): Promise<ProofCartOutcome> {
        const args = {
            payloadHash: input.payloadHash,
            ...(input.attesterId ? { attesterId: input.attesterId } : {}),
            ...(input.contentRoot ? { contentRoot: input.contentRoot, schemaId: input.schemaId } : {}),
            claimsJson: JSON.stringify(input.claims),
            validUntil: input.validUntil ?? claimValidUntil(),
            sessionId: this.sessionId, contractAddress: input.contractAddress, compiledArtifactRef: CONTRACT_REF,
            ...this.sponsored()
        };
        let res: any = null;
        try {
            // Same bounded retry the anchor steps use: a cart submitted right
            // after the anchor from the same wallet can race that tx's dust
            // settlement (1014, provably pre-mempool).
            const jobResult: any = await runChainStep('proof cart', async () => {
                res = await sendDetached(this.nightgate, 'issueFieldPredicateAttestationBatch', args, this.user);
                return waitForJobResult(
                    this.nightgate, res.jobId, this.sessionId, this.user,
                    { requireChainSuccess: true, timeoutMs: input.timeoutMs }
                );
            });
            const txHash = String(jobResult?.proof?.proofValue ?? jobResult?.txHash ?? '');
            return { txHash, jobId: String(res?.jobId ?? ''), claimIds: claimIdsByKey(res?.claims, jobResult?.claims) };
        } catch (e) {
            const msg = String((e as Error)?.message ?? e);
            throw new ProofCartError(msg, {
                partial: /OnChainStatus|PARTIAL/i.test(msg) && !!res,
                jobId: String(res?.jobId ?? ''),
                claimIds: claimIdsByKey(res?.claims),
                cause: e
            });
        }
    }

    async verifyClaimLanded(input: ClaimVerifyInput): Promise<{ verified: boolean; txHash: string }> {
        if (!input.predicateAttestationId) return { verified: false, txHash: '' };
        const v: any = await sendDetached(this.nightgate, 'verifyPredicateAttestation',
            { predicateAttestationId: input.predicateAttestationId }, this.user);
        return { verified: !!v?.verified, txHash: String(v?.provenTxHash ?? '') };
    }

    async dispose(): Promise<void> { /* the session outlives the lane */ }
}
