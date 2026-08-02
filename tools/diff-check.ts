/**
 * Sanity check for the word diff, runnable without a browser:
 *
 *     node --experimental-strip-types tools/diff-check.ts
 *
 * The invariant that matters: applying the changes to the original must
 * reproduce the rewrite exactly. If that holds, applying them to the DOM
 * produces the right text too.
 */

import { classifyChange, diffWords, type Change } from '../src/core/diff.ts';

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
    [['their is alot ', 'there are a lot ', 'Grammar']],
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

const total = failures + groupFailures;
console.log(total === 0 ? '\nDiff checks passed.' : `\n${total} FAILED`);
process.exit(total === 0 ? 0 : 1);
