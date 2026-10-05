import { REVIEW_ASK_ACTION, REVIEW_ASK_TEXT } from '../core/review';
import { askWorker, type AppliedResult } from '../core/messages';
import { toast } from './toast';

/**
 * Tells the worker something was applied. Returns true when this was the one
 * time to ask for a rating, and the question has been shown in place of the
 * plain "Applied" message.
 */
export async function noteApplied(shadow: ShadowRoot, mayAsk = true): Promise<boolean> {
  const counted = await askWorker<AppliedResult>({ type: 'proofkey:applied' });
  if (!mayAsk || !counted.ok || !counted.value.askReview) return false;
  toast(shadow, {
    kind: 'ok',
    text: REVIEW_ASK_TEXT,
    action: {
      label: REVIEW_ASK_ACTION,
      run: () => void askWorker({ type: 'proofkey:open-review' }),
    },
  });
  return true;
}
