/**
 * Runs the real build against a real provider, end to end, before a release.
 *
 *     npm run build
 *     export PROOFKEY_EVAL_KEY=...
 *     node tools/provider-test.mjs --base http://127.0.0.1:8080/v1 --model qwen3-4b-instruct --temperature 0
 *     PROOFKEY_BROWSER=/usr/bin/brave-origin-stable xvfb-run -a node tools/provider-test.mjs --headed --base ...
 *
 * `test:ext` and `test:render` run against stubs, and a stub agrees with whatever
 * it is sent. This loads `dist/` as it ships, points one OpenAI-compatible
 * connection at a real model, and uses every feature the way a user would: each
 * action, a custom action, the explain card, the dictionary, a live check, a bad
 * key and the fallback chain through the worker; then underline, Apply and a
 * per-action shortcut on a real page, with the content script the extension
 * registers itself.
 *
 * What a model writes is printed, not scored — `npm run eval` and
 * `tools/action-eval.ts` measure quality. This asserts that every path answers,
 * and answers with something that is not the input handed back.
 *
 * Free models are out of scope here as everywhere; see MODELS.md.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = `${ROOT}dist`;
const TEST_EXT = `${ROOT}.provider-ext`;
const PROFILE = `${ROOT}.provider-profile`;
const PORT = 8897;
const PAGE_ORIGIN = `http://localhost:${PORT}`;

const flag = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const base = flag('base');
const model = flag('model');
const temperature = flag('temperature');
const key = process.env['PROOFKEY_EVAL_KEY'];
if (!base || !model || key === undefined) {
  console.error('Usage: PROOFKEY_EVAL_KEY=... node tools/provider-test.mjs --base <url>/v1 --model <id> [--temperature 0] [--headed]');
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const show = (label, text) => console.log(`        ${label}: ${JSON.stringify(text)}`);

const PAGE = `<!doctype html><meta charset="utf-8"><title>provider test</title>
<style>body{font:16px system-ui;margin:40px;width:600px} textarea,div[contenteditable]{display:block;width:560px;height:90px;margin:0 0 40px;font:16px system-ui;padding:8px;border:1px solid #888}</style>
<textarea id="plain"></textarea>
<div id="rich" contenteditable="true"></div>`;

function connection(id, label, apiKey) {
  return {
    id,
    label,
    presetId: 'custom',
    transport: 'chat_completions',
    baseUrl: base,
    apiKey,
    model,
    authStyle: 'bearer',
    extraHeaders: {},
    extraBody: {},
    extraQuery: {},
    ...(temperature === undefined ? {} : { temperature: Number(temperature) }),
    maxOutputTokens: 1024,
  };
}

function settings(overrides = {}) {
  return {
    schemaVersion: 1,
    connections: [connection('real', 'Real provider', key)],
    activeConnectionId: 'real',
    fallbackConnectionIds: [],
    customActions: [],
    builtInOverrides: {},
    defaultActionId: 'fix-grammar',
    profile: { styleGuide: '', neverFlag: [], nativeLanguage: '', explainLanguage: '', translateLanguage: 'Spanish' },
    liveCheck: {
      enabledOrigins: [],
      blockedOrigins: [],
      debounceMs: 800,
      minChars: 12,
      maxSentencesPerRequest: 8,
      dictionary: [],
    },
    shortcutOrigins: [],
    frameOrigins: {},
    ...overrides,
  };
}

/** Underlines on a field, from whichever surface drew them. */
const probe = (id) => {
  const shadow = document.getElementById('proofkey-root')?.shadowRoot;
  const field = document.getElementById(id);
  const marks = shadow ? [...shadow.querySelectorAll('.pk-u')].map((mark) => mark.getBoundingClientRect().toJSON()) : [];
  const ranges = ['proofkey-grammar', 'proofkey-spelling', 'proofkey-style']
    .flatMap((name) => [...(CSS.highlights.get(name) ?? [])])
    .filter((range) => field.contains(range.startContainer))
    .map((range) => range.getBoundingClientRect().toJSON());
  const badge = shadow?.querySelector('.pk-badge');
  return {
    mounted: !!shadow,
    rects: field instanceof HTMLTextAreaElement ? marks : ranges,
    badge: badge && !badge.hidden ? badge.textContent : null,
    text: field.value ?? field.innerText,
  };
};

async function waitFor(page, fn, arg, predicate, timeout) {
  const until = Date.now() + timeout;
  let state = await page.evaluate(fn, arg);
  while (!predicate(state) && Date.now() < until) {
    await page.waitForTimeout(500);
    state = await page.evaluate(fn, arg);
  }
  return state;
}

async function run() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  await rm(TEST_EXT, { recursive: true, force: true });
  await mkdir(TEST_EXT, { recursive: true });
  await cp(DIST, TEST_EXT, { recursive: true });
  // The real flow asks for these from a click a test cannot make.
  const manifestPath = `${TEST_EXT}/manifest.json`;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [`${PAGE_ORIGIN}/*`, `${new URL(base).origin}/*`];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await rm(PROFILE, { recursive: true, force: true });

  const executablePath = process.env['PROOFKEY_BROWSER'];
  const context = await chromium.launchPersistentContext(PROFILE, {
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    headless: !process.argv.includes('--headed'),
    viewport: { width: 900, height: 700 },
    args: [`--disable-extensions-except=${TEST_EXT}`, `--load-extension=${TEST_EXT}`],
  });
  const workerErrors = [];
  context.on('weberror', (error) => workerErrors.push(String(error.error())));

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  const extensionId = new URL(worker.url()).host;

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/index.html`);
  await options.waitForTimeout(500);
  const version = await options.evaluate(() => chrome.runtime.getManifest().version);
  const browserVersion = context.browser()?.version() ?? (await options.evaluate(() => navigator.userAgent));
  console.log(`\nProofKey ${version} in ${executablePath ?? 'Playwright Chromium'} (${browserVersion})`);
  console.log(`provider ${base}, model ${model}${temperature === undefined ? '' : `, temperature ${temperature}`}`);

  const store = (value) => options.evaluate((s) => chrome.storage.sync.set({ 'proofkey:settings': s }), value);
  const ask = (message) => options.evaluate((m) => chrome.runtime.sendMessage(m), message);
  const timed = async (message) => {
    const started = Date.now();
    const reply = await ask(message);
    return { reply, ms: Date.now() - started };
  };

  // ------------------------------------------------------------- every action
  console.log('\nevery action, through the real worker:');
  await store(settings({
    customActions: [{ id: 'custom-shout', label: 'Shout', systemPrompt: 'Rewrite the text in capital letters. Change nothing else.', enabled: true }],
  }));
  await options.waitForTimeout(300);
  const state = await ask({ type: 'proofkey:get-state' });
  const actions = state?.value?.actions ?? [];
  check('the state lists the built-in actions and the custom one', actions.length >= 9 && actions.some((a) => a.id === 'custom-shout'),
    actions.map((a) => a.id).join(', '));

  const SAMPLE = 'Their is alot of things we needs to discuss in the meeting tomorow, so please come prepared and bring you notes.';
  for (const action of actions) {
    const { reply, ms } = await timed({ type: 'proofkey:run', actionId: action.id, text: SAMPLE });
    const text = reply?.value?.text ?? '';
    check(`${action.label} answers with new text`, reply?.ok === true && text.length > 0 && text !== SAMPLE,
      reply?.ok ? `${ms} ms, served by ${reply.value.servedBy}` : reply?.error);
    if (reply?.ok) show('out', text);
    if (action.id === 'fix-grammar' && reply?.ok) {
      check('Fix grammar fixes the obvious errors', /there (is|are) a lot/i.test(text) && /tomorrow/i.test(text) && /\bneed to\b/i.test(text));
    }
    if (action.id === 'custom-shout' && reply?.ok) {
      check('the custom action followed its own prompt', text === text.toUpperCase() && /[A-Z]/.test(text));
    }
  }

  // ------------------------------------------------------------- live check
  console.log('\nlive check, as the content script batches it:');
  const sentences = [
    'i has been working on this projet since last week.',
    'The report is ready.',
    'We was going to the meating on thursday.',
    'See https://example.com/docs?a=1&b=2 for details.',
  ];
  {
    const { reply, ms } = await timed({ type: 'proofkey:check', sentences });
    const corrections = reply?.value?.corrections ?? [];
    check('it succeeds', reply?.ok === true, reply?.ok ? `${ms} ms` : reply?.error);
    check('one line back per sentence', corrections.length === sentences.length, `${corrections.length}`);
    check('the wrong sentences come back corrected', corrections[0] !== sentences[0] && corrections[2] !== sentences[2]);
    check('the clean ones come back unchanged', corrections[1] === sentences[1] && corrections[3] === sentences[3],
      JSON.stringify([corrections[1], corrections[3]]));
    corrections.forEach((c, i) => c !== sentences[i] && show(sentences[i], c));
  }

  // ---------------------------------------------------------------- explain
  console.log('\nexplain card:');
  {
    const { reply, ms } = await timed({ type: 'proofkey:explain', original: 'We was going', replacement: 'We were going' });
    check('it explains the change', reply?.ok === true && (reply.value.text ?? '').length > 10, reply?.ok ? `${ms} ms` : reply?.error);
    if (reply?.ok) show('out', reply.value.text);
  }

  // ------------------------------------------------------------- dictionary
  console.log('\ndictionary:');
  {
    const reply = await ask({ type: 'proofkey:add-word', word: 'ProofKey' });
    check('a word is added', reply?.ok === true && reply.value.includes('ProofKey'), JSON.stringify(reply?.value ?? reply?.error));
    const stored = await options.evaluate(async () => (await chrome.storage.sync.get('proofkey:settings'))['proofkey:settings']);
    check('and survives in storage', stored?.liveCheck?.dictionary?.includes('ProofKey'));
  }

  // --------------------------------------------------- bad key and fallback
  console.log('\na rejected key, then the fallback chain:');
  if (key) {
    await store(settings({ connections: [connection('real', 'Real provider', 'wrong-key')] }));
    await options.waitForTimeout(300);
    const bad = await ask({ type: 'proofkey:run', actionId: 'fix-grammar', text: SAMPLE });
    check('a wrong key fails with a message, not silence', bad?.ok === false && (bad.error ?? '').length > 0, bad?.error ?? JSON.stringify(bad));

    await store(settings({
      connections: [connection('broken', 'Broken key', 'wrong-key'), connection('real', 'Real provider', key)],
      activeConnectionId: 'broken',
      fallbackConnectionIds: ['real'],
    }));
    await options.waitForTimeout(300);
    const saved = await ask({ type: 'proofkey:run', actionId: 'fix-grammar', text: SAMPLE });
    check('the fallback connection answers instead', saved?.ok === true && saved.value.servedBy === 'Real provider',
      saved?.ok ? `served by ${saved.value.servedBy}, ${saved.value.fallbackErrors?.length ?? 0} error(s) recorded` : saved?.error);
  } else {
    console.log('  (skipped: the provider takes no key, so no key can be wrong)');
  }

  // ------------------------------------------------------------- real page
  // The page's origin gets the content script the way a user's toggle gives it:
  // through settings the worker turns into a registration.
  await store(settings({
    shortcutOrigins: [PAGE_ORIGIN],
    liveCheck: { ...settings().liveCheck, enabledOrigins: [PAGE_ORIGIN] },
    builtInOverrides: { 'fix-grammar': { shortcut: 'Alt+KeyG' } },
  }));
  await options.waitForTimeout(1000);

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${PAGE_ORIGIN}/`);
  await page.waitForTimeout(1500);

  for (const id of ['plain', 'rich']) {
    console.log(`\nreal page, ${id === 'plain' ? 'textarea' : 'contenteditable'}: underline and Apply`);
    await page.click(`#${id}`);
    await page.keyboard.type('i has a eror in this sentense. We was late to the meating on thursday.', { delay: 15 });
    const found = await waitFor(page, probe, id, (s) => s.rects.length > 0, 60_000);
    check('the content script mounted', found.mounted);
    check('the errors are underlined', found.rects.length > 0, `${found.rects.length} underline(s), badge ${JSON.stringify(found.badge)}`);
    if (!found.rects.length) continue;

    const before = found.text;
    const rect = found.rects[0];
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.waitForTimeout(400);
    const button = await page.evaluate(() => {
      const shadow = document.getElementById('proofkey-root').shadowRoot;
      const card = shadow.querySelector('.pk-card');
      if (!card || card.hidden) return null;
      const r = shadow.querySelector('.pk-btn--primary').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, before: shadow.querySelector('.pk-card__before')?.textContent, after: shadow.querySelector('.pk-card__after')?.textContent };
    });
    check('clicking an underline opens its card', !!button, button ? `${JSON.stringify(button.before)} → ${JSON.stringify(button.after)}` : 'no card');
    if (!button) continue;
    await page.mouse.click(button.x, button.y);
    const applied = await waitFor(page, probe, id, (s) => s.text !== before, 5_000);
    check('Apply writes the correction into the field', applied.text !== before && applied.text.includes(button.after ?? '\u0000'),
      JSON.stringify(applied.text));
  }

  console.log('\nreal page: per-action shortcut on the focused field');
  {
    await page.evaluate(() => {
      const field = document.getElementById('plain');
      field.value = '';
      field.focus();
    });
    await page.keyboard.type('Their is alot of things to do', { delay: 15 });
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => document.getElementById('plain').value);
    await page.keyboard.press('Alt+KeyG');
    const after = await waitFor(page, probe, 'plain', (s) => s.text !== before, 60_000);
    check('Alt+G runs Fix grammar and rewrites the field', after.text !== before && /there (is|are) a lot/i.test(after.text), JSON.stringify(after.text));
  }

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; ') || 'clean');
  check('no uncaught worker errors', workerErrors.length === 0, workerErrors.join('; ') || 'clean');

  await context.close();
  server.close();
  await rm(PROFILE, { recursive: true, force: true });
  await rm(TEST_EXT, { recursive: true, force: true });

  console.log(failures === 0 ? '\nProvider checks passed.' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
