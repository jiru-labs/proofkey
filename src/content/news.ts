import { askWorker, type NewsResult } from '../core/messages';
import { toast, toastShowing } from './toast';

/**
 * Asks, once per page load, whether there is a note about something new, and
 * shows it as an ordinary notice. Called when live checking takes a field —
 * the one moment ProofKey is known to be wanted on this page — and after a
 * short wait, so the note does not land on the first keystroke.
 *
 * It yields to anything already on screen: an Undo, an error, a rating
 * question. The worker decides whether there is a note at all; see
 * `core/news.ts` for when there is.
 */

const NEWS_DELAY_MS = 1500;
/** Long enough to read a sentence and decide; the pointer on it holds it longer. */
const NEWS_MIN_MS = 10_000;

let asked = false;

export function offerNews(shadow: ShadowRoot): void {
  if (asked || window !== window.top) return;
  asked = true;
  window.setTimeout(() => void show(shadow), NEWS_DELAY_MS);
}

async function show(shadow: ShadowRoot): Promise<void> {
  // Asking hands the note out and marks it seen, so ask only when it can be shown.
  if (toastShowing()) return;
  const news = await askWorker<NewsResult>({ type: 'proofkey:news' });
  if (!news.ok || !news.value || toastShowing()) return;
  const note = news.value;

  toast(shadow, {
    kind: 'info',
    text: note.text,
    minMs: NEWS_MIN_MS,
    ...(note.actionLabel
      ? {
          action: {
            label: note.actionLabel,
            run: () => void act(shadow, note.id),
          },
        }
      : {}),
  });
}

async function act(shadow: ShadowRoot, id: string): Promise<void> {
  const done = await askWorker<string>({ type: 'proofkey:news-act', id });
  toast(shadow, done.ok ? { kind: 'ok', text: done.value } : { kind: 'error', text: done.error });
}
