/**
 * Checks the scoring of `tools/action-eval.ts`, runnable without a key:
 *
 *     node --experimental-strip-types tools/action-eval-check.ts
 *
 * Every number the action eval reports goes through `contains`, and a matcher
 * that cannot see a word turns a translation into a pass without a sound. That
 * is how it went until 2026-10-03: a single word was bounded by "not a letter"
 * on both sides, and in Japanese the characters around a word are letters too,
 * so `中止` inside a Japanese sentence never matched. The Japanese fixture's
 * `cancel` → `中止` scored as a respelling, which does not fail a check.
 */

import { contains } from './action-eval-fixtures.ts';

let failures = 0;

function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
}

console.log('contains — scripts that put no spaces between words:');
check(
  'a Japanese translation inside a Japanese sentence is seen',
  contains('明日のミーティングは中止が決定いたしました。', '中止'),
);
check(
  'katakana inside a Japanese sentence is seen',
  contains('明日のミーティングはキャンセルになりました。', 'キャンセル'),
);
check(
  'a Latin word inside a Japanese sentence is still seen',
  contains('明日のミーティングはcancelになりました。', 'cancel'),
);

console.log('\ncontains — word boundaries still hold for spaced scripts:');
check('a whole word is seen', contains('El deadline es mañana.', 'deadline'));
check('a word inside a longer word is not', !contains('The deadlines moved.', 'deadline'));
check('an accented word is not matched by its unaccented form', !contains('nos vemos manana', 'mañana'));
check('a word next to an accented letter is bounded', !contains('equipoé', 'equipo'));
check('a phrase matches as a substring', contains('dijo "we will ship it on Friday".', 'we will ship it on Friday'));

console.log(failures === 0 ? '\nAction-eval scoring checks passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
