import { askWorker, type FrameGrant, type FrameOffer } from '../core/messages';
import { toast } from './toast';

/**
 * Offers the grant for an editor that lives in a frame on another origin.
 *
 * The browser grants a page without granting the frames inside it, and whole
 * applications are built inside a frame — iCloud Mail's compose editor sits on
 * `www-mail.icloud-sandbox.com`, Infomaniak Mail entirely on
 * `mail.infomaniak.com`. With only the address-bar origin granted ProofKey is
 * injected into the page around the editor and never into the editor, so the
 * user sees an extension that does nothing and nothing tells them why. Adding
 * the frame's origin by hand in Options fixes both sites, but the string to
 * type is only readable from the browser's frame tree.
 *
 * The moment to say so is the moment it matters: focus moving into a frame
 * ProofKey cannot reach. A frame on another origin is opaque from here, but
 * focus moving into it is not — this window loses focus and `activeElement`
 * becomes the `<iframe>` — and the frame's own origin is on its `src`. The
 * offer goes to the service worker, which asks whether that origin is already
 * set up, and the click on Allow is what carries the user gesture the
 * browser's permission prompt requires. Sent from the click and nowhere else.
 *
 * Offered once per origin per page load. Declining is a decision, not a
 * request to be asked again on the next click.
 */
export interface FrameWatcher {
  /** Whether focus events should be watched at all. */
  setActive(active: boolean): void;
  /** Offers the grant for one frame now, if its origin needs it. */
  offerFor(frame: HTMLIFrameElement): Promise<void>;
  destroy(): void;
}

export function createFrameWatcher(shadow: ShadowRoot): FrameWatcher {
  let active = false;
  const offered = new Set<string>();

  /** Origin of the document a frame was pointed at, when it is one worth asking about. */
  function originOf(frame: HTMLIFrameElement): string | null {
    const src = frame.getAttribute('src');
    if (!src) return null;
    try {
      const url = new URL(src, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      // A same-origin frame is reached by the registration already, and if it
      // is not, the missing piece is not a grant.
      if (url.origin === location.origin) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  async function offer(frame: HTMLIFrameElement): Promise<void> {
    const origin = originOf(frame);
    if (!origin || offered.has(origin)) return;
    offered.add(origin);

    const answer = await askWorker<FrameOffer>({ type: 'proofkey:frame-offer', origin });
    if (!answer.ok || !answer.value.needed) return;

    const host = new URL(origin).host;
    toast(shadow, {
      kind: 'info',
      sticky: true,
      text: `The editor here runs inside a frame on ${host}, which ProofKey cannot reach until you allow it.`,
      action: { label: `Allow ${host}`, run: () => void grant(origin, host) },
    });
  }

  async function grant(origin: string, host: string): Promise<void> {
    // No await before the request leaves: the click that ran this is the
    // gesture the permission prompt needs, and it does not wait for anything.
    const pending = askWorker<FrameGrant>({ type: 'proofkey:frame-grant', origin });
    const dismiss = toast(shadow, { kind: 'busy', text: `Asking the browser about ${host}…`, sticky: true });
    const result = await pending;
    dismiss();

    if (!result.ok) {
      toast(shadow, {
        kind: 'error',
        text: result.error,
        action: { label: 'Open settings', run: () => void askWorker({ type: 'proofkey:open-options' }) },
      });
      return;
    }

    if (!result.value.granted) {
      toast(shadow, { kind: 'info', text: `${host} was not allowed, so ProofKey stays out of that frame.` });
      return;
    }

    toast(shadow, {
      kind: 'ok',
      text: result.value.injected
        ? `${host} is allowed. Click into the editor to start.`
        : `${host} is allowed. Reload the page to start.`,
    });
  }

  /**
   * Both events, because a page can hand focus to a frame in more than one way.
   * The check runs a tick later: at the moment the event fires
   * `activeElement` may still name whatever had focus before.
   */
  const onFocusLeft = (): void => {
    if (!active) return;
    setTimeout(() => {
      if (!active) return;
      const element = document.activeElement;
      if (element instanceof HTMLIFrameElement) void offer(element);
    }, 0);
  };

  window.addEventListener('blur', onFocusLeft);
  document.addEventListener('focusout', onFocusLeft, true);

  return {
    setActive(next) {
      active = next;
    },
    offerFor: offer,
    destroy() {
      window.removeEventListener('blur', onFocusLeft);
      document.removeEventListener('focusout', onFocusLeft, true);
    },
  };
}
