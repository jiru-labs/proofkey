/**
 * Message contract between the service worker and content scripts.
 *
 * The split is deliberate: the content script owns everything that touches the
 * page (which field is focused, what is selected, how to write text back), and
 * the service worker owns everything that touches the network. Neither reaches
 * into the other's half.
 */

import type { ShortcutBinding } from './shortcuts';

/** Content script → service worker. */
export type ContentRequest =
  | { type: 'proofkey:run'; actionId: string; text: string }
  | { type: 'proofkey:check'; sentences: string[] }
  | { type: 'proofkey:explain'; original: string; replacement: string }
  | { type: 'proofkey:open-options' }
  | { type: 'proofkey:set-live'; enabled: boolean }
  | { type: 'proofkey:add-word'; word: string }
  | { type: 'proofkey:get-state' }
  /** Live checking was switched on here; is the page's origin granted, so it survives a reload? */
  | { type: 'proofkey:site-offer' }
  /** The user clicked Allow on that offer. Carries the click's user gesture. */
  | { type: 'proofkey:site-grant' }
  /** Focus went into a frame on another origin; does that origin need setting up? */
  | { type: 'proofkey:frame-offer'; origin: string }
  /** The user clicked Allow on that offer. Must be sent from the click itself. */
  | { type: 'proofkey:frame-grant'; origin: string };

/** Service worker → content script. */
export type WorkerRequest =
  | { type: 'proofkey:ping' }
  /** Menu or shortcut fired; the content script decides what text that means. */
  | { type: 'proofkey:invoke'; actionId: string }
  /**
   * The toolbar button. `injected` is true when the click had to bring the
   * script into the page, which means live checking was not running here
   * whatever the stored switch says.
   */
  | { type: 'proofkey:toggle-live'; injected: boolean };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface CheckResult {
  /** One corrected sentence per input, in the same order. */
  corrections: string[];
}

export interface RunResult {
  text: string;
  /** Connection that served it, for the "served by fallback" hint. */
  servedBy: string;
  /** Failures from earlier connections in the chain. */
  fallbackErrors: { label: string; message: string }[];
}

export interface FrameOffer {
  /**
   * True when ProofKey cannot work inside a frame on this origin yet: the
   * browser has not granted it, or the script is not registered there, or
   * live checking is on for the page around it but not for the frame.
   */
  needed: boolean;
}

export interface SiteOffer {
  /** True when the browser has not granted the page's origin, so nothing loads the script on the next visit. */
  needed: boolean;
}

export interface SiteGrant {
  /** Whether the browser granted the origin. False when the user declined. */
  granted: boolean;
}

export interface FrameGrant {
  /** Whether the browser granted the origin. False when the user declined. */
  granted: boolean;
  /** Whether the script was injected into the frame right away. */
  injected: boolean;
}

export interface ContentState {
  /** Actions to show, already filtered to the enabled ones. */
  actions: { id: string; label: string }[];
  defaultActionId: string;
  /**
   * Chords to listen for on this page. Empty unless the origin is one the user
   * turned shortcuts on for, so a page that was never opted in never has its
   * keystrokes inspected.
   */
  shortcuts: ShortcutBinding[];
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
