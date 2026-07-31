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
process.exit(failures === 0 ? 0 : 1);
