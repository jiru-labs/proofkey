/**
 * Runs the real build against Chrome's built-in model, as a fresh install.
 *
 *     npm run build
 *     CHROME=/opt/google/chrome/chrome node tools/builtin-test.mjs [profile-dir]
 *
 * `test:ext` cannot cover this: it drives Playwright's Chromium, which has no
 * model. This loads `dist/` into Google Chrome over `--remote-debugging-pipe`
 * (branded Chrome ignores `--load-extension`), from a fresh copy so the
 * extension id and its storage are new — nothing configured, exactly what a
 * new user gets — and talks to the real service worker with the same messages
 * the content script sends.
 *
 * The profile must already hold the model; see `tools/nano-bridge.mjs`.
 */

import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const chromeBin = process.env['CHROME'];
if (!chromeBin) {
  console.error('Set CHROME to a Google Chrome binary, e.g. /opt/google/chrome/chrome.');
  process.exit(1);
}
const profile = process.argv[2] ?? join(homedir(), '.cache', 'proofkey-nano-eval', 'profile');
const DIST = fileURLToPath(new URL('../dist', import.meta.url));

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const extDir = await mkdtemp(join(tmpdir(), 'proofkey-builtin-test-'));
await cp(DIST, extDir, { recursive: true });

const child = spawn(chromeBin, [
  `--user-data-dir=${profile}`,
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  '--headless=new',
  ...(process.env['CHROME_ARGS'] ?? '').split(/\s+/).filter(Boolean),
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

const toChrome = child.stdio[3];
const fromChrome = child.stdio[4];
let nextId = 0;
let buffer = '';
const pending = new Map();
fromChrome.on('data', (chunk) => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const message = { id: ++nextId, method, params, ...(sessionId ? { sessionId } : {}) };
  pending.set(message.id, resolve);
  toChrome.write(`${JSON.stringify(message)}\0`);
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function finish() {
  child.kill();
  await rm(extDir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nBuilt-in model checks passed.' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

const loaded = await send('Extensions.loadUnpacked', { path: extDir });
const extId = loaded.result?.id;
if (!extId) {
  console.error('Extensions.loadUnpacked failed:', JSON.stringify(loaded.error ?? loaded));
  await finish();
}
console.log(`\n${(await send('Browser.getVersion')).result?.product}, extension ${extId}`);

// The options page opens itself on install; open our own copy to talk from.
const { targetId } = (await send('Target.createTarget', {
  url: `chrome-extension://${extId}/options/index.html`,
})).result;
await wait(2000);
const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })).result;
const page = async (expression) => {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (reply.result?.exceptionDetails) {
    throw new Error(reply.result.exceptionDetails.exception?.description ?? 'exception in page');
  }
  return reply.result?.result?.value;
};
const worker = (message) => page(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);

console.log('\nA fresh install:');
check(
  'nothing is saved, so the defaults are what runs',
  (await page(`chrome.storage.sync.get(null).then((all) => Object.keys(all).length)`)) === 0,
);
const text = await page(`(async () => {
  for (let i = 0; i < 40; i++) {
    if (document.body.innerText.includes('Ready.') || document.body.innerText.includes('Download model')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return document.body.innerText;
})()`);
check('the provider card is Chrome built-in AI', text.includes('Chrome built-in AI'));
check('it reports the model ready, with no key asked for', text.includes('Ready.'));
// `.field__progress` set `display`, which outranks `hidden`: an empty bar sat under
// the card in every state but downloading, "Ready." included.
check(
  'no download bar is drawn once the model is ready',
  (await page(`(() => { const bar = document.querySelector('[data-builtin-progress]'); return !!bar && bar.getBoundingClientRect().height === 0; })()`)) === true,
);
check("the Actions section says only Fix grammar is offered", text.includes('offers Fix grammar and your own actions only'));

console.log('\nFix grammar, through the real worker:');
let started = Date.now();
const fixed = await worker({ type: 'proofkey:run', actionId: 'fix-grammar', text: 'Their is alot of things to do.' });
check('it succeeds with no provider configured', fixed?.ok === true, fixed?.ok ? '' : fixed?.error);
console.log(`        ${JSON.stringify(fixed?.value?.text)} in ${Date.now() - started} ms`);

const refused = await worker({ type: 'proofkey:run', actionId: 'improve-writing', text: 'Hola team, el kickoff es mañana.' });
check('an action not offered here is refused, and says why', refused?.ok === false && /built-in model/.test(refused?.error ?? ''), refused?.error);

const state = await worker({ type: 'proofkey:get-state' });
const offered = state?.value?.actions?.map((a) => a.id) ?? [];
check('the card and shortcuts are handed Fix grammar alone', JSON.stringify(offered) === '["fix-grammar"]', JSON.stringify(offered));

console.log('\nA live check, eight sentences as the content script sends them:');
const sentences = [
  'i has been working on this projet since last week',
  'The meating is thursday.',
  'Todo esta bien pero el informe todavia no esta listo',
  "Je suis allé au magasin hier et j'ai acheter du pain",
  'Das ist ein sehr schön Tag',
  'gonna push the fix tonight, lmk if that works',
  '¿Cómo está usted hoy?',
  'See https://example.com/docs?a=1&b=2 for details.',
];
started = Date.now();
const live = await worker({ type: 'proofkey:check', sentences });
const ms = Date.now() - started;
check('it succeeds', live?.ok === true, live?.ok ? '' : live?.error);
const corrections = live?.value?.corrections ?? [];
check('one correction per sentence', corrections.length === sentences.length, `${corrections.length}`);
check(
  'no full stop is added to a line that had none',
  [0, 2, 3, 4, 5].every((i) => !/[^.]\.$/.test(corrections[i] ?? '')),
  JSON.stringify([0, 2, 3, 4, 5].map((i) => corrections[i])),
);
check('clean sentences come back unchanged', corrections[5] === sentences[5] && corrections[6] === sentences[6] && corrections[7] === sentences[7]);
console.log(`        ${ms} ms`);
corrections.forEach((c, i) => {
  if (c !== sentences[i]) console.log(`        ${sentences[i]}  →  ${c}`);
});

await finish();
