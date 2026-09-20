// Vendors @odatano/brand assets into the standalone explorer and demo apps.
//
// Both apps run under a same-origin CSP and behind the public-surface gate,
// so the files must live inside /explorer and /demo. Runs on postinstall;
// the copied files are committed so the Docker image and fresh checkouts
// work without extra steps.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const brand = join(root, 'node_modules', '@odatano', 'brand');
const files = ['tokens.css', 'logos/nightpass-icon.svg'];

for (const app of ['explorer', 'demo']) {
  const dstDir = join(root, 'app', app, 'brand');
  mkdirSync(dstDir, { recursive: true });
  for (const f of files) {
    copyFileSync(join(brand, f), join(dstDir, f.split('/').pop()));
  }
  console.log(`vendored @odatano/brand -> ${dstDir}`);
}
