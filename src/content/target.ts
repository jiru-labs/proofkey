/**
 * Reading text out of a page and writing it back is the part that breaks
 * extensions. Two rules here:
 *
 * 1. Never assign `.value` directly. Frameworks that control an input track the
 *    value on their own instance; a raw assignment updates the DOM and is then
 *    reverted on the next render. `execCommand('insertText')` goes through the
 *    browser's own editing path, which fires the events frameworks listen for
 *    and — just as importantly — leaves the user's undo history intact.
 *
 * 2. Never mutate the DOM of a rich text editor. Slate, ProseMirror, Lexical and
 *    Quill all reconcile against their own model and will fight or crash. The
 *    same `insertText` path is what a keystroke would have done, so they accept it.
 */

type TextInput = HTMLInputElement | HTMLTextAreaElement;

export type EditTarget =
  | { kind: 'input'; node: TextInput; start: number; end: number; text: string }
  | { kind: 'contenteditable'; node: HTMLElement; range: Range; text: string }
  /** Selected page text we can read but not write back to. */
  | { kind: 'readonly'; text: string };

/** `<input>` types that behave like a text box and expose a selection. */
const TEXTUAL_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', '']);

/** Fields whose contents should never be sent anywhere. */
const SENSITIVE = /password|otp|one-time-code|credit-card|cc-number|new-password|current-password/i;

/** `document.activeElement` stops at a shadow boundary; walk through it. */
function deepActiveElement(): Element | null {
  let node = document.activeElement;
  while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
  return node;
}

function isTextInput(node: Element | null): node is TextInput {
  if (node instanceof HTMLTextAreaElement) return !node.readOnly && !node.disabled;
  if (!(node instanceof HTMLInputElement)) return false;
  if (node.readOnly || node.disabled) return false;
  return TEXTUAL_INPUT_TYPES.has(node.type.toLowerCase());
}

function isSensitive(node: Element): boolean {
  if (node instanceof HTMLInputElement && node.type.toLowerCase() === 'password') return true;
  const signals = [
    node.getAttribute('autocomplete'),
    node.getAttribute('name'),
    node.id,
    node.getAttribute('aria-label'),
  ]
    .filter(Boolean)
    .join(' ');
  return SENSITIVE.test(signals);
}

/**
 * What the user means by "this text": their selection if they made one,
 * otherwise the whole field they are working in.
 */
export function readTarget(): EditTarget | null {
  const active = deepActiveElement();

  if (active && isTextInput(active)) {
    if (isSensitive(active)) return null;

    let start = 0;
    let end = active.value.length;
    try {
      if (active.selectionStart !== null && active.selectionEnd !== null) {
        if (active.selectionStart !== active.selectionEnd) {
          start = active.selectionStart;
          end = active.selectionEnd;
        }
      }
    } catch {
      // Some input types throw on selection access; the whole value is fine.
    }

    return { kind: 'input', node: active, start, end, text: active.value.slice(start, end) };
  }

  const selection = window.getSelection();
  const editableHost = active instanceof HTMLElement && active.isContentEditable ? active : null;

  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    const host = closestEditableHost(range.commonAncestorContainer);
    if (host) {
      if (isSensitive(host)) return null;
      return { kind: 'contenteditable', node: host, range: range.cloneRange(), text: selection.toString() };
    }
    // A selection outside any editor: readable, but there is nothing to write to.
    return { kind: 'readonly', text: selection.toString() };
  }

  if (editableHost) {
    if (isSensitive(editableHost)) return null;
    const range = document.createRange();
    range.selectNodeContents(editableHost);
    return {
      kind: 'contenteditable',
      node: editableHost,
      range,
      text: editableHost.innerText,
    };
  }

  return null;
}

function closestEditableHost(node: Node): HTMLElement | null {
  const start = node instanceof HTMLElement ? node : node.parentElement;
  const host = start?.closest<HTMLElement>('[contenteditable]');
  return host?.isContentEditable ? host : null;
}

/** Returns false when the text could not be written, so the caller can fall back. */
export function applyToTarget(target: EditTarget, text: string): boolean {
  if (target.kind === 'readonly') return false;
  if (target.kind === 'input') return applyToInput(target.node, target.start, target.end, text);
  return applyToContentEditable(target.node, target.range, text);
}

function applyToInput(node: TextInput, start: number, end: number, text: string): boolean {
  node.focus();
  try {
    node.setSelectionRange(start, end);
  } catch {
    return false;
  }

  if (document.execCommand('insertText', false, text)) return true;

  // execCommand is refused in a few editors. Fall back to the prototype setter,
  // which is what React's own value tracker reads, then announce the change.
  const prototype =
    node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) return false;

  const next = node.value.slice(0, start) + text + node.value.slice(end);
  setter.call(node, next);
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
  node.setSelectionRange(start + text.length, start + text.length);
  return true;
}

function applyToContentEditable(node: HTMLElement, range: Range, text: string): boolean {
  node.focus();

  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);

  if (document.execCommand('insertText', false, text)) return true;

  // Last resort for editors that block execCommand: a synthetic paste, which
  // most of them handle because it is a path they must support anyway.
  const transfer = new DataTransfer();
  transfer.setData('text/plain', text);
  return !node.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
  );
}
