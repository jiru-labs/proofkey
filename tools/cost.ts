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
 * Rough for English and other Latin-script languages.
 *
 * Measured against xAI's tokenizer (`POST /v1/tokenize-text`, grok-4.3,
 * 2026-08-01), which is the only real tokenizer this repo has checked:
 *
 *   - flowing English prose                  5.2 chars/token
 *   - flowing Spanish prose                  4.8
 *   - this repo's live-check system prompt   4.4  (dense, punctuation-heavy)
 *   - a numbered payload of ASCII sentences  3.8
 *   - the same payload with accents + emoji  ~3.2
 *
 * So 4 is a fair middle for the composed request and slightly optimistic once
 * accents and emoji are in the text. Prose alone tokenizes better than 4;
 * structure and punctuation are what cost tokens. CJK, Arabic and Devanagari
 * are worse still and remain unmeasured here — treat these figures as a floor
 * for those.
 */
const CHARS_PER_TOKEN = 4;

/** A chat or email sentence. The harness fixtures run 60–120. */
const SENTENCE_CHARS = 90;

/** One paragraph, the typical target of a quick action. ~100 words. */
const PARAGRAPH_CHARS = 600;

/** Live check batches up to this many sentences per request (storage.ts). */
const SENTENCES_PER_CHECK = 8;

const ASSUMPTIONS = [
  `${CHARS_PER_TOKEN} characters per token — measured at 3.8–5.2 on xAI's tokenizer depending on how punctuated the text is; worse for CJK`,
  `${SENTENCE_CHARS}-character sentences, ${SENTENCES_PER_CHECK} per live-check request`,
  `${PARAGRAPH_CHARS}-character paragraph for a quick action`,
  'empty writing profile — a style guide adds its own length to every request',
  'thinking tokens counted on the live check only, where they have been measured',
];

const EMPTY_PROFILE: WritingProfile = {
  styleGuide: '',
  neverFlag: [],
  nativeLanguage: '',
  explainLanguage: '',
};

// ------------------------------------------------------------------- pricing

interface Price {
  /** USD per million input tokens. */
  in: number;
  /** USD per million output tokens. */
  out: number;
  /** How thinking is controlled, in the user's terms. */
  thinking: string;
  /**
   * Thinking tokens the model spends on one live check, where that is measured
   * and cannot be turned off. Billed at the output rate on top of the reply, so
   * leaving it out understates the cost of a reasoning model badly — on
   * grok-build-0.1 the thinking is 20x the reply.
   *
   * Measured by `tools/eval.ts` on a 14-sentence request and scaled linearly
   * to 8 here, which is approximate — thinking almost certainly has a fixed
   * component too. Undefined means "not measured", not "zero".
   */
  thinkingTokens?: number;
}

interface Provider {
  name: string;
  /** Where the prices came from, so the next person can re-check them. */
  source: string;
  checked: string;
  /**
   * Tokens the provider adds to every request whatever it contains — a chat
   * template or a hidden system prompt. Measured by sending a one-character
   * message and subtracting what the provider's own tokenizer says that
   * message is worth.
   *
   * It matters here because ProofKey's live check is a small, frequent
   * request, so a fixed addend is proportionally large: 184 tokens on xAI is
   * about 29% on top of a live check. Undefined means unmeasured.
   */
  overheadTokens?: number;
  models: Record<string, Price>;
}

/**
 * USD per million tokens, standard (non-batch, non-priority) tier.
 *
 * Prices change. Re-check before trusting these.
 */
const PROVIDERS: Provider[] = [
  {
    name: 'Google Gemini',
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    checked: '2026-08-01',
    // Note the pattern that page follows: batch and flex are half of standard,
    // priority is 1.8x. A row that breaks it is probably a transcription error.
    models: {
      'gemini-2.5-flash-lite': { in: 0.1, out: 0.4, thinking: 'off via reasoning_effort' },
      'gemini-3.1-flash-lite': { in: 0.25, out: 1.5, thinking: 'cannot be disabled' },
      'gemini-2.5-flash': { in: 0.3, out: 2.5, thinking: 'off via reasoning_effort' },
      'gemini-3.5-flash-lite': { in: 0.3, out: 2.5, thinking: 'cannot be disabled' },
      'gemini-3.6-flash': { in: 1.5, out: 7.5, thinking: 'cannot be disabled' },
      'gemini-3.5-flash': { in: 1.5, out: 9.0, thinking: 'cannot be disabled' },
      'gemini-2.5-pro': { in: 1.25, out: 10.0, thinking: 'cannot be disabled' },
    },
  },
  {
    name: 'xAI (Grok)',
    source: 'https://docs.x.ai/docs/models',
    checked: '2026-08-01',
    // Measured: a 1-character message bills 185 prompt tokens, and the xAI
    // tokenizer scores that message at 1.
    overheadTokens: 184,
    models: {
      // Prices below the 200k-token long-context threshold, which ProofKey is
      // never near. Past it every rate doubles.
      // grok-4.3 appears twice because both configurations are real, and the
      // gap between them is the whole point: same model, same prices, 4x the
      // bill once it is allowed to think.
      'grok-4.20-0309-non-reasoning': { in: 1.25, out: 2.5, thinking: 'never thinks' },
      'grok-4.3 + reasoning_effort:none': { in: 1.25, out: 2.5, thinking: 'disabled' },
      'grok-4.3': { in: 1.25, out: 2.5, thinking: 'on by default', thinkingTokens: 685 },
      'grok-build-0.1': { in: 1.0, out: 2.0, thinking: 'cannot be disabled', thinkingTokens: 1959 },
      'grok-4.5': { in: 2.0, out: 6.0, thinking: 'cannot be disabled', thinkingTokens: 485 },
    },
  },
];

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

/**
 * Thinking is billed at the output rate, and the provider's fixed overhead at
 * the input rate, so both belong in the total rather than in a footnote.
 *
 * Thinking is only counted on the live check: it is the only workload measured,
 * and a quick action is a different enough shape that reusing the figure would
 * be inventing data.
 */
function costPer1000(w: Workload, price: Price, provider: Provider): number {
  const input = w.inputTokens + (provider.overheadTokens ?? 0);
  const output = w.outputTokens + (w.name === 'Live check' ? (price.thinkingTokens ?? 0) : 0);
  return ((input * price.in + output * price.out) / 1_000_000) * 1000;
}

// -------------------------------------------------------------------- output

const money = (n: number): string => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

function main(): void {
  const markdown = process.argv.includes('--markdown');
  const jobs = workloads();

  const line = (cells: string[]) =>
    markdown ? `| ${cells.join(' | ')} |` : cells.map((c) => c.padEnd(34)).join('');
  const rule = (n: number) => (markdown ? `|${'---|'.repeat(n)}` : '-'.repeat(n * 34));

  console.log(markdown ? '### Token footprint\n' : '\nTOKEN FOOTPRINT\n');
  console.log(line(['Operation', 'Input tokens', 'Output tokens', 'What it is']));
  if (markdown) console.log(rule(4));
  for (const w of jobs) {
    console.log(line([w.name, String(w.inputTokens), String(w.outputTokens), w.note]));
  }

  // One table per provider: prices come from different pages, are checked on
  // different days, and the per-request overhead differs between them.
  for (const provider of PROVIDERS) {
    const heading = `Cost per 1,000 operations — ${provider.name}`;
    console.log(markdown ? `\n### ${heading}\n` : `\n\n${heading.toUpperCase()}\n`);
    console.log(line(['Model', ...jobs.map((w) => w.name), 'Thinking']));
    if (markdown) console.log(rule(jobs.length + 2));
    for (const [model, price] of Object.entries(provider.models)) {
      console.log(
        line([
          markdown ? `\`${model}\`` : model,
          ...jobs.map((w) => money(costPer1000(w, price, provider))),
          price.thinking,
        ]),
      );
    }

    const notes: string[] = [];
    if (provider.overheadTokens) {
      notes.push(
        `includes ${provider.overheadTokens} tokens of fixed per-request overhead, measured`,
      );
    }
    const thinkers = Object.entries(provider.models).filter(([, p]) => p.thinkingTokens);
    if (thinkers.length) {
      notes.push(
        `live check includes measured thinking tokens: ${thinkers
          .map(([m, p]) => `${m} ${p.thinkingTokens}`)
          .join(', ')}`,
      );
    }
    notes.push(`prices from ${provider.source}, checked ${provider.checked}`);
    for (const n of notes) console.log(markdown ? `\n${n[0]!.toUpperCase()}${n.slice(1)}.` : `  ${n}`);
  }

  console.log(markdown ? '\n**Assumptions.**\n' : '\n\nASSUMPTIONS\n');
  for (const a of ASSUMPTIONS) console.log(markdown ? `- ${a}` : `  - ${a}`);
  console.log(
    markdown
      ? '\nRegenerate with `npm run cost -- --markdown`.'
      : '\nRe-check prices at the sources listed above before trusting them.\n',
  );
}

main();
