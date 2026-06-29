// Vite build for the NIGHTPASS Lace connector page.
//
// Vite (not esbuild) is required because the Midnight SDK ships wasm-bindgen
// "bundler-target" WASM (ledger-v8 etc.) that must be INSTANTIATED by the
// bundler — esbuild's file loader only copies the .wasm and leaves
// `wasm.__wbindgen_start` undefined → "(void 0) is not a function". vite-plugin-wasm
// + vite-plugin-top-level-await handle the instantiation + the async init.
//
// Run via `npm run build:connector` (= `vite build app/connector`). Output goes
// to app/connector/dist, served statically by CAP at /connector/dist/.
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
    base: '/connector/dist/',
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
        sourcemap: true,
        minify: false
    },
    // ledger-v8 exists twice in node_modules: hoisted 8.1.0 (wallet-sdk +
    // @odatano/nightgate want ^8.1.0) and a nested 8.0.3 pinned by
    // midnight-js-protocol. Two copies → Vite bundles two wasm-bindgen glue
    // instances; only one gets its `__wbg_set_wasm` init, so the SDK's
    // contract-state deserialize hits an uninitialised `wasm` →
    // "Cannot read properties of undefined (reading '__wbindgen_malloc')".
    // dedupe forces a single (8.1.0) instance into the bundle, initialised once.
    resolve: {
        dedupe: ['@midnight-ntwrk/ledger-v8']
    },
    plugins: [wasm(), topLevelAwait()]
});
