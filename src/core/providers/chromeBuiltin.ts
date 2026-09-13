import type { Connection } from '../types';
import {
  ProviderError,
  REQUEST_TIMEOUT_MS,
  type CompletionRequest,
  type CompletionResult,
} from './request';

/**
 * Chrome's own on-device model, reached through the Prompt API (`LanguageModel`).
 * No key, no account, and no request of ours leaves the machine: Chrome fetches
 * the model once from Google through its component updater, and every prompt
 * runs locally.
 *
 * Called straight from the service worker. `LanguageModel` is defined there as
 * well as on extension pages — measured in Chrome 153 with a probe extension,
 * both answering `availability()` — so no offscreen document is needed.
 *
 * Which browsers have it is measured, not assumed, and only this far
 * (2026-09-13): Google Chrome 153 runs it. Brave Origin 153 defines
 * `LanguageModel` but answers `unavailable` on hardware Chrome accepts, so that
 * state cannot be read as "this computer is too weak". Playwright's Chromium 151
 * answered `downloadable` on a web page and `unavailable` in `test:ext`'s
 * extension worker; nobody has let it download. Chrome documents its own
 * floor as 22 GB of free disk and a GPU with more than 4 GB of VRAM, or 16 GB of
 * RAM with 4 cores.
 */

/** The languages Chrome documents for this model's input and output. */
export const BUILTIN_LANGUAGES = ['en', 'es', 'de', 'fr', 'ja'] as const;

export const BUILTIN_MODEL = 'gemini-nano';

/**
 * The built-in actions offered while this model is the active connection. The
 * rest stay in settings and come back the moment a provider with a key is made
 * active.
 *
 * Chosen by measurement, `tools/action-eval.ts --actions all --runs 3 --temperature 0`
 * through `tools/nano-bridge.mjs`, 2026-09-13. Every fixture there mixes two
 * languages in one message, and the actions promise to keep the mixture. Fix
 * grammar kept it in 21 of 24 checks. The rewrites did not: Improve writing and
 * Make professional 9/24, Make friendly 12/24, Expand 15/24, Simplify and
 * Summarize 18/24. Read, the failures are one behaviour — borrowed words
 * absorbed into the sentence's main language ("Hola team… kickoff meeting"
 * became "Hola equipo… reunión de inicio") — so the output reads well and
 * quietly drops what the writer chose. Translate failed differently and worse:
 * it obeyed the injection fixture, answering a bare "OK", on 3 of 3 runs.
 *
 * Convert to bullet points also scored 21/24 and is still left out. Three runs
 * is a small sample — this repo has measured a six-point spread out of 25
 * between sessions with nothing changed — so 21 against 18 is not a
 * distinction, and the set stays at the one action the model is most needed
 * for until more runs say otherwise. Live checking is not an action and is
 * always on offer: 13.0/14 on `npm run eval`.
 */
export const ACTIONS_ON_BUILTIN_MODEL: ReadonlySet<string> = new Set(['fix-grammar']);

export type BuiltinAvailability =
  | 'no-api'
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

interface Session {
  prompt(input: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

interface CreateOptions {
  initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[];
  expectedInputs?: { type: 'text'; languages: readonly string[] }[];
  expectedOutputs?: { type: 'text'; languages: readonly string[] }[];
  temperature?: number;
  topK?: number;
  signal?: AbortSignal;
  monitor?: (monitor: EventTarget) => void;
}

interface LanguageModelApi {
  availability(options?: CreateOptions): Promise<Exclude<BuiltinAvailability, 'no-api'>>;
  create(options?: CreateOptions): Promise<Session>;
}

function api(): LanguageModelApi | undefined {
  return (globalThis as { LanguageModel?: LanguageModelApi }).LanguageModel;
}

const IO: CreateOptions = {
  expectedInputs: [{ type: 'text', languages: BUILTIN_LANGUAGES }],
  expectedOutputs: [{ type: 'text', languages: BUILTIN_LANGUAGES }],
};

export async function builtinAvailability(): Promise<BuiltinAvailability> {
  const model = api();
  if (!model) return 'no-api';
  try {
    return await model.availability(IO);
  } catch {
    return 'unavailable';
  }
}

/** What to tell the user for each state that is not `available`. */
export function builtinProblem(state: BuiltinAvailability): string | null {
  switch (state) {
    case 'available':
      return null;
    case 'no-api':
      return 'This browser has no built-in model. It works in Google Chrome on desktop; here, add a provider with an API key instead.';
    case 'unavailable':
      // Not a hardware verdict: Brave answers this on a machine Chrome runs it on.
      return 'This browser says its built-in model is unavailable. Brave has answered that on a computer where Chrome runs it; in Google Chrome it usually means the computer is below Chrome\'s requirements (22 GB of free disk, and a GPU with more than 4 GB of memory or 16 GB of RAM). Add a provider with an API key instead.';
    case 'downloadable':
      return 'The built-in model is not downloaded yet. Open ProofKey settings and click "Download model".';
    case 'downloading':
      return 'Chrome is still downloading the built-in model. Try again when it finishes.';
  }
}

export async function complete(
  connection: Connection,
  request: CompletionRequest,
): Promise<CompletionResult> {
  const model = api();
  const state = await builtinAvailability();
  const problem = builtinProblem(state);
  if (!model || problem) throw new ProviderError(problem ?? 'No built-in model.', connection.label);

  // Always greedy. Measured 2026-09-13 with `npm run eval`, 14 fixtures x 10
  // runs in an extension service worker: Chrome's default sampling scored
  // 12.8/14 with a 12-13 spread and one run rewriting a sentence into
  // "Literally there's a lot of things to do."; temperature 0 with topK 1
  // scored 13.0/14 on every run. The card shows no sampling fields for this
  // connection, so there is no user setting to honour instead.
  const sampling = { temperature: 0, topK: 1 };

  // The same ceiling the network transports put on a request. Without it a
  // stalled session would hold `runCompletion` on this connection forever and
  // the fallback chain would never be tried.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const failure = (what: string, error: unknown): unknown => {
    // The caller cancelling is not a failure, and must stay an AbortError.
    if (request.signal?.aborted) return error;
    if (timeout.aborted) {
      return new ProviderError(
        `The built-in model did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`,
        connection.label,
      );
    }
    return new ProviderError(`${what}: ${describe(error)}`, connection.label);
  };

  let session: Session;
  try {
    session = await model.create({
      ...IO,
      ...sampling,
      initialPrompts: [{ role: 'system', content: request.systemPrompt }],
      signal,
    });
  } catch (error) {
    throw failure('Chrome could not start its built-in model', error);
  }

  try {
    const text = await session.prompt(request.userText, { signal });
    if (!text.trim()) throw new ProviderError('The built-in model returned an empty reply.', connection.label);
    return { text, model: BUILTIN_MODEL };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw failure('The built-in model failed', error);
  } finally {
    session.destroy();
  }
}

export async function listModels(): Promise<string[]> {
  return [BUILTIN_MODEL];
}

/**
 * Starts the one-time model download. Chrome requires a user gesture for it, so
 * this must be called synchronously from a click on an extension page — any
 * await before it discards the activation.
 */
export function downloadBuiltinModel(onProgress: (fraction: number) => void): Promise<void> {
  const model = api();
  if (!model) return Promise.reject(new Error(builtinProblem('no-api')!));
  return model
    .create({
      ...IO,
      monitor: (monitor) =>
        monitor.addEventListener('downloadprogress', (event) =>
          onProgress((event as Event & { loaded: number }).loaded),
        ),
    })
    .then((session) => session.destroy());
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
