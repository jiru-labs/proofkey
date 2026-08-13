/**
 * Checks the live-check reply parser, runnable without a browser:
 *
 *     node --experimental-strip-types tools/prompts-check.ts
 *
 * `parseCheckReply` is the seam between a model's text and the user's document:
 * whatever comes out of it is what gets written into the field. Two failure
 * modes matter, and both are silent rather than loud.
 *
 *   1. The contract itself — `null` for a reply that cannot be mapped back to
 *      sentences, rather than a half-filled array. A partial parse would
 *      rewrite sentence 3 with the correction meant for sentence 5.
 *   2. Whitespace the model added around an otherwise untouched sentence.
 *      `live.ts` compares the parsed line to the trimmed original with `===`,
 *      so a line returned as `"Looks fine.  "` is not equal to `"Looks fine."`
 *      and becomes a real underline offering to insert two spaces into correct
 *      text. Found against a local llama.cpp model, which pads lines with the
 *      Markdown hard-break convention when the prompt is loose enough.
 *
 * `tools/eval.ts` cannot catch (2): it normalises whitespace before comparing,
 * so a padded-but-correct answer scores as correct there.
 */

import { parseCheckReply } from '../src/core/prompts.ts';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function equal(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log('\nparseCheckReply — the contract:');

equal(
  'a well-formed reply maps to sentences',
  parseCheckReply('1. There are a lot of things to do.\n2. The meeting is Thursday.', 2),
  ['There are a lot of things to do.', 'The meeting is Thursday.'],
);
equal(
  'a close-paren numbering is accepted too',
  parseCheckReply('1) first\n2) second', 2),
  ['first', 'second'],
);
equal('a missing line fails the whole reply', parseCheckReply('1. only this one', 2), null);
equal('prose instead of a list fails', parseCheckReply('Sure! Here are your corrections.', 2), null);
equal(
  'commentary around the list is ignored',
  parseCheckReply('Here you go:\n1. first\n2. second\nHope that helps!', 2),
  ['first', 'second'],
);
equal(
  'a repeated index does not overwrite the first',
  parseCheckReply('1. first\n1. again\n2. second', 2),
  ['first', 'second'],
);
equal('an empty correction is a legitimate answer', parseCheckReply('1. \n2. second', 2), [
  '',
  'second',
]);

console.log('\nparseCheckReply — whitespace the model added:');

equal(
  'a trailing Markdown hard break is not part of the sentence',
  parseCheckReply('1. The report looks fine.  \n2. The meeting is Thursday.', 2),
  ['The report looks fine.', 'The meeting is Thursday.'],
);
equal(
  'a trailing tab is dropped too',
  parseCheckReply('1. Looks fine.\t\n2. Second.', 2),
  ['Looks fine.', 'Second.'],
);
equal(
  'a carriage return from CRLF is not kept',
  parseCheckReply('1. Looks fine.\r\n2. Second.\r\n', 2),
  ['Looks fine.', 'Second.'],
);
equal(
  'extra space after the number is not indentation',
  parseCheckReply('1.    Looks fine.\n2. Second.', 2),
  ['Looks fine.', 'Second.'],
);

console.log(failures === 0 ? '\nPrompt checks passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
