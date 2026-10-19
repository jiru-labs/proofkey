/**
 * Checks the English words found inside Spanish, French and Portuguese text
 * (`src/core/borrowed.ts`), against the word lists actually shipped:
 *
 *     node --experimental-strip-types tools/borrowed-check.ts
 *
 * The cases are the mixed fixtures of issue #1, both directions, plus what
 * must not be found: a German text, a text in one language, a word the
 * language has with an accent, an English word the other languages share.
 * Then the clauses of a text that switches language from clause to clause
 * (`mixedClauses`), and the texts it must leave alone.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  baseLanguage,
  borrowedWords,
  foreignWordsInEnglish,
  KEEPS_BORROWED_WORDS,
  loadLexicon,
  lostMixture,
  mixedClauses,
} from '../src/core/borrowed.ts';
import { BUILT_IN_ACTIONS, composeSystemPrompt, emptyProfile, keptPassages } from '../src/core/prompts.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function equal(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(name, ok, ok ? '' : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const read = async (file: string): Promise<ArrayBuffer> => {
  const bytes = await readFile(fileURLToPath(new URL(`../public/lexicon/${file}`, import.meta.url)));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const lexicon = await loadLexicon(read);

console.log('the shipped word lists:');
check('the English list is sorted the way the search compares',
  lexicon.english.every((word, i) => i === 0 || lexicon.english[i - 1] < word));
check('and holds only lowercase words of three letters or more',
  lexicon.english.every((word) => /^[a-z]{3,}$/.test(word)), `${lexicon.english.length} words`);
let refused = false;
try {
  await loadLexicon(async (file) => (file === 'fr.bin' ? new ArrayBuffer(3) : read(file)));
} catch {
  refused = true;
}
check('a mask that does not fit the list is refused, not read wrong', refused);

console.log('\nthe language of the text:');
equal('Spanish', baseLanguage('El deadline es mañana pero todavia no tengo el draft.'), 'es');
equal('French', baseLanguage('Merci pour ton retour, je regarde le document demain matin.'), 'fr');
equal('Portuguese', baseLanguage('Vou fazer o deploy depois do almoco, mas preciso revisar o rollback.'), 'pt');
equal('English', baseLanguage('I told her mañana works better, pero she wants to meet today.'), 'en');
equal('none of its short words: no guess', baseLanguage('明日のミーティングはcancelになりました'), undefined);

console.log('\nwhat is found:');
equal('English words in Spanish',
  borrowedWords('El deadline es mañana pero todavia no tengo el draft.', lexicon), ['deadline', 'draft']);
equal('as written, each once',
  borrowedWords('Hola Team, el Kickoff meeting es mañana; el meeting dura una hora.', lexicon),
  ['Team', 'Kickoff', 'meeting']);
equal('English words in Portuguese',
  borrowedWords('Vou fazer o deploy depois do almoco, mas preciso revisar o rollback.', lexicon),
  ['deploy', 'rollback']);
equal('English words in French',
  borrowedWords('Je regarde le feedback de la review demain, puis on fait le merge.', lexicon),
  ['feedback', 'review', 'merge']);

console.log('\nthe other direction, in English text:');
equal('Spanish words in English',
  borrowedWords('I told her mañana works better, pero she wants to meet today.', lexicon), ['mañana', 'pero']);
equal('loanwords English lists are named too: keeping them costs nothing',
  borrowedWords('She said gracias and left, the fiesta was over.', lexicon), ['gracias', 'fiesta']);
equal('a word with a letter English spells without', foreignWordsInEnglish('We had a little déjà vu moment during the meeting.'), ['déjà']);
equal('nothing in English alone', borrowedWords('I will send the report tomorrow morning before the meeting.', lexicon), []);
equal('nor in English typos', borrowedWords('Their is alot of things we needs to discuss tomorow.', lexicon), []);
equal('nor the words English shares with them',
  foreignWordsInEnglish('My son will pour the coffee, play a solo and die laughing at the todo list.'), []);

console.log('\nwhat is not:');
equal('a text in Spanish alone', borrowedWords('Mañana tenemos la reunión con el equipo a las nueve.', lexicon), []);
equal('a word the language has with its accent (menú)', borrowedWords('El menu del restaurante está bien.', lexicon), []);
equal('anything in German text — no data for it',
  borrowedWords('Der Kunde hat gefragt ob wir das feature flag vor dem release aktivieren.', lexicon), []);
// The cost, kept visible: a Spanish typo that is an English word is named, and
// a rewrite then leaves it. This is why Fix grammar does not get the list.
equal('a typo that is an English word IS found (boy for voy)', borrowedWords('Yo boy a la playa con mis amigos.', lexicon), ['boy']);

console.log('\nwhere it is used:');
check('the rewording actions', ['improve-writing', 'make-professional', 'make-friendly', 'simplify', 'expand']
  .every((id) => KEEPS_BORROWED_WORDS.has(id)));
check('not Fix grammar, Translate, Summarize or bullet points',
  ['fix-grammar', 'translate', 'summarize', 'bullet-points'].every((id) => !KEEPS_BORROWED_WORDS.has(id)));
const improve = BUILT_IN_ACTIONS.find((action) => action.id === 'improve-writing')!;
const text = 'El deadline es mañana pero todavia no tengo el draft.';
const prompt = composeSystemPrompt(improve, emptyProfile(), text, borrowedWords(text, lexicon));
check('a rewrite is told each word by name, last',
  prompt.includes('- deadline\n- draft') && prompt.trim().endsWith('- draft'));
equal('a word inside a quotation is not named twice',
  keptPassages('Le dije "we will ship it on Friday" y no se.', ['will', 'ship', 'Friday', 'deadline']),
  ['we will ship it on Friday', 'deadline']);

console.log('\nclause by clause:');
const clauses = "Je t'envoie le rapport après le standup, but I still need to review the numbers first.";
equal('a French clause and an English clause, each named', mixedClauses(clauses), [
  { passage: "Je t'envoie le rapport après le standup", language: 'French' },
  { passage: 'but I still need to review the numbers first', language: 'English' },
]);
equal('a short English clause, by its contraction (I\'ll)',
  mixedClauses("I'll call you tonight, mais je ne sais pas encore à quelle heure.").map((part) => part.language),
  ['English', 'French']);
equal('a short English clause whose `on` is French too',
  mixedClauses('We can meet on Friday, se você ainda estiver na cidade.').map((part) => part.language),
  ['English', 'Portuguese']);
equal('nothing for borrowed words in one clause', mixedClauses('El deadline es mañana pero todavia no tengo el draft.'), []);
equal('nothing for a text in one language, clause after clause',
  mixedClauses('Ich schicke dir die Unterlagen morgen früh, dann koennen wir am Freitag darüber sprechen.'), []);
equal('nothing for German whose `was` and `in` are English words too',
  mixedClauses('Die Option ist neu und nicht getestet, was Ganzzahlwerte in Kilobyte pro Sekunde akzeptiert.'), []);
equal('nothing for English whose `as a` is Portuguese too',
  mixedClauses('As a result, we do not recommend it, and the protocol may change.'), []);
equal('nothing for the letters of a command line', mixedClauses('Use it like this: complete -o default -o bashdefault, and that is all.'), []);
equal('nothing for two languages neither of which is English',
  mixedClauses('Ya terminé el informe, mais je ne sais pas encore à quelle heure.'), []);
const parts = mixedClauses(clauses);
const clausePrompt = composeSystemPrompt(improve, emptyProfile(), clauses, [], parts);
check('a rewrite is told each part and its language, last',
  clausePrompt.trim().endsWith('- "but I still need to review the numbers first" (English)') &&
    clausePrompt.includes(`- "Je t'envoie le rapport après le standup" (French)`));
const translateAction = BUILT_IN_ACTIONS.find((action) => action.id === 'translate')!;
check('a translation is not told to keep them',
  !composeSystemPrompt(translateAction, { ...emptyProfile(), translateLanguage: 'German' }, clauses, [], parts)
    .includes('changes language from one part'));

console.log('\na rewrite of it that kept both languages, or did not:');
const spanishFirst = 'Ya terminé el informe, I just need to send it to Laura before lunch.';
check('both kept', !lostMixture(spanishFirst, 'Ya terminé el informe; I just need to send it to Laura before lunch.'));
check('both kept with the switch inside a clause, where no comma splits it',
  !lostMixture('El cliente ya aprobó el diseño, so we can start building next week.',
    'El cliente aprobó el diseño que le enviamos, por lo que podemos start building the new version next week.'));
check('all in Spanish', lostMixture(spanishFirst, 'Ya terminé el informe, solo necesito enviárselo a Laura antes del almuerzo.'));
check('all in English', lostMixture("I'll call you tonight, mais je ne sais pas encore à quelle heure.",
  "I'll call you tonight, but I don't know yet at what time."));
check('nothing to lose in a text in one language',
  !lostMixture('Ich schicke dir die Unterlagen morgen früh, dann koennen wir am Freitag darüber sprechen.', 'Ich schicke dir die Unterlagen morgen.'));
check('nor in one with borrowed words only',
  !lostMixture('El deadline es mañana pero todavia no tengo el draft.', 'El plazo es mañana pero todavía no tengo el borrador.'));

console.log(failures === 0 ? '\nBorrowed-word checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
