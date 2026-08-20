/**
 * Sponsored NIGHTGATE sandbox for outside testers.
 *
 * A tester runs a LOCAL script (their SDK builds records; prepareDocumentProof
 * is compute-only and runs client-side against any NIGHTGATE), then hands this
 * service the prepared coordinates. The service anchors + proves them against
 * one SHARED pre-deployed vault, with a pool sponsor wallet paying every dust
 * fee. The tester needs no wallet, NIGHT, tDUST, or server of their own.
 *
 * Inert unless DEMO_ENABLED=true and SANDBOX_CONTRACT_ADDRESS is set. Runs
 * under one fixed technical principal (same as DemoService), so the tester's
 * caller session and the sponsor session share a user and same-user fee
 * sponsoring applies. Capped per IP / per tester / per day; one sponsor per
 * run, leased from PASSPORT_FEE_SPONSOR_WALLET.
 */
service SandboxService @(path: '/api/v1/sandbox', requires: 'any') {

    /**
     * Open a sandbox session for the caller's OWN identity.
     *
     * The attestation is bound to the caller's attester id (derived in-circuit
     * from its secret), so an agent proving a document proves it UNDER ITS OWN
     * ADDRESS; we only sponsor the dust. Pass `seedHex` (128 hex = 64 bytes) to
     * bring your own wallet; omit it and the sandbox mints a throwaway identity
     * for a quick anonymous try. The seed is held encrypted and only for the
     * duration a sponsored submit needs to sign (NIGHTGATE fee sponsoring is
     * intra-server: caller and sponsor sessions must be co-located).
     */
    action startTester(nickname: String, seedHex: String) returns {
        testerId        : String;
        attesterId      : String;   // the identity every attestation will carry
        shieldedAddress : String;
        nightAddress    : String;
        ownIdentity     : Boolean;  // true when you supplied the seed
    };

    /**
     * Compute-only proof preparation, proxied so the tester talks to ONE
     * surface. No dust, no session: turns a canonical document + ordered field
     * list into the content root, schema id, per-field salts + inclusion paths
     * and the full opening the run recipe needs. `saltSeed` (optional) makes it
     * deterministic across a re-prepare.
     */
    action prepareProof(
        documentJson    : LargeString,
        proofFieldsJson : LargeString,
        saltSeed        : String
    ) returns {
        contentRoot : String;
        schemaId    : String;
        schema      : LargeString;
        fields      : LargeString;
        opening     : LargeString;
    };

    /**
     * Queue one sponsored run. `runSpecJson` is the prepared recipe the client
     * built from prepareDocumentProof outputs: anchored payload hashes, content
     * roots + schema ids, and a claim list (equality / predicate / membership /
     * documentDiff / documentIntegrity). Poll sandboxRunStatus for the result.
     */
    action runSandbox(
        testerId    : String,
        label       : String,
        runSpecJson : LargeString
    ) returns {
        runId         : UUID;
        queuePosition : Integer;
    };

    /** Timeline + result polling for a run. */
    function sandboxRunStatus(runId: UUID) returns {
        state        : String;
        stepsJson    : LargeString;
        resultJson   : LargeString;
        error        : String;
        queuePosition : Integer;
    };

    /** Is the sandbox open, how busy, and which shared vault it anchors into. */
    function sandboxInfo() returns {
        enabled         : Boolean;
        contractAddress : String;
        network         : String;
        queueDepth      : Integer;
        runningCount    : Integer;
        dailyRemaining  : Integer;
    };
}
