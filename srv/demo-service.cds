/**
 * "Try it" live demo: anonymous, tightly capped public surface. A visitor
 * gets a fresh zero-funded server-side wallet, creates a 5-field passport
 * (CO2 confidential + provable) and the platform sponsor wallet pays every
 * on-chain fee (NIGHTGATE 0.8.0 per-tx sponsoring).
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
     * Create + anchor the demo passport (queued; poll demoRunStatus).
     * co2Kg stays confidential; the run proves co2Kg <= proveThreshold
     * on-chain without revealing the value.
     */
    action createDemoPassport(
        testerId         : String,
        model            : String,
        manufacturer     : String,
        weightKg         : Decimal,
        performanceClass : String,    // A to E, public on the explorer
        co2Kg            : Decimal,   // confidential, never published
        proveThreshold   : Decimal    // public claim bound (kg CO2)
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
}
