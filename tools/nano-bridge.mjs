/**
 * Puts Chrome's built-in model behind an OpenAI-shaped endpoint, so the same
 * harnesses that measure every other provider can measure it unchanged.
 *
 *     CHROME=/opt/google/chrome/chrome node tools/nano-bridge.mjs [profile-dir] [port]
 *     (or `npm run nano-bridge`, with CHROME set)
 *     PROOFKEY_EVAL_KEY=local npm run eval -- --base http://127.0.0.1:8765/v1 \
 *       --models gemini-nano --reasoning off --temperature 0 --runs 10
 *
 * The model runs inside an extension **service worker**, because that is where
 * ProofKey calls it from, and the Prompt API's sampling parameters are only
 * stable for extensions. A web page would measure a different configuration.
 *
 * Three things about getting there that each cost a cycle to find:
 *
 *   - Branded Chrome ignores `--load-extension` (Chrome 153 did, measured), so
 *     the worker is loaded with `Extensions.loadUnpacked` over
 *     `--remote-debugging-pipe`.
 *   - Under Playwright's `launch`, the same binary and profile answer
 *     `unavailable`; spawned plainly they answer `downloadable`. Its defaults
 *     include `--disable-component-update`, `--disable-background-networking`
 *     and `--disable-field-trial-config`, any of which could be the cause —
 *     which one was not isolated. Chrome is spawned here directly.
 *   - Chrome wants 20 GB free on the volume holding the profile *before* it will
 *     start the ~4 GB download, and says so only in
 *     chrome://on-device-internals. A profile on a small tmpfs never downloads.
 *
 * The profile must already hold the model. Download it once through ProofKey's
 * own "Download model" button in that same Chrome and profile.
 *
 * Only Google Chrome has the model; Chromium, Brave and Playwright's bundled
 * browser do not, which is why `CHROME` has no default.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const chromeBin = process.env['CHROME'];
if (!chromeBin) {
  console.error('Set CHROME to a Google Chrome binary, e.g. /opt/google/chrome/chrome.');
  process.exit(1);
}
const profile = process.argv[2] ?? join(homedir(), '.cache', 'proofkey-nano-eval', 'profile');
const port = Number(process.argv[3] ?? 8765);

/** The languages Chrome documents for this model — the same list ProofKey declares. */
const LANGUAGES = ['en', 'es', 'de', 'fr', 'ja'];

const extDir = await mkdtemp(join(tmpdir(), 'proofkey-nano-bridge-'));
await writeFile(join(extDir, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'proofkey-nano-bridge',
  version: '1',
  background: { service_worker: 'sw.js', type: 'module' },
}));
await writeFile(join(extDir, 'sw.js'), `
const io = { expectedInputs: [{ type: 'text', languages: ${JSON.stringify(LANGUAGES)} }],
             expectedOutputs: [{ type: 'text', languages: ${JSON.stringify(LANGUAGES)} }] };
self.status = () => LanguageModel.availability(io);
self.complete = async (system, user, sampling) => {
  const session = await LanguageModel.create({ initialPrompts: [{ role: 'system', content: system }], ...io, ...sampling });
  try {
    const started = Date.now();
    const reply = await session.prompt(user);
    return { reply, ms: Date.now() - started, used: session.contextUsage, window: session.contextWindow };
  } finally { session.destroy(); }
};
chrome.runtime.onMessage.addListener((message, sender, reply) => reply('awake'));
`);
await writeFile(join(extDir, 'wake.html'), '<script src="wake.js"></script>');
await writeFile(join(extDir, 'wake.js'), "chrome.runtime.sendMessage('wake');");

const child = spawn(chromeBin, [
  `--user-data-dir=${profile}`,
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  '--headless=new',
  // For a Chrome unpacked outside /opt, where the sandbox helper is not setuid:
  // CHROME_ARGS=--no-sandbox.
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

const loaded = await send('Extensions.loadUnpacked', { path: extDir });
const extId = loaded.result?.id;
if (!extId) {
  console.error('Extensions.loadUnpacked failed:', JSON.stringify(loaded.error ?? loaded));
  child.kill();
  process.exit(1);
}

// An MV3 worker stops after ~30 s idle, and the harness pauses between models.
// Staying attached keeps it alive; if it stopped anyway, a real runtime message
// from an extension page starts it again. Detaching after every call is what
// broke the first version: 20 of 20 requests failed after one idle gap.
let workerSession = null;

async function attachWorker() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { targetInfos } = (await send('Target.getTargets')).result;
    const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    if (worker) {
      const attached = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
      if (attached.result?.sessionId) return attached.result.sessionId;
    } else {
      await send('Target.createTarget', { url: `chrome-extension://${extId}/wake.html` });
    }
    await wait(500);
  }
  throw new Error('the extension service worker never started');
}

async function inWorker(expression) {
  for (let attempt = 0; attempt < 2; attempt++) {
    workerSession ??= await attachWorker();
    const reply = await send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      workerSession,
    );
    if (reply.error) {
      workerSession = null; // the session went away with the worker
      continue;
    }
    if (reply.result?.exceptionDetails) {
      throw new Error(reply.result.exceptionDetails.exception?.description ?? 'exception in worker');
    }
    return reply.result?.result?.value;
  }
  throw new Error('the extension service worker kept stopping');
}

await wait(1500);
const version = (await send('Browser.getVersion')).result?.product;
const status = await inWorker('self.status()');
console.log(`${version} — model ${status}`);
if (status !== 'available') {
  console.error('The model is not on this profile. Download it once with ProofKey\'s "Download model" button.');
  child.kill();
  process.exit(1);
}

const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const system = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const user = body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
  // `--temperature 0` maps to what ProofKey ships: greedy, temperature 0 with
  // topK 1. Without the flag, Chrome's own default sampling is measured.
  const sampling = typeof body.temperature === 'number' ? { temperature: body.temperature, topK: 1 } : {};

  try {
    const result = await inWorker(
      `self.complete(${JSON.stringify(system)}, ${JSON.stringify(user)}, ${JSON.stringify(sampling)})`,
    );
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      model: 'gemini-nano',
      choices: [{ message: { role: 'assistant', content: result.reply }, finish_reason: 'stop' }],
      usage: { context_used: result.used, context_window: result.window, generation_ms: result.ms },
      provider: `Chrome built-in, extension service worker (${version})`,
    }));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end(String(error instanceof Error ? error.message : error));
  }
});

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
console.log(`Listening on http://127.0.0.1:${port}/v1 — Ctrl+C to stop`);

const stop = () => {
  server.close();
  child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
