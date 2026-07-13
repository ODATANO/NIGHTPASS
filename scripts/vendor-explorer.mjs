// Vendors the anime.js ESM bundle into the standalone explorer app.
//
// The explorer runs under the NIGHTGATE CSP (`script-src 'self'` + the UI5
// CDN), so no third-party CDN is allowed: the library must be served from the
// app's own origin. Runs on postinstall; the copied file is committed so the
// Docker image and fresh checkouts work without extra steps.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'animejs', 'dist', 'bundles', 'anime.esm.min.js');
const dst = join(root, 'app', 'explorer', 'vendor', 'anime.esm.js');

mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log(`vendored animejs -> ${dst}`);
