/**
 * Message contract between the service worker and content scripts.
 *
 * The split is deliberate: the content script owns everything that touches the
 * page (which field is focused, what is selected, how to write text back), and
 * the service worker owns everything that touches the network. Neither reaches
 * into the other's half.
 */

/** Content script → service worker. */
export type ContentRequest =
  | { type: 'proofkey:run'; actionId: string; text: string }
  | { type: 'proofkey:explain'; original: string; replacement: string }
  | { type: 'proofkey:open-options' }
  | { type: 'proofkey:get-state' };

/** Service worker → content script. */
export type WorkerRequest =
  | { type: 'proofkey:ping' }
  /** Menu or shortcut fired; the content script decides what text that means. */
  | { type: 'proofkey:invoke'; actionId: string }
  | { type: 'proofkey:toggle-live' };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface RunResult {
  text: string;
  /** Connection that served it, for the "served by fallback" hint. */
  servedBy: string;
  /** Failures from earlier connections in the chain. */
  fallbackErrors: { label: string; message: string }[];
}

export interface ContentState {
  /** Actions to show, already filtered to the enabled ones. */
  actions: { id: string; label: string }[];
  defaultActionId: string;
  /** Whether live checking is switched on for this origin. */
  liveEnabled: boolean;
  debounceMs: number;
  minChars: number;
  maxSentencesPerRequest: number;
  /** Terms the user marked correct; suggestions touching them are dropped. */
  dictionary: string[];
  /** True when at least one usable connection exists. */
  configured: boolean;
}

/** Typed wrapper around `chrome.runtime.sendMessage` for the content script. */
export async function askWorker<T>(request: ContentRequest): Promise<Result<T>> {
  try {
    return (await chrome.runtime.sendMessage(request)) as Result<T>;
  } catch (error) {
    // The service worker can be asleep or the extension mid-reload.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
