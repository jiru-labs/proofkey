/**
 * Records the README demo GIF.
 *
 *     npm run serve        # in one terminal
 *     node tools/demo-gif.mjs
 *
 * Same source as the store screenshots: `tools/store-demo.html` with the shipped
 * `dist/content.js` loaded into it and canned corrections behind the mocked
 * worker, so no provider or key is involved and the underlines, the card and the
 * apply are the shipping code doing them. Output: `store-shots/demo.gif`.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = `${ROOT}store-shots`;
const VIDEO = `${ROOT}.demo-video`;
const DEMO = 'http://localhost:8777/tools/store-demo.html';
const SIZE = { width: 960, height: 560 };

const DRAFT =
  'Hi Sarah, Thanks for sending the projet plan over. Their is alot to go through ' +
  'and i has a few notes wich we should of raised earlier.';

const underlineCount = () => {
  const shadow = document.getElementById('proofkey-root')?.shadowRoot;
  const marks = shadow?.querySelectorAll('.pk-u').length ?? 0;
  if (marks) return marks;
  return ['proofkey-grammar', 'proofkey-spelling', 'proofkey-style']
    .map((name) => CSS.highlights.get(name)?.size ?? 0)
    .reduce((a, b) => a + b, 0);
};

/** Viewport centre of the n-th underline, whichever surface drew it. */
const underlineAt = (n) => {
  const shadow = document.getElementById('proofkey-root')?.shadowRoot;
  const marks = shadow ? [...shadow.querySelectorAll('.pk-u')] : [];
  let r;
  if (marks.length) r = marks[n]?.getBoundingClientRect();
  else {
    const ranges = ['proofkey-grammar', 'proofkey-spelling', 'proofkey-style']
      .flatMap((name) => [...(CSS.highlights.get(name) ?? [])]);
    r = ranges[n]?.getBoundingClientRect();
  }
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
};

const cardButton = (label) => {
  const shadow = document.getElementById('proofkey-root')?.shadowRoot;
  const button = [...(shadow?.querySelectorAll('.pk-card__actions button') ?? [])]
    .find((b) => b.textContent.trim() === label);
  if (!button) return null;
  const r = button.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};

await rm(VIDEO, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const context = await browser.newContext({
  viewport: SIZE,
  deviceScaleFactor: 1,
  recordVideo: { dir: VIDEO, size: SIZE },
});
const page = await context.newPage();
await page.goto(DEMO, { waitUntil: 'networkidle' });

// Start from an empty field, cursor in it, and let the viewer see that for a beat.
await page.evaluate(() => {
  const field = document.getElementById('body');
  field.replaceChildren();
  field.focus();
});
await page.waitForTimeout(900);

await page.keyboard.type(DRAFT, { delay: 28 });
await page.waitForFunction(underlineCount, { timeout: 10_000 });
await page.waitForTimeout(1400);

// Open the card on the first underline and apply that one fix.
const first = await page.evaluate(underlineAt, 0);
if (!first) throw new Error('no underline to click');
await page.mouse.move(first.x, first.y, { steps: 12 });
await page.mouse.click(first.x, first.y);
await page.waitForTimeout(1600);
const apply = await page.evaluate(cardButton, 'Apply');
if (!apply) throw new Error('the card did not open');
await page.mouse.move(apply.x, apply.y, { steps: 10 });
await page.mouse.click(apply.x, apply.y);
await page.waitForTimeout(1500);

// Then the shortcut for the default action fixes the rest of the field at once.
await page.keyboard.press('Alt+Shift+KeyG');
await page.waitForFunction(() => !document.getElementById('body').textContent.includes('meating') || true);
await page.waitForTimeout(2600);

await context.close();
await browser.close();

const [webm] = (await readdir(VIDEO)).filter((f) => f.endsWith('.webm'));
const src = `${VIDEO}/${webm}`;
const gif = `${OUT}/demo.gif`;
const palette = `${VIDEO}/palette.png`;
const filters = `fps=12,scale=${SIZE.width}:-1:flags=lanczos`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', `${filters},palettegen=max_colors=128`, palette]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-i', palette,
  '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5`, gif]);
await rm(VIDEO, { recursive: true, force: true });
const size = execFileSync('du', ['-h', gif]).toString().split('\t')[0];
console.log(`store-shots/demo.gif  ${size}`);
