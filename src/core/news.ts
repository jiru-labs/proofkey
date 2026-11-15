import type { Settings } from './types';

/**
 * What's new, said once, where it is useful.
 *
 * A feature nobody hears about may as well not exist: automatic correction
 * ships switched off, so without a word about it the users it was built for
 * never find the switch. The opposite failure is worse — a changelog tab
 * opening on every update, or a banner in someone's mail — so the rules are
 * narrow:
 *
 * - One small note, shown once per item, inside a page where ProofKey is
 *   already at work (a field with live checking on), with the action itself on
 *   the button. Never a new tab, never on a page ProofKey was not asked into.
 * - Only to the people it concerns: an item knows when it is irrelevant (the
 *   feature is already on, or the user never uses the part it belongs to).
 * - At most one a day, so a release with two items does not stack them.
 * - A fresh install has nothing "new": every item is marked seen on install.
 *
 * The state is a list of ids and a timestamp in `chrome.storage.local`. It
 * never syncs, and nothing about it leaves the computer.
 */

export type NewsAction = 'auto-correct';

export interface NewsItem {
  /** Stable forever: it is what `seen` records. */
  id: string;
  text: string;
  /** The button, what it does, and what to say once it has. */
  action?: { label: string; does: NewsAction; done: string };
  /** False when the note would tell this user nothing they can use. */
  relevant(settings: Settings): boolean;
}

/** Newest last. An item stays here for good; removing it would only make it unseeable. */
export const NEWS: readonly NewsItem[] = [
  {
    id: 'auto-correct',
    text: 'New in ProofKey: it can fix typos and accents for you when you pause, with Undo one click away.',
    action: {
      label: 'Turn on',
      does: 'auto-correct',
      done: 'Automatic correction is on. Switch it off any time under Settings → Live checking.',
    },
    relevant: (settings) => settings.liveCheck.enabledOrigins.length > 0 && settings.liveCheck.autoCorrect !== true,
  },
];

export interface NewsState {
  seen: string[];
  /** When a note was last shown, in ms since the epoch. */
  lastShownAt: number;
}

export const NEWS_GAP_MS = 24 * 60 * 60 * 1000;

export function emptyNewsState(): NewsState {
  return { seen: [], lastShownAt: 0 };
}

/** What a fresh install starts from: nothing that exists today is news to it. */
export function installedNewsState(items: readonly NewsItem[] = NEWS): NewsState {
  return { seen: items.map((item) => item.id), lastShownAt: 0 };
}

/**
 * The note to show now, and the state to store once it has been shown —
 * marked seen at the moment it is handed out, so a tab closed before anyone
 * looked does not bring it back in every other tab.
 */
export function takeNews(
  state: NewsState,
  settings: Settings,
  now: number,
  items: readonly NewsItem[] = NEWS,
): { item: NewsItem | null; state: NewsState } {
  if (now - state.lastShownAt < NEWS_GAP_MS) return { item: null, state };
  const item = items.find((candidate) => !state.seen.includes(candidate.id) && candidate.relevant(settings)) ?? null;
  if (!item) return { item: null, state };
  return { item, state: { seen: [...state.seen, item.id], lastShownAt: now } };
}

/** Carries out a note's button. Returns false for an action this build does not know. */
export function applyNewsAction(settings: Settings, does: string): boolean {
  if (does === 'auto-correct') {
    settings.liveCheck.autoCorrect = true;
    return true;
  }
  return false;
}
