/**
 * Holds the in-browser model: WebLLM running Qwen3.5 4B on WebGPU.
 *
 * An offscreen document rather than the service worker, for three reasons:
 *
 *   - It is a document, the context the model was measured in
 *     (`tools/webllm-probe.html`, a page, in the user's Brave on an RX 6600).
 *     WebGPU in an extension service worker has not been measured in Brave.
 *   - The first download took 535 s there. A service worker is stopped after
 *     5 minutes on one event; an offscreen document is not.
 *   - The model stays loaded between requests without the worker being kept
 *     alive, and is unloaded after `IN_BROWSER_IDLE_MS` so it does not hold
 *     ~4 GB of GPU memory for the whole browser session.
 *
 * Only `chrome.runtime` exists here — an offscreen document has no
 * `chrome.storage` — so everything goes through messages addressed with
 * `target: 'proofkey-offscreen'`, and every other message is left alone.
 *
 * Network: nothing but the model's files from the pinned Hugging Face
 * revision, and only when the user clicks "Download model". A request to check
 * text never starts a download; it answers that the model is not there.
 */

import {
  IN_BROWSER_IDLE_MS,
  IN_BROWSER_INTEGRITY,
  IN_BROWSER_INTERRUPTED,
  IN_BROWSER_MODEL,
  IN_BROWSER_MODEL_LIB,
  IN_BROWSER_MODEL_URL,
  IN_BROWSER_NETWORK_RETRIES,
  IN_BROWSER_VRAM_MB,
  interruptedDownload,
  isNetworkError,
  stripThinking,
  type InBrowserState,
  type OffscreenRequest,
} from '../core/providers/inBrowserModel';

interface Engine {
  chat: { completions: { create(request: unknown): Promise<any> } };
  interruptGenerate(): void;
  unload(): Promise<void>;
}

interface WebLLM {
  CreateMLCEngine(
    model: string,
    config: { appConfig: unknown; initProgressCallback?: (report: { progress: number; text: string }) => void },
  ): Promise<Engine>;
  hasModelInCache(model: string, appConfig: unknown): Promise<boolean>;
  deleteModelAllInfoInCache(model: string, appConfig: unknown): Promise<void>;
}

/**
 * WebLLM, loaded on first use so the 6 MB bundle is parsed only by someone who
 * chose this model.
 *
 * `test:ext` cannot run a model — its Chromium has no GPU — so its copy of the
 * extension carries `offscreen/test-engine.js`, a stand-in with the same three
 * functions. A released build has no such file, and the probe for it is a
 * request to the extension's own package.
 */
let webllm: Promise<WebLLM> | null = null;
function loadWebLLM(): Promise<WebLLM> {
  webllm ??= (async () => {
    const stand = chrome.runtime.getURL('offscreen/test-engine.js');
    const exists = await fetch(stand, { method: 'HEAD' }).then((r) => r.ok, () => false);
    if (exists) return (await import(/* @vite-ignore */ stand)) as WebLLM;
    return (await import('@mlc-ai/web-llm')) as unknown as WebLLM;
  })();
  return webllm;
}

function appConfig(): unknown {
  return {
    model_list: [
      {
        model: IN_BROWSER_MODEL_URL,
        model_id: IN_BROWSER_MODEL,
        model_lib: chrome.runtime.getURL(IN_BROWSER_MODEL_LIB),
        vram_required_MB: IN_BROWSER_VRAM_MB,
        low_resource_required: false,
        // As WebLLM's own record for this build.
        overrides: { context_window_size: 4096, max_history_size: 1 },
        integrity: IN_BROWSER_INTEGRITY,
      },
    ],
  };
}

let engine: Engine | null = null;
let loading: Promise<Engine> | null = null;
let progress: { fraction: number; text: string } | null = null;
let lastError: string | null = null;
/** Set while the user's "Download model" is running, as against a load from the cache. */
let downloading = false;
let idle: ReturnType<typeof setTimeout> | undefined;
/**
 * The reply being generated, when a live check may drop it. Measured in the
 * user's Brave on an RX 6600, 2026-10-04: while the model generated, half the
 * keystrokes on the page took over 100 ms to paint (up to 264 ms), against none
 * with the GPU idle — the model and the page's compositor share the GPU.
 */
let generating: { interruptible: boolean; interrupted: boolean } | null = null;

function startEngine(): Promise<Engine> {
  loading ??= (async () => {
    const lib = await loadWebLLM();
    progress = { fraction: 0, text: 'Starting…' };
    lastError = null;
    try {
      // One dropped connection used to end a 2.4 GB download: seen in the
      // user's Brave on Windows, 2026-10-04, at 71%, as "Failed to execute
      // 'add' on 'Cache': Cache.add() encountered a network error". WebLLM
      // keeps every file it finished, so trying again carries on from there.
      for (let attempt = 0; ; attempt++) {
        try {
          const created = await lib.CreateMLCEngine(IN_BROWSER_MODEL, {
            appConfig: appConfig(),
            initProgressCallback: (report) => {
              progress = { fraction: report.progress, text: report.text };
            },
          });
          engine = created;
          return created;
        } catch (error) {
          if (!isNetworkError(error) || attempt >= IN_BROWSER_NETWORK_RETRIES.length) throw error;
          await new Promise((resolve) => setTimeout(resolve, IN_BROWSER_NETWORK_RETRIES[attempt]));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = isNetworkError(error) ? interruptedDownload(message) : message;
      throw error;
    } finally {
      progress = null;
      loading = null;
    }
  })();
  return loading;
}

async function webgpuProblem(): Promise<string | null> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: unknown): Promise<unknown> } }).gpu;
  if (!gpu) return 'WebGPU is not available in this browser.';
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
  return adapter ? null : 'WebGPU found no usable GPU (it may be blocklisted or switched off).';
}

async function status(): Promise<InBrowserState> {
  const problem = await webgpuProblem();
  if (problem) return { kind: 'no-webgpu', reason: problem };
  if (engine) return { kind: 'ready' };
  if (loading) return { kind: 'downloading', fraction: progress?.fraction ?? 0, text: progress?.text ?? '' };
  if (lastError) return { kind: 'error', message: lastError };
  const lib = await loadWebLLM();
  return (await lib.hasModelInCache(IN_BROWSER_MODEL, appConfig())) ? { kind: 'ready' } : { kind: 'not-downloaded' };
}

function touch(): void {
  clearTimeout(idle);
  idle = setTimeout(() => {
    const held = engine;
    engine = null;
    void held?.unload();
  }, IN_BROWSER_IDLE_MS);
}

async function complete(request: Extract<OffscreenRequest, { op: 'complete' }>): Promise<string> {
  if (!engine) {
    // A download can run for minutes; a request waiting on it would outlive the
    // worker's 60 s timeout and say nothing useful.
    if (downloading) throw new Error('The in-browser model is still downloading. Try again when settings say it is ready.');
    if (!loading) {
      const lib = await loadWebLLM();
      if (!(await lib.hasModelInCache(IN_BROWSER_MODEL, appConfig()))) {
        throw new Error('The in-browser model is not downloaded yet. Open ProofKey settings and click "Download model".');
      }
    }
    await startEngine();
  }
  touch();
  const current = { interruptible: !!request.interruptible, interrupted: false };
  generating = current;
  let content = '';
  let finish: string | null = null;
  try {
    // Streamed, though nothing reads it as it comes. WebLLM's non-streamed path
    // tests the interrupt flag before it starts and never clears it, so an
    // interrupt landing just after a reply finished made every later request
    // come back empty (WebLLM 0.2.85, read in its source on 2026-10-04). The
    // streamed path clears the flag at the start of each request.
    const stream = await engine!.chat.completions.create({
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userText },
      ],
      // Greedy, as measured: 13.0/14 on all 10 runs.
      temperature: 0,
      max_tokens: request.maxTokens,
      extra_body: { enable_thinking: false },
      stream: true,
    });
    for await (const chunk of stream as AsyncIterable<any>) {
      content += chunk?.choices?.[0]?.delta?.content ?? '';
      finish = chunk?.choices?.[0]?.finish_reason ?? finish;
    }
  } finally {
    if (generating === current) generating = null;
  }
  touch();
  // A half-generated correction is not a correction; the check runs again.
  if (current.interrupted || finish === 'abort') throw new Error(IN_BROWSER_INTERRUPTED);
  const text = stripThinking(content);
  if (!text.trim()) throw new Error('The in-browser model returned an empty reply.');
  return text;
}

async function handle(request: OffscreenRequest): Promise<unknown> {
  switch (request.op) {
    case 'status':
      return status();
    case 'download': {
      const problem = await webgpuProblem();
      if (problem) throw new Error(problem);
      // Not awaited: the page asking polls `status` for progress.
      if (!engine && !loading) {
        downloading = true;
        startEngine().then(touch, () => undefined).finally(() => (downloading = false));
      }
      return status();
    }
    case 'delete': {
      clearTimeout(idle);
      const held = engine;
      engine = null;
      await held?.unload();
      lastError = null;
      const lib = await loadWebLLM();
      await lib.deleteModelAllInfoInCache(IN_BROWSER_MODEL, appConfig());
      return status();
    }
    case 'complete':
      return complete(request);
    case 'interrupt':
      // Only a live check: an action the user asked for is never dropped.
      if (generating?.interruptible && engine) {
        generating.interrupted = true;
        engine.interruptGenerate();
      }
      return null;
  }
}

chrome.runtime.onMessage.addListener((message: OffscreenRequest, sender, sendResponse) => {
  if (message?.target !== 'proofkey-offscreen' || sender.id !== chrome.runtime.id) return false;
  handle(message).then(
    (value) => sendResponse({ ok: true, value }),
    (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});
