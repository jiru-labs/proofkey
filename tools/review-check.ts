/**
 * Checks when ProofKey asks for a rating, and where it sends people:
 *
 *     node --experimental-strip-types tools/review-check.ts
 *
 * The question is put once in the life of an install, after enough applied
 * suggestions over enough days, and only by a build that knows its store.
 */

import {
  emptyReviewState,
  recordApplied,
  REVIEW_AFTER_APPLIED,
  REVIEW_AFTER_MS,
  reviewUrl,
  type ReviewState,
} from '../src/core/review.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 5);

/** Applies `count` suggestions spread evenly from `from` to `to`; returns the state and when it asked. */
function applyMany(count: number, from: number, to: number, canAsk = true, state = emptyReviewState()) {
  const asks: number[] = [];
  for (let i = 0; i < count; i++) {
    const now = count === 1 ? from : from + ((to - from) * i) / (count - 1);
    const step = recordApplied(state, now, canAsk);
    state = step.state;
    if (step.ask) asks.push(i + 1);
  }
  return { state, asks };
}

console.log('when it asks:');
{
  const quick = applyMany(50, START, START + DAY);
  check('not on the first day, however much is applied', quick.asks.length === 0, `asked at ${quick.asks}`);

  const slow = applyMany(REVIEW_AFTER_APPLIED - 1, START, START + 30 * DAY);
  check('not before enough suggestions, however long it has been', slow.asks.length === 0, `asked at ${slow.asks}`);

  const both = applyMany(REVIEW_AFTER_APPLIED, START, START + REVIEW_AFTER_MS);
  check('on the suggestion that meets both thresholds', both.asks.join() === String(REVIEW_AFTER_APPLIED), `asked at ${both.asks}`);

  const after = applyMany(200, START + 3 * DAY, START + 60 * DAY, true, both.state);
  check('and never again', after.asks.length === 0 && after.state.asked, `asked again at ${after.asks}`);

  const late = applyMany(30, START, START + DAY);
  const day3 = recordApplied(late.state, START + 3 * DAY);
  check('a heavy first day is asked on the first apply once the days have passed', day3.ask);
}

console.log('\nwhat it remembers:');
{
  const first = recordApplied(emptyReviewState(), START);
  check('the first apply sets the clock', first.state.firstAppliedAt === START && first.state.applied === 1);
  const second = recordApplied(first.state, START + DAY);
  check('later ones do not move it', second.state.firstAppliedAt === START && second.state.applied === 2);
  const input: ReviewState = { applied: 4, firstAppliedAt: START, asked: false };
  recordApplied(input, START + DAY);
  check('the stored state is not changed in place', input.applied === 4);
}

console.log('\na build that knows no store:');
{
  const unpacked = applyMany(REVIEW_AFTER_APPLIED * 3, START, START + 10 * DAY, false);
  check('counts, and never asks', unpacked.asks.length === 0 && unpacked.state.applied === REVIEW_AFTER_APPLIED * 3);
  check('and keeps the question for later', !unpacked.state.asked);
  const nowStore = recordApplied(unpacked.state, START + 11 * DAY, true);
  check('which a store build then asks', nowStore.ask);
}

console.log('\nwhere it sends people:');
{
  const id = 'loibjoemoahkajjnfioajcibcamhdafc';
  check(
    'a Chrome Web Store install goes to its own reviews page',
    reviewUrl('https://clients2.google.com/service/update2/crx', id) === `https://chromewebstore.google.com/detail/${id}/reviews`,
  );
  check('an unpacked build goes nowhere', reviewUrl(undefined, id) === null);
  check(
    'nor does an Edge Add-ons install, until its page is known',
    reviewUrl('https://edge.microsoft.com/extensionwebstorebase/v1/crx', id) === null,
  );
  check('nor any other update server', reviewUrl('https://example.com/update2/crx', id) === null);
}

console.log(failures === 0 ? '\nReview checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
