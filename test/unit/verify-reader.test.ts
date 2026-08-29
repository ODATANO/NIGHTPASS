import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyVia } from '../../srv/lib/verify-reader';

// Which surface answers the crawler-free state reads. Explicit env wins;
// otherwise hosted only when the demo runs remote AND the hosted API is
// configured, so a cockpit host never silently talks to api.nightgate.dev.
describe('verifyVia', () => {
    const hosted = { NIGHTGATE_API_URL: 'https://api.example', DEMO_NIGHTGATE_AGENT_TOKEN: 'ngat_x' };
    it('explicit setting wins', () => {
        assert.equal(verifyVia({ NIGHTGATE_VERIFY_VIA: 'hosted' }), 'hosted');
        assert.equal(verifyVia({ NIGHTGATE_VERIFY_VIA: 'PLUGIN', ...hosted, DEMO_TRANSPORT: 'remote' }), 'plugin');
    });
    it('remote demo with a configured hosted API reads hosted', () => {
        assert.equal(verifyVia({ ...hosted, DEMO_TRANSPORT: 'remote' }), 'hosted');
    });
    it('anything else reads through the plugin', () => {
        assert.equal(verifyVia({}), 'plugin');
        assert.equal(verifyVia({ ...hosted }), 'plugin');
        assert.equal(verifyVia({ DEMO_TRANSPORT: 'remote', NIGHTGATE_API_URL: 'https://api.example' }), 'plugin');
    });
});
