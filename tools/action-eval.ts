/**
 * Measures the **quick actions** — the half of ProofKey nothing measured.
 *
 *     export PROOFKEY_EVAL_KEY=...
 *     node --experimental-strip-types tools/action-eval.ts
 *     node --experimental-strip-types tools/action-eval.ts --action summarize --runs 5
 *     node --experimental-strip-types tools/action-eval.ts --models gemini-2.5-flash --actions all
 *     node --experimental-strip-types tools/action-eval.ts --base https://api.x.ai/v1 --models grok-4.3 --reasoning off
 *     node --experimental-strip-types tools/action-eval.ts --actions translate --target-language French
 *     node --experimental-strip-types tools/action-eval.ts --fixtures monolingual --actions all --base http://127.0.0.1:8080/v1 --models qwen3-4b-instruct --reasoning off --temperature 0
 *
 * `tools/eval.ts` sends `composeCheckPrompt` and measures the live underline
 * pass. It has never sent an action prompt, and MODELS.md says so out loud:
 * "that is a result about one prompt, not about the model's judgement on
 * 'improve writing' or 'make professional' — which nobody has measured."
 * This is that harness.
 *
 * Like `eval.ts`, it sends the **real** composed prompt — `composeSystemPrompt`
 * with the real `BUILT_IN_ACTIONS` entry — so what it measures is ProofKey
 * rather than an approximation of it.
 *
 * WHAT IT MEASURES, AND WHY THIS RATHER THAN "ACCURACY"
 *
 * Every fixture here mixes languages inside one message, because that is the
 * case the action prompts make a promise about and the case a user reported
 * breaking: PRESERVATION_RULES says "If the text mixes languages, keep the
 * mixture. Correct each language on its own terms rather than normalising the
 * whole thing into one of them."
 *
 * Scoring a rewrite by exact match would be meaningless — "improve writing" has
 * no single right answer. So a fixture does not carry an expected output. It
 * carries `mustSurvive`: the words that were in a language other than the
 * message's base language, and that a translation would therefore be the first
 * thing to eat. A model that renders "el deadline" as "el plazo" has broken the
 * promise, and it has broken it in a way a string search can see. That is a
 * narrower claim than "the mixture was preserved", and it is the one this
 * harness can actually support.
 *
 * `mustNotAppear` is the other half, and it is deliberately small: the specific
 * translation a model reaches for first. It catches the case where the English
 * word is dropped rather than replaced, which `mustSurvive` alone would score
 * as a survival failure without saying why.
 *
 * The limits, stated rather than buried:
 *
 *   - A word can survive while the sentence around it is translated. Token
 *     survival is a floor, not a proof. Every distinct output is printed for a
 *     human to read, and that reading is the real result — same rule as
 *     `eval.ts`.
 *   - `mustNotAppear` is a blocklist of guesses. A model that invents a
 *     translation not on the list scores as a pass here and a fail to a reader.
 *   - No language identification. Doing it properly needs a dependency this
 *     project does not have and will not add for a test harness.
 *
 * Free models are out of scope on every provider, exactly as in `eval.ts`.
 *
 * This spends real money. It is `runs x actions x fixtures` small requests.
 */

import {
  BUILT_IN_ACTIONS,
  composeSystemPrompt,
  emptyProfile,
} from '../src/core/prompts.ts';
import type { WritingAction, WritingProfile } from '../src/core/types.ts';
import {
  FIXTURES,
  isTranslating,
  MONOLINGUAL_FIXTURES,
  scoreOutput,
  TRANSLATE_FIXTURES,
  type Fixture,
} from './action-eval-fixtures.ts';



/**
 * Deliberately empty, like `eval.ts`. The profile blocks are the user's own
 * rules and would make a score unrepeatable between machines.
 *
 * `nativeLanguage` is left empty for a second reason worth stating: it injects
 * a block naming one language several times, and whether that biases a
 * mixed-language rewrite toward that language is a separate question this
 * harness can answer later by setting it. Measuring the default first means
 * there is a control to compare against.
 */
const BASE_PROFILE: WritingProfile = emptyProfile();

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

/**
 * The quick-actions default from the Gemini preset, not the live-check winner.
 * MODELS.md recommends `gemini-2.5-flash` for actions and `-flash-lite` for the
 * live check, and this harness measures actions.
 */
const DEFAULT_MODELS = ['gemini-2.5-flash'];

/**
 * `fix-grammar` is the default action and the one a user reported translating.
 * `--actions all` runs every enabled built-in.
 */
const DEFAULT_ACTIONS = ['fix-grammar'];

/**
 * Sets `profile.translateLanguage`, which is the only way a translating action
 * has a language to translate into. Without it `composeSystemPrompt` leaves the
 * target-language token unresolved and the run is meaningless, so the harness
 * refuses rather than measuring nonsense.
 */
const DEFAULT_TARGET_LANGUAGE = 'English';

const DEFAULT_REASONING = 'none';
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_RUNS = 3;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}


interface Attempt {
  fixture: Fixture;
  output: string;
  ms: number;
  usage: Record<string, unknown>;
  survived: string[];
  lost: string[];
  appeared: string[];
  /**
   * The strong signal, and the only one this harness will call a translation:
   * a word from `mustNotAppear` is present. That is the model having reached
   * for the other language's equivalent.
   */
  translated: boolean;
  /**
   * A `mustSurvive` entry went missing on a translating action, where the
   * payload disappearing is itself the failure. Kept on the attempt rather than
   * recomputed, so the reporting below can say which token went.
   */
  dropped: boolean;
  /**
   * The weak signal: a `mustSurvive` token is gone but no translation showed
   * up in its place. Measured runs show this is usually orthography rather
   * than translation — `standup` to `stand-up`, `feature flag` to
   * `Featureflag`, which is ordinary German compounding. Reported separately
   * because folding it into the headline number would overstate the bug, and
   * a fix that "improved" this number by suppressing German spelling rules
   * would be a worse product.
   */
  respelled: boolean;
  ok: boolean;
}

interface Options {
  base: string;
  key: string;
  model: string;
  reasoning: string;
  maxTokens: number;
  temperature: number | undefined;
}


/** `--fixtures mixed` (the default, so earlier numbers stay comparable) or `monolingual`. */
function fixturesFor(action: WritingAction, set: string): Fixture[] {
  if (isTranslating(action)) return TRANSLATE_FIXTURES;
  return set === 'monolingual' ? MONOLINGUAL_FIXTURES : FIXTURES;
}

async function runOne(
  action: WritingAction,
  fixture: Fixture,
  profile: WritingProfile,
  { base, key, model, reasoning, maxTokens, temperature }: Options,
): Promise<Attempt> {
  const body = {
    model,
    messages: [
      { role: 'system', content: composeSystemPrompt(action, profile, fixture.input) },
      { role: 'user', content: fixture.input },
    ],
    max_tokens: maxTokens,
    stream: false,
    ...(reasoning === 'off' ? {} : { reasoning_effort: reasoning }),
    ...(temperature === undefined ? {} : { temperature }),
  };

  const started = Date.now();
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - started;

  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    const suffix = retryAfter ? ` (retry-after: ${retryAfter})` : '';
    throw new Error(`HTTP ${response.status}${suffix} — ${(await response.text()).slice(0, 300)}`);
  }

  const payload = await response.json();
  const output: string = payload?.choices?.[0]?.message?.content ?? '';
  const usage = (payload?.usage ?? {}) as Record<string, unknown>;

  return { fixture, output: output.trim(), ms, usage, ...scoreOutput(action, fixture, output) };
}

function resolveActions(requested: string[]): WritingAction[] {
  if (requested.length === 1 && requested[0] === 'all') {
    return BUILT_IN_ACTIONS.filter((a) => a.enabled).map((a) => ({ ...a }));
  }
  return requested.map((id) => {
    const found = BUILT_IN_ACTIONS.find((a) => a.id === id);
    if (!found) {
      const known = BUILT_IN_ACTIONS.map((a) => a.id).join(', ');
      throw new Error(`Unknown action "${id}". Known: ${known}, or "all".`);
    }
    return { ...found };
  });
}

async function main(): Promise<void> {
  const key = process.env.PROOFKEY_EVAL_KEY;
  if (!key) {
    console.error('Set PROOFKEY_EVAL_KEY to a real API key for the endpoint you are measuring.');
    process.exit(1);
  }

  const base = arg('base') ?? DEFAULT_BASE;
  const models = (arg('models') ?? DEFAULT_MODELS.join(',')).split(',').map((m) => m.trim());
  const actionIds = (arg('actions') ?? arg('action') ?? DEFAULT_ACTIONS.join(','))
    .split(',')
    .map((a) => a.trim());
  const runs = Number(arg('runs') ?? DEFAULT_RUNS);
  const reasoning = arg('reasoning') ?? DEFAULT_REASONING;
  const maxTokens = Number(arg('max-tokens') ?? DEFAULT_MAX_TOKENS);
  const temperatureArg = arg('temperature');
  const temperature = temperatureArg === undefined ? undefined : Number(temperatureArg);
  const targetLanguage = arg('target-language') ?? DEFAULT_TARGET_LANGUAGE;
  const fixtureSet = arg('fixtures') ?? 'mixed';
  if (fixtureSet !== 'mixed' && fixtureSet !== 'monolingual') {
    console.error(`Unknown --fixtures "${fixtureSet}". Use mixed or monolingual.`);
    process.exit(1);
  }

  const actions = resolveActions(actionIds);

  console.log(`\nBase:     ${base}`);
  console.log(`Models:   ${models.join(', ')}`);
  console.log(`Actions:  ${actions.map((a) => a.id).join(', ')}`);
  if (actions.some((action) => !isTranslating(action))) {
    console.log(fixtureSet === 'monolingual'
      ? `Fixtures: ${MONOLINGUAL_FIXTURES.length} monolingual, ${runs} run(s) each`
      : `Fixtures: ${FIXTURES.length} mixed-language, ${runs} run(s) each`);
  }
  if (actions.some(isTranslating)) {
    console.log(`Target:   ${targetLanguage} (translating actions use ${TRANSLATE_FIXTURES.length} fixtures of their own)`);
  }
  console.log(`Thinking: ${reasoning === 'off' ? 'field omitted' : `reasoning_effort: ${reasoning}`}`);

  let totalChecks = 0;
  let totalPassed = 0;

  for (const model of models) {
    for (const action of actions) {
      console.log(`\n${'='.repeat(74)}`);
      console.log(`${model} — ${action.label} (${action.id})`);
      console.log('='.repeat(74));

      // Distinct outputs are collected rather than counted, because the whole
      // point is that a human reads them. A model can preserve every token and
      // still have mangled the sentence around them.
      const distinct = new Map<string, number>();
      let passed = 0;
      let attempted = 0;
      const failures = new Map<string, number>();

      const fixtures = fixturesFor(action, fixtureSet);
      const profile: WritingProfile = isTranslating(action)
        ? { ...BASE_PROFILE, translateLanguage: targetLanguage }
        : BASE_PROFILE;

      for (const fixture of fixtures) {
        const results: Attempt[] = [];
        for (let run = 0; run < runs; run++) {
          attempted++;
          try {
            const attempt = await runOne(action, fixture, profile, {
              base,
              key,
              model,
              reasoning,
              maxTokens,
              temperature,
            });
            results.push(attempt);
            if (attempt.ok) passed++;
            const seen = distinct.get(attempt.output) ?? 0;
            distinct.set(attempt.output, seen + 1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.set(message, (failures.get(message) ?? 0) + 1);
          }
        }

        const ok = results.filter((r) => r.ok).length;
        const mark = results.length === 0 ? '????' : ok === results.length ? 'PASS' : 'FAIL';
        console.log(`\n  ${mark}  ${fixture.tests}`);
        console.log(`        in:  ${fixture.input}`);

        const outputs = new Set(results.map((r) => r.output));
        for (const output of outputs) {
          console.log(`        out: ${output}`);
        }

        const appeared = new Set(results.flatMap((r) => r.appeared));
        if (appeared.size > 0) {
          console.log(`        TRANSLATED: ${[...appeared].join(', ')}`);
          console.log(`        ${ok}/${results.length} run(s) kept the mixture`);
        }

        // Printed even when the fixture passes, because it is the thing a
        // reader has to judge for themselves: whether the altered token is a
        // legitimate spelling in that language or the first step of a
        // translation.
        // For a translating action a lost token IS the failure -- a dropped URL,
        // mention, placeholder or instruction -- and nothing else prints it, so
        // without this a translate fixture failed showing no reason at all.
        const droppedTokens = new Set(results.filter((r) => r.dropped).flatMap((r) => r.lost));
        if (droppedTokens.size > 0) {
          console.log(`        DROPPED: ${[...droppedTokens].join(', ')}`);
          console.log(`        ${ok}/${results.length} run(s) kept the payload`);
        }

        const respelledTokens = new Set(results.filter((r) => r.respelled).flatMap((r) => r.lost));
        if (respelledTokens.size > 0) {
          console.log(
            `        respelled (not scored): ${[...respelledTokens].join(', ')} — read the output`,
          );
        }
      }

      totalChecks += attempted;
      totalPassed += passed;

      console.log(`\n  ${passed}/${attempted} checks kept the mixture intact (translation only)`);
      if (distinct.size > fixtures.length) {
        console.log(
          `  ${distinct.size} distinct outputs across ${fixtures.length} fixtures — the model is not stable here`,
        );
      }
      for (const [message, count] of failures) {
        console.log(`  ${count}x request failed: ${message}`);
      }
    }
  }

  console.log(`\n${'='.repeat(74)}`);
  console.log(`Total: ${totalPassed}/${totalChecks} checks kept the mixture intact`);
  console.log(
    'Only a translation fails a check. Respellings are printed but not scored, and\ntoken survival is a floor rather than a proof — read the outputs before quoting this.\n',
  );
}

await main();
