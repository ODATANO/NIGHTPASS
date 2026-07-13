// Dev launcher: starts the cockpit with the SERVER WALLET registry loaded.
//
// Reads the gitignored `secrets/producer-wallets.env` (mnemonic / viewing key /
// shielded address per wallet, written by the wallet generator), exports it into
// the child process, sets `PRODUCER_WALLETS` from the ids it finds, and runs
// `cds-tsx serve`. Secrets stay in this process tree: they are never written to
// a tracked file and never logged.
//
// Run: node scripts/start-with-wallets.mjs        (add env overrides as usual)
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const SECRETS = 'secrets/producer-wallets.env';
const env = { ...process.env };

if (existsSync(SECRETS)) {
    const ids = new Set();
    for (const line of readFileSync(SECRETS, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
        if (!m) continue;
        env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').trim();
        const id = m[1].match(/^PRODUCER_([A-Z0-9]+)_(WALLET_MNEMONIC|VIEWING_KEY|SHIELDED_ADDRESS)$/);
        if (id) ids.add(id[1]);
    }
    if (ids.size && !env.PRODUCER_WALLETS) env.PRODUCER_WALLETS = [...ids].join(',');
    console.log(`[start] server wallets: ${env.PRODUCER_WALLETS || '(none)'}`);
} else {
    console.log(`[start] no ${SECRETS}; only the legacy PRODUCER_* wallet (if set) will be offered`);
}

const child = spawn('npx', ['cds-tsx', 'serve'], { env, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
