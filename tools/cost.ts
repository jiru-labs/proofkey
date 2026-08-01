/**
 * Estimates what ProofKey costs to run, per model.
 *
 *     node --experimental-strip-types tools/cost.ts
 *     node --experimental-strip-types tools/cost.ts --markdown   # tables for MODELS.md
 *
 * The system-prompt sizes are measured from `src/core/prompts.ts` rather than
 * typed in, so this stays honest when the prompts are edited. Everything else
 * is an assumption, and every assumption is named in ASSUMPTIONS below and
 * printed with the output — a cost table whose inputs are invisible is a way of
 * being confidently wrong.
 *
 * Token counts are estimated at CHARS_PER_TOKEN. To make them exact, call the
 * provider's token-counting endpoint instead; for Gemini that is
 * `POST {base}/v1beta/models/{model}:countTokens`, which needs a key.
 */

import {
  BUILT_IN_ACTIONS,
  composeCheckPrompt,
  composeSystemPrompt,
  formatCheckPayload,
} from '../src/core/prompts.ts';
import type { WritingProfile } from '../src/core/types.ts';

// --------------------------------------------------------------- assumptions

/**
 * Rough for English and other Latin-script languages. Languages that tokenize
 * worse — CJK, Arabic, Devanagari, and heavily accented text — land nearer 2,
 * so treat these figures as a floor for those and roughly double them.
 */
const CHARS_PER_TOKEN = 4;

/** A chat or email sentence. The harness fixtures run 60–120. */
const SENTENCE_CHARS = 90;

/** One paragraph, the typical target of a quick action. ~100 words. */
const PARAGRAPH_CHARS = 600;

/** Live check batches up to this many sentences per request (storage.ts). */
const SENTENCES_PER_CHECK = 8;

const ASSUMPTIONS = [
  `${CHARS_PER_TOKEN} characters per token (Latin script; halve for CJK)`,
  `${SENTENCE_CHARS}-character sentences, ${SENTENCES_PER_CHECK} per live-check request`,
  `${PARAGRAPH_CHARS}-character paragraph for a quick action`,
  'empty writing profile — a style guide adds its own length to every request',
  'no thinking tokens; see the note on reasoning models',
];

const EMPTY_PROFILE: WritingProfile = {
  styleGuide: '',
  neverFlag: [],
  nativeLanguage: '',
  explainLanguage: '',
};

// ------------------------------------------------------------------- pricing

/**
 * USD per million tokens, standard (non-batch, non-priority) tier.
 *
 * Source: https://ai.google.dev/gemini-api/docs/pricing — checked 2026-08-01.
 * Prices change. Re-check before trusting these, and note the pattern the page
 * follows: batch and flex are half of standard, priority is 1.8x. A row that
 * breaks that pattern is probably a transcription error here.
 */
const PRICES: Record<string, { in: number; out: number; thinking: string }> = {
  'gemini-2.5-flash-lite': { in: 0.1, out: 0.4, thinking: 'off via reasoning_effort' },
  'gemini-3.1-flash-lite': { in: 0.25, out: 1.5, thinking: 'cannot be disabled' },
  'gemini-2.5-flash': { in: 0.3, out: 2.5, thinking: 'off via reasoning_effort' },
  'gemini-3.5-flash-lite': { in: 0.3, out: 2.5, thinking: 'cannot be disabled' },
  'gemini-3.6-flash': { in: 1.5, out: 7.5, thinking: 'cannot be disabled' },
  'gemini-3.5-flash': { in: 1.5, out: 9.0, thinking: 'cannot be disabled' },
  'gemini-2.5-pro': { in: 1.25, out: 10.0, thinking: 'cannot be disabled' },
};

// ----------------------------------------------------------------- workloads

const tokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

interface Workload {
  name: string;
  note: string;
  inputTokens: number;
  outputTokens: number;
}

function workloads(): Workload[] {
  const sentence = 'x'.repeat(SENTENCE_CHARS);
  const batch = Array.from({ length: SENTENCES_PER_CHECK }, () => sentence);
  const checkSystem = composeCheckPrompt(EMPTY_PROFILE, SENTENCES_PER_CHECK);
  const checkPayload = formatCheckPayload(batch);

  const fixGrammar = BUILT_IN_ACTIONS.find((a) => a.id === 'fix-grammar')!;
  const summarize = BUILT_IN_ACTIONS.find((a) => a.id === 'summarize')!;
  const paragraph = tokens('x'.repeat(PARAGRAPH_CHARS));

  return [
    {
      name: 'Live check',
      note: `one request, ${SENTENCES_PER_CHECK} sentences in and back`,
      inputTokens: tokens(checkSystem) + tokens(checkPayload),
      // The contract is to return every line, corrected or not.
      outputTokens: tokens(checkPayload),
    },
    {
      name: 'Fix grammar',
      note: 'one paragraph, rewritten at about the same length',
      inputTokens: tokens(composeSystemPrompt(fixGrammar, EMPTY_PROFILE)) + paragraph,
      outputTokens: paragraph,
    },
    {
      name: 'Summarize',
      note: 'one paragraph in, a short summary out',
      inputTokens: tokens(composeSystemPrompt(summarize, EMPTY_PROFILE)) + paragraph,
      outputTokens: Math.ceil(paragraph * 0.3),
    },
  ];
}

const costPer1000 = (w: Workload, price: { in: number; out: number }): number =>
  ((w.inputTokens * price.in + w.outputTokens * price.out) / 1_000_000) * 1000;

// -------------------------------------------------------------------- output

const money = (n: number): string => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

function main(): void {
  const markdown = process.argv.includes('--markdown');
  const jobs = workloads();
  const models = Object.keys(PRICES);

  const line = (cells: string[]) =>
    markdown ? `| ${cells.join(' | ')} |` : cells.map((c) => c.padEnd(24)).join('');
  const rule = (n: number) => (markdown ? `|${'---|'.repeat(n)}` : '-'.repeat(n * 24));

  console.log(markdown ? '### Token footprint\n' : '\nTOKEN FOOTPRINT\n');
  console.log(line(['Operation', 'Input tokens', 'Output tokens', 'What it is']));
  if (markdown) console.log(rule(4));
  for (const w of jobs) {
    console.log(line([w.name, String(w.inputTokens), String(w.outputTokens), w.note]));
  }

  console.log(markdown ? '\n### Cost per 1,000 operations\n' : '\n\nCOST PER 1,000 OPERATIONS\n');
  console.log(line(['Model', ...jobs.map((w) => w.name), 'Thinking']));
  if (markdown) console.log(rule(jobs.length + 2));
  for (const model of models) {
    const price = PRICES[model]!;
    console.log(
      line([
        markdown ? `\`${model}\`` : model,
        ...jobs.map((w) => money(costPer1000(w, price))),
        price.thinking,
      ]),
    );
  }

  console.log(markdown ? '\n**Assumptions.**\n' : '\n\nASSUMPTIONS\n');
  for (const a of ASSUMPTIONS) console.log(markdown ? `- ${a}` : `  - ${a}`);
  console.log(
    markdown
      ? '\nRegenerate with `npm run cost -- --markdown`. Prices checked 2026-08-01.'
      : '\nPrices checked 2026-08-01 against ai.google.dev/gemini-api/docs/pricing\n',
  );
}

main();
