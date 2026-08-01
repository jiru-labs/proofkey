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
  /**
   * Overrides the provider-level figure, for aggregators where it is not a
   * provider-level property at all: on OpenRouter the same measurement runs
   * from 1 token to 193 depending on which upstream serves the model.
   */
  overheadTokens?: number;
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
  {
    // An aggregator, so almost nothing here is a property of OpenRouter itself.
    // It bills the serving upstream's price and takes its margin when you buy
    // credits, so these rows are other vendors' prices seen through one key —
    // `google/gemini-2.5-flash-lite` costs exactly what it costs direct.
    //
    // Two consequences for this table, both measured rather than assumed:
    //
    //   - Per-request overhead is *not* provider-level, because there is no
    //     single provider. It is recorded per model below and ranges over two
    //     orders of magnitude, from 1 token to 193.
    //   - These are the *catalogue* prices, and they are not always what gets
    //     charged. A model id can have 22 upstream endpoints at up to 10x the
    //     price spread, and routing picks one per request. Checked against
    //     `usage.cost` on ten models: seven matched to eight decimal places,
    //     and the three that did not each reconcile exactly with the price of
    //     whichever upstream served them — llama-3.3-70b billed at DeepInfra's
    //     $0.10/$0.32, deepseek-v4-flash at Baidu's $0.09/$0.179, and
    //     mistral-small-3.2 at Venice's $0.09375/$0.25. Treat these rows as
    //     +/-25%, or read `GET /models/{id}/endpoints` for the one you get.
    name: 'OpenRouter',
    source: 'https://openrouter.ai/api/v1/models (the key\'s own catalogue)',
    checked: '2026-08-01',
    models: {
      // Overheads are `prompt_tokens` for a one-character message, minus one
      // for the character — which assumes "x" is a single token in each of
      // these tokenizers. True for all of them as far as anything here can
      // check, but it is an assumption, not a measurement, unlike the xAI
      // figure above which was confirmed against that provider's tokenizer.
      'mistralai/mistral-nemo': { in: 0.019, out: 0.03, thinking: 'never thinks', overheadTokens: 5 },
      'openai/gpt-oss-20b': {
        in: 0.03,
        out: 0.13,
        // Rejects reasoning_effort with HTTP 400 rather than ignoring it.
        thinking: 'cannot be disabled',
        thinkingTokens: 585,
        overheadTokens: 65,
      },
      'qwen/qwen3.7-flash + reasoning_effort:none': {
        in: 0.03,
        out: 0.13,
        thinking: 'disabled',
        overheadTokens: 10,
      },
      'qwen/qwen3.7-flash': {
        in: 0.03,
        out: 0.13,
        thinking: 'on by default',
        thinkingTokens: 1801,
        overheadTokens: 10,
      },
      'mistralai/mistral-small-3.2-24b-instruct': {
        in: 0.075,
        out: 0.2,
        thinking: 'never thinks',
        overheadTokens: 3,
      },
      'google/gemini-2.5-flash-lite': {
        in: 0.1,
        out: 0.4,
        thinking: 'off via reasoning_effort',
        // A one-character message bills exactly 1 token: no chat template on
        // top at all, the only model measured here with none.
        overheadTokens: 0,
      },
      'openai/gpt-4.1-nano': { in: 0.1, out: 0.4, thinking: 'never thinks', overheadTokens: 7 },
      'meta-llama/llama-3.3-70b-instruct': {
        in: 0.13,
        out: 0.4,
        thinking: 'never thinks',
        overheadTokens: 10,
      },
      'deepseek/deepseek-v4-flash + reasoning_effort:none': {
        in: 0.14,
        out: 0.28,
        thinking: 'disabled',
        overheadTokens: 4,
      },
      'deepseek/deepseek-v4-flash': {
        in: 0.14,
        out: 0.28,
        thinking: 'on by default',
        thinkingTokens: 487,
        overheadTokens: 4,
      },
      'openai/gpt-4.1-mini': { in: 0.4, out: 1.6, thinking: 'never thinks', overheadTokens: 7 },
      'anthropic/claude-haiku-4.5': {
        in: 1.0,
        out: 5.0,
        thinking: 'off by default',
        overheadTokens: 7,
      },
    },
  },
  {
    // Also an aggregator, and the same caveat applies: these are other vendors'
    // prices seen through one key. Unlike OpenRouter there is no routing
    // choice — one id, one upstream, one price — so a row here is not a
    // +/-25% estimate the way an OpenRouter row is.
    //
    // Worth recording because it is the first cross-check this repo has on
    // whether an aggregator marks prices up. It does not: every model OpenCode
    // lists that is *also* priced elsewhere in this file matches to the cent —
    // gemini-3.6-flash, gemini-3.5-flash and gemini-3.5-flash-lite against
    // Google's own page, grok-4.5 and grok-build-0.1 against xAI's, and
    // deepseek-v4-flash and claude-haiku-4.5 against OpenRouter's catalogue.
    // Seven for seven at list price.
    //
    // Only the ProofKey-relevant end of a 60-model catalogue is listed. The
    // rest is coding-agent tooling — Opus at $5/$25, GPT 5.5 Pro at $30/$180 —
    // which nobody should point a live checker at.
    //
    // Where a row carries an overheadTokens or thinkingTokens figure, it was
    // measured on the **Go** endpoint (/zen/go/v1) rather than on Zen, because
    // the key available had a Go subscription and no Zen balance — every paid
    // Zen model answered CreditsError. Same provider and same model id, but a
    // different product, so treat those two figures as borrowed rather than
    // measured in place. Rows without them are unmeasured, which is not the
    // same as zero: the overheads that could be measured ranged from 0 to 249
    // tokens, so guessing a small number would be inventing data.
    name: 'OpenCode Zen',
    source: 'https://opencode.ai/docs/zen/',
    checked: '2026-08-01',
    models: {
      'gpt-5-nano': { in: 0.05, out: 0.4, thinking: 'not measured' },
      'deepseek-v4-flash': { in: 0.14, out: 0.28, thinking: 'not measured' },
      'gpt-5.6-luna': { in: 0.2, out: 1.2, thinking: 'not measured', overheadTokens: 6 },
      'qwen3.5-plus': { in: 0.2, out: 1.2, thinking: 'not measured', overheadTokens: 10 },
      'gpt-5.4-nano': { in: 0.2, out: 1.25, thinking: 'not measured' },
      'minimax-m2.5': { in: 0.3, out: 1.2, thinking: 'not measured', overheadTokens: 41 },
      'gpt-5.1-codex-mini': { in: 0.25, out: 2.0, thinking: 'not measured' },
      'qwen3.7-plus': { in: 0.4, out: 1.6, thinking: 'not measured' },
      'gemini-3.5-flash-lite': { in: 0.3, out: 2.5, thinking: 'cannot be disabled' },
      'gemini-3-flash': { in: 0.5, out: 3.0, thinking: 'not measured' },
      'claude-haiku-4-5': { in: 1.0, out: 5.0, thinking: 'off by default' },
      // The one row where both figures exist, and the one worth comparing
      // against the xAI table: same model, same list price, but 206 tokens of
      // overhead through OpenCode against 184 measured on xAI direct, and 398
      // thinking tokens against 485. Without the thinking term this row would
      // read $2.41 against xAI's $5.69 and look like a discount that is not
      // there.
      'grok-4.5': {
        in: 2.0,
        out: 6.0,
        thinking: 'cannot be disabled',
        thinkingTokens: 398,
        overheadTokens: 206,
      },
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
  const input = w.inputTokens + (price.overheadTokens ?? provider.overheadTokens ?? 0);
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
    const perModelOverhead = Object.entries(provider.models).filter(([, p]) => p.overheadTokens);
    if (perModelOverhead.length) {
      notes.push(
        `fixed per-request overhead differs by model and is included: ${perModelOverhead
          .map(([m, p]) => `${m} ${p.overheadTokens}`)
          .join(', ')}`,
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
