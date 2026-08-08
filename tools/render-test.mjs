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

/**
 * How many underlines are showing, whichever surface drew them: a mirror
 * overlay for `<input>` and `<textarea>`, CSS custom highlights for rich text.
 */
const underlineCount = (state) => (state.marks.length ? state.marks.length : state.highlightCounts);

/** Viewport rect of the first underline, from whichever surface holds it. */
async function firstUnderline(page, state) {
  if (state.marks.length) return state.marks[0].rect;
  return page.evaluate(() => {
    const highlight = ['proofkey-grammar', 'proofkey-spelling', 'proofkey-style']
      .map((name) => CSS.highlights.get(name))
      .find((set) => set && set.size);
    const range = highlight ? [...highlight][0] : null;
    if (!range) return null;
    const r = range.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
}

/**
 * Works through a field the way a user does: click the first underline, press
 * Apply, repeat until none are left. Returns how many were there to start with,
 * how many actually went through, and the final probe.
 */
async function applyEachInTurn(page, probeArgs, limit = 8) {
  let rounds = 0;
  let state = await page.evaluate(probe, probeArgs);
  const started = underlineCount(state);

  while (underlineCount(state) > 0 && rounds < limit) {
    const rect = await firstUnderline(page, state);
    if (!rect) break;
    await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
    await page.waitForTimeout(200);

    const applyAt = await page.evaluate(() => {
      const shadow = document.getElementById('proofkey-root').shadowRoot;
      const card = shadow.querySelector('.pk-card');
      if (!card || card.hidden) return null;
      const button = shadow.querySelector('.pk-btn--primary').getBoundingClientRect();
      return { x: button.x + button.width / 2, y: button.y + button.height / 2 };
    });
    if (!applyAt) break;

    await page.mouse.click(applyAt.x, applyAt.y);
    await page.waitForTimeout(300);
    rounds++;
    state = await page.evaluate(probe, probeArgs);
  }

  return { started, rounds, state };
}

/** What the suggestion card is showing, or null when it is closed. */
const cardProbe = () => {
  const shadow = document.getElementById('proofkey-root')?.shadowRoot;
  const card = shadow?.querySelector('.pk-card');
  if (!card || card.hidden) return null;
  const rect = card.getBoundingClientRect();
  return {
    before: shadow.querySelector('.pk-card__before')?.textContent,
    after: shadow.querySelector('.pk-card__after')?.textContent,
    rect: { x: rect.x, y: rect.y },
  };
};

/** Replaces a field's whole contents and leaves the caret at the end, as a paste does. */
const paste = ([id, text]) => {
  const field = document.getElementById(id);
  field.focus();
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    field.value = text;
    field.setSelectionRange(text.length, text.length);
  } else {
    field.replaceChildren(document.createTextNode(text));
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
};

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
  // Clipboard access so one case can paste for real. A synthetic ClipboardEvent
  // is not enough: Lexical ignores an untrusted one, and a test that cannot
  // paste quietly proves nothing about pasting.
  const context = await browser.newContext({ viewport: { width: 700, height: 820 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();

  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`    [page error] ${message.text()}`);
  });
  page.on('pageerror', (error) => console.log(`    [page exception] ${error.message}`));

  for (const field of ['plain', 'odd', 'single', 'chat', 'rich']) {
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

    if (field === 'chat') {
      // The reported bug, stated as an assertion. A single unterminated
      // sentence is the caret's own sentence, so nothing was ever sent — and
      // the badge reported that silence as a clean result. The tick is only
      // honest once the settle pass has actually checked something.
      check('lone sentence is not reported clean without being checked',
        before.badge?.text !== '✓',
        `badge reads ${JSON.stringify(before.badge?.text ?? '(hidden)')}`);
    }

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

    // Applying one correction must not retire the others. The corrected
    // sentence hashes differently afterwards, and the apply path used to record
    // that new hash as clean — which threw away every remaining finding in the
    // same sentence and left a green tick over text that still had errors in it.
    const countOf = (probed) => (isOverlay ? probed.marks.length : probed.highlightCounts);
    if (countOf(before) > 1) {
      check('other suggestions survive an apply',
        countOf(after) === countOf(before) - 1,
        `${countOf(before)} before -> ${countOf(after)} after, badge reads ${JSON.stringify(after.badge?.text ?? '(hidden)')}`);
    }

    if (field === 'rich') {
      check('bold survives the edit', after.hasStrong);
    }
  }

  // Applying every suggestion one at a time, the way a user actually works
  // through a message. One apply is not enough to catch this: the bug retired
  // the *other* findings in the corrected sentence, so the failure only shows
  // from the second correction onwards. The tick at the end has to be earned by
  // arriving at the same text the model would have written in one pass.
  {
    console.log('\nchat — apply every suggestion in turn:');
    await page.goto(`${BASE}?field=chat`, { waitUntil: 'load' });
    await page.waitForSelector('#pk-harness-ready', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);

    const expected = await page.evaluate(() =>
      window.__pkCorrect(document.getElementById('chat').value),
    );

    const { started, rounds, state } = await applyEachInTurn(page, ['chat', MIRRORED]);

    check('every suggestion could be applied in turn', rounds === started,
      `${started} found, ${rounds} applied, ${state.marks.length} left`);
    check('text matches a single-pass correction',
      state.fieldText.trim() === expected.trim(),
      `got ${JSON.stringify(state.fieldText.trim())}`);
    // Asserted as a conjunction on purpose. A bare `badge === '✓'` passes in the
    // broken state too — the tick was exactly what the bug produced — so on its
    // own it would be one more check that has never failed and proves nothing.
    check('tick appears only once the text is actually clean',
      state.badge?.text === '✓' && state.fieldText.trim() === expected.trim(),
      `badge reads ${JSON.stringify(state.badge?.text ?? '(hidden)')} over ${JSON.stringify(state.fieldText.trim())}`);

    await page.screenshot({ path: `${SHOTS}chat-applied.png` });
  }

  // Correcting a sentence must not blacklist it. Reported from x.com and
  // WhatsApp: work through a message suggestion by suggestion, then put the
  // original text back — paste it, undo, retype it — and the findings do not
  // come back. The badge sits on a green tick over text nobody corrected.
  //
  // Both fields are here because the two report sites differ in kind: x.com and
  // WhatsApp compose in a contenteditable, and a textarea is the simpler case
  // that proves the fault is in the session bookkeeping rather than in either
  // editor. The single-issue field is the one that reaches a full green tick —
  // with several findings only the first is lost, which is quieter and worse.
  for (const [field, seed] of [
    ['chat', null],
    ['rich', 'the meating is at noon and we all need to be there '],
  ]) {
    console.log(`\n${field} — the old text pasted back is checked again:`);
    await page.goto(`${BASE}?field=${field}`, { waitUntil: 'load' });
    await page.waitForSelector('#pk-harness-ready', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);

    if (seed) {
      await page.evaluate(paste, [field, seed]);
      await page.waitForTimeout(1400);
    }

    const original = await page.evaluate(
      (id) => document.getElementById(id).value ?? document.getElementById(id).innerText,
      field,
    );

    const { started, rounds, state } = await applyEachInTurn(page, [field, MIRRORED]);
    check('field was corrected before the paste', started > 0 && rounds === started,
      `${started} found, ${rounds} applied, badge reads ${JSON.stringify(state.badge?.text ?? '(hidden)')}`);

    await page.evaluate(paste, [field, original]);
    await page.waitForTimeout(1600);

    const after = await page.evaluate(probe, [field, MIRRORED]);
    check('the original text is underlined again', underlineCount(after) === started,
      `${started} before, ${underlineCount(after)} after the paste`);
    check('badge counts them instead of reporting clean',
      after.badge?.text === String(started),
      `badge reads ${JSON.stringify(after.badge?.text ?? '(hidden)')} over ${JSON.stringify(after.fieldText.trim().slice(0, 60))}`);

    await page.screenshot({ path: `${SHOTS}${field}-pasted-back.png` });
  }

  // The caret does not have to be at the end for a message to be finished. Click
  // back into the middle to fix a word, or paste and then click somewhere, and a
  // one-sentence message is the caret's sentence — skipped by the ordinary check
  // by design, and refused by the settle pass because the caret is not at the
  // end. Nothing was ever sent. The badge said so, greyly and honestly, forever.
  {
    console.log('\nchat — caret parked in the middle of the message:');
    await page.goto(`${BASE}?field=chat`, { waitUntil: 'load' });
    await page.waitForSelector('#pk-harness-ready', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);

    await page.evaluate(() => {
      const field = document.getElementById('chat');
      field.focus();
      field.value = 'i has been writing this mesage and dont want to be late';
      field.setSelectionRange(12, 12); // mid-message, where a click would leave it
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    });
    await page.waitForTimeout(2500);

    const state = await page.evaluate(probe, ['chat', MIRRORED]);
    check('it is checked anyway once typing stops', state.marks.length > 0,
      `${state.marks.length} underline(s), badge reads ${JSON.stringify(state.badge?.text ?? '(hidden)')}`);
    check('and the badge reports the count, not "not checked yet"',
      state.badge?.text === String(state.marks.length),
      `badge reads ${JSON.stringify(state.badge?.text ?? '(hidden)')}`);

    await page.screenshot({ path: `${SHOTS}chat-caret-mid.png` });
  }

  // The same thing again on the real Lexical editor, driven the way a user
  // drives it: select all, Ctrl+V. Every other case in this file pastes by
  // assigning to the DOM, which fires `input` — and `input` was the only signal
  // the live layer had. Lexical fires none for a paste or an undo: it handles
  // the command itself and reconciles, leaving a DOM mutation and nothing else.
  // So the whole message could be swapped under a green tick with nothing
  // looking again, which is what X and WhatsApp reported.
  {
    console.log('\nlexical — text replaced by a real paste is checked again:');
    await page.goto(`${BASE}?field=lexical`, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.click('#lexical');
    await page.waitForTimeout(1800);

    const read = () => page.evaluate(() => window.__pkLexicalText());
    const original = await read();

    const { started, rounds, state } = await applyEachInTurn(page, ['lexical', MIRRORED], 12);
    check('the editor was corrected before the paste', started > 0 && rounds === started,
      `${started} found, ${rounds} applied, badge reads ${JSON.stringify(state.badge?.text ?? '(hidden)')}`);
    check('and reads clean afterwards', state.badge?.text === '✓',
      `badge reads ${JSON.stringify(state.badge?.text ?? '(hidden)')}`);

    await page.evaluate((text) => navigator.clipboard.writeText(text), original);
    await page.click('#lexical');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(2000);

    // Asserted separately and first. A paste that silently fails to land leaves
    // the field genuinely clean, and every check after this one would pass for
    // the wrong reason — which is exactly how this bug was nearly missed.
    const restored = await read();
    check('the paste actually landed', restored.trim() === original.trim(),
      restored.trim() === original.trim()
        ? 'field holds the uncorrected text again'
        : `field reads ${JSON.stringify(restored.slice(0, 60))}`);

    const after = await page.evaluate(probe, ['lexical', MIRRORED]);
    check('the pasted text is underlined again', after.highlightCounts === started,
      `${started} before, ${after.highlightCounts} after`);
    check('badge counts them instead of holding its old tick',
      after.badge?.text === String(started),
      `badge reads ${JSON.stringify(after.badge?.text ?? '(hidden)')}`);

    await page.screenshot({ path: `${SHOTS}lexical-pasted-back.png` });
  }

  // An open card describes text that can move out from under it — a paste, an
  // undo, one more keystroke. Its offsets were captured when it opened, and the
  // write path indexes the field by exactly those offsets, so an Apply pressed
  // afterwards lands the replacement over whatever now sits at them.
  //
  // Two defences, tested separately because either alone leaves the other case
  // open: the card closes when the text it describes goes, and the write itself
  // refuses when the text under the offsets is not what was offered.
  {
    const REPLACED = 'The meeting is at noon and we all need to be there. ';

    /** Loads the chat field and opens the card on its first underline. */
    async function openFirstCard() {
      await page.goto(`${BASE}?field=chat`, { waitUntil: 'load' });
      await page.waitForSelector('#pk-harness-ready', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(600);
      const state = await page.evaluate(probe, ['chat', MIRRORED]);
      const rect = state.marks[0]?.rect;
      if (!rect) return null;
      await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
      await page.waitForTimeout(200);
      return page.evaluate(cardProbe);
    }

    console.log('\nchat — a card left open while the text changes underneath it:');
    let opened = await openFirstCard();
    check('a card is open to begin with', !!opened,
      opened ? `"${opened.before}" -> "${opened.after}"` : 'card stayed hidden');

    await page.evaluate(paste, ['chat', REPLACED]);
    await page.waitForTimeout(1600);

    const lingering = await page.evaluate(cardProbe);
    check('the card closes once the text it described is gone', lingering === null,
      lingering ? `still offering "${lingering.before}" -> "${lingering.after}"` : 'closed');

    console.log('\nchat — Apply pressed before the card could close:');
    opened = await openFirstCard();
    check('a card is open to begin with', !!opened,
      opened ? `"${opened.before}" -> "${opened.after}"` : 'card stayed hidden');

    // Paste and press Apply inside one task, so the debounce that closes the
    // card has not run: it is still open and still describes the old text. This
    // is the race a user hits by pasting and clicking straight away, and
    // nothing about the test's timing decides the outcome.
    await page.evaluate((text) => {
      const field = document.getElementById('chat');
      field.focus();
      field.value = text;
      field.setSelectionRange(text.length, text.length);
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));

      const shadow = document.getElementById('proofkey-root').shadowRoot;
      shadow.querySelector('.pk-btn--primary').click();
    }, REPLACED);
    await page.waitForTimeout(700);

    const afterApply = await page.evaluate(probe, ['chat', MIRRORED]);
    check('an Apply against text that has moved is refused',
      afterApply.fieldText === REPLACED,
      `field reads ${JSON.stringify(afterApply.fieldText)}`);
  }

  // The other half of that rule. A suggestion can survive an edit and still
  // move — inserting a sentence ahead of it shifts every offset after it — and
  // a card left pinned where the word used to be points at the wrong one.
  {
    console.log('\nplain — a card follows the word it describes:');
    await page.goto(`${BASE}?field=plain`, { waitUntil: 'load' });
    await page.waitForSelector('#pk-harness-ready', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);

    const before = await page.evaluate(probe, ['plain', MIRRORED]);
    // Deliberately a word in a later sentence, so inserting ahead of it moves it
    // without touching the sentence it lives in — its cache entry has to survive
    // for this to be testing re-anchoring rather than a re-check.
    const word = before.marks.find((mark) => mark.text === 'projet') ?? before.marks.at(-1);
    check('a later sentence has an underline to open', !!word,
      word ? `"${word.text}"` : `marks: ${before.marks.map((m) => m.text).join(', ')}`);

    if (word) {
      await page.mouse.click(word.rect.x + word.rect.w / 2, word.rect.y + word.rect.h / 2);
      await page.waitForTimeout(200);
      const opened = await page.evaluate(cardProbe);
      check('card opens on it', !!opened,
        opened ? `"${opened.before}" -> "${opened.after}"` : 'card stayed hidden');

      await page.evaluate(() => {
        const field = document.getElementById('plain');
        field.focus();
        field.value = `Adding a whole new sentence in front of it here. ${field.value}`;
        field.setSelectionRange(0, 0);
        field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      });
      await page.waitForTimeout(1600);

      const after = await page.evaluate(probe, ['plain', MIRRORED]);
      const moved = after.marks.find((mark) => mark.text === opened?.before);
      const card = await page.evaluate(cardProbe);

      check('the card stays open on the same word', !!card && card.before === opened?.before,
        card ? `"${card.before}" -> "${card.after}"` : 'card closed');
      // GAP is 8px below the word, and this field sits high enough on the page
      // that the card never flips above it.
      check('and re-anchors to where that word moved to',
        !!(moved && card) && Math.abs(card.rect.y - (moved.rect.y + moved.rect.h + 8)) < 2,
        moved && card
          ? `card top ${Math.round(card.rect.y)}, word bottom ${Math.round(moved.rect.y + moved.rect.h)}`
          : 'word or card missing');
    }
  }

  // The Ctrl+Shift+K path: one rewrite of the whole field. Distinct from
  // applying a single card, and the path that scrambled a WhatsApp message.
  for (const field of ['lexical', 'rerender', 'rich']) {
    console.log(`\n${field} — whole-field invoke:`);
    await page.goto(`${BASE}?field=${field}`, { waitUntil: 'load' });
    await page.waitForTimeout(400);

    const read = (id) =>
      id === 'lexical' && window.__pkLexicalText
        ? window.__pkLexicalText()
        : document.getElementById(id).textContent;

    const readField = (id) =>
      page.evaluate(
        (i) =>
          i === 'lexical' && window.__pkLexicalText
            ? window.__pkLexicalText()
            : document.getElementById(i).textContent,
        id,
      );

    const before = await readField(field);
    const expected = await page.evaluate(
      (id) => {
        const readField = (i) =>
          i === 'lexical' && window.__pkLexicalText
            ? window.__pkLexicalText()
            : document.getElementById(i).textContent;
        return window.__pkCorrect(readField(id));
      },
      field,
    );

    await page.evaluate(() => window.__pkInvoke('fix-grammar'));
    await page.waitForTimeout(700);

    const actual = await page.evaluate(
      (id) =>
        id === 'lexical' && window.__pkLexicalText
          ? window.__pkLexicalText()
          : document.getElementById(id).textContent,
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

    // One shortcut, one undo. Each `execCommand` is its own undo transaction, so
    // a rewrite issued as one command per changed word took a press of Ctrl+Z
    // per word to take back — three here, five on a field that fell through to
    // the atomic replacement partway. Counting presses is the only way to see
    // it: the text after N presses is correct either way, so every assertion
    // above passed throughout.
    //
    // `rerender` is excluded rather than skipped quietly: it rebuilds its text
    // nodes on every input event, which destroys the browser's undo stack
    // outright. No number of presses restores it, before or after this fix, and
    // there is nothing the extension can preserve once the page has done that.
    if (field !== 'rerender') {
      const normalize = (text) => text.replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim();
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(300);
      const undone = await readField(field);
      check(
        'one Ctrl+Z restores the original',
        normalize(undone) === normalize(before),
        normalize(undone) === normalize(before) ? '' : `got ${JSON.stringify(normalize(undone).slice(0, 60))}`,
      );
    }
  }

  // The reported case, on the real Lexical instance: a short plain message with
  // a few word-level fixes, which is what a WhatsApp message is.
  //
  // The seeded Lexical text above does not cover this. It has more corrections
  // than the surgical path will attempt, so it goes straight to the atomic
  // replacement and costs one press either way — the bug was invisible there.
  // This message takes the surgical path, and took three presses before those
  // edits were collapsed into one.
  {
    console.log('\nlexical — a short message undoes in one press:');
    const TEXT = 'we should of finish the projet on thursday';

    await page.goto(`${BASE}?field=lexical`, { waitUntil: 'load' });
    await page.waitForTimeout(500);

    // A real paste: Lexical ignores an untrusted synthetic ClipboardEvent.
    await page.evaluate((text) => navigator.clipboard.writeText(text), TEXT);
    await page.click('#lexical');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(1500);

    const read = () => page.evaluate(() => window.__pkLexicalText());
    const normalize = (text) => text.replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim();
    const before = await read();

    // Asserted first: a paste that did not land leaves the seeded text in place,
    // and everything below would then measure the wrong field.
    check('the message is in the editor', normalize(before) === TEXT,
      normalize(before) === TEXT ? '' : `field reads ${JSON.stringify(normalize(before).slice(0, 60))}`);

    await page.evaluate(() => window.__pkInvoke('fix-grammar'));
    await page.waitForTimeout(1000);

    const rewritten = await read();
    check('it is rewritten', normalize(rewritten) !== normalize(before),
      JSON.stringify(normalize(rewritten)));

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    const undone = await read();
    check('one Ctrl+Z restores the original', normalize(undone) === normalize(before),
      normalize(undone) === normalize(before) ? '' : `got ${JSON.stringify(normalize(undone))}`);
  }

  // The per-action shortcut. Everything above drives the rewrite by handing the
  // content script a message; this presses the key, which is the half that can
  // fail on its own — a chord that is stored but never matched is invisible,
  // because a shortcut that does nothing looks exactly like a broken action.
  {
    console.log('\nper-action shortcut:');
    await page.goto(`${BASE}?field=plain`, { waitUntil: 'load' });
    await page.waitForTimeout(400);

    const readPlain = () => page.evaluate(() => document.getElementById('plain').value);
    const original = await readPlain();
    const expected = await page.evaluate((text) => window.__pkCorrect(text), original);

    await page.focus('#plain');

    // The control first: a chord nothing is bound to must leave the text alone.
    // Without it, a shortcut path that rewrites on *any* keypress would pass the
    // check below and look correct.
    await page.keyboard.press('Alt+KeyH');
    await page.waitForTimeout(500);
    check('an unbound chord changes nothing', (await readPlain()) === original);

    await page.keyboard.press('Alt+KeyG');
    await page.waitForTimeout(700);
    const afterBound = await readPlain();
    check(
      'the bound chord runs its action',
      afterBound.replace(/\s+/g, ' ').trim() === expected.replace(/\s+/g, ' ').trim(),
      afterBound === original ? 'the field was not touched' : JSON.stringify(afterBound.slice(0, 60)),
    );

    // Rebinding in the options page has to reach tabs that are already open.
    // Before the storage listener existed this needed a reload, which reads as
    // the feature being broken.
    await page.goto(`${BASE}?field=plain`, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      window.__pkState = { ...window.__pkState, shortcuts: [{ actionId: 'fix-grammar', chord: 'Alt+KeyH' }] };
      window.__pkFireStorageChange();
    });
    await page.waitForTimeout(300);
    await page.focus('#plain');

    await page.keyboard.press('Alt+KeyG');
    await page.waitForTimeout(500);
    check('the old chord stops working', (await readPlain()) === original);

    await page.keyboard.press('Alt+KeyH');
    await page.waitForTimeout(700);
    check(
      'the new one works without a reload',
      (await readPlain()).replace(/\s+/g, ' ').trim() === expected.replace(/\s+/g, ' ').trim(),
    );
  }

  await browser.close();
  console.log(failures === 0 ? '\nAll render checks passed.' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
