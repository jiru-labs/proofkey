import type { Connection } from '../types';
import {
  IN_BROWSER_MODEL,
  type InBrowserState,
  type OffscreenRequest,
} from './inBrowserModel';
import {
  ProviderError,
  REQUEST_TIMEOUT_MS,
  type CompletionRequest,
  type CompletionResult,
} from './request';

export { ACTIONS_ON_IN_BROWSER_MODEL, describeInBrowserState, type InBrowserState } from './inBrowserModel';

/**
 * The service worker's side of the in-browser model. The model itself lives in
 * an offscreen document (`src/offscreen/offscreen.ts`, which says why); this
 * creates that document when it is needed and relays to it.
 *
 * No request of ours leaves the machine to answer a check: the document runs the
 * model from the browser's cache. The only network traffic is the one-time
 * weight download the user starts from settings.
 */

const OFFSCREEN_PATH = 'offscreen/index.html';

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const open = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (open.length > 0) return;
  // Two requests arriving together must not both create it: the second call
  // would fail, as an extension may hold only one offscreen document.
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Runs the language model the user chose to run inside the browser, on WebGPU.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

export async function askOffscreen<T>(request: OffscreenRequest): Promise<T> {
  await ensureOffscreen();
  const reply = (await chrome.runtime.sendMessage(request)) as Reply<T> | undefined;
  if (!reply) throw new Error('The in-browser model did not answer.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

export function inBrowserStatus(): Promise<InBrowserState> {
  return askOffscreen<InBrowserState>({ target: 'proofkey-offscreen', op: 'status' });
}

export async function complete(
  connection: Connection,
  request: CompletionRequest,
): Promise<CompletionResult> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const asked = askOffscreen<string>({
    target: 'proofkey-offscreen',
    op: 'complete',
    systemPrompt: request.systemPrompt,
    userText: request.userText,
    maxTokens: connection.maxOutputTokens,
    liveCheck: request.liveCheck,
  });
  // The same ceiling every other transport has, so a stalled GPU cannot hold
  // the fallback chain forever. The document is not told to stop: WebLLM
  // finishes the reply, and the next request queues behind it.
  const stop = new Promise<never>((_, reject) => {
    const fail = (why: string) => reject(new ProviderError(why, connection.label));
    timeout.addEventListener('abort', () =>
      fail(`The in-browser model did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`),
    );
    request.signal?.addEventListener('abort', () => reject(request.signal!.reason));
  });
  try {
    const text = await Promise.race([asked, stop]);
    return { text, model: IN_BROWSER_MODEL };
  } catch (error) {
    if (error instanceof ProviderError || request.signal?.aborted) throw error;
    throw new ProviderError(error instanceof Error ? error.message : String(error), connection.label);
  }
}

export async function listModels(): Promise<string[]> {
  return [IN_BROWSER_MODEL];
}
