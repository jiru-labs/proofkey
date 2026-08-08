import { matchBinding, type ShortcutBinding } from '../core/shortcuts';

export interface ShortcutListener {
  setBindings(bindings: readonly ShortcutBinding[]): void;
  destroy(): void;
}

/**
 * Runs an action when its chord is pressed.
 *
 * Capture phase, on `window`, so a claimed chord is taken before the page's own
 * handler sees it — otherwise an editor that binds the same key would act first
 * and ProofKey would fire on top of whatever it did. The flip side is that
 * anything claimed here is claimed everywhere on the page, which is why
 * `chordProblem` refuses the editing chords outright.
 *
 * Nothing is inspected until a binding exists, and nothing at all happens on a
 * page whose origin the user did not turn shortcuts on for: the service worker
 * sends an empty list and this stays inert.
 */
export function createShortcuts(run: (actionId: string) => void): ShortcutListener {
  let bindings: readonly ShortcutBinding[] = [];

  const onKeydown = (event: KeyboardEvent): void => {
    if (bindings.length === 0) return;
    // Auto-repeat would queue one request per frame while the key is held.
    if (event.repeat) return;
    // Mid-composition the keydown belongs to the IME, not to a shortcut. 229 is
    // the legacy signal for the same thing, still sent by some IMEs on Windows.
    if (event.isComposing || event.keyCode === 229) return;

    const actionId = matchBinding(bindings, event);
    if (!actionId) return;

    // Both, and in this order: `preventDefault` stops the browser's default for
    // the chord, `stopImmediatePropagation` stops every other listener on the
    // page — including ones already registered on window in capture phase.
    event.preventDefault();
    event.stopImmediatePropagation();
    run(actionId);
  };

  window.addEventListener('keydown', onKeydown, true);

  return {
    setBindings(next) {
      bindings = next;
    },
    destroy() {
      window.removeEventListener('keydown', onKeydown, true);
      bindings = [];
    },
  };
}
