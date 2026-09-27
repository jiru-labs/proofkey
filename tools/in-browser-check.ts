/**
 * Checks the in-browser model's fixed facts — what it strips from a reply, which
 * actions it is offered, and that what downloads is pinned:
 *
 *     node --experimental-strip-types tools/in-browser-check.ts
 *
 * The model itself cannot run here: there is no GPU. `test:ext` drives the whole
 * path against a stand-in engine, and MODELS.md records the real one, measured
 * in Brave on an RX 6600.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BUILT_IN_ACTIONS } from '../src/core/prompts.ts';
import { getPreset } from '../src/core/presets.ts';
import {
  ACTIONS_ON_IN_BROWSER_MODEL,
  describeInBrowserState,
  IN_BROWSER_DOWNLOAD_HOST,
  IN_BROWSER_INTEGRITY,
  IN_BROWSER_MODEL,
  IN_BROWSER_MODEL_LIB,
  IN_BROWSER_MODEL_LIB_SHA256,
  IN_BROWSER_MODEL_URL,
  stripThinking,
} from '../src/core/providers/inBrowserModel.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('what reaches the field:');
// The exact shape Qwen3.5 returned on every request in Brave (2026-09-26).
check('the empty think block Qwen3.5 opens with is removed', stripThinking('<think>\n\n</think>\n\nEl deadline es mañana.') === 'El deadline es mañana.');
check('a block with reasoning in it is removed too', stripThinking('<think>the user wants…</think>Fixed text.') === 'Fixed text.');
check('a reply without one is untouched', stripThinking('  - a bullet\n- another') === '  - a bullet\n- another');
// Only a block at the very start is the model's; anywhere else it is the user's text.
check(
  'the words "<think>" later in the user\'s own text are left alone',
  stripThinking('Type <think></think> to open a block.') === 'Type <think></think> to open a block.',
);

console.log('\nwhat it is offered:');
check(
  'Fix grammar, bullet points and Translate — the three measured well',
  [...ACTIONS_ON_IN_BROWSER_MODEL].sort().join(',') === 'bullet-points,fix-grammar,translate',
  [...ACTIONS_ON_IN_BROWSER_MODEL].join(','),
);
check(
  'every one of them is a real built-in action',
  [...ACTIONS_ON_IN_BROWSER_MODEL].every((id) => BUILT_IN_ACTIONS.some((a) => a.id === id)),
);
check('none of the six rewrites', !['improve-writing', 'make-professional', 'make-friendly', 'simplify', 'summarize', 'expand'].some((id) => ACTIONS_ON_IN_BROWSER_MODEL.has(id)));

console.log('\nwhat downloads, and from where:');
check('the preset runs the model that was measured', getPreset('in-browser').defaultModel === IN_BROWSER_MODEL, getPreset('in-browser').defaultModel);
check('the preset needs no key and no URL', !getPreset('in-browser').requiresApiKey && getPreset('in-browser').baseUrl === '');
check(
  'the weights are pinned to one Hugging Face revision, not main',
  /^https:\/\/huggingface\.co\/mlc-ai\/Qwen3\.5-4B-q4f16_1-MLC\/resolve\/[0-9a-f]{40}\/$/.test(IN_BROWSER_MODEL_URL),
  IN_BROWSER_MODEL_URL,
);
check('the host named to the user is that URL\'s host', new URL(IN_BROWSER_MODEL_URL).host === IN_BROWSER_DOWNLOAD_HOST);
const before = describeInBrowserState({ kind: 'not-downloaded' });
check('before downloading, the size and the host are both said', /\d\.\d GB/.test(before) && before.includes(IN_BROWSER_DOWNLOAD_HOST), before);

check(
  'WebLLM is given the model library\'s own hash, the one the fetch script pins',
  IN_BROWSER_INTEGRITY.model_lib === `sha256-${Buffer.from(IN_BROWSER_MODEL_LIB_SHA256, 'hex').toString('base64')}`,
  IN_BROWSER_INTEGRITY.model_lib,
);
check(
  'and hashes for the config and tokenizer, failing hard on a mismatch',
  /^sha256-[A-Za-z0-9+/]{43}=$/.test(IN_BROWSER_INTEGRITY.config) &&
    /^sha256-[A-Za-z0-9+/]{43}=$/.test(IN_BROWSER_INTEGRITY.tokenizer['tokenizer.json']) &&
    IN_BROWSER_INTEGRITY.onFailure === 'error',
);

const lib = await readFile(new URL(`../public/${IN_BROWSER_MODEL_LIB}`, import.meta.url)).catch(() => null);
if (lib) {
  const sha = createHash('sha256').update(lib).digest('hex');
  check('the bundled model library is the pinned one', sha === IN_BROWSER_MODEL_LIB_SHA256, sha);
} else {
  console.log(`  note  public/${IN_BROWSER_MODEL_LIB} is not here; run tools/fetch-webllm-lib.mjs to ship it`);
}

if (failures > 0) {
  console.error(`\n${failures} in-browser model check(s) failed.`);
  process.exit(1);
}
console.log('\nIn-browser model checks passed.');
