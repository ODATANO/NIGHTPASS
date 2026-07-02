// Vite LIBRARY build of the connector building blocks (attest / grant / revoke /
// deploy / predicate + wallet helpers), so a non-bundled host (the SAPUI5
// producer cockpit) can dynamic-import them and run the Lace flow IN-APP —
// instead of redirecting to the standalone connector page.
//
// Same WASM handling as vite.config.mjs (vite-plugin-wasm + top-level-await +
// ledger-v8 dedupe). Output → app/connector/lib, served by CAP at /connector/lib/.
// Run via `npm run build:connector-lib`.
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

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
    plugins: [wasm(), topLevelAwait()]
});
