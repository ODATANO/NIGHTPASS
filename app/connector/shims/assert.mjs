// Browser shim for the Node "assert" builtin. @subsquid/scale-codec and
// @subsquid/util-internal-hex (transitive deps of the Midnight wallet SDK's
// address-format package) import it, which made Vite emit "externalized for
// browser compatibility" warnings and stub the module out at runtime.
// Those packages only ever call assert(condition, message); strictEqual is
// included for completeness.
function assert(condition, message) {
    if (!condition) {
        throw new Error(message ? String(message) : 'Assertion failed');
    }
}

assert.ok = assert;

assert.strictEqual = function strictEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(message ? String(message) : `Expected ${String(expected)} but got ${String(actual)}`);
    }
};

export default assert;
export const ok = assert;
export const strictEqual = assert.strictEqual;
