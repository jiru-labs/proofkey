/**
 * The model ProofKey can run inside the browser itself, through WebLLM on
 * WebGPU, for browsers that have no built-in model: Brave switches Chrome's off
 * and Edge on Linux has none (COMPATIBILITY.md).
 *
 * No runtime imports and no `chrome.*`, so the service worker, the offscreen
 * document and the options page can all read it — and so can the checks in
 * `tools/`.
 *
 * Chosen by measurement, `tools/webllm-probe.html` in the user's own Brave on an
 * AMD Radeon RX 6600, 2026-09-26 (MODELS.md, "a model inside the browser"):
 * `Qwen3.5-4B` scored 13.0/14 on the live check on every one of 10 runs, as
 * Chrome's built-in model does. `Qwen3.5-2B` scored 12.0/14 and read worse —
 * it left `Their is` and `no se` uncorrected, put whole Portuguese and German
 * messages into English, and looped in Expand — so it is not offered. The
 * original hybrid `Qwen3-4B`, the only Qwen3-4B WebLLM ships, handed every error
 * back unchanged (7.0/14).
 */

export const IN_BROWSER_MODEL = 'Qwen3.5-4B-q4f16_1-MLC';

/**
 * The weights, pinned to one Hugging Face revision so what downloads is what
 * was measured. That pin and TLS are all that stand behind the 78 weight
 * shards: WebLLM 0.2.85 has no integrity check for weights (read in its
 * source, 2026-09-27 — its `oid sha256` lookup serves a cross-origin cache
 * extension, not verification). What it can check, it does: see
 * `IN_BROWSER_INTEGRITY`.
 */
export const IN_BROWSER_MODEL_URL =
  'https://huggingface.co/mlc-ai/Qwen3.5-4B-q4f16_1-MLC/resolve/44b42469f9e192814bfd90440e3b377d89ba7a13/';

/** 86 files at that revision, summed from Hugging Face's own listing, 2026-09-27. */
export const IN_BROWSER_DOWNLOAD_BYTES = 2_390_497_405;

/** The one host the weights come from, named to the user before anything is fetched. */
export const IN_BROWSER_DOWNLOAD_HOST = 'huggingface.co';

/**
 * The compiled WebGPU library for this model, shipped inside the extension:
 * MV3 forbids code fetched at run time, and a `.wasm` is code. Fetched into
 * `public/webllm/` by `tools/fetch-webllm-lib.mjs`, which checks this hash.
 */
export const IN_BROWSER_MODEL_LIB = 'webllm/Qwen3.5-4B-q4f16_1_cs1k-webgpu.wasm';
export const IN_BROWSER_MODEL_LIB_SHA256 =
  '7e8f9895daa710a83952efac4d5c6f36e9f89dc684b25022746d881bdc904712';

/**
 * SRI hashes WebLLM checks before using a file, throwing on a mismatch: the
 * model's config and tokenizer at the pinned revision, and the bundled model
 * library. Computed 2026-09-27 from the files themselves.
 */
export const IN_BROWSER_INTEGRITY = {
  config: 'sha256-uU1Tv95bSW2NliOb9GhOJLU5QgnlrvkSeGbvpFQ5VlE=',
  model_lib: 'sha256-fo+YldqnEKg5Uu+sTVxvNun4ncaEslAidG2IG9yQRxI=',
  tokenizer: { 'tokenizer.json': 'sha256-X55NSQGpK5l+RjwfRgVQiLbMpcphplItG59kxLuBy0I=' },
  onFailure: 'error',
} as const;

/** WebLLM's own figure for this build (`prebuiltAppConfig`, 0.2.85). */
export const IN_BROWSER_VRAM_MB = 3868;

/**
 * The built-in actions offered while this model is active, by the same rule as
 * Chrome's built-in model: only what measured well. Same Brave, same GPU, one run
 * per fixture of `tools/action-eval.ts`:
 *
 *   - Fix grammar 7/8 on mixed-language text and 4/4 in one language — Nano's
 *     equal (21/24) — and it read well.
 *   - Convert to bullet points 8/8 and 4/4.
 *   - Translate 4/4, translating the injection fixture as text where Nano
 *     obeyed it on every run.
 *
 * Left out: the six rewrites, which translated borrowed words in 3 or 4 of 8
 * mixed fixtures (`team` → `equipo`). Live checking is not an action and is on
 * offer as well: 13.0/14.
 */
export const ACTIONS_ON_IN_BROWSER_MODEL: ReadonlySet<string> = new Set([
  'fix-grammar',
  'bullet-points',
  'translate',
]);

/** How long the model stays in GPU memory after its last request. */
export const IN_BROWSER_IDLE_MS = 5 * 60_000;

/** Waits before each new try when the download hits a network error; one entry per retry. */
export const IN_BROWSER_NETWORK_RETRIES: readonly number[] = [2_000, 10_000, 30_000];

/**
 * A fetch that failed on the network, as against a bad file or no GPU. The
 * browser words it differently by API — "Failed to fetch", "NetworkError",
 * and from the Cache API "Cache.add() encountered a network error".
 */
export function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /network ?error|failed to fetch|load failed|ERR_(INTERNET|NETWORK|CONNECTION)/i.test(message);
}

/** What the card says when the download stopped on the network after every retry. */
export function interruptedDownload(detail: string): string {
  return `The download was interrupted by a network error. Click "Download model" to carry on: the part already downloaded is kept. (${detail})`;
}

/**
 * Qwen3.5 in WebLLM 0.2.85 opens every reply with an empty `<think></think>`
 * even with thinking off (measured on the RX 6600). It is not text the user
 * wrote, so it must never reach a field; a non-empty block is dropped too.
 */
export function stripThinking(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
}

/** What the options page and the worker say about the model's state. */
export type InBrowserState =
  | { kind: 'no-webgpu'; reason: string }
  | { kind: 'not-downloaded' }
  | { kind: 'downloading'; fraction: number; text: string }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

/** Messages to the offscreen document. `target` keeps every other listener out of them. */
export type OffscreenRequest =
  | { target: 'proofkey-offscreen'; op: 'status' }
  | { target: 'proofkey-offscreen'; op: 'download' }
  | { target: 'proofkey-offscreen'; op: 'delete' }
  | {
      target: 'proofkey-offscreen';
      op: 'complete';
      systemPrompt: string;
      userText: string;
      maxTokens: number;
      liveCheck?: boolean;
    };

export function describeInBrowserState(state: InBrowserState): string {
  switch (state.kind) {
    case 'no-webgpu':
      return `This browser cannot run the model: ${state.reason}`;
    case 'not-downloaded':
      return `Not downloaded yet. It is ${(IN_BROWSER_DOWNLOAD_BYTES / 1e9).toFixed(1)} GB, fetched once from ${IN_BROWSER_DOWNLOAD_HOST} and kept by this browser; after that nothing you check leaves this computer.`;
    case 'downloading':
      return `Downloading… ${Math.round(state.fraction * 100)}%`;
    case 'ready':
      return 'Ready. The model runs on this computer\'s GPU, inside the browser, and ProofKey sends nothing you check anywhere.';
    case 'error':
      return state.message;
  }
}
