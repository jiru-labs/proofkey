/**
 * Sentence segmentation, used to keep live checking cheap.
 *
 * Only sentences whose text changed are ever sent, and the one the caret sits
 * in is skipped until the user moves on — checking a half-typed sentence
 * produces nonsense suggestions and spends tokens to do it.
 *
 * `Intl.Segmenter` does the work where available: it handles scripts without
 * spaces and punctuation conventions that a regex would get wrong, which
 * matters for a tool that claims to work in any language.
 */

export interface Sentence {
  text: string;
  start: number;
  end: number;
}

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'sentence' })
    : null;

export function segment(text: string): Sentence[] {
  if (!text) return [];

  if (segmenter) {
    const out: Sentence[] = [];
    for (const part of segmenter.segment(text)) {
      const value = part.segment;
      if (!value.trim()) continue;
      out.push({ text: value, start: part.index, end: part.index + value.length });
    }
    return out;
  }

  return fallbackSegment(text);
}

/** Only reached on engines without `Intl.Segmenter`; deliberately conservative. */
function fallbackSegment(text: string): Sentence[] {
  const out: Sentence[] = [];
  const pattern = /[^.!?。！？\n]+(?:[.!?。！？]+|\n+|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (!match[0].trim()) continue;
    out.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return out;
}

/** Index of the sentence containing `caret`, or -1. */
export function sentenceAt(sentences: Sentence[], caret: number): number {
  return sentences.findIndex((sentence) => caret >= sentence.start && caret <= sentence.end);
}

/**
 * Stable key for the cache. Trailing whitespace is ignored so that typing a
 * space after a finished sentence does not re-send it.
 */
export function sentenceKey(text: string): string {
  const normalised = text.trim().replace(/\s+/g, ' ');
  let hash = 5381;
  for (let i = 0; i < normalised.length; i++) {
    hash = ((hash << 5) + hash + normalised.charCodeAt(i)) | 0;
  }
  return `${normalised.length}:${(hash >>> 0).toString(36)}`;
}
