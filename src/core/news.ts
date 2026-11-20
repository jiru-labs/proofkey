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

/** What a note's button does: change a setting, or open a page in a new tab. */
export type NewsAction = 'auto-correct' | 'open-report';

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
  {
    id: 'report-forms',
    text: 'New in ProofKey: tell us how it works here. Working or broken, a short report helps. Also under Settings → Tell us how it went.',
    action: {
      label: 'Report',
      does: 'open-report',
      done: 'The report form is open in a new tab. Nothing is sent unless you submit it there. Thank you!',
    },
    relevant: (settings) => settings.liveCheck.enabledOrigins.length > 0,
  },
  {
    // Up to 0.1.25 settings said a second provider was tried when one failed,
    // and nothing could make it so; whoever added one for that is told how now.
    id: 'backup',
    text: 'New in ProofKey: tick Backup on a second provider in Settings, and it is tried when the active one fails.',
    relevant: (settings) => (settings.connections?.length ?? 0) > 1 && (settings.fallbackConnectionIds ?? []).length === 0,
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

/** The page a note's button opens in a new tab, or null when the button changes a setting instead. */
export function newsLink(does: string, version: string): string | null {
  return does === 'open-report' ? reportFormUrl('site', version) : null;
}

/** Carries out a note's button. Returns false for an action this build does not know, or one that only opens a page. */
export function applyNewsAction(settings: Settings, does: string): boolean {
  if (does === 'auto-correct') {
    settings.liveCheck.autoCorrect = true;
    return true;
  }
  return false;
}

/**
 * The GitHub issue forms people report on, the only way a store user can tell
 * us how ProofKey works for them. Opening one sends nothing; submitting the
 * form is the user's own act, on GitHub. The installed version is the only
 * thing filled in: the page they were on is deliberately left out, because
 * merely opening the link would hand it to GitHub.
 */
const REPORT_FORM = 'https://github.com/nyakojiru/proofkey/issues/new';

export function reportFormUrl(kind: 'site' | 'provider', version: string): string {
  const url = new URL(REPORT_FORM);
  url.searchParams.set('template', `${kind}-report.yml`);
  url.searchParams.set('version', version);
  return url.href;
}
