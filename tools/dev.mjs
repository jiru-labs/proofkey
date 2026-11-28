/**
 * Watches both Vite builds in parallel:
 *   1. service worker, options page, offscreen document (`vite.config.ts`)
 *   2. content script IIFE (`vite.content.config.ts`)
 *
 * Runs one clean primary build first, then starts both watchers with
 * `PROOFKEY_WATCH=1` so neither wipes the other's output in `dist/`.
 */

import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/.bin/vite', import.meta.url));

execFileSync(VITE, ['build'], { cwd: ROOT, stdio: 'inherit' });

const env = { ...process.env, PROOFKEY_WATCH: '1' };
const children = [
  spawn(VITE, ['build', '--watch'], { cwd: ROOT, stdio: 'inherit', env }),
  spawn(VITE, ['build', '--config', 'vite.content.config.ts', '--watch'], { cwd: ROOT, stdio: 'inherit', env }),
];

const shutdown = (code = 0) => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
for (const child of children) {
  child.on('exit', (code) => {
    if (code && code !== 0) shutdown(code);
  });
}
