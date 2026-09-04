import { askWorker, type ContentState, type RunResult, type WorkerRequest } from '../core/messages';
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
      void toggleLive();
      sendResponse(true);
      return false;
  }
});

// ------------------------------------------------------ live layer and keys

let live: LiveController | null = null;

const shortcuts = createShortcuts((actionId) => void invoke(actionId));

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
}

// Edits in the options page reach open tabs without a reload. Without this a
// shortcut the user just bound would do nothing until every tab was refreshed,
// which reads as the feature being broken.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'sync') void refreshState();
});

async function toggleLive(): Promise<void> {
  if (!live) await refreshState();
  if (!live) return;

  const next = !live.isEnabled();
  const saved = await askWorker<boolean>({ type: 'proofkey:set-live', enabled: next });
  if (!saved.ok) {
    toast(ui(), { kind: 'error', text: saved.error });
    return;
  }

  live.setEnabled(next);
  toast(ui(), {
    kind: 'ok',
    text: next
      ? 'Live checking is on for this site. Click into a text field to start.'
      : 'Live checking is off for this site.',
  });
}

void refreshState();

// ------------------------------------------------------------------ action

let running = false;

async function invoke(actionId: string): Promise<void> {
  if (running) return;

  const target = readTarget();
  if (!target) {
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
      toast(ui(), {
        kind: 'error',
        text: 'This editor would not accept the text, so it was copied to your clipboard instead.',
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
    message.includes('No base URL');

  toast(ui(), {
    kind: 'error',
    text: message,
    action: needsSetup
      ? { label: 'Open settings', run: () => void askWorker({ type: 'proofkey:open-options' }) }
      : undefined,
  });
}

export type { EditTarget };
