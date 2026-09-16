import {
  askWorker,
  type ContentState,
  type RunResult,
  type SiteGrant,
  type SiteOffer,
  type WorkerRequest,
} from '../core/messages';
import { createFrameWatcher } from './frames';
import { createShortcuts } from './keys';
import { createLive, type LiveController } from './live';
import { applyToTarget, readTarget, targetIsCurrent, type EditTarget } from './target';
import { toast } from './toast';
import css from './ui.css?inline';

const HOST_ID = 'proofkey-root';

let shadow: ShadowRoot | null = null;

function ui(): ShadowRoot {
  if (shadow) return shadow;

  const existing = document.getElementById(HOST_ID);
  if (existing?.shadowRoot) {
    shadow = existing.shadowRoot;
    return shadow;
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  // The host itself must not affect layout — everything inside is fixed-position.
  host.style.cssText = 'all: initial; position: static;';
  shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = css;
  shadow.append(style);

  document.documentElement.append(host);
  return shadow;
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((message: WorkerRequest, _sender, sendResponse) => {
  switch (message.type) {
    case 'proofkey:ping':
      sendResponse(true);
      return false;

    case 'proofkey:invoke':
      void invoke(message.actionId);
      sendResponse(true);
      return false;

    case 'proofkey:toggle-live':
      void toggleLive(message.injected);
      sendResponse(true);
      return false;
  }
});

// ------------------------------------------------------ live layer and keys

let live: LiveController | null = null;

const shortcuts = createShortcuts((actionId) => void invoke(actionId));

/**
 * Built lazily like the live layer: the shadow root is only appended when
 * something is going to be shown, and this shows nothing on a page the user
 * never set ProofKey up for.
 */
let frames: ReturnType<typeof createFrameWatcher> | null = null;

/**
 * Pulls the current settings and applies them to both in-page layers.
 *
 * The live controller is built once, on the first pull, because rebuilding it
 * would drop the sentence cache and re-check text that has already been paid
 * for. Bindings are cheap by comparison and are replaced wholesale each time.
 */
async function refreshState(): Promise<void> {
  const state = await askWorker<ContentState>({ type: 'proofkey:get-state' });
  if (!state.ok) return;

  shortcuts.setBindings(state.value.shortcuts);
  if (!live) live = createLive(ui(), state.value);
  live.setEnabled(state.value.liveEnabled);

  // Only on a page ProofKey was set up for. The script also arrives on demand,
  // from the menu or the toolbar button, and a page reached that way has
  // frames of its own — ads, embeds — that nobody asked about.
  if (!frames) frames = createFrameWatcher(ui());
  frames.setActive(state.value.liveEnabled || state.value.shortcuts.length > 0);
}

// Edits in the options page reach open tabs without a reload. Without this a
// shortcut the user just bound would do nothing until every tab was refreshed,
// which reads as the feature being broken.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'sync') void refreshState();
});

async function toggleLive(injected: boolean): Promise<void> {
  if (!live) await refreshState();
  if (!live) return;

  // A click that had to bring the script in was made on a page where live
  // checking was not running, whatever the stored switch said. Flipping that
  // switch turned it off: the user saw nothing, clicked to get it back, and
  // was told "off". A click means "the thing I see changes", so here it runs.
  const next = injected && live.isEnabled() ? true : !live.isEnabled();
  if (next !== live.isEnabled()) {
    const saved = await askWorker<boolean>({ type: 'proofkey:set-live', enabled: next });
    if (!saved.ok) {
      toast(ui(), { kind: 'error', text: saved.error });
      return;
    }
  }

  live.setEnabled(next);
  if (next && window === window.top && (await offerSite())) return;
  toast(ui(), {
    kind: 'ok',
    text: next
      ? 'Live checking is on for this site. Click into a text field to start.'
      : 'Live checking is off for this site.',
  });
}

/**
 * Offers the grant that keeps live checking on past this page load, when the
 * browser has not given ProofKey this site yet. Without it the toolbar click
 * reaches this one page only, and the next visit starts with nothing loaded.
 * Returns whether the offer was shown.
 */
async function offerSite(): Promise<boolean> {
  const answer = await askWorker<SiteOffer>({ type: 'proofkey:site-offer' });
  if (!answer.ok || !answer.value.needed) return false;

  const host = location.host;
  toast(ui(), {
    kind: 'info',
    sticky: true,
    text: `Live checking is on for this page. Allow ${host} to keep it on after the page reloads.`,
    action: { label: `Allow ${host}`, run: () => void grantSite(host) },
  });
  return true;
}

async function grantSite(host: string): Promise<void> {
  // No await before the request leaves: the click that ran this is the gesture
  // the permission prompt needs, and it does not wait for anything.
  const pending = askWorker<SiteGrant>({ type: 'proofkey:site-grant' });
  const dismiss = toast(ui(), { kind: 'busy', text: `Asking the browser about ${host}…`, sticky: true });
  const result = await pending;
  dismiss();

  if (!result.ok) {
    toast(ui(), {
      kind: 'error',
      text: result.error,
      action: { label: 'Open settings', run: () => void askWorker({ type: 'proofkey:open-options' }) },
    });
    return;
  }
  toast(ui(), {
    kind: result.value.granted ? 'ok' : 'info',
    text: result.value.granted
      ? `${host} is allowed. Live checking stays on here from now on.`
      : `${host} was not allowed, so live checking lasts until this page reloads.`,
  });
}

void refreshState();

// ------------------------------------------------------------------ action

let running = false;

async function invoke(actionId: string): Promise<void> {
  if (running) return;

  const target = readTarget();
  if (!target) {
    // The cursor may well be in a text field — one inside a frame on another
    // origin, where this copy of the script cannot see it. If that frame is
    // set up, its own copy is handling this invocation and there is nothing to
    // say here; if it is not, the user just asked for an action in a place
    // ProofKey cannot reach, which is exactly when to offer the grant.
    const focused = document.activeElement;
    if (focused instanceof HTMLIFrameElement) {
      if (!frames) frames = createFrameWatcher(ui());
      await frames.offerFor(focused);
      return;
    }
    toast(ui(), {
      kind: 'error',
      text: 'Select some text, or put the cursor in a text field first.',
    });
    return;
  }
  if (!target.text.trim()) {
    toast(ui(), { kind: 'error', text: 'That field is empty.' });
    return;
  }

  running = true;
  const dismiss = toast(ui(), { kind: 'busy', text: 'Working…', sticky: true });

  try {
    const result = await askWorker<RunResult>({
      type: 'proofkey:run',
      actionId,
      text: target.text,
    });
    dismiss();

    if (!result.ok) {
      showFailure(result.error);
      return;
    }

    // A provider that answers with nothing -- an empty completion, or a refusal
    // that trims away to nothing -- would otherwise be written straight over the
    // target, deleting exactly the text the user picked out. Nothing downstream
    // catches this: `runAction` validates the text going *out* and returns
    // `result.text.trim()` without ever checking that anything came back.
    //
    // Note this is only safe as an emptiness check. A length-ratio guard would
    // be wrong here, because `summarize` and `simplify` are supposed to come
    // back much shorter than they went in.
    if (!result.value.text.trim()) {
      toast(ui(), {
        kind: 'error',
        text: `${result.value.servedBy} returned nothing, so your text was left as it was.`,
      });
      return;
    }

    // The round-trip takes seconds and the user can type through it. `target`
    // was read before the request went out, so writing now would land the
    // rewrite over text the model never saw. `applyToTarget` refuses this too;
    // catching it here is only so the message can say what actually happened.
    if (!targetIsCurrent(target)) {
      await navigator.clipboard.writeText(result.value.text).catch(() => undefined);
      toast(ui(), {
        kind: 'error',
        text: 'The text changed while this was running, so the result was copied to your clipboard instead.',
      });
      return;
    }

    const applied = await applyToTarget(target, result.value.text);
    if (!applied) {
      // Rather than lose the result, hand it over so it can still be pasted.
      await navigator.clipboard.writeText(result.value.text).catch(() => undefined);
      // Said only when it is true: an editor can take part of a write and refuse
      // to take it back, and "would not accept" over a changed field sends the
      // user off believing their text is untouched.
      toast(ui(), {
        kind: 'error',
        text: targetIsCurrent(target)
          ? 'This editor would not accept the text, so it was copied to your clipboard instead.'
          : 'This editor changed the text in a way ProofKey could not check. Look it over before you send it; the result is on your clipboard.',
      });
      return;
    }

    const fallback = result.value.fallbackErrors[0];
    toast(ui(), {
      kind: 'ok',
      text: fallback
        ? `Applied via ${result.value.servedBy} — ${fallback.label} failed.`
        : 'Applied.',
    });
  } catch (error) {
    dismiss();
    showFailure(error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
  }
}

function showFailure(message: string): void {
  const needsSetup =
    message.includes('No provider is configured') ||
    message.includes('requires an API key') ||
    message.includes('No base URL') ||
    // Chrome's on-device model: missing, not downloaded, or not supported here.
    message.includes('built-in model');

  toast(ui(), {
    kind: 'error',
    text: message,
    action: needsSetup
      ? { label: 'Open settings', run: () => void askWorker({ type: 'proofkey:open-options' }) }
      : undefined,
  });
}

export type { EditTarget };
