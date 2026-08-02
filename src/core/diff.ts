/**
 * Word-level diff between the original text and a model's rewrite.
 *
 * This is load-bearing in two places. It is how a correction gets applied to a
 * rich text editor without destroying formatting — replacing a whole block with
 * a flat string deletes every tag inside it, so instead only the words that
 * actually changed are rewritten, and markup around them is never touched. It
 * is also how one blob of corrected text becomes the individual spans the
 * inline layer underlines.
 *
 * Diffing is used rather than asking the model for structured JSON because it
 * works against any endpoint, including small local models that cannot reliably
 * emit valid JSON, and it cannot fail to parse.
 */

export interface Change {
  /** Offsets into the original text. */
  start: number;
  end: number;
  /** Text that replaces that span. Empty for a pure deletion. */
  replacement: string;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

/**
 * Above this, the quadratic table stops being worth it. Real edits are
 * sentence-sized; anything larger is a whole-document rewrite where a single
 * replacement is the honest answer anyway.
 */
const MAX_TOKENS = 1500;

/** Splits into words and whitespace runs, keeping exact source offsets. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s+|\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/**
 * Returns the minimal set of edits turning `before` into `after`, or `null`
 * when the inputs are too large to diff — callers should replace wholesale.
 */
export function diffWords(before: string, after: string): Change[] | null {
  if (before === after) return [];

  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;

  const n = a.length;
  const m = b.length;

  // Longest common subsequence over suffixes, so the backtrack runs forward
  // and produces changes already in document order.
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i]!.text === b[j]!.text
          ? lcs[(i + 1) * width + (j + 1)]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + (j + 1)]!);
    }
  }

  const changes: Change[] = [];
  let pending: Change | null = null;

  const beginChange = (index: number): Change => ({
    // An insertion with nothing to delete anchors at the next token's start.
    start: index < n ? a[index]!.start : before.length,
    end: index < n ? a[index]!.start : before.length,
    replacement: '',
  });

  const flush = () => {
    if (pending && (pending.start !== pending.end || pending.replacement !== '')) {
      changes.push(pending);
    }
    pending = null;
  };

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i]!.text === b[j]!.text) {
      flush();
      i++;
      j++;
      continue;
    }

    pending ??= beginChange(i);

    const deleteScore = i < n ? lcs[(i + 1) * width + j]! : -1;
    const insertScore = j < m ? lcs[i * width + (j + 1)]! : -1;

    if (i < n && deleteScore >= insertScore) {
      pending.end = a[i]!.end;
      i++;
    } else {
      pending.replacement += b[j]!.text;
      j++;
    }
  }
  flush();

  return mergeAdjacent(changes, before);
}

/**
 * Whether a change is one word rewritten as one recognisably similar word — a
 * typo, an accent, a capital, an inflection. The word survives the edit; only
 * its spelling changed.
 */
function isWordFix(change: Change, before: string): boolean {
  const original = before.slice(change.start, change.end).trim();
  const replacement = change.replacement.trim();
  if (!original || !replacement) return false;
  if (/\s/.test(original) || /\s/.test(replacement)) return false;

  const { category, severity } = classifyChange(change, before);
  return severity === 'spelling' || category === 'Word form';
}

/**
 * Joins changes separated by a single space. Rewriting "was there" as "went
 * there" reads as one correction and applies as one undo step, which is what a
 * user expects from a phrase-level fix.
 *
 * Two misspelled words in a row are not that. "mi extencion" offered as a
 * single "my extension" was reported from x.com, and it is wrong twice over:
 * you cannot take one typo and leave the other, and the merged span has no
 * single-word category left, so two spelling mistakes were labelled and
 * coloured as `Grammar`. Where both halves are the same word respelled, they
 * stay two corrections — because that is what they are.
 *
 * The test is deliberately about the halves rather than about their number. A
 * pair where one side becomes a *different* word is a restructure, and the
 * boundary between "one fix" and "two" there is genuinely the model's to draw,
 * so those still merge.
 */
function mergeAdjacent(changes: Change[], before: string): Change[] {
  const merged: Change[] = [];

  for (const change of changes) {
    const previous = merged[merged.length - 1];
    if (previous) {
      const between = before.slice(previous.end, change.start);
      const separate = isWordFix(previous, before) && isWordFix(change, before);
      if (between.length > 0 && between.trim() === '' && !between.includes('\n') && !separate) {
        previous.replacement += between + change.replacement;
        previous.end = change.end;
        continue;
      }
    }
    merged.push({ ...change });
  }

  return merged;
}

/** Crude category for a change, used to label and colour suggestions. */
export function classifyChange(change: Change, before: string): {
  category: string;
  severity: 'grammar' | 'spelling' | 'style';
} {
  const original = before.slice(change.start, change.end);
  const replacement = change.replacement;

  if (!original.trim()) return { category: 'Missing word', severity: 'grammar' };
  if (!replacement.trim()) return { category: 'Redundant', severity: 'style' };

  const strippedOriginal = stripDiacritics(original);
  const strippedReplacement = stripDiacritics(replacement);
  if (original !== replacement && strippedOriginal === strippedReplacement) {
    return { category: 'Accent', severity: 'spelling' };
  }

  const punctuationOnly = /^[\p{P}\p{S}\s]+$/u;
  if (punctuationOnly.test(original) && punctuationOnly.test(replacement)) {
    return { category: 'Punctuation', severity: 'grammar' };
  }

  const originalWords = original.trim().split(/\s+/).length;
  const replacementWords = replacement.trim().split(/\s+/).length;
  if (originalWords === 1 && replacementWords === 1) {
    const a = original.trim().toLowerCase();
    const b = replacement.trim().toLowerCase();

    if (a === b) return { category: 'Capitalisation', severity: 'spelling' };

    // One word extending the other is an inflection — "show"/"shows",
    // "walk"/"walked" — which is agreement or tense, not a typo.
    if (a.startsWith(b) || b.startsWith(a)) {
      return { category: 'Word form', severity: 'grammar' };
    }

    return editDistanceWithin(a, b, 2)
      ? { category: 'Spelling', severity: 'spelling' }
      : { category: 'Word choice', severity: 'style' };
  }

  return { category: 'Grammar', severity: 'grammar' };
}

function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/** Bounded Levenshtein — only needs to answer "is this a typo or a different word". */
function editDistanceWithin(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return false;
    previous = current;
  }

  return previous[b.length]! <= limit;
}
