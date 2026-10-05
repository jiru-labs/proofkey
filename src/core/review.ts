/**
 * The one time ProofKey asks for a rating.
 *
 * Two ratings is what the store listing had on 2026-10-05, and nothing in the
 * extension ever said where to leave one. So, once, after someone has applied
 * enough suggestions over enough days that the tool has plainly been of use,
 * the "Applied" message carries a link to the store's reviews page.
 *
 * Everything here stays on this computer, in `chrome.storage.local`: a count,
 * a timestamp and whether the question was asked. Nothing is sent anywhere —
 * the count exists only to decide when to ask, and asking is the only thing it
 * is ever used for.
 */

/** Suggestions or rewrites applied before the question is worth asking. */
export const REVIEW_AFTER_APPLIED = 10;
/** And not in the first sessions: someone who has only just installed it has no opinion yet. */
export const REVIEW_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

export interface ReviewState {
  applied: number;
  /** When the first suggestion was applied, in ms since the epoch. */
  firstAppliedAt: number;
  /** Set when the question has been put; it is never put again. */
  asked: boolean;
}

export function emptyReviewState(): ReviewState {
  return { applied: 0, firstAppliedAt: 0, asked: false };
}

/**
 * Counts one applied suggestion and says whether this is the moment to ask.
 * True at most once in the life of an install: the returned state has `asked`
 * set from then on. A build with nowhere to send anyone (`canAsk` false) keeps
 * counting and keeps the question for when it has somewhere.
 */
export function recordApplied(
  state: ReviewState,
  now: number,
  canAsk = true,
): { state: ReviewState; ask: boolean } {
  const next: ReviewState = {
    applied: state.applied + 1,
    firstAppliedAt: state.firstAppliedAt || now,
    asked: state.asked,
  };
  const ask =
    canAsk && !next.asked && next.applied >= REVIEW_AFTER_APPLIED && now - next.firstAppliedAt >= REVIEW_AFTER_MS;
  if (ask) next.asked = true;
  return { state: next, ask };
}

/** The Chrome Web Store's update endpoint, as a store install's manifest carries it. */
const CHROME_WEB_STORE_UPDATE = 'https://clients2.google.com/service/update2/crx';

/**
 * Where this install can be rated, or null when there is nowhere to send
 * anyone: an unpacked build has no `update_url`, and a store other than the
 * Chrome Web Store has its own reviews page that this does not know about yet.
 */
export function reviewUrl(updateUrl: string | undefined, extensionId: string): string | null {
  if (updateUrl !== CHROME_WEB_STORE_UPDATE) return null;
  return `https://chromewebstore.google.com/detail/${extensionId}/reviews`;
}

/** What the "Applied" message says when it asks. */
export const REVIEW_ASK_TEXT =
  'Applied. If ProofKey has been useful, a rating in the Chrome Web Store helps other people find it.';
export const REVIEW_ASK_ACTION = 'Rate ProofKey';
