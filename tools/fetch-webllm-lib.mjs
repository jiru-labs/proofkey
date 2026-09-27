/**
 * Puts the in-browser model's compiled WebGPU library into `public/webllm/`, so
 * `npm run build` ships it inside the extension:
 *
 *     node tools/fetch-webllm-lib.mjs
 *
 * MV3 forbids code fetched at run time, and a `.wasm` is code, so the library
 * has to be in the package; only the weights download later. It comes from
 * mlc-ai/binary-mlc-llm-libs pinned to one commit, and is refused unless its
 * SHA-256 is the one in `src/core/providers/inBrowserModel.ts`.
 *
 * Not committed: that repository declares no licence (checked 2026-09-27 — no
 * LICENSE file, nothing in its README, no SPDX id on GitHub), and a binary
 * without one is not ours to redistribute. Until that is settled the library is
 * fetched for development and measurement only.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const COMMIT = '025bcaf3780fa8254f5e5efd3bfea0a5397248f4';
const SOURCE = `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/${COMMIT}/web-llm-models/v0_2_84/base/Qwen3.5-4B-q4f16_1_cs1k-webgpu.wasm`;

const model = await readFile(fileURLToPath(new URL('../src/core/providers/inBrowserModel.ts', import.meta.url)), 'utf8');
const expected = model.match(/IN_BROWSER_MODEL_LIB_SHA256 =\s*'([0-9a-f]{64})'/)?.[1];
const target = model.match(/IN_BROWSER_MODEL_LIB = '([^']+)'/)?.[1];
if (!expected || !target) throw new Error('Could not read the pinned hash and path from inBrowserModel.ts');

const out = fileURLToPath(new URL(`../public/${target}`, import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const existing = await readFile(out).catch(() => null);
if (existing && sha(existing) === expected) {
  console.log(`public/${target}: already there, SHA-256 matches.`);
  process.exit(0);
}

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${SOURCE}`);
const bytes = Buffer.from(await response.arrayBuffer());
const got = sha(bytes);
if (got !== expected) throw new Error(`SHA-256 mismatch: expected ${expected}, got ${got}. Not written.`);

await mkdir(fileURLToPath(new URL('../public/webllm/', import.meta.url)), { recursive: true });
await writeFile(out, bytes);
console.log(`public/${target}: ${bytes.length} bytes, SHA-256 matches.`);
