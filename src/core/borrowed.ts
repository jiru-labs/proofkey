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
 * Measured on Qwen3-4B, six actions × 25 mixed texts (2026-10-13): 127/150
 * without it, 137 with it, 140 when the words were named by hand. On 28 texts
 * in one language with typos it named two misspellings that happen to be
 * English (`boy` for `voy`), which a rewrite then leaves as written — so it is
 * used for the rewording actions only, never for Fix grammar or the live check.
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

/** The English words in `text`, as written, first occurrence of each. */
export function borrowedWords(text: string, lexicon: Lexicon): string[] {
  const base = baseLanguage(text);
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
