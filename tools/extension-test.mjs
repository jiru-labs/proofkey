/**
 * Loads the real extension in Chromium and inspects what it puts on the wire.
 *
 *     npm run build && node tools/extension-test.mjs
 *
 * Everything else in this repo tests the content script with a stubbed service
 * worker. This runs the actual worker — real storage, real provider code — and
 * points it at a local endpoint that records the request, so the shape of what
 * each transport sends can be asserted rather than assumed. Service-worker
 * console errors are surfaced too; without this they are invisible.
 *
 * The extension is copied to `.test-ext` and its manifest patched to hold the
 * host permission outright, because the real flow asks for it from a click that
 * a test cannot produce.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = `${ROOT}dist`;
const TEST_EXT = `${ROOT}.test-ext`;
const PROFILE = `${ROOT}.test-profile`;
const PORT = 8899;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Records every request so the test can assert on it. */
function startStubProvider() {
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      seen.push({
        path: request.url,
        method: request.method,
        headers: request.headers,
        body: body ? JSON.parse(body) : null,
      });

      response.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
      });

      // Gemini's catalogue shape: ids carry the `models/` resource prefix, and
      // `antigravity-preview-05-2026` sorts ahead of every gemini-* entry. That
      // combination is what used to end up in an empty model field.
      if (request.url.includes('/models')) {
        response.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'models/gemini-2.5-flash' },
              { id: 'models/antigravity-preview-05-2026' },
              { id: 'models/embedding-001' },
              { id: 'models/gemini-2.5-flash-lite' },
            ],
          }),
        );
        return;
      }

      // Reply in whichever shape the caller asked for.
      response.end(
        request.url.includes('/messages')
          ? JSON.stringify({
              model: 'stub-anthropic',
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'There is a lot to do.' }],
              usage: { input_tokens: 10, output_tokens: 5 },
            })
          : JSON.stringify({
              model: 'stub-openai',
              choices: [{ message: { content: 'There is a lot to do.' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }),
      );
    });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve({ server, seen })));
}

async function buildTestExtension() {
  await rm(TEST_EXT, { recursive: true, force: true });
  await mkdir(TEST_EXT, { recursive: true });
  await cp(DIST, TEST_EXT, { recursive: true });

  const manifestPath = `${TEST_EXT}/manifest.json`;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [`http://localhost:${PORT}/*`];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

function settingsFor(transport) {
  const shared = {
    id: 'test-connection',
    label: 'Stub',
    baseUrl: `http://localhost:${PORT}/v1`,
    apiKey: 'test-key-123',
    model: 'stub-model',
    extraHeaders: {},
    extraBody: {},
    extraQuery: {},
    maxOutputTokens: 512,
  };

  const connection =
    transport === 'anthropic_messages'
      ? { ...shared, presetId: 'anthropic', transport, authStyle: 'x-api-key' }
      : { ...shared, presetId: 'custom', transport, authStyle: 'bearer' };

  return {
    schemaVersion: 1,
    connections: [connection],
    activeConnectionId: connection.id,
    fallbackConnectionIds: [],
    customActions: [],
    builtInOverrides: {},
    defaultActionId: 'fix-grammar',
    profile: { styleGuide: '', neverFlag: [], nativeLanguage: '', explainLanguage: '' },
    liveCheck: {
      enabledOrigins: [],
      blockedOrigins: [],
      debounceMs: 1000,
      minChars: 12,
      maxSentencesPerRequest: 8,
      dictionary: [],
    },
  };
}

/**
 * A Gemini-preset connection with an empty model field, pointed at the stub.
 * The preset supplies `stripIdPrefix` and the default model, so this exercises
 * the real registry row rather than a fixture of one.
 */
function geminiSettings() {
  const base = settingsFor('chat_completions');
  return {
    ...base,
    connections: [{ ...base.connections[0], presetId: 'gemini', model: '' }],
  };
}

async function run() {
  const { server, seen } = await startStubProvider();
  await buildTestExtension();
  await rm(PROFILE, { recursive: true, force: true });

  // MV3 service workers only run under Chromium's new headless mode, which
  // Playwright exposes as the `chromium` channel. The default headless build
  // loads no extensions at all and the worker never registers.
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${TEST_EXT}`, `--load-extension=${TEST_EXT}`],
  });

  const workerErrors = [];
  context.on('weberror', (error) => workerErrors.push(String(error.error())));

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });

  const extensionId = new URL(worker.url()).host;
  console.log(`\nextension loaded: ${extensionId}`);
  check('service worker registered', !!worker);

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });

  await page.goto(`chrome-extension://${extensionId}/options/index.html`);
  await page.waitForTimeout(500);

  check(
    'options page renders without errors',
    pageErrors.length === 0,
    pageErrors.join('; ') || 'clean',
  );
  check(
    'options page shows the provider section',
    (await page.locator('text=Providers').count()) > 0,
  );
  check(
    'writing-rules section is present',
    (await page.locator('text=Your writing rules').count()) > 0,
  );
  check(
    'live checking can be pinned to its own connection',
    (await page.locator('option', { hasText: 'Same as the active connection' }).count()) > 0,
    'liveCheck.connectionId is the biggest lever on cost; it has to be reachable from the UI',
  );

  // Per-action shortcuts, against the real storage the options page writes to.
  // The recorder can look right and still store nothing: a built-in's chord
  // goes into `builtInOverrides`, not onto the action, and that is invisible
  // from the UI until the page is reloaded.
  {
    console.log('\nshortcuts:');
    check(
      'the origins where shortcuts run are configurable',
      (await page.locator('text=Shortcuts run on').count()) > 0,
      'without an origin the content script is never registered and no key can fire',
    );

    await page.locator('details.action').first().evaluate((node) => (node.open = true));
    const recorder = page.locator('[data-shortcut-for="fix-grammar"]');
    check('the first action has a recorder', (await recorder.count()) > 0);

    await recorder.click();
    check('clicking it arms the recorder', (await recorder.textContent()) === 'Press a key…');

    // Refused first: the reply has to say why, not silently store it.
    await page.keyboard.press('Control+KeyV');
    await page.waitForTimeout(150);
    const refusal = await page.locator('.shortcut .field__hint--error').first().textContent();
    check(
      'a chord that would break paste is refused',
      (await recorder.textContent()) === 'Press a key…' && !!refusal?.includes('paste'),
      refusal ?? 'no reason given',
    );

    await page.keyboard.press('Alt+KeyG');
    await page.waitForTimeout(200);
    check(
      'a usable chord is accepted and shown',
      (await page.locator('[data-shortcut-for="fix-grammar"]').textContent()) === 'Alt+G',
    );

    // No origin is listed at this point, so the key cannot fire anywhere. The
    // confirmation on its own reads as "done", which is how you end up pressing
    // a key that was never going to work.
    check(
      'a key bound with no site listed says so',
      (await page.locator('.shortcut-origins .notice--warn').count()) > 0 &&
        (await page.locator('text=this key cannot run anywhere yet').count()) > 0,
      'otherwise the only symptom is a key that does nothing',
    );

    await page.locator('button', { hasText: 'Save' }).last().click();
    await page.waitForTimeout(600);

    const stored = await page.evaluate(async () => {
      const all = await chrome.storage.sync.get('proofkey:settings');
      return all['proofkey:settings'] ?? null;
    });
    check(
      'the chord survives a save, in canonical form',
      stored?.builtInOverrides?.['fix-grammar']?.shortcut === 'Alt+KeyG',
      JSON.stringify(stored?.builtInOverrides?.['fix-grammar'] ?? null),
    );

    // Removal has to clear the key rather than leave a stale one behind.
    await page.locator('details.action').first().evaluate((node) => (node.open = true));
    await page.locator('.shortcut button', { hasText: 'Remove' }).first().click();
    await page.waitForTimeout(200);
    await page.locator('button', { hasText: 'Save' }).last().click();
    await page.waitForTimeout(600);

    const afterRemoval = await page.evaluate(async () => {
      const all = await chrome.storage.sync.get('proofkey:settings');
      const settings = all['proofkey:settings'];
      return settings ? { overrides: settings.builtInOverrides ?? {} } : null;
    });
    check(
      'removing it clears the stored chord',
      afterRemoval !== null && afterRemoval.overrides['fix-grammar']?.shortcut === undefined,
      JSON.stringify(afterRemoval?.overrides ?? null),
    );
    check(
      'and does not leave an empty override behind',
      afterRemoval !== null && !('fix-grammar' in afterRemoval.overrides),
      'storage.sync has a per-item quota; empty objects are not worth any of it',
    );

    // The registration itself, in the real service worker. Everything above can
    // pass with this broken, and the result would be a key that works only
    // after the user has right-clicked the page once — which is precisely the
    // failure the whole origin mechanism exists to prevent.
    const origin = `http://localhost:${PORT}`;
    const setOrigins = (origins) =>
      page.evaluate(async (list) => {
        const all = await chrome.storage.sync.get('proofkey:settings');
        const settings = all['proofkey:settings'] ?? {};
        settings.shortcutOrigins = list;
        await chrome.storage.sync.set({ 'proofkey:settings': settings });
      }, origins);
    const registeredIds = () =>
      page.evaluate(() => chrome.scripting.getRegisteredContentScripts());

    await setOrigins([origin]);
    await page.waitForTimeout(900);
    const registered = await registeredIds();
    const script = registered.find((entry) => entry.id === 'proofkey-shortcuts');
    check(
      'listing an origin registers the content script there',
      !!script && script.matches.includes(`${origin}/*`),
      script ? script.matches.join(', ') : 'nothing registered',
    );
    check(
      'and it registers the same bundle the menu injects',
      !!script && script.js.includes('content.js'),
      script?.js?.join(', ') ?? 'no files',
    );

    await setOrigins([]);
    await page.waitForTimeout(900);
    check(
      'removing the origin unregisters it again',
      !(await registeredIds()).some((entry) => entry.id === 'proofkey-shortcuts'),
      'a listener the user thinks they removed must not survive',
    );
  }

  for (const transport of ['chat_completions', 'anthropic_messages']) {
    console.log(`\n${transport}:`);
    seen.length = 0;

    await page.evaluate(
      (settings) => chrome.storage.sync.set({ 'proofkey:settings': settings }),
      settingsFor(transport),
    );

    const reply = await page.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'proofkey:run',
        actionId: 'fix-grammar',
        text: 'Their is alot of things to do.',
      }),
    );

    check('worker returns a result', reply?.ok === true, reply?.ok ? reply.value.text : reply?.error);

    const request = seen[0];
    if (!request) {
      check('request reached the provider', false, 'nothing recorded');
      continue;
    }

    const expectedPath = transport === 'anthropic_messages' ? '/v1/messages' : '/v1/chat/completions';
    check('endpoint path', request.path === expectedPath, request.path);

    if (transport === 'anthropic_messages') {
      check('x-api-key header sent', request.headers['x-api-key'] === 'test-key-123');
      check('anthropic-version header sent', request.headers['anthropic-version'] === '2023-06-01');
      check(
        'browser-access header sent',
        request.headers['anthropic-dangerous-direct-browser-access'] === 'true',
        'required or the CORS preflight fails from an extension',
      );
      check('system sent as a top-level string', typeof request.body.system === 'string');
      check('messages array carries only the user turn', request.body.messages.length === 1);
      check(
        'temperature omitted',
        !('temperature' in request.body),
        'current Claude models reject it',
      );
    } else {
      check('bearer auth sent', request.headers['authorization'] === 'Bearer test-key-123');
      check(
        'system sent as the first message',
        request.body.messages?.[0]?.role === 'system',
      );
      check('user text sent as the second message', request.body.messages?.[1]?.role === 'user');
      check('temperature omitted', !('temperature' in request.body));
    }

    check(
      'style-guide rules would ride on the system prompt',
      String(request.body.system ?? request.body.messages?.[0]?.content ?? '').includes(
        'Output only the resulting text',
      ),
      'output contract present',
    );
  }

  // ------------------------------------------------------------ model picker
  // Regression test for a real report: the Gemini dropdown appeared to hold a
  // single model, `models/antigravity-preview-05-2026`. Nothing was filtered —
  // the list is sorted alphabetically, the empty field took entry [0], and the
  // datalist then matched only the value now sitting in the field.
  console.log('\nmodel picker:');

  await page.evaluate(
    (settings) => chrome.storage.sync.set({ 'proofkey:settings': settings }),
    geminiSettings(),
  );
  await page.reload();
  await page.waitForTimeout(300);

  const modelField = page.locator('input[placeholder="model name"]').first();
  check('model field starts empty', (await modelField.inputValue()) === '');

  await page.getByRole('button', { name: 'Fetch models' }).first().click();
  await page.waitForTimeout(800);

  const picked = await modelField.inputValue();
  check(
    'alphabetically-first model is not adopted',
    picked !== 'antigravity-preview-05-2026' && picked !== 'models/antigravity-preview-05-2026',
    picked || '(empty)',
  );
  check(
    "preset's own default is adopted instead",
    picked === 'gemini-2.5-flash',
    picked || '(empty)',
  );
  check(
    'models/ prefix stripped — the bare id is the measured form',
    !picked.startsWith('models/'),
    picked,
  );

  const browse = page.locator('.field__picker select').first();
  check('browse list rendered', (await browse.count()) > 0);

  const browseOptions = await browse.locator('option').allTextContents();
  check(
    'browse list holds every model regardless of the field',
    browseOptions.filter((text) => !text.startsWith('Browse all')).length === 4,
    `${browseOptions.length} options with the field reading "${picked}"`,
  );
  check(
    'browse list is also stripped',
    browseOptions.some((text) => text === 'gemini-2.5-flash-lite'),
    browseOptions.join(', '),
  );

  const datalistOptions = await page.locator('datalist option').count();
  check('datalist still populated for type-to-filter', datalistOptions === 4, `${datalistOptions}`);

  check('no uncaught worker errors', workerErrors.length === 0, workerErrors.join('; ') || 'clean');

  await context.close();
  server.close();
  await rm(PROFILE, { recursive: true, force: true });
  await rm(TEST_EXT, { recursive: true, force: true });

  console.log(failures === 0 ? '\nExtension checks passed.' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
