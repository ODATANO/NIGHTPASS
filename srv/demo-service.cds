/**
 * "Try it" live demo: anonymous, tightly capped public surface. A visitor
 * picks a product family, gets a fresh zero-funded identity, creates a small
 * passport with a few public head fields and confidential provable values,
 * and the hosted sponsor pays every on-chain fee.
 *
 * No entities are exposed on purpose: tester rows carry encrypted wallet
 * secrets. The UI talks only to these actions, authorized by the opaque
 * testerId handle. The whole service is inert unless DEMO_ENABLED=true.
 */
service DemoService @(path: '/api/v1/demo', requires: 'any') {

    /** Create an anonymous tester + fresh zero-funded wallet. */
    action startTester(nickname: String) returns {
        testerId        : String;
        shieldedAddress : String;
        nightAddress    : String;
    };

    /**
     * Create + anchor the demo passport (queued; poll demoRunStatus). The
     * head values are public; every claimed value stays confidential and is
     * proven on-chain without being revealed.
     */
    action createDemoPassport(
        testerId   : String,
        profile    : String,       // product family from demoProfiles(); default battery
        headJson   : LargeString,  // JSON object of the family's head fields (demoProfiles().headJson)
        // JSON array of { field, value, threshold } (numeric) or { field, member }
        // (membership). Fields come from demoClaimFields(profile); the family's
        // primary claim is required. All claims are proven in ONE transaction.
        claimsJson : LargeString,
        secondLife : Boolean       // battery only: age + repurpose = second anchor version
    ) returns {
        runId         : UUID;
        passportId    : String;
        queuePosition : Integer;
    };

    /**
     * Timeline polling for a run. runningCount executes right now,
     * waitingAhead queued runs are before this one; startingInSec is the
     * estimated start countdown when only the start stagger is ticking
     * (-1 while the run waits for a free slot). queuePosition stays for
     * compatibility (waitingAhead + runningCount).
     */
    function demoRunStatus(runId: UUID) returns {
        passportId    : String;
        state         : String;
        stepsJson     : LargeString;
        error         : String;
        queuePosition : Integer;
        runningCount  : Integer;
        waitingAhead  : Integer;
        startingInSec : Integer;
    };

    /** Landing-page status: is the demo open, how busy is it. */
    function demoInfo() returns {
        enabled        : Boolean;
        queueDepth     : Integer;
        runningCount   : Integer;
        waitingCount   : Integer;
        dailyRemaining : Integer;
    };

    /**
     * The product families a visitor can pick, with the public head fields of
     * each (JSON array of { name, label, kind, target, options, defaultValue,
     * min, max, hint }). Static, DB-free.
     */
    function demoProfiles() returns array of {
        id           : String;
        label        : String;
        tagline      : String;
        regulation   : String;
        idPrefix     : String;
        primaryField : String;
        secondLife   : Boolean;
        headJson     : LargeString;
    };

    /**
     * The confidential values a visitor can prove for one family, so the form
     * builds itself from the server's catalogue instead of hard-coding fields
     * and bounds. The primary claim is always proven; the rest are optional
     * and ride in the same transaction.
     */
    function demoClaimFields(profile: String) returns array of {
        field            : String;
        label            : String;
        kind             : String;  // numeric | membership
        unit             : String;
        predicate        : String;  // lessOrEqual | greaterOrEqual (numeric only)
        min              : Decimal;
        max              : Decimal;
        defaultValue     : Decimal;
        defaultThreshold : Decimal;
        // membership kind: the hidden value is proven to be one of a published
        // allow-list; the visitor picks it from the list itself.
        setId            : String;
        setLabel         : String;
        optionsJson      : LargeString; // JSON array of the allow-list values
        defaultOption    : String;
        primary          : Boolean; // the family's always-proven claim
    };

    /**
     * Ops dust monitor: NIGHT + dust snapshot of the fee-sponsor pool, so an
     * operator can spot a depleting sponsor before it starts failing anchors.
     * Empty when no sponsor is configured or the demo is disabled.
     */
    function demoSponsorStatus() returns array of {
        walletId             : String;
        label                : String;
        state                : String;  // 'ready' | 'warming' | 'cold' | 'error'
        nightDisplay         : String;
        dustPresent          : Boolean;
        registeredNightUtxos : Integer;
        healthy              : Boolean;
        error                : String;
    };
}
