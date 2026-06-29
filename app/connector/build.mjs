// Bundle the NIGHTPASS Lace connector flow for the browser.
// Run: node app/connector/build.mjs   (or: npm run build:connector)
import { build } from 'esbuild';
import { nodeModulesPolyfillPlugin } from 'esbuild-plugins-node-modules-polyfill';

await build({
    entryPoints: ['app/connector/connector.mjs'],
    bundle: true,
    format: 'esm',
    splitting: true,            // dynamic import() of the midnight-js SDK
    outdir: 'app/connector/dist',
    platform: 'browser',
    target: 'es2022',           // top-level await
    loader: { '.wasm': 'file' },
    sourcemap: true,            // map browser errors back to real source:line
    // The midnight-js indexer client pulls Node-ish deps (@subsquid/scale-codec
    // needs `assert`, etc.) — polyfill ALL Node builtins + inject Buffer/process
    // globals (some SDK code uses them as bare globals, not imports).
    plugins: [nodeModulesPolyfillPlugin({ globals: { Buffer: true, process: true } })],
    define: { global: 'globalThis' },
    logLevel: 'info'
});
console.log('connector bundle built → app/connector/dist/');
