/**
 * Sanity check for the word diff, runnable without a browser:
 *
 *     node --experimental-strip-types tools/diff-check.ts
 *
 * The invariant that matters: applying the changes to the original must
 * reproduce the rewrite exactly. If that holds, applying them to the DOM
 * produces the right text too.
 */

import { autoFixable, classifyChange, diffWords, type Change } from '../src/core/diff.ts';

function apply(before: string, changes: Change[]): string {
  let out = before;
  for (const change of [...changes].reverse()) {
    out = out.slice(0, change.start) + change.replacement + out.slice(change.end);
  }
  return out;
}

const cases: [string, string][] = [
  // The playground's contenteditable case — the one that ate the bold tag.
  [
    'Our quarterly report show that revenue have increased by 12%, wich is better then we expected.',
    'Our quarterly report shows that revenue has increased by 12%, which is better than we expected.',
  ],
  [
    'i has been working on this projet since last week and their is still alot of things to do.',
    'I have been working on this project since last week and there are still a lot of things to do.',
  ],
  ['Espero que puedes venir mañana', 'Espero que puedas venir mañana'],
  ['unchanged text', 'unchanged text'],
  ['delete these extra words here', 'delete words here'],
  ['insert', 'please insert something'],
  ['', 'from nothing'],
  ['everything goes', ''],
  ['tildes: cancion, tambien', 'tildes: canción, también'],
  ['Hello  world', 'Hello world'],
];

let failures = 0;

for (const [before, after] of cases) {
  const changes = diffWords(before, after);
  if (changes === null) {
    console.log(`SKIP (too large): ${before.slice(0, 40)}`);
    continue;
  }

  const rebuilt = apply(before, changes);
  const ok = rebuilt === after;
  if (!ok) failures++;

  const touched = changes.reduce((sum, c) => sum + (c.end - c.start), 0);
  const ratio = before.length ? Math.round((touched / before.length) * 100) : 0;

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${changes.length} change(s), ${ratio}% of text touched`);
  if (!ok) {
    console.log(`  expected: ${JSON.stringify(after)}`);
    console.log(`  got:      ${JSON.stringify(rebuilt)}`);
  }
  for (const change of changes) {
    const { category } = classifyChange(change, before);
    console.log(
      `    [${category}] ${JSON.stringify(before.slice(change.start, change.end))}` +
        ` -> ${JSON.stringify(change.replacement)}`,
    );
  }
}

console.log(failures === 0 ? '\nAll cases reproduce the rewrite exactly.' : `\n${failures} FAILED`);

/**
 * How the edits are cut up, which the round-trip above cannot see: "mi
 * extencion" offered as one correction and as two both reproduce the rewrite
 * exactly. The cut is what the user actually acts on — it decides what can be
 * accepted on its own, and it decides the label, because a span of more than
 * one word has no single-word category left to be given.
 */
const grouping: [string, string, [string, string, string][]][] = [
  // Reported from x.com: two typos in a row were one suggestion labelled
  // Grammar, so neither could be taken without the other.
  [
    'this is a test, and ai want to see if mi extencion is working correctly.',
    'this is a test, and I want to see if my extension is working correctly.',
    [
      ['ai', 'I', 'Spelling'],
      ['mi', 'my', 'Spelling'],
      ['extencion', 'extension', 'Spelling'],
    ],
  ],
  [
    'tildes: cancion, tambien',
    'tildes: canción, también',
    [
      ['cancion,', 'canción,', 'Accent'],
      ['tambien', 'también', 'Accent'],
    ],
  ],
  // A restructure stays one correction. Where a word becomes a *different*
  // word, the boundary between "one fix" and "two" is the model's to draw.
  [
    'i was there when he went',
    'I went there when he was',
    [
      ['i was', 'I went', 'Grammar'],
      ['went', 'was', 'Word choice'],
    ],
  ],
  [
    'their is alot of things',
    'there are a lot of things',
    [['their is alot', 'there are a lot', 'Grammar']],
  ],
];

let groupFailures = 0;
console.log('\nGrouping:');

for (const [before, after, expected] of grouping) {
  const actual = (diffWords(before, after) ?? []).map((change): [string, string, string] => [
    before.slice(change.start, change.end),
    change.replacement,
    classifyChange(change, before).category,
  ]);

  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) groupFailures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(before.slice(0, 46))}`);
  if (!ok) {
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    got:      ${JSON.stringify(actual)}`);
  }
}

/**
 * Which findings automatic correction may write without a click. The `false`
 * rows are the point: each is a change `classifyChange` labels Spelling (or a
 * variety difference the model would offer) that swaps one real word for
 * another, so writing it unasked would change what the user said.
 */
const autoCases: [string, string, boolean, boolean?][] = [
  ['corectly', 'correctly', true],
  ['meating', 'meeting', true],
  ['teh', 'the', true],
  ['thursday', 'Thursday', true],
  ['vendia', 'vendía', true],
  ['cancion,', 'canción,', true],
  ['recieved', 'received', true],
  ['accomodation', 'accommodation', true],
  // A pinned variety's spelling (the fourth column: an English variety is pinned).
  ['color', 'colour', true, true],
  ['center', 'centre', true, true],
  ['organize', 'organise', true, true],
  ['analyze', 'analyse', true, true],
  ['video', 'vídeo', true],
  // With no variety pinned, the author's spelling system is theirs: a model
  // converting it is not fixing a typo. Qwen3.5-4B wrote analyze -> analyse
  // into a correct American sentence in 2 of 5 runs of tools/auto-eval.ts.
  ['analyze', 'analyse', false],
  ['colour', 'color', false],
  ['center', 'centre', false],
  ['organise', 'organize', false],
  ['traveled', 'travelled', false],
  ['catalog', 'catalogue', false],
  ['defense', 'defence', false],
  // Different words, however close.
  ['mi', 'my', false],
  ['in', 'on', false],
  ['ai', 'I', false],
  ['program', 'programme', false],
  ['ordenador', 'computadora', false],
  ['alot', 'a lot', false],
  ['their is', 'there is', false],
  ['show', 'shows', false],
  // Inflection or variety word sitting before punctuation must stay underlined, not auto-fix.
  ['show.', 'shows.', false],
  ['program.', 'programme.', false],
  // British/American centred/centered pair.
  ['centred', 'centered', false],
  ['centred', 'centered', true, true],
  // The word is the same but the punctuation moved: not a typo.
  ['done.', 'done,', false],
  ['(teh)', 'the()', false],
  // Scripts written without spaces: the "word" is the whole run of text, so
  // the edit-distance bound would let a clause be rewritten. Underlined only.
  ['日本語を勉強します', '日本誤を勉強します', false],
  // Japanese dakuten (NFD diacritic) turns one word into another ("persimmon" -> "key").
  ['かき', 'かぎ', false],
  ['我今天很高心', '我今天很高兴', false],
  ['ฉันชอบกินข้าวผด', 'ฉันชอบกินข้าวผัด', false],
  // Korean is written with spaces, so its words are words.
  ['학교에 감니다', '학교에 갑니다', true],
];

let autoFailures = 0;
console.log('\nAutomatic correction:');
for (const [before, after, expected, englishPinned = false] of autoCases) {
  const change = (diffWords(before, after) ?? [])[0];
  const category = change ? classifyChange(change, before).category : '';
  const actual = !!change && autoFixable(before.slice(change.start, change.end), change.replacement, category, englishPinned);
  const ok = actual === expected;
  if (!ok) autoFailures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(before)} -> ${JSON.stringify(after)} [${category}] ${actual ? 'fixed' : 'underlined'}`);
}

const total = failures + groupFailures + autoFailures;
// Large document with a single-word fix must still diff via prefix/suffix trimming.
const longWords = Array.from({ length: 1000 }, (_, i) => `word${i}`);
const longBefore = longWords.join(' ');
longWords[500] = 'fixed500';
const longAfter = longWords.join(' ');
const longChanges = diffWords(longBefore, longAfter);
const longOk = longChanges !== null && longChanges.length === 1 && apply(longBefore, longChanges) === longAfter;
console.log(`\nLarge document prefix/suffix trim:\n  ${longOk ? 'PASS' : 'FAIL'}  2000-token single-word edit`);

// Punctuation-only change on a word should classify as Punctuation, not Spelling.
const punctChange = (diffWords('done.', 'done,') ?? [])[0]!;
const punctCat = classifyChange(punctChange, 'done.').category;
const punctOk = punctCat === 'Punctuation';
console.log(`  ${punctOk ? 'PASS' : 'FAIL'}  "done." -> "done," classifies as Punctuation (got ${punctCat})`);

const finalTotal = total + (longOk ? 0 : 1) + (punctOk ? 0 : 1);
console.log(finalTotal === 0 ? '\nDiff checks passed.' : `\n${finalTotal} FAILED`);
process.exit(finalTotal === 0 ? 0 : 1);
