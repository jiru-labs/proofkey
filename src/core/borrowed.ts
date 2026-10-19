/**
 * English words inside Spanish, French or Portuguese text — the `deadline` in
 * «El deadline es mañana» — found without asking a model, so a rewrite can be
 * told to keep them (issue #1). `keptPassages` catches a word in another
 * script; one in the same script needs a dictionary.
 *
 * The rule: a word of three letters or more that is an English word and not a
 * word of the text's language, with or without its accents. The text's
 * language is guessed from its commonest short words. The data is built by
 * `tools/build-lexicon.mjs`: an English word list, and per language one bit per
 * English word saying it is absent from that language.
 *
 * Measured with this data, five rewording actions on the mixed fixtures
 * (2026-10-14, MODELS.md "Naming the words to keep"): Gemini 2.5 Flash 246/400
 * without it, 321 with it; Qwen3-4B 66/120 → 79. On 28 texts in one language
 * with typos it named one misspelling that happens to be English (`boy` for
 * `voy`), which a rewrite then leaves as written — so it is used for the
 * rewording actions only, never for Fix grammar or the live check.
 */

/** The languages there is data for. German is not one: see the build tool. */
export type BorrowedBase = 'es' | 'fr' | 'pt';
const BASES: readonly BorrowedBase[] = ['es', 'fr', 'pt'];

/** Actions that get the words named. Custom actions do not: unmeasured. */
export const KEEPS_BORROWED_WORDS: ReadonlySet<string> = new Set([
  'improve-writing',
  'make-professional',
  'make-friendly',
  'simplify',
  'expand',
]);

export interface Lexicon {
  /** Lowercase English words, sorted. */
  english: string[];
  /** Bit i set: `english[i]` is not a word of that language. */
  absentFrom: Record<BorrowedBase, Uint8Array>;
}

const FUNCTION_WORDS: Record<string, ReadonlySet<string>> = {
  en: words('the of and to in is it that for on with as was are be this you have not but at by from or we they he she his her their our my your will would can could should there what which who when if so than then them these those an about into just do does did has had been were am i me us'),
  es: words('el la los las de del que y en un una es por con para no se lo le les al su sus como pero más mi me te tu ya muy este esta eso hay ser fue son está estoy tengo tenemos'),
  fr: words('le la les de des du que et en un une est pour pas ne se ce il elle je tu nous vous avec sur dans qui au aux mais ou donc très mon ton son ma ta sa être suis on a'),
  de: words('der die das den dem des und ist nicht ein eine einen zu mit von auf für sich es ich du wir sie er auch noch wie aber oder wenn dass hat haben sind bin bei aus vor'),
  pt: words('o a os as de do da dos das que e em um uma é por com para não se no na nos nas ao mas mais muito meu minha você eu ele ela isso vou'),
};

function words(list: string): ReadonlySet<string> {
  return new Set(list.split(' '));
}

const WORD = /\p{L}+(?:['’]\p{L}+)?/gu;

/**
 * The language whose short common words the text uses most, or undefined when
 * it uses none. A tie goes to the earlier one in `FUNCTION_WORDS`, English
 * first, so a text the counts cannot place is never searched for English.
 */
export function baseLanguage(text: string): string | undefined {
  const tokens = (text.match(WORD) ?? []).map((token) => token.toLowerCase());
  let best: string | undefined;
  let bestHits = 0;
  for (const [language, list] of Object.entries(FUNCTION_WORDS)) {
    const hits = tokens.filter((token) => list.has(token)).length;
    if (hits > bestHits) {
      best = language;
      bestHits = hits;
    }
  }
  return best;
}

export function isBorrowedBase(language: string | undefined): language is BorrowedBase {
  return (BASES as readonly string[]).includes(language ?? '');
}

/**
 * The other direction: Spanish, French, Portuguese or German words inside
 * English text — the `mañana` and `pero` in «I told her mañana works better,
 * pero she wants to meet today», which every rewording action translated on
 * Gemini 2.5 Flash (2026-10-14). There is no word list for it: a word with a
 * letter English spells without (ñ, é, ç, ã, ß…), or one of the common words
 * below. Those were checked against the English list, and the ones English
 * also uses (`son`, `die`, `pour`, `solo`, `todo`) left out; loanwords it
 * lists (`fiesta`, `amigo`) stay, since keeping one as written costs nothing.
 */
const NOT_ENGLISH = words(
  'pero muy porque cuando donde ahora entonces siempre nunca tengo tenemos tiene tambien manana ' +
    'gracias hola adios bueno nada mucho luego vamos pues eso esta este estos que los una amigo amigos fiesta ' +
    'mais avec dans merci bien alors aussi toujours demain peut ici bonjour comme quoi pourquoi donc ' +
    "c'est muito obrigado obrigada hoje isso ainda depois nao tudo voce " +
    'aber und nicht auch noch doch schon heute danke bitte sehr ich wir',
);
const NOT_ENGLISH_LETTER = /[^\P{Script=Latin}a-z]/u;

/** The non-English words in an English `text`, as written, first occurrence of each. */
export function foreignWordsInEnglish(text: string): string[] {
  const found = new Map<string, string>();
  for (const token of text.match(WORD) ?? []) {
    const word = token.toLowerCase().replace('’', "'");
    if (!found.has(word) && (NOT_ENGLISH.has(word) || NOT_ENGLISH_LETTER.test(word))) found.set(word, token);
  }
  return [...found.values()];
}

/** A run of the text in one language, as written, and that language's name. */
export interface LanguagePart {
  passage: string;
  language: string;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
};
const CLAUSE = /[^,;:.!?¿¡()\n]+/g;
const MAX_PARTS = 6;
const MAX_PART_LENGTH = 200;

/** English short words that are German, French, Spanish or Portuguese words too. */
const SHARED_WITH_ENGLISH = words('in was so am an as on me he');
/** Contractions, which no other of the five languages writes: a short clause has little else. */
const ENGLISH_CONTRACTIONS = words("i'm i'll i've i'd don't doesn't didn't can't won't isn't aren't wasn't it's that's there's we're you're they're let's");
const WHOLE_WORD = /^\p{L}+(?:['’]\p{L}+)?$/u;

/**
 * The language of one clause, only when its short common words leave no doubt:
 * English with two or more of them, not counting the ones other languages
 * share (German `was`, `in`) on either side, and two more than any other
 * language has;
 * another language with two or more, none of English's, shared or not (`as a
 * whole` is not Portuguese), and more than the
 * runner-up (French and Spanish share `le`, `la`, `de`). Each word counts
 * once, and only a whole word between spaces, so the letters of `-o` or
 * `ddd0a9e494` in a command line are not Portuguese.
 */
function clauseLanguage(clause: string): string | undefined {
  const tokens = new Set(
    clause
      .split(/\s+/)
      .map((token) => token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '').replace('’', "'").toLowerCase())
      .filter((token) => WHOLE_WORD.test(token)),
  );
  const count = (list: ReadonlySet<string>) => [...tokens].filter((token) => list.has(token));
  const plain = (found: string[]) => found.filter((token) => !SHARED_WITH_ENGLISH.has(token)).length;
  const others = Object.entries(FUNCTION_WORDS)
    .filter(([language]) => language !== 'en')
    .map(([language, list]) => [language, count(list)] as const)
    .sort((a, b) => b[1].length - a[1].length);
  const english = [...count(FUNCTION_WORDS.en!), ...count(ENGLISH_CONTRACTIONS)];
  const otherwise = Math.max(...others.map(([, found]) => plain(found)));
  if (plain(english) >= 2 && plain(english) >= otherwise + 2) return 'en';
  if (english.length > 0) return undefined;
  const [first, second] = others;
  return first![1].length >= 2 && first![1].length > second![1].length ? first![0] : undefined;
}

/**
 * The clauses of a text that switches between English and one other language
 * from clause to clause — «Je t'envoie le rapport après le standup, but I still
 * need to review the numbers first» — each with its language, or nothing for a
 * text in one language. On that line the commonest short words tie, the text
 * reads as English, and the five rewording actions wrote it all in French:
 * Qwen3-4B kept the mixture in 0 of 15 checks, Gemini 2.5 Flash in 35 of 50
 * (2026-10-15/17). The borrowed words cannot help, as no single word is out of
 * place. Clauses are split at punctuation, and those whose language is not
 * clear are left out. Measured in MODELS.md, "A text that switches language".
 */
export function mixedClauses(text: string): LanguagePart[] {
  const parts: LanguagePart[] = [];
  for (const match of text.match(CLAUSE) ?? []) {
    const passage = match.trim();
    const language = clauseLanguage(passage);
    if (language && passage.length <= MAX_PART_LENGTH) parts.push({ passage, language });
  }
  const languages = new Set(parts.map((part) => part.language));
  if (languages.size !== 2 || !languages.has('en')) return [];
  // The cap must not cut the text's other language out: a long English text
  // with its Spanish at the end would otherwise name English parts only.
  const capped = parts.slice(0, MAX_PARTS);
  for (const language of languages) {
    if (!capped.some((part) => part.language === language)) {
      capped[capped.length - 1] = parts.find((part) => part.language === language)!;
    }
  }
  return capped.map(({ passage, language }) => ({ passage, language: LANGUAGE_NAMES[language]! }));
}

/**
 * Whether a rewrite of a text that `mixedClauses` splits came back in one of
 * its two languages: not one short common word of English, or not one of the
 * other language, left in it. Counted over the whole rewrite rather than clause
 * by clause, because a rewrite that keeps both often switches mid-clause
 * («por lo que podemos start building the new version next week») where no
 * punctuation splits it. On the stored outputs of 2026-10-17/18 for the six
 * clause fixtures (Gemini 2.5 Flash and Qwen3-4B, five actions), it named 190
 * of the 191 that lost the mixture and none of the 194 that kept it.
 */
export function lostMixture(text: string, rewrite: string): boolean {
  const other = mixedClauses(text).find((part) => part.language !== LANGUAGE_NAMES.en)?.language;
  const code = Object.keys(LANGUAGE_NAMES).find((key) => LANGUAGE_NAMES[key] === other);
  if (!code) return false;
  const tokens = rewrite
    .split(/\s+/)
    .map((token) => token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '').replace('’', "'").toLowerCase())
    // `a` is French, Spanish and Portuguese as well as English: counted, an
    // all-English rewrite of a French text read as keeping the French.
    .filter((token) => !SHARED_WITH_ENGLISH.has(token) && token !== 'a');
  const english = tokens.some((token) => FUNCTION_WORDS.en!.has(token) || ENGLISH_CONTRACTIONS.has(token));
  return !english || !tokens.some((token) => FUNCTION_WORDS[code]!.has(token));
}

/**
 * The English words in a Spanish, French or Portuguese `text` — or, in an
 * English one, the words of those languages (`foreignWordsInEnglish`) — as
 * written, first occurrence of each.
 */
export function borrowedWords(text: string, lexicon: Lexicon): string[] {
  const base = baseLanguage(text);
  if (base === 'en') return foreignWordsInEnglish(text);
  if (!isBorrowedBase(base)) return [];
  const mask = lexicon.absentFrom[base];

  const found = new Map<string, string>();
  for (const token of text.match(WORD) ?? []) {
    const word = token.toLowerCase();
    if (found.has(word) || !/^[a-z]{3,}$/.test(word)) continue;
    const i = indexOf(lexicon.english, word);
    if (i >= 0 && (mask[i >> 3]! >> (i & 7)) & 1) found.set(word, token);
  }
  return [...found.values()];
}

function indexOf(sorted: string[], word: string): number {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const at = sorted[mid]!;
    if (at === word) return mid;
    if (at < word) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

/**
 * Reads the files `tools/build-lexicon.mjs` writes, through `read`, which takes
 * a path under `public/lexicon/` — `fetch` of the extension URL in the
 * extension, the file system in the tools.
 */
export async function loadLexicon(read: (file: string) => Promise<ArrayBuffer>): Promise<Lexicon> {
  const [english, ...masks] = await Promise.all([
    read('en.txt'),
    ...BASES.map((language) => read(`${language}.bin`)),
  ]);
  const list = new TextDecoder().decode(english).split('\n').filter(Boolean);
  const absentFrom = Object.fromEntries(
    BASES.map((language, i) => [language, new Uint8Array(masks[i]!)]),
  ) as Record<BorrowedBase, Uint8Array>;
  for (const [language, mask] of Object.entries(absentFrom)) {
    if (mask.length !== Math.ceil(list.length / 8)) {
      throw new Error(`lexicon/${language}.bin does not match lexicon/en.txt; rebuild both.`);
    }
  }
  return { english: list, absentFrom };
}
