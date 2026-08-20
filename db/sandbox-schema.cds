namespace sandbox;

using { cuid, managed } from '@sap/cds/common';
using { demo.Testers } from './demo-schema';

/**
 * Sponsored NIGHTGATE sandbox: an outside tester (e.g. a VeilCore evaluator)
 * anchors a document and proves claims about it against a SHARED pre-deployed
 * attestation vault, while a pool sponsor wallet pays every dust fee. Reuses
 * demo.Testers for the ephemeral zero-funded caller identity.
 *
 * No entity is exposed through a service; the tester talks only to
 * SandboxService actions, keyed by the opaque testerId + runId.
 */
entity Runs : cuid, managed {
    tester     : Association to Testers;
    // Whatever label the tester gave the run (their record id); informational.
    label      : String(120);
    // queued | running | done | failed
    state      : String(20);
    // JSON timeline: [{ kind, status, txHash, explorerUrl }]
    stepsJson  : LargeString;
    // JSON result the client verifies against: anchored payload hashes,
    // content roots, and per-claim verify coordinates. Public.
    resultJson : LargeString;
    error      : String(500);
    clientKey  : String(64);
}
