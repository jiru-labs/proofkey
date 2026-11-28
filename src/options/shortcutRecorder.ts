import {
  chordFromEvent,
  chordProblem,
  chordWarning,
  formatChord,
  isModifierCode,
  parseChord,
  serializeChord,
  suggestChord,
  suggestChords,
  suggestionLetter,
} from '../core/shortcuts';
import { resolveActions, setActionShortcut } from '../core/storage';
import type { WritingAction } from '../core/types';
import { button, el } from './dom';
import { IS_MAC, openShortcutSettings, shortcutLabel, store } from './state';

/** What the button reads while it is waiting for a key. */
const PROMPT = 'Press a key…';

function labelOf(actionId: string): string {
  return resolveActions(store.settings).find((a) => a.id === actionId)?.label ?? actionId;
}

/** The caution for a stored chord, if it has one. */
export function warningFor(stored: string): string | null {
  const chord = parseChord(stored);
  return chord ? chordWarning(chord, { mac: IS_MAC }) : null;
}

/**
 * Every chord already spoken for — other actions, and the browser command the
 * manifest owns.
 */
export function takenChords(exceptActionId: string): string[] {
  const bound = resolveActions(store.settings)
    .filter((other) => other.id !== exceptActionId && other.shortcut)
    .map((other) => other.shortcut!);
  return [...bound, ...store.commandChords.map((command) => command.chord)];
}

/** The per-action recorder: current key, a way to change it, a way to remove it. */
export function renderShortcutRow(
  action: WritingAction,
  conflicts: Map<string, string[]>,
): HTMLElement {
  const keyText = action.shortcut ? shortcutLabel(action.shortcut) : 'Set a key…';
  const trigger = el('button', {
    class: `btn shortcut__key ${action.shortcut ? '' : 'shortcut__key--empty'}`,
    type: 'button',
    text: keyText,
    dataset: { shortcutFor: action.id },
    attrs: { 'aria-label': `Shortcut key for ${action.label}: ${keyText}` },
    on: { click: () => startRecording(action, trigger, hint) },
  });

  const hint = el('p', {
    class: 'field__hint',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });

  if (store.shortcutNotice?.actionId === action.id) {
    hint.textContent = store.shortcutNotice.text;
    hint.className = `field__hint ${store.shortcutNotice.kind === 'error' ? 'field__hint--error' : ''}`;
    store.shortcutNotice = null;
  } else if (action.shortcut && conflicts.has(action.shortcut)) {
    const others = (conflicts.get(action.shortcut) ?? [])
      .filter((id) => id !== action.id)
      .map((id) => labelOf(id));
    hint.textContent = `Also bound to ${others.join(', ')} — only the first one in this list will run.`;
    hint.className = 'field__hint field__hint--error';
  } else if (action.shortcut && warningFor(action.shortcut)) {
    hint.textContent = warningFor(action.shortcut)!;
    hint.className = 'field__hint field__hint--error';
  } else if (!action.shortcut) {
    hint.textContent = 'Optional. Runs only on the sites listed at the bottom of this section.';
  }

  const stranded = action.shortcut
    ? el('p', {
        class: 'field__hint field__hint--error',
        text: 'No sites are listed under "Shortcuts run on" below, so this key cannot run anywhere yet.',
        attrs: { 'data-stranded-warning': '' },
      })
    : null;
  if (stranded) stranded.hidden = store.settings.shortcutOrigins.length > 0;

  const rowButtons = action.shortcut
    ? [
        button('Suggest another', () => applySuggestion(action, action.shortcut!), 'ghost'),
        button(
          'Remove',
          () => {
            setActionShortcut(store.settings, action.id, null);
            store.shortcutNotice = { actionId: action.id, text: 'Key removed.', kind: 'ok' };
            store.pendingFocusSelector = `[data-shortcut-for="${CSS.escape(action.id)}"]`;
            store.render();
          },
          'ghost',
        ),
      ]
    : [button('Suggest one', () => applySuggestion(action), 'ghost')];

  return el(
    'div',
    { class: 'shortcut' },
    el('div', { class: 'row row--wrap' }, trigger, ...rowButtons),
    hint,
    stranded,
  );
}

function applySuggestion(action: WritingAction, after?: string): void {
  const free = suggestChords(takenChords(action.id), action.label, { mac: IS_MAC });
  const at = after === undefined ? -1 : free.indexOf(after);
  const chord = at >= 0 ? free[(at + 1) % free.length] : free[0] ?? null;

  if (after !== undefined && (!chord || chord === after)) {
    store.shortcutNotice = {
      actionId: action.id,
      text: 'No other key ProofKey can vouch for is free. Record one yourself.',
      kind: 'error',
    };
    store.pendingFocusSelector = `[data-shortcut-for="${CSS.escape(action.id)}"]`;
    store.render();
    return;
  }

  store.shortcutNotice = chord
    ? {
        actionId: action.id,
        text: `Set to ${shortcutLabel(chord)}${
          suggestionLetter(chord, action.label) ? ` (${suggestionLetter(chord, action.label)} from "${action.label}")` : ''
        }. Nothing else claims it — remember to save.`,
        kind: 'ok',
      }
    : {
        actionId: action.id,
        text: 'Every key ProofKey can vouch for is already in use. Record one yourself.',
        kind: 'error',
      };

  if (chord) setActionShortcut(store.settings, action.id, chord);
  store.pendingFocusSelector = `[data-shortcut-for="${CSS.escape(action.id)}"]`;
  store.render();
}

function startRecording(
  action: WritingAction,
  trigger: HTMLButtonElement,
  hint: HTMLParagraphElement,
): void {
  store.cancelRecording?.();

  const restore = trigger.textContent ?? '';
  trigger.classList.add('shortcut__key--recording');
  trigger.textContent = PROMPT;
  hint.className = 'field__hint';
  hint.textContent = 'Press the combination you want. Esc cancels.';

  const stop = (): void => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onModifierRelease, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    trigger.classList.remove('shortcut__key--recording');
    store.cancelRecording = null;
  };

  const abandon = (message: string): void => {
    stop();
    trigger.textContent = restore;
    hint.className = 'field__hint';
    hint.textContent = message;
  };

  const onModifierRelease = (event: KeyboardEvent): void => {
    if (isModifierCode(event.code)) trigger.textContent = modifierPreview(event);
  };

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Element | null;
    if (target === trigger || target?.closest?.('[data-keep-recording]')) return;
    abandon('Left unchanged.');
  };

  const onKey = (event: KeyboardEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();

    if (event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      abandon('Left unchanged.');
      return;
    }

    if (isModifierCode(event.code)) {
      trigger.textContent = modifierPreview(event);
      return;
    }

    const chord = chordFromEvent(event);
    const problem = chordProblem(chord);
    if (problem) {
      trigger.textContent = PROMPT;
      hint.className = 'field__hint field__hint--error';
      const free = suggestChord(takenChords(action.id), action.label, { mac: IS_MAC });
      hint.textContent = free ? `${problem} ${shortcutLabel(free)} is free.` : problem;
      return;
    }

    const serialized = serializeChord(chord);
    const taken = store.commandChords.find((command) => command.chord === serialized);
    if (taken) {
      trigger.textContent = PROMPT;
      hint.className = 'field__hint field__hint--error';
      hint.textContent = `${shortcutLabel(serialized)} is ProofKey's own browser shortcut (${taken.label}), so the page never sees it. Clear or change it in the browser, then press it here again. `;
      const go = button('Open browser shortcut settings', openShortcutSettings, 'ghost');
      go.dataset.keepRecording = '';
      hint.append(go);
      return;
    }

    stop();

    const previous = resolveActions(store.settings).find(
      (other) => other.id !== action.id && other.shortcut === serialized,
    );
    if (previous) setActionShortcut(store.settings, previous.id, null);

    setActionShortcut(store.settings, action.id, serialized);
    const caution = chordWarning(chord, { mac: IS_MAC });
    store.shortcutNotice = {
      actionId: action.id,
      text: previous
        ? `Set to ${shortcutLabel(serialized)}, taken from "${previous.label}".`
        : `Set to ${shortcutLabel(serialized)}. Remember to save.`,
      kind: 'ok',
    };
    if (caution) store.shortcutNotice = { actionId: action.id, text: caution, kind: 'error' };
    store.pendingFocusSelector = `[data-shortcut-for="${CSS.escape(action.id)}"]`;
    store.render();
  };

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onModifierRelease, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  store.cancelRecording = () => abandon('Left unchanged.');
}

function modifierPreview(event: KeyboardEvent): string {
  const held = formatChord(
    { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, code: '' },
    { mac: IS_MAC, layout: store.layoutMap },
  );
  return held || PROMPT;
}
