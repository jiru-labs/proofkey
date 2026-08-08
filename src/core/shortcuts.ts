/**
 * Keyboard chords for the per-action shortcuts.
 *
 * These are handled in the page, not by `chrome.commands`, because the commands
 * API cannot do what this feature needs: its commands are declared statically in
 * the manifest (so an action the user wrote can never have one), only four may
 * carry a suggested key, and an extension is not permitted to set or clear a
 * binding itself — that only happens on `chrome://extensions/shortcuts`. The
 * manifest command stays as the one global entry point; everything configurable
 * lives here.
 *
 * A chord is identified by `KeyboardEvent.code`, never `key`. Two reasons, both
 * of which produce wrong bindings in exactly the multilingual setups this
 * extension is for:
 *
 *   - `key` is layout-dependent. Recording `key` on one layout and matching it
 *     on another binds a different physical key than the one the user pressed.
 *   - On macOS, Alt composes: pressing Alt+G reports `key` as "©". Recorded
 *     that way the binding can never match, because matching compares against a
 *     `key` that is only "©" while Alt is held.
 *
 * `code` costs one thing in return — the label. `KeyG` is the physical QWERTY-G
 * position, which on AZERTY or Dvorak is not the key printed "G". `keyLabel`
 * takes an optional layout map so the options page can show what is actually
 * printed on the user's keyboard.
 */

export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** A `KeyboardEvent.code`, e.g. `KeyG`, `Digit1`, `F9`. */
  code: string;
}

/** Codes that are only ever a modifier, so a keydown on one is never a chord. */
const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'FnLock',
]);

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

function isFunctionKey(code: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(code);
}

/**
 * Chords Chrome keeps for itself, taken from its published shortcut list rather
 * than from memory: https://support.google.com/chrome/answer/157179
 *
 * Binding one is not a conflict the user can win. Chrome acts on these before
 * the page is consulted, so the shortcut would simply never fire and nothing
 * would say why — the failure is silent, which is the worst kind here.
 *
 * Both the Windows/Linux and the macOS tables are included. A chord is stored
 * once and may be carried to the other platform with a synced profile, so a
 * binding that is only checked against the current platform would come back
 * broken on the other one.
 */
const BROWSER_RESERVED = new Set([
  // Tabs and windows.
  'Ctrl+KeyN', 'Ctrl+KeyT', 'Ctrl+KeyW', 'Ctrl+KeyQ',
  'Ctrl+Shift+KeyN', 'Ctrl+Shift+KeyT', 'Ctrl+Shift+KeyW', 'Ctrl+Shift+KeyQ',
  'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageUp', 'Ctrl+PageDown',
  'Ctrl+Shift+PageUp', 'Ctrl+Shift+PageDown',
  'Alt+Home', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+F4', 'Ctrl+F4',
  // Browser features.
  'Ctrl+Shift+KeyB', 'Ctrl+Shift+KeyO', 'Ctrl+KeyH', 'Ctrl+KeyJ',
  'Ctrl+Shift+KeyM', 'Ctrl+Shift+Delete', 'Shift+Escape',
  'Alt+Shift+KeyT', 'Alt+Shift+KeyI', 'Alt+Shift+KeyA', 'Alt+Shift+KeyN',
  // DevTools.
  'Ctrl+Shift+KeyI', 'Ctrl+Shift+KeyJ', 'Ctrl+Shift+KeyC',
  'Meta+Alt+KeyI', 'Meta+Alt+KeyJ', 'Meta+Alt+KeyC',
  // The address bar swallows the keydown entirely.
  'Ctrl+KeyL', 'Alt+KeyD', 'Ctrl+KeyK', 'Ctrl+KeyE',
  // Function keys Chrome claims. F8 and F9 are deliberately absent — Chrome
  // documents no use for either, which is what makes them a safe suggestion.
  'F1', 'F3', 'F5', 'F6', 'F7', 'F10', 'F11', 'F12',
  'Shift+F5', 'Ctrl+F5', 'Ctrl+F6',
  // macOS equivalents.
  'Meta+KeyN', 'Meta+KeyT', 'Meta+KeyW', 'Meta+KeyQ', 'Meta+KeyM', 'Meta+KeyH',
  'Meta+Shift+KeyN', 'Meta+Shift+KeyT', 'Meta+Shift+KeyW',
  'Meta+KeyY', 'Meta+Shift+KeyJ', 'Meta+Shift+KeyB', 'Meta+Alt+KeyB',
  'Meta+Shift+KeyM', 'Meta+Shift+Delete', 'Meta+KeyL', 'Meta+Comma',
  'Meta+Alt+Shift+KeyI', 'Meta+Alt+Shift+KeyA', 'Meta+Alt+KeyN',
  'Meta+BracketLeft', 'Meta+BracketRight', 'Meta+ArrowLeft', 'Meta+ArrowRight',
  'Meta+Alt+ArrowLeft', 'Meta+Alt+ArrowRight',
  // Ctrl+1..8 jump to a tab, Ctrl+9 to the last one; Ctrl+0 resets zoom.
  ...Array.from({ length: 10 }, (_, digit) => `Ctrl+Digit${digit}`),
  ...Array.from({ length: 10 }, (_, digit) => `Meta+Digit${digit}`),
]);

/**
 * Chords Chrome documents but the page is allowed to take. These are a warning
 * rather than a refusal: ProofKey's capture-phase handler does win them, so the
 * binding works — the user just loses Chrome's own feature on the sites where
 * shortcuts are enabled, and should be told that before they find out.
 */
const BROWSER_SHARED = new Set([
  'Ctrl+KeyS', 'Ctrl+KeyP', 'Ctrl+KeyF', 'Ctrl+KeyD', 'Ctrl+KeyO', 'Ctrl+KeyU',
  'Ctrl+KeyG', 'Ctrl+KeyR', 'Ctrl+Shift+KeyG', 'Ctrl+Shift+KeyR', 'Ctrl+Shift+KeyD',
  'Meta+KeyS', 'Meta+KeyP', 'Meta+KeyF', 'Meta+KeyD', 'Meta+KeyO',
  'Meta+KeyG', 'Meta+Shift+KeyG', 'Meta+Shift+KeyR', 'Meta+Shift+KeyD',
]);

/**
 * Editing chords. These do reach the page and could be intercepted, which is
 * the problem — ProofKey runs inside the text field the user is typing in, so a
 * binding that swallows paste or undo breaks the thing it is meant to help.
 */
const EDITING_RESERVED = new Set(['KeyC', 'KeyV', 'KeyX', 'KeyA', 'KeyZ', 'KeyY']);

export function chordFromEvent(event: {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  code: string;
}): Chord {
  return {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    code: event.code,
  };
}

/** Canonical storage form. Modifier order is fixed so two chords compare as strings. */
export function serializeChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Meta');
  parts.push(chord.code);
  return parts.join('+');
}

/** Returns null for anything that is not a canonical chord string. */
export function parseChord(raw: string): Chord | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('+');
  const code = parts.pop();
  if (!code || isModifierCode(code)) return null;

  const chord: Chord = { ctrl: false, alt: false, shift: false, meta: false, code };
  for (const part of parts) {
    switch (part) {
      case 'Ctrl':
        chord.ctrl = true;
        break;
      case 'Alt':
        chord.alt = true;
        break;
      case 'Shift':
        chord.shift = true;
        break;
      case 'Meta':
        chord.meta = true;
        break;
      default:
        return null;
    }
  }

  // Round-trip check: rejects duplicated or out-of-order modifiers, so a stored
  // string only ever has one spelling and `===` is a safe comparison.
  return serializeChord(chord) === trimmed ? chord : null;
}

export function chordsEqual(a: Chord, b: Chord): boolean {
  return serializeChord(a) === serializeChord(b);
}

/**
 * Why this chord cannot be used, or null if it can.
 *
 * The modifier requirement is not stylistic. Without it a bare letter would be
 * claimed inside every text field on the page, and typing that letter would run
 * an action instead of writing it.
 */
export function chordProblem(chord: Chord): string | null {
  if (!chord.code || isModifierCode(chord.code)) {
    return 'Hold a modifier and press another key.';
  }

  if (!chord.ctrl && !chord.alt && !chord.meta && !isFunctionKey(chord.code)) {
    return chord.shift
      ? 'Shift alone is not enough — add Ctrl, Alt or Cmd, or use a function key.'
      : 'Add Ctrl, Alt or Cmd, or use a function key. A plain key would be captured while you type.';
  }

  // Ctrl+Alt is how AltGr arrives on Windows: pressing AltGr to type @ or ~ or ç
  // raises a keydown with ctrlKey and altKey both set, indistinguishable from a
  // deliberate Ctrl+Alt. A binding here would fire while the user types, on
  // exactly the multilingual keyboards this extension is built for. Chrome's own
  // commands API refuses Ctrl+Alt for the same reason.
  if (chord.ctrl && chord.alt && !chord.meta) {
    return 'Ctrl+Alt is AltGr on many keyboards, so this would fire while you type. Try Alt+Shift and a letter.';
  }

  const serialized = serializeChord(chord);
  if (BROWSER_RESERVED.has(serialized)) {
    return 'Chrome keeps this one, so it would never reach the page.';
  }

  if ((chord.ctrl || chord.meta) && !chord.alt && EDITING_RESERVED.has(chord.code)) {
    return 'This is copy, paste, undo or select-all — ProofKey will not take it from a text field.';
  }

  return null;
}

/**
 * A caution about a chord that is allowed. Null when there is nothing to say.
 *
 * Separate from `chordProblem` because the answer is different in kind: the
 * binding will work, and the user may well want it anyway. Refusing these would
 * shrink the usable space for no reason, which is the opposite of the problem
 * this feature has.
 */
export function chordWarning(chord: Chord): string | null {
  if (BROWSER_SHARED.has(serializeChord(chord))) {
    return 'Chrome also uses this one. ProofKey takes it first, so you would lose that on the sites below.';
  }
  return null;
}

/**
 * A chord that is free, or null if the pool is exhausted.
 *
 * The pool is `Alt+Shift` and a letter, which is the pattern Chrome's extension
 * documentation points developers at, minus the four `Alt+Shift` chords Chrome
 * documents for itself. Two bare function keys close it out for anyone whose
 * desktop has claimed Alt+Shift for switching layouts.
 *
 * This exists because validation alone left the user hunting: it could say a
 * chord was taken but never name one that was not.
 */
const SUGGESTIONS = [
  'Alt+Shift+KeyG',
  'Alt+Shift+KeyK',
  'Alt+Shift+KeyJ',
  'Alt+Shift+KeyL',
  'Alt+Shift+KeyH',
  'Alt+Shift+KeyU',
  'Alt+Shift+KeyM',
  'Alt+Shift+KeyP',
  'Alt+Shift+KeyR',
  'Alt+Shift+KeyE',
  'Alt+Shift+KeyD',
  'Alt+Shift+KeyF',
  'Alt+Shift+KeyW',
  'Alt+Shift+KeyB',
  'Alt+Shift+KeyO',
  'Alt+Shift+KeyY',
  'F8',
  'F9',
];

export function suggestChord(taken: Iterable<string> = []): string | null {
  const used = new Set(taken);
  return SUGGESTIONS.find((chord) => !used.has(chord)) ?? null;
}

// ------------------------------------------------------------------ display

const NAMED_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Escape: 'Esc',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** US-layout fallbacks, used only when the keyboard layout map is unavailable. */
const PUNCTUATION: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/**
 * A human label for one key.
 *
 * `layout` is a `navigator.keyboard.getLayoutMap()` result. With it the label is
 * what is printed on the user's own keyboard; without it the US legend is the
 * best guess available.
 */
export function keyLabel(code: string, layout?: Map<string, string> | null): string {
  const named = NAMED_KEYS[code];
  if (named) return named;

  const fromLayout = layout?.get(code);
  if (fromLayout && fromLayout.length <= 2) return fromLayout.toUpperCase();

  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (isFunctionKey(code)) return code;
  return PUNCTUATION[code] ?? code;
}

export interface LabelOptions {
  /** Renders Meta as ⌘ and orders modifiers the way macOS writes them. */
  mac?: boolean;
  layout?: Map<string, string> | null;
}

export function formatChord(chord: Chord, options: LabelOptions = {}): string {
  const { mac = false, layout = null } = options;
  const parts: string[] = [];

  if (mac) {
    // macOS convention: Control, Option, Shift, Command, key.
    if (chord.ctrl) parts.push('⌃');
    if (chord.alt) parts.push('⌥');
    if (chord.shift) parts.push('⇧');
    if (chord.meta) parts.push('⌘');
    return parts.join('') + keyLabel(chord.code, layout);
  }

  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Meta');
  parts.push(keyLabel(chord.code, layout));
  return parts.join('+');
}

/** Formats a stored chord string, returning it unchanged if it will not parse. */
export function describeShortcut(raw: string, options: LabelOptions = {}): string {
  const chord = parseChord(raw);
  return chord ? formatChord(chord, options) : raw;
}

// ------------------------------------------------------------------ matching

export interface ShortcutBinding {
  actionId: string;
  /** Canonical chord string. */
  chord: string;
}

/**
 * The action bound to this event, if any.
 *
 * Deliberately cheap and allocation-free in the common case: this runs on every
 * keydown on the page, and the overwhelming majority carry no modifier at all.
 */
export function matchBinding(
  bindings: readonly ShortcutBinding[],
  event: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; code: string },
): string | null {
  if (bindings.length === 0) return null;
  if (!event.ctrlKey && !event.altKey && !event.metaKey && !isFunctionKey(event.code)) return null;
  if (isModifierCode(event.code)) return null;

  const serialized = serializeChord(chordFromEvent(event));
  for (const binding of bindings) {
    if (binding.chord === serialized) return binding.actionId;
  }
  return null;
}

/**
 * Parses what `chrome.commands.getAll()` reports into canonical chords, so the
 * options page can refuse a binding the extension's own global command already
 * owns. Best effort: an unparseable entry is dropped rather than guessed at.
 */
export function parseCommandShortcut(shortcut: string): string | null {
  const trimmed = shortcut.trim();
  if (!trimmed) return null;

  const chord: Chord = { ctrl: false, alt: false, shift: false, meta: false, code: '' };
  // Chrome writes these with "+" on Windows and Linux, and as bare glyphs on
  // macOS ("⌘⇧K"), so both spellings have to be understood.
  const parts = trimmed.includes('+') ? trimmed.split('+') : [...trimmed];

  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    switch (part) {
      case 'Ctrl':
      case 'Control':
      case '⌃':
        chord.ctrl = true;
        continue;
      case 'Alt':
      case 'Option':
      case '⌥':
        chord.alt = true;
        continue;
      case 'Shift':
      case '⇧':
        chord.shift = true;
        continue;
      case 'Command':
      case 'MacCtrl':
      case 'Meta':
      case '⌘':
        chord.meta = true;
        continue;
      default:
        break;
    }

    if (/^[A-Za-z]$/.test(part)) chord.code = `Key${part.toUpperCase()}`;
    else if (/^[0-9]$/.test(part)) chord.code = `Digit${part}`;
    else if (isFunctionKey(part)) chord.code = part;
    else if (NAMED_KEYS[part]) chord.code = part;
    else return null;
  }

  return chord.code ? serializeChord(chord) : null;
}
