/**
 * Updates a real published release to the build in `dist`, in one profile, and
 * checks that what its user had set up is still there.
 *
 *     npm run build && npm run test:upgrade            # the latest GitHub release
 *     npm run build && npm run test:upgrade -- v0.1.26
 *
 * The extension test seeds storage by hand in the shape an earlier version is
 * believed to leave. This does not believe anything: the old release is set up
 * through its own settings page — a provider with a key and an extra header, a
 * second one ticked as Backup, a writing rule — and saved by its own code. Then
 * the files are swapped for `dist` under the same path, so the extension keeps
 * its id and profile, exactly as a store update does. Run it before a release
 * that touches storage; it needs `gh` and the network, so it is not in verify.
 *
 * The only stand-in is `permissions.request`, answered yes: Save asks for the
 * provider's site from a click, and that dialog never resolves headless.
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = `${ROOT}dist`;
const WORK = await mkdtemp(join(tmpdir(), 'proofkey-upgrade-'));
const EXT = join(WORK, 'ext');
const PROFILE = join(WORK, 'profile');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

const gh = (...args) => execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const tag = process.argv[2] ?? gh('release', 'view', '--json', 'tagName', '--jq', '.tagName');

/** The release's own zip, unpacked: what the store hands an installed user. */
async function fetchRelease() {
  gh('release', 'download', tag, '--pattern', '*.zip', '--dir', WORK);
  const zip = execFileSync('sh', ['-c', `ls "${WORK}"/*.zip`], { encoding: 'utf8' }).trim();
  execFileSync('unzip', ['-q', zip, '-d', join(WORK, 'old')]);
  return join(WORK, 'old');
}

/**
 * `dist` with a version above the old one: Chromium only treats changed files
 * under the same path as an update — `onInstalled` with reason `update` — when
 * the version moved, and `main` keeps the released version until release time.
 */
async function newBuild(oldVersion) {
  const dir = join(WORK, 'new');
  await cp(DIST, dir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.version === oldVersion) {
    const parts = oldVersion.split('.').map(Number);
    parts[parts.length - 1] += 1;
    manifest.version = parts.join('.');
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  return dir;
}

async function launch(from) {
  if (from) {
    await rm(EXT, { recursive: true, force: true });
    await cp(from, EXT, { recursive: true });
  }
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/options/index.html`);
  await page.getByRole('button', { name: '+ Add provider' }).waitFor();
  return { context, page };
}

const storage = (page) =>
  page.evaluate(async () => ({ sync: await chrome.storage.sync.get(null), local: await chrome.storage.local.get(null) }));

const NAME_FIELD = 'input[placeholder="Work key, Local Ollama…"]';

/** Adds a provider card and fills it the way a user would. */
async function addProvider(page, { label, preset, key, model }) {
  await page.getByRole('button', { name: '+ Add provider' }).click();
  const card = page.locator(NAME_FIELD).last().locator('xpath=ancestor::*[.//button[normalize-space()="Make active"]][1]');
  await card.locator(NAME_FIELD).fill(label);
  const select = card.locator('select').first();
  const value = await select.locator('option').evaluateAll(
    (options, name) => options.find((o) => o.textContent.trim().startsWith(name))?.value,
    preset,
  );
  await select.selectOption(value);
  await card.locator('input[type=password]').fill(key);
  await card.locator('input[placeholder="model name"]').fill(model);
  return card;
}

async function save(page) {
  await page.evaluate(() => { chrome.permissions.request = async () => true; });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Unsaved changes').waitFor({ state: 'hidden' }).catch(() => {});
  await page.waitForTimeout(500);
}

const rulesField = (page) => page.locator('section.card', { hasText: 'Your writing rules' }).locator('textarea').first();

async function run() {
  console.log(`\nset up ${tag} through its own settings page:`);
  const old = await fetchRelease();
  const oldVersion = JSON.parse(await readFile(join(old, 'manifest.json'), 'utf8')).version;
  let { context, page } = await launch(old);

  const work = await addProvider(page, { label: 'Work key', preset: 'OpenAI', key: 'sk-upgrade-work-0001', model: 'gpt-4.1-mini' });
  await work.locator('details').evaluateAll((all) => all.forEach((d) => { d.open = true; }));
  await work.locator('textarea:visible').first().fill('{"X-Org-Secret":"header-secret-42"}');
  await work.getByRole('button', { name: 'Make active' }).click();
  const spare = await addProvider(page, { label: 'Spare', preset: 'Mistral', key: 'sk-upgrade-spare-0002', model: 'mistral-small-latest' });
  await spare.locator('input[data-backup]').check();
  await rulesField(page).fill('We write "e-mail", never "email". UPGRADE-MARKER');
  await save(page);

  const before = await storage(page);
  const was = before.sync['proofkey:settings'] ?? before.local['proofkey:settings'];
  check(`${oldVersion} saved the setup`, JSON.stringify(was ?? {}).includes('UPGRADE-MARKER')
    && was.connections.some((c) => c.label === 'Spare') && was.fallbackConnectionIds?.length === 1);
  await context.close();

  const fresh = await newBuild(oldVersion);
  console.log(`\nupdate to dist in the same profile:`);
  ({ context, page } = await launch(fresh));
  await page.waitForTimeout(1500);
  const after = await storage(page);
  const now = after.local['proofkey:settings'];
  const byLabel = (label) => now?.connections?.find((c) => c.label === label);
  const keys = after.local['proofkey:apiKeys'] ?? {};

  check('settings are in storage.local', now?.connections?.length === was.connections.length, JSON.stringify(Object.keys(after.local)));
  check('the same provider is active', now?.activeConnectionId === was.activeConnectionId);
  check('the backup is still the backup', now?.fallbackConnectionIds?.[0] === byLabel('Spare')?.id && now.fallbackConnectionIds.length === 1,
    JSON.stringify(now?.fallbackConnectionIds));
  check('both keys kept, in the key record and not in the settings',
    keys[byLabel('Work key')?.id] === 'sk-upgrade-work-0001' && keys[byLabel('Spare')?.id] === 'sk-upgrade-spare-0002'
      && !JSON.stringify(now).includes('sk-upgrade'));
  check('the extra header kept', byLabel('Work key')?.extraHeaders?.['X-Org-Secret'] === 'header-secret-42',
    JSON.stringify(byLabel('Work key')?.extraHeaders));
  check('the writing rules kept', JSON.stringify(now).includes('UPGRADE-MARKER'));
  check('sync left as it was, for computers not yet updated', JSON.stringify(after.sync['proofkey:settings']) === JSON.stringify(before.sync['proofkey:settings']));
  check('no key in sync', !JSON.stringify(after.sync).includes('sk-upgrade'));

  await page.reload();
  await page.getByRole('button', { name: '+ Add provider' }).waitFor();
  await page.waitForTimeout(500);
  // A card other than the active one is drawn folded: its name and badge, no fields.
  const { values, text } = await page.evaluate(() => ({
    values: [...document.querySelectorAll('input, textarea')].map((e) => e.value),
    text: document.body.innerText,
  }));
  check('the page shows the active provider with its key', values.includes('Work key') && values.includes('sk-upgrade-work-0001'));
  check('and the spare, marked Backup', /Spare\s*Backup/.test(text), text.match(/Spare.{0,40}/s)?.[0]);
  check('the page shows the writing rules', values.some((v) => v.includes('UPGRADE-MARKER')));

  await rulesField(page).fill('Edited after the update. AFTER-MARKER');
  await save(page);
  await context.close();
  ({ context, page } = await launch());
  await page.waitForTimeout(1500);
  const again = await storage(page);
  check('an edit after the update survives a restart, not overwritten from sync',
    JSON.stringify(again.local['proofkey:settings']).includes('AFTER-MARKER'));
  check('and it is not written to sync', !JSON.stringify(again.sync).includes('AFTER-MARKER'));
  await context.close();
}

try {
  await run();
} catch (error) {
  failures++;
  console.log(`  FAIL  ${error.message.split('\n')[0]}`);
} finally {
  await rm(WORK, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nupgrade: all checks pass');
process.exit(failures ? 1 : 0);
