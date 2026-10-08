// Typing-latency runner that never touches the OS keyboard or focus: it drives a
// throwaway browser profile over the browser's own protocol (Playwright), so the
// person using this computer keeps working. Usage:
//   node runner.mjs plan.json
// plan: { exe, profile, ext, lab, expectVersion, window: [x,y,w,h], runs: [{ name, origin?, kind?, sentences? }] }
//   kind: "type" (default, 8 sentences), "long" (N distinct sentences), "action-mid" (8 sentences, Fix grammar after the 4th)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const lab = plan.lab ?? 'http://127.0.0.1:8777';
const log = (ev, extra = {}) => {
  const line = JSON.stringify({ src: 'runner', ev, t: Date.now(), ...extra });
  console.log(line);
  return fetch(lab + '/log', { method: 'POST', body: line }).catch(() => undefined);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = [
  'Ths is a sentnce with sevral erors that i wrote quikly.',
  'Yesterday we goed to the markt and buyed some aples.',
  'Their is a lot of things to do befor the meeting tomorow.',
  'She dont know were the documants are, and nether do I.',
  'The report have been sended to the cliant last weak.',
  "I recieved you're message and will anwser as soon as posible.",
  'Our team are working hardly to finnish the project on time.',
  'Please let me knew if their is anything else I can do.',
];
const PLACES = ['Lisbon', 'Madrid', 'Porto', 'Valencia', 'Seville', 'Bilbao', 'Malaga', 'Granada'];
function sentencesFor(run) {
  if (run.kind === 'long') {
    const n = run.sentences ?? 48;
    // Distinct text every time: an identical sentence is answered from the page's cache.
    return Array.from({ length: n }, (_, i) => BASE[i % 8].replace(/\.$/, ` in ${PLACES[Math.floor(i / 8) % 8]} ${i + 1}.`));
  }
  return BASE;
}

const [x, y, w, h] = plan.window ?? [-1400, 500, 1300, 900];
const context = await chromium.launchPersistentContext(plan.profile, {
  executablePath: plan.exe,
  headless: false,
  viewport: null,
  ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
  args: [
    `--disable-extensions-except=${plan.ext}`,
    `--load-extension=${plan.ext}`,
    `--window-position=${x},${y}`,
    `--window-size=${w},${h}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Keep painting while covered by other windows, so the measurement holds
    // with the test window behind the user's own.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
  ],
});
let result = { ok: false };
try {
  const findWorker = async () => {
    for (let i = 0; i < 100; i++) {
      const w = context.serviceWorkers().find((sw) => sw.url().startsWith('chrome-extension://'));
      if (w) return w;
      await sleep(200);
    }
    throw new Error('the extension service worker did not start');
  };
  let worker = await findWorker();
  const extId = new URL(worker.url()).host;
  // A restart can keep an old service worker. The extensions page's own Reload
  // (what its button calls) re-reads it from disk; chrome.runtime.reload() of an
  // extension loaded from the command line leaves it disabled instead.
  const mgr = await context.newPage();
  await mgr.goto('chrome://extensions');
  const version = await mgr.evaluate(async (id) => {
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
    await chrome.developerPrivate.reload(id, { failQuietly: true, populateErrorForUnpacked: false });
    await new Promise((r) => setTimeout(r, 3000));
    return (await chrome.developerPrivate.getExtensionInfo(id)).version;
  }, extId);
  await mgr.close();
  await log('extension', { version, extId });
  if (plan.expectVersion && version !== plan.expectVersion) throw new Error(`version ${version}, expected ${plan.expectVersion}`);

  for (const p of context.pages().slice(1)) await p.close().catch(() => undefined);
  const page = context.pages()[0] ?? (await context.newPage());
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/options/index.html`).catch(() => undefined);
  await page.bringToFront().catch(() => undefined);

  for (const run of plan.runs) {
    const origin = run.origin ?? lab;
    await page.goto(`${origin}/?run=${encodeURIComponent(run.name)}`);
    await sleep(5000);
    const before = await page.evaluate(() => {
      const hst = document.getElementById('proofkey-root');
      return hst?.shadowRoot ? hst.shadowRoot.querySelectorAll('.pk-u').length : -1;
    });
    await log('run-start', { run: run.name, underlinesBefore: before });
    await page.focus('#t');
    const list = sentencesFor(run);
    for (let i = 0; i < list.length; i++) {
      await page.keyboard.type(list[i] + ' ', { delay: 80 });
      if (run.kind === 'action-mid' && i === 3) {
        await log('action', { run: run.name });
        const r = await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'proofkey:run', actionId: 'fix-grammar', text: 'Todo esta bien pero todavia no.' }));
        await log('action-done', { run: run.name, ok: r?.ok });
      }
      await sleep(2000);
    }
    await sleep(15000);
    const s = await page.evaluate(() => (typeof summary === 'function' ? summary() : null));
    if (s) {
      await fetch(`${lab}/results?run=${encodeURIComponent(run.name)}`, { method: 'POST', body: JSON.stringify(s) }).catch(() => undefined);
      await log('run-end', { run: run.name, keydowns: s.keydowns, over100: s.over100, over200: s.over200, worst: s.worst, underlines: s.marks.at(-1)?.n });
    }
  }
  result = { ok: true };
} catch (error) {
  result = { ok: false, error: String(error?.stack ?? error) };
} finally {
  await log('done', result);
  await context.close().catch(() => undefined);
}
