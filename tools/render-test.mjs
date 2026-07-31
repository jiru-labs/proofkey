/**
 * Integration test for the content script's rendering and apply paths.
 *
 *     node tools/render-test.mjs            # headless
 *     node tools/render-test.mjs --headed   # watch it run
 *
 * Loads the real built `dist/content.js` against `tools/harness.html`, which
 * stubs the service worker with canned corrections. No provider or API key is
 * involved, so this exercises segmentation, diffing, offset mapping, underline
 * rendering and text replacement on their own.
 *
 * The alignment assertion is the point of the exercise: the mirror overlay for
 * `<input>` and `<textarea>` only lands underlines under the right glyphs if
 * every property affecting text layout is copied from the field. Comparing the
 * two computed styles catches a missed property immediately, where a screenshot
 * would need a human to notice a few pixels of drift.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:8777/tools/harness.html';
const SHOTS = new URL('../.test-shots/', import.meta.url).pathname;

const MIRRORED = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing',
  'lineHeight', 'textTransform', 'textIndent', 'textAlign', 'direction',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'boxSizing',
];

let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Everything the page can tell us about what ProofKey drew. */
const probe = ([id, props]) => {
  {
    const shadow = document.getElementById('proofkey-root')?.shadowRoot;
    if (!shadow) return { error: 'no shadow root — content script did not mount' };

    const field = document.getElementById(id);
    const fieldRect = field.getBoundingClientRect();
    const overlay = shadow.querySelector('.pk-overlay');
    const content = shadow.querySelector('.pk-overlay__content');
    const badge = shadow.querySelector('.pk-badge');

    const marks = [...shadow.querySelectorAll('.pk-u')].map((mark) => {
      const rect = mark.getBoundingClientRect();
      return {
        text: mark.textContent,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      };
    });

    let styleDrift = [];
    if (content) {
      const a = getComputedStyle(field);
      const b = getComputedStyle(content);
      styleDrift = props.filter((property) => a[property] !== b[property])
        .map((property) => `${property}: field=${a[property]} overlay=${b[property]}`);
    }

    const highlightNames = ['proofkey-grammar', 'proofkey-spelling', 'proofkey-style'];
    const highlightCounts = typeof CSS !== 'undefined' && CSS.highlights
      ? highlightNames.map((n) => (CSS.highlights.get(n)?.size ?? 0)).reduce((a, b) => a + b, 0)
      : -1;

    const overlayRect = overlay?.getBoundingClientRect();

    return {
      marks,
      styleDrift,
      highlightCounts,
      badge: badge && !badge.hidden
        ? { text: badge.textContent, rect: badge.getBoundingClientRect().toJSON() }
        : null,
      fieldRect: { x: fieldRect.x, y: fieldRect.y, w: fieldRect.width, h: fieldRect.height },
      overlayRect: overlayRect
        ? { x: overlayRect.x, y: overlayRect.y, w: overlayRect.width, h: overlayRect.height }
        : null,
      fieldText: field.value ?? field.innerText,
      hasStrong: !!document.querySelector('#rich strong'),
    };
  }
};

async function run() {
  const reachable = await fetch('http://localhost:8777/dist/content.js')
    .then((response) => response.ok)
    .catch(() => false);
  if (!reachable) {
    console.error(
      'Nothing on http://localhost:8777. Run `npm run build` then `npm run serve` first.',
    );
    process.exit(1);
  }

  await mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
  const page = await browser.newPage({ viewport: { width: 700, height: 820 } });

  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`    [page error] ${message.text()}`);
  });
  page.on('pageerror', (error) => console.log(`    [page exception] ${error.message}`));

  for (const field of ['plain', 'odd', 'single', 'rich']) {
    console.log(`\n${field}:`);
    await page.goto(`${BASE}?field=${field}`, { waitUntil: 'load' });
    await page.waitForSelector('#pk-harness-ready', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);

    const before = await page.evaluate(probe, [field, MIRRORED]);
    if (before.error) {
      check('content script mounted', false, before.error);
      continue;
    }

    const isOverlay = field !== 'rich';
    const drew = isOverlay ? before.marks.length > 0 : before.highlightCounts > 0;
    check('underlines drawn', drew, isOverlay
      ? `${before.marks.length} mark(s)`
      : `${before.highlightCounts} highlighted range(s)`);

    if (isOverlay) {
      check('overlay typography matches field', before.styleDrift.length === 0,
        before.styleDrift.join('; ') || 'all mirrored properties equal');

      const r = before.overlayRect;
      const f = before.fieldRect;
      const aligned = r && Math.abs(r.x - f.x) < 1 && Math.abs(r.y - f.y) < 1
        && Math.abs(r.w - f.w) < 1 && Math.abs(r.h - f.h) < 1;
      check('overlay box aligns with field', !!aligned,
        r ? `overlay ${r.x},${r.y} ${r.w}x${r.h} vs field ${f.x},${f.y} ${f.w}x${f.h}` : 'no overlay');

      const inside = before.marks.every((m) =>
        m.rect.x >= f.x - 2 && m.rect.x + m.rect.w <= f.x + f.w + 2 &&
        m.rect.y >= f.y - 2 && m.rect.y + m.rect.h <= f.y + f.h + 2);
      check('every underline sits inside the field', inside);
    }

    check('badge shown near field', !!before.badge, before.badge
      ? `"${before.badge.text}" at ${Math.round(before.badge.rect.x)},${Math.round(before.badge.rect.y)}`
      : 'missing');

    await page.screenshot({ path: `${SHOTS}${field}.png` });

    // Open the card by clicking the first underline, then apply it.
    const targetRect = isOverlay
      ? before.marks[0]?.rect
      : await page.evaluate(() => {
          const h = CSS.highlights.get('proofkey-grammar') ?? CSS.highlights.get('proofkey-spelling');
          const range = h ? [...h][0] : null;
          if (!range) return null;
          const r = range.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });

    if (!targetRect) {
      check('card opens on click', false, 'nothing to click');
      continue;
    }

    await page.mouse.click(targetRect.x + targetRect.w / 2, targetRect.y + targetRect.h / 2);
    await page.waitForTimeout(200);

    const card = await page.evaluate(() => {
      const shadow = document.getElementById('proofkey-root').shadowRoot;
      const node = shadow.querySelector('.pk-card');
      if (!node || node.hidden) return null;
      const apply = shadow.querySelector('.pk-btn--primary').getBoundingClientRect();
      return {
        before: shadow.querySelector('.pk-card__before')?.textContent,
        after: shadow.querySelector('.pk-card__after')?.textContent,
        category: shadow.querySelector('.pk-chip')?.textContent,
        apply: { x: apply.x + apply.width / 2, y: apply.y + apply.height / 2 },
      };
    });

    check('card opens on click', !!card, card ? `${card.category}: "${card.before}" -> "${card.after}"` : 'card stayed hidden');
    if (!card) continue;

    await page.screenshot({ path: `${SHOTS}${field}-card.png` });

    await page.mouse.click(card.apply.x, card.apply.y);
    await page.waitForTimeout(300);

    const after = await page.evaluate(probe, [field, MIRRORED]);
    const applied = after.fieldText.includes(card.after.trim());
    check('apply writes the correction', applied,
      applied ? `field now contains "${card.after.trim()}"` : `field text: ${JSON.stringify(after.fieldText.slice(0, 80))}`);

    if (field === 'rich') {
      check('bold survives the edit', after.hasStrong);
    }
  }

  // The Ctrl+Shift+K path: one rewrite of the whole field. Distinct from
  // applying a single card, and the path that scrambled a WhatsApp message.
  for (const field of ['rerender', 'rich']) {
    console.log(`\n${field} — whole-field invoke:`);
    await page.goto(`${BASE}?field=${field}`, { waitUntil: 'load' });
    await page.waitForTimeout(400);

    const expected = await page.evaluate(
      (id) => window.__pkCorrect(document.getElementById(id).textContent),
      field,
    );

    await page.evaluate(() => window.__pkInvoke('fix-grammar'));
    await page.waitForTimeout(700);

    const actual = await page.evaluate(
      (id) => document.getElementById(id).textContent,
      field,
    );

    const ok = actual.replace(/\s+/g, ' ').trim() === expected.replace(/\s+/g, ' ').trim();
    check('whole-field rewrite lands intact', ok);
    if (!ok) {
      // Show where it diverges, not the start — corruption is usually well in.
      const e = expected.replace(/\s+/g, ' ').trim();
      const a = actual.replace(/\s+/g, ' ').trim();
      let i = 0;
      while (i < e.length && i < a.length && e[i] === a[i]) i++;
      const from = Math.max(0, i - 30);
      console.log(`      diverges at char ${i}`);
      console.log(`      expected: …${JSON.stringify(e.slice(from, i + 70))}`);
      console.log(`      actual:   …${JSON.stringify(a.slice(from, i + 70))}`);
    }
    if (field === 'rich') {
      check('bold survives whole-field rewrite', await page.evaluate(() => !!document.querySelector('#rich strong')));
    }

    await page.screenshot({ path: `${SHOTS}${field}-invoke.png` });
  }

  await browser.close();
  console.log(failures === 0 ? '\nAll render checks passed.' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
