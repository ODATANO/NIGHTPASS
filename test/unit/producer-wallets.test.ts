import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { listProducerWallets, producerWalletSecrets } from '../../srv/lib/producer-wallets';

/**
 * The server-wallet registry backing the cockpit's "server wallet" login mode.
 * Env-driven, so each test sets its own env and restores it afterwards.
 */

const KEYS = [
    'PRODUCER_WALLETS', 'PRODUCER_LABEL', 'PRODUCER_SHIELDED_ADDRESS',
    'PRODUCER_WALLET_MNEMONIC', 'PRODUCER_VIEWING_KEY',
    'PRODUCER_A_WALLET_MNEMONIC', 'PRODUCER_A_VIEWING_KEY', 'PRODUCER_A_SHIELDED_ADDRESS', 'PRODUCER_A_LABEL',
    'PRODUCER_B_WALLET_MNEMONIC', 'PRODUCER_B_VIEWING_KEY', 'PRODUCER_B_SHIELDED_ADDRESS'
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
    saved = {};
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

describe('producer wallet registry', () => {
    test('lists the configured wallets without exposing secrets', () => {
        process.env.PRODUCER_WALLETS = 'A,B';
        process.env.PRODUCER_A_WALLET_MNEMONIC = 'phrase a';
        process.env.PRODUCER_A_VIEWING_KEY = 'vk-a';
        process.env.PRODUCER_A_SHIELDED_ADDRESS = 'mn_shield-addr_preview1aaa';
        process.env.PRODUCER_A_LABEL = 'CellCo';
        process.env.PRODUCER_B_WALLET_MNEMONIC = 'phrase b';
        process.env.PRODUCER_B_VIEWING_KEY = 'vk-b';
        process.env.PRODUCER_B_SHIELDED_ADDRESS = 'mn_shield-addr_preview1bbb';

        const wallets = listProducerWallets();
        assert.equal(wallets.length, 2);
        assert.deepEqual(wallets[0], {
            id: 'A', label: 'CellCo', owner: 'mn_shield-addr_preview1aaa', signingReady: true
        });
        // Default label when none is configured.
        assert.equal(wallets[1].label, 'Producer B');
        // No secret ever leaves the registry's public view.
        const serialized = JSON.stringify(wallets);
        assert.ok(!serialized.includes('phrase'));
        assert.ok(!serialized.includes('vk-'));
    });

    test('marks a wallet without signing keys as not ready', () => {
        process.env.PRODUCER_WALLETS = 'A';
        process.env.PRODUCER_A_SHIELDED_ADDRESS = 'mn_shield-addr_preview1aaa';

        assert.equal(listProducerWallets()[0].signingReady, false);
        assert.equal(producerWalletSecrets('A'), undefined);
    });

    test('resolves the secrets of the requested wallet id', () => {
        process.env.PRODUCER_WALLETS = 'A,B';
        process.env.PRODUCER_A_WALLET_MNEMONIC = 'phrase a';
        process.env.PRODUCER_A_VIEWING_KEY = 'vk-a';
        process.env.PRODUCER_B_WALLET_MNEMONIC = 'phrase b';
        process.env.PRODUCER_B_VIEWING_KEY = 'vk-b';

        assert.equal(producerWalletSecrets('B')?.mnemonic, 'phrase b');
        assert.equal(producerWalletSecrets('A')?.viewingKey, 'vk-a');
        assert.equal(producerWalletSecrets('nope'), undefined);
    });

    test('exposes the legacy single-wallet env as the `default` wallet', () => {
        process.env.PRODUCER_WALLET_MNEMONIC = 'legacy phrase';
        process.env.PRODUCER_VIEWING_KEY = 'legacy vk';
        process.env.PRODUCER_SHIELDED_ADDRESS = 'mn_shield-addr_preview1legacy';

        const wallets = listProducerWallets();
        assert.equal(wallets.length, 1);
        assert.equal(wallets[0].id, 'default');
        assert.equal(wallets[0].owner, 'mn_shield-addr_preview1legacy');
        // Omitting the id falls back to the legacy wallet, which is what the
        // ERP ingest path (no walletId) relies on.
        assert.equal(producerWalletSecrets()?.mnemonic, 'legacy phrase');
        assert.equal(producerWalletSecrets('default')?.mnemonic, 'legacy phrase');
    });

    test('with only named wallets and no id, a single wallet is still resolvable', () => {
        process.env.PRODUCER_WALLETS = 'A';
        process.env.PRODUCER_A_WALLET_MNEMONIC = 'phrase a';
        process.env.PRODUCER_A_VIEWING_KEY = 'vk-a';

        assert.equal(producerWalletSecrets()?.id, 'A');
    });

    test('no configuration at all yields no wallets', () => {
        assert.deepEqual(listProducerWallets(), []);
        assert.equal(producerWalletSecrets(), undefined);
    });
});
