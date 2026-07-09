// Vite LIBRARY build of the connector building blocks (attest / grant / revoke /
// deploy / predicate + wallet helpers), so a non-bundled host (the SAPUI5
// producer cockpit) can dynamic-import them and run the Lace flow IN-APP —
// instead of redirecting to the standalone connector page.
//
// WASM via vite-plugin-wasm + ledger-v8 dedupe. No top-level-await plugin:
// the output is an ES module with target es2022, where TLA is native, and the
// plugin's rollup peer dependency breaks fresh installs under rolldown-vite 8.
// Output → app/connector/lib, served by CAP at /connector/lib/.
// Run via `npm run build:connector-lib`.
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
    base: '/connector/lib/',
    build: {
        outDir: 'lib',
        emptyOutDir: true,
        target: 'es2022',
        sourcemap: false,
        minify: false,
        lib: {
            entry: 'connector.mjs',
            formats: ['es'],
            fileName: () => 'nightpass-connector.js'
        }
    },
    resolve: {
        dedupe: ['@midnight-ntwrk/ledger-v8']
    },
    plugins: [wasm()]
});
