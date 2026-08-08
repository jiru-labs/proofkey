/**
 * Captures the Chrome Web Store screenshots.
 *
 *     npm run serve      # in one terminal
 *     npm run shots      # in another
 *
 * Store listings want 1280x800. Two sources, both real rather than mocked:
 *
 *   - `tools/store-demo.html`, a neutral composer with the shipped
 *     `dist/content.js` loaded into it, so the underlines and the suggestion
 *     card in the shot are the shipping code drawing them.
 *   - The options page of the actual extension, loaded in Chromium the way the
 *     browser loads it, so the settings shots cannot drift from the real UI.
 *
 * Shots land in `store-shots/`. Rerun after any UI change; a listing showing an
 * interface the extension no longer has is a rejection reason.
 */

import { chromium } from 'playwright';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = `${ROOT}store-shots`;
const TEST_EXT = `${ROOT}.shots-ext`;
const PROFILE = `${ROOT}.shots-profile`;
const DEMO = 'http://localhost:8777/tools/store-demo.html';
const SIZE = { width: 1280, height: 800 };

/** Replaces the field's contents and leaves the caret at the end, as a paste does. */
const paste = ([id, text]) => {
  const field = document.getElementById(id);
  field.focus();
  field.replaceChildren(document.createTextNode(text));
  const range = document.createRange();
  range.selectNodeContents(field);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
};

/** Viewport rect of the first underline, whichever surface drew it. */
const firstUnderline = () => {
  const shadow = document.getElementById('proofkey-root')?.shadowRoot;
  const mark = shadow?.querySelector('.pk-u');
  if (mark) {
    const r = mark.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }
  const highlight = ['proofkey-grammar', 'proofkey-spelling', 'proofkey-style']
    .map((name) => CSS.highlights.get(name))
    .find((set) => set && set.size);
  if (!highlight) return null;
  const r = [...highlight][0].getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};

const DRAFT =
  'Hi Sarah, Thanks for sending the projet plan over. Their is alot to go through ' +
  'and i has a few notes wich we should of raised earlier. The meating is thursday ' +
  'and i dont want to be late.';

/**
 * What the options page shows in the shots: a cloud connection with a local
 * model behind it, so the fallback chain is visible, and a filled-in writing
 * profile. The key is a placeholder of the right shape — the field masks it, and
 * a real one has no business in a published screenshot either way.
 */
const SHOWCASE = {
  schemaVersion: 1,
  connections: [
    {
      id: 'gemini-main',
      label: 'Google Gemini',
      presetId: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'AIzaSyExampleKeyNotARealOne0000000000',
      model: 'gemini-2.5-flash',
      transport: 'chat_completions',
      authStyle: 'bearer',
      extraHeaders: {},
      extraBody: {},
      extraQuery: {},
      maxOutputTokens: 512,
    },
    {
      id: 'ollama-local',
      label: 'Ollama (local)',
      presetId: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'llama3.2',
      transport: 'chat_completions',
      authStyle: 'bearer',
      extraHeaders: {},
      extraBody: {},
      extraQuery: {},
      maxOutputTokens: 512,
    },
  ],
  activeConnectionId: 'gemini-main',
  fallbackConnectionIds: ['ollama-local'],
  customActions: [],
  // Chords from the suggestion pool, so the shot shows the feature working and
  // shows keys that are actually free rather than ones Chrome would swallow.
  builtInOverrides: {
    'improve-writing': { shortcut: 'Alt+Shift+KeyG' },
    'make-professional': { shortcut: 'Alt+Shift+KeyK' },
    summarize: { shortcut: 'Alt+Shift+KeyJ' },
  },
  shortcutOrigins: ['https://mail.google.com', 'https://github.com', 'https://www.notion.so'],
  defaultActionId: 'fix-grammar',
  profile: {
    styleGuide: 'We write e-mail, not email. Avoid superlatives.',
    neverFlag: ['ProofKey', 'Jiru Labs'],
    nativeLanguage: 'Portuguese',
    explainLanguage: '',
  },
  liveCheck: {
    enabledOrigins: ['https://web.whatsapp.com', 'https://x.com'],
    blockedOrigins: [],
    debounceMs: 1000,
    minChars: 12,
    maxSentencesPerRequest: 8,
    dictionary: [],
  },
};

async function inlineShots(browser) {
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 2 });
  await page.goto(DEMO, { waitUntil: 'networkidle' });

  await page.evaluate(paste, ['body', DRAFT]);
  await page.waitForFunction(
    () => {
      const shadow = document.getElementById('proofkey-root')?.shadowRoot;
      if (shadow?.querySelector('.pk-u')) return true;
      return ['proofkey-grammar', 'proofkey-spelling', 'proofkey-style'].some(
        (name) => CSS.highlights.get(name)?.size,
      );
    },
    { timeout: 10_000 },
  );
  await page.waitForTimeout(400);

  await page.screenshot({ path: `${OUT}/01-underlines.png` });
  console.log('  01-underlines.png       underlines on a real draft');

  const at = await page.evaluate(firstUnderline);
  if (!at) throw new Error('no underline to click — the card shot cannot be taken');
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(500);

  const cardOpen = await page.evaluate(() => {
    const card = document.getElementById('proofkey-root')?.shadowRoot?.querySelector('.pk-card');
    return !!card && !card.hidden;
  });
  if (!cardOpen) throw new Error('the card did not open');

  await page.screenshot({ path: `${OUT}/02-suggestion-card.png` });
  console.log('  02-suggestion-card.png  the suggestion card, opened on a word');
  await page.close();
}

/**
 * The options page needs the extension actually installed. Host permission is
 * patched in for the same reason `extension-test.mjs` does it: the real grant
 * comes from a click a script cannot produce.
 */
async function optionsShots() {
  await rm(TEST_EXT, { recursive: true, force: true });
  await cp(`${ROOT}dist`, TEST_EXT, { recursive: true });
  const manifest = JSON.parse(await readFile(`${TEST_EXT}/manifest.json`, 'utf8'));
  manifest.host_permissions = ['http://*/*', 'https://*/*'];
  delete manifest.optional_host_permissions;
  await writeFile(`${TEST_EXT}/manifest.json`, JSON.stringify(manifest, null, 2));

  await rm(PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: true,
    viewport: SIZE,
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${TEST_EXT}`, `--load-extension=${TEST_EXT}`],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  const extensionId = new URL(worker.url()).host;

  const page = await context.newPage();
  await page.setViewportSize(SIZE);
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);

  // A configured profile, not a fresh install. The first-run state is all
  // "Needs setup" and "No base URL set", which is honest about a new install and
  // a poor advertisement for what the thing does once it is running.
  await page.evaluate(
    (settings) => chrome.storage.sync.set({ 'proofkey:settings': settings }),
    SHOWCASE,
  );
  await page.reload();
  await page.waitForTimeout(900);

  await page.screenshot({ path: `${OUT}/03-options.png` });
  console.log('  03-options.png          provider settings');

  // The actions list, where the per-action keys live. Scrolled to rather than
  // clicked, so the shot does not depend on a heading staying where it is.
  const scrolled = await page.evaluate(() => {
    const heading = [...document.querySelectorAll('h2, h3')].find((node) =>
      /action|shortcut|key/i.test(node.textContent ?? ''),
    );
    if (!heading) return false;
    heading.scrollIntoView({ block: 'start' });
    return true;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/04-actions.png` });
  console.log(
    `  04-actions.png          actions and their keys${scrolled ? '' : ' (heading not found — check this one)'}`,
  );

  await context.close();
  await rm(TEST_EXT, { recursive: true, force: true });
  await rm(PROFILE, { recursive: true, force: true });
}

async function run() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  console.log('Store screenshots (1280x800, 2x):\n');

  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    await inlineShots(browser);
  } finally {
    await browser.close();
  }

  await optionsShots();

  console.log(`\nWritten to store-shots/. Chrome Web Store takes up to five.`);
}

run().catch((error) => {
  console.error(`\nstore-shots failed: ${error.message}`);
  process.exit(1);
});
