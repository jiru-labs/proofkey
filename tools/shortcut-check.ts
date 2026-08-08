/**
 * Checks the per-action shortcut chords, runnable without a browser:
 *
 *     node --experimental-strip-types tools/shortcut-check.ts
 *
 * Three things have to hold, and all three are places a wrong answer is silent
 * rather than loud — the shortcut simply never fires, or fires on the wrong key.
 *
 *   1. A chord survives a round trip through storage unchanged.
 *   2. Matching accepts exactly the event it was recorded from, and nothing else.
 *   3. Validation refuses the chords that cannot work: no modifier (would eat a
 *      letter while typing), reserved by the browser (never reaches the page),
 *      reserved for editing (would break paste in the field ProofKey edits),
 *      or Ctrl+Alt (arrives from AltGr on a European layout, mid-word).
 *   4. Something free can always be named. Refusing a chord without offering a
 *      working one leaves the user guessing, which is how this feature failed
 *      its first real use.
 */

import { normalizeOrigin, originMatchPattern } from '../src/core/browser.ts';
import {
  chordFromEvent,
  chordProblem,
  chordWarning,
  describeShortcut,
  formatChord,
  matchBinding,
  parseChord,
  parseCommandShortcut,
  serializeChord,
  suggestChord,
  type Chord,
} from '../src/core/shortcuts.ts';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function equal(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** A KeyboardEvent-shaped object, as `matchBinding` and `chordFromEvent` see one. */
function press(
  code: string,
  modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {},
) {
  return {
    code,
    ctrlKey: !!modifiers.ctrl,
    altKey: !!modifiers.alt,
    shiftKey: !!modifiers.shift,
    metaKey: !!modifiers.meta,
  };
}

// -------------------------------------------------------------- round trip

console.log('Round trip:');

const roundTrip = [
  'Alt+KeyG',
  'Ctrl+Shift+Digit1',
  'Ctrl+Alt+Shift+Meta+KeyK',
  'Alt+Meta+Period',
  'F9',
  'Ctrl+F9',
  'Alt+ArrowUp',
  'Ctrl+Alt+Space',
];

for (const stored of roundTrip) {
  const chord = parseChord(stored);
  equal(stored, chord ? serializeChord(chord) : null, stored);
}

// Anything not in canonical form must be rejected rather than quietly accepted:
// two spellings of one chord would compare unequal and never match.
const rejected = [
  ['Shift+Ctrl+KeyG', 'modifiers out of canonical order'],
  ['Meta+Alt+Period', 'the same chord spelled Meta-first'],
  ['Ctrl+Ctrl+KeyG', 'a repeated modifier'],
  ['Hyper+KeyG', 'an unknown modifier'],
  ['ControlLeft', 'a bare modifier'],
  ['', 'the empty string'],
  ['Alt+', 'no key'],
];

for (const [raw, why] of rejected) {
  check(`rejects ${JSON.stringify(raw)}`, parseChord(raw!) === null, why);
}

// -------------------------------------------------------------- validation

console.log('\nValidation:');

const shouldBeRefused: [Chord, string][] = [
  [chordFromEvent(press('KeyG')), 'no modifier at all'],
  [chordFromEvent(press('KeyG', { shift: true })), 'Shift alone'],
  [chordFromEvent(press('ControlLeft', { ctrl: true })), 'a modifier as the key'],
  [chordFromEvent(press('KeyT', { ctrl: true })), 'Ctrl+T, kept by the browser'],
  [chordFromEvent(press('KeyW', { meta: true })), 'Cmd+W, kept by the browser'],
  [chordFromEvent(press('KeyI', { ctrl: true, shift: true })), 'DevTools'],
  [chordFromEvent(press('F12')), 'DevTools'],
  [chordFromEvent(press('KeyV', { ctrl: true })), 'paste'],
  [chordFromEvent(press('KeyZ', { meta: true })), 'undo'],
  [chordFromEvent(press('KeyA', { ctrl: true })), 'select all'],
  // AltGr raises ctrlKey and altKey together, so any Ctrl+Alt binding fires
  // while a European layout types @ ~ ç €. This one used to be allowed, on the
  // reasoning that Ctrl+Alt+V is not paste — true, and beside the point.
  [chordFromEvent(press('KeyV', { ctrl: true, alt: true })), 'Ctrl+Alt is AltGr'],
  [chordFromEvent(press('KeyG', { ctrl: true, alt: true })), 'Ctrl+Alt is AltGr'],
  // Newly covered from Chrome's published list; each was bindable before.
  [chordFromEvent(press('KeyL', { ctrl: true })), 'Ctrl+L focuses the address bar'],
  [chordFromEvent(press('KeyJ', { ctrl: true })), 'Ctrl+J opens downloads'],
  [chordFromEvent(press('Digit1', { ctrl: true })), 'Ctrl+1 jumps to the first tab'],
  [chordFromEvent(press('KeyI', { alt: true, shift: true })), 'Alt+Shift+I opens feedback'],
  [chordFromEvent(press('F6')), 'F6 moves focus to the toolbar'],
];

for (const [chord, why] of shouldBeRefused) {
  const problem = chordProblem(chord);
  check(`refuses ${serializeChord(chord)}`, problem !== null, problem ? why : 'was allowed');
}

const shouldBeAllowed: [Chord, string][] = [
  [chordFromEvent(press('KeyG', { alt: true })), 'Alt+G'],
  [chordFromEvent(press('Digit1', { ctrl: true, shift: true })), 'Ctrl+Shift+1'],
  [chordFromEvent(press('F9')), 'a bare function key needs no modifier'],
  [chordFromEvent(press('F8')), 'F8 is claimed by nothing'],
  [chordFromEvent(press('KeyG', { alt: true, shift: true })), 'the suggested pattern'],
  [chordFromEvent(press('KeyK', { ctrl: true, shift: true })), "ProofKey's own default"],
];

for (const [chord, why] of shouldBeAllowed) {
  const problem = chordProblem(chord);
  check(`allows ${serializeChord(chord)}`, problem === null, problem ?? why);
}

// ------------------------------------------------------------------ warnings

console.log('\nWarnings:');

// Allowed, but the user loses Chrome's own feature on the sites they enabled.
const ctrlS = chordFromEvent(press('KeyS', { ctrl: true }));
check('Ctrl+S is allowed', chordProblem(ctrlS) === null);
check('Ctrl+S warns', chordWarning(ctrlS) !== null, chordWarning(ctrlS) ?? 'said nothing');

// The control: a chord Chrome has no claim on must warn about nothing, or the
// warning means nothing.
const altShiftG = chordFromEvent(press('KeyG', { alt: true, shift: true }));
check('Alt+Shift+G warns about nothing', chordWarning(altShiftG) === null);

// --------------------------------------------------------------- suggestions

console.log('\nSuggestions:');

const firstSuggestion = suggestChord([]);
check('suggests something when nothing is bound', firstSuggestion !== null, firstSuggestion ?? '');
check(
  'and what it suggests is actually usable',
  !!firstSuggestion && chordProblem(parseChord(firstSuggestion)!) === null,
  firstSuggestion ?? '',
);

// Every entry in the pool has to survive its own validation. A suggestion the
// recorder would then refuse is worse than no suggestion at all.
const pool: string[] = [];
for (let taken = pool.slice(); ; ) {
  const next = suggestChord(taken);
  if (!next) break;
  pool.push(next);
  taken = pool.slice();
}
const badPoolEntry = pool.find((raw) => {
  const chord = parseChord(raw);
  return !chord || chordProblem(chord) !== null || chordWarning(chord) !== null;
});
equal('every pooled chord is clean', badPoolEntry ?? null, null);
check(`the pool is not thin — ${pool.length} chords`, pool.length >= 10, `${pool.length}`);

equal(
  'skips one already bound',
  suggestChord([firstSuggestion!]) !== firstSuggestion,
  true,
);
equal('returns null once the pool is exhausted', suggestChord(pool), null);

// ---------------------------------------------------------------- matching

console.log('\nMatching:');

const bindings = [
  { actionId: 'fix-grammar', chord: 'Alt+KeyG' },
  { actionId: 'summarize', chord: 'Ctrl+Shift+Digit1' },
  { actionId: 'expand', chord: 'F9' },
];

equal('Alt+G runs fix-grammar', matchBinding(bindings, press('KeyG', { alt: true })), 'fix-grammar');
equal(
  'Ctrl+Shift+1 runs summarize',
  matchBinding(bindings, press('Digit1', { ctrl: true, shift: true })),
  'summarize',
);
equal('F9 runs expand with no modifier', matchBinding(bindings, press('F9')), 'expand');

// Each of these differs from a binding by exactly one thing.
equal('plain G runs nothing', matchBinding(bindings, press('KeyG')), null);
equal(
  'Alt+Shift+G is not Alt+G',
  matchBinding(bindings, press('KeyG', { alt: true, shift: true })),
  null,
);
equal('Ctrl+G is not Alt+G', matchBinding(bindings, press('KeyG', { ctrl: true })), null);
equal('Alt+H is not Alt+G', matchBinding(bindings, press('KeyH', { alt: true })), null);
equal(
  'Ctrl+1 is not Ctrl+Shift+1',
  matchBinding(bindings, press('Digit1', { ctrl: true })),
  null,
);
equal('nothing matches with no bindings', matchBinding([], press('KeyG', { alt: true })), null);
equal(
  'a held modifier alone matches nothing',
  matchBinding(bindings, press('AltLeft', { alt: true })),
  null,
);

/**
 * The macOS Alt trap, and the reason chords are stored by `code`. Pressing
 * Alt+G there reports `key` as "©" while Alt is held. Recording by `key` would
 * store "©" and then compare it against a `key` that is "g" the moment Alt is
 * not held — a binding that can never fire. `code` is `KeyG` throughout.
 */
equal(
  'Alt+G matches on macOS, where key would read "©"',
  matchBinding(bindings, { ...press('KeyG', { alt: true }), key: '©' } as never),
  'fix-grammar',
);

// -------------------------------------------------------------- formatting

console.log('\nLabels:');

equal('Alt+KeyG reads as Alt+G', describeShortcut('Alt+KeyG'), 'Alt+G');
equal('Ctrl+Shift+Digit1 reads as Ctrl+Shift+1', describeShortcut('Ctrl+Shift+Digit1'), 'Ctrl+Shift+1');
equal('F9 reads as F9', describeShortcut('F9'), 'F9');
equal('Alt+ArrowUp reads as an arrow', describeShortcut('Alt+ArrowUp'), 'Alt+↑');
equal(
  'macOS uses glyphs in its own order',
  describeShortcut('Ctrl+Alt+Shift+Meta+KeyK', { mac: true }),
  '⌃⌥⇧⌘K',
);

// The AZERTY case: the physical KeyA position is printed "Q". Without the
// layout map the label is the US legend, which is the wrong letter to show.
const azerty = new Map([['KeyA', 'q']]);
equal(
  'a layout map labels the key by what is printed on it',
  formatChord(chordFromEvent(press('KeyA', { alt: true })), { layout: azerty }),
  'Alt+Q',
);
equal(
  'without one, the US legend is the fallback',
  formatChord(chordFromEvent(press('KeyA', { alt: true }))),
  'Alt+A',
);

// ------------------------------------------------- chrome.commands parsing

console.log('\nBrowser commands:');

equal('Ctrl+Shift+K', parseCommandShortcut('Ctrl+Shift+K'), 'Ctrl+Shift+KeyK');
equal('Command+Shift+K', parseCommandShortcut('Command+Shift+K'), 'Shift+Meta+KeyK');
equal('macOS glyphs', parseCommandShortcut('⌘⇧K'), 'Shift+Meta+KeyK');
equal('Alt+Shift+1', parseCommandShortcut('Alt+Shift+1'), 'Alt+Shift+Digit1');
equal('an unbound command', parseCommandShortcut(''), null);
equal('something unparseable', parseCommandShortcut('Ctrl+Shift+SomethingElse'), null);

// ------------------------------------------------------ the origins listed

console.log('\nOrigins:');

// A line that will not parse is dropped, and a dropped origin has no symptom
// beyond a key that does nothing — so what counts as parseable matters.
equal('a bare host', normalizeOrigin('github.com'), 'https://github.com');
equal('a full origin', normalizeOrigin('https://github.com'), 'https://github.com');
equal('a trailing slash', normalizeOrigin('https://github.com/'), 'https://github.com');
equal('a pasted page URL', normalizeOrigin('https://github.com/jiru-labs/proofkey'), 'https://github.com');
equal('surrounding space', normalizeOrigin('  github.com  '), 'https://github.com');
equal('a subdomain is its own origin', normalizeOrigin('mail.google.com'), 'https://mail.google.com');
equal('a port is part of it', normalizeOrigin('http://localhost:3000'), 'http://localhost:3000');
equal('localhost with no dot', normalizeOrigin('localhost'), 'https://localhost');
equal('an empty line', normalizeOrigin('   '), null);
equal('a bare word', normalizeOrigin('notes'), null);
equal('a non-web scheme', normalizeOrigin('chrome://extensions'), null);

equal('the match pattern for one', originMatchPattern('https://github.com'), 'https://github.com/*');
equal('and for a bad one', originMatchPattern('not a url'), null);

console.log(failures === 0 ? '\nShortcut checks passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
