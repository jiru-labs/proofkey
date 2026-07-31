import { diffWords } from '../core/diff';

/**
 * Reading text out of a page and writing it back is the part that breaks
 * extensions. Three rules here:
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
 *
 * 3. In rich text, replace only what changed. Selecting a whole block and
 *    inserting a flat string deletes every tag inside it — bold, links, list
 *    structure. Diffing the rewrite against the original and rewriting just the
 *    changed words leaves the surrounding markup untouched.
 */

type TextInput = HTMLInputElement | HTMLTextAreaElement;

export type EditTarget =
  | { kind: 'input'; node: TextInput; start: number; end: number; text: string }
  /** Offsets index the flattened text of the editable host, not the DOM. */
  | { kind: 'contenteditable'; node: HTMLElement; start: number; end: number; text: string }
  /** Selected page text we can read but not write back to. */
  | { kind: 'readonly'; text: string };

/** `<input>` types that behave like a text box and expose a selection. */
const TEXTUAL_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', '']);

/** Fields whose contents should never be sent anywhere. */
const SENSITIVE = /password|otp|one-time-code|credit-card|cc-number|new-password|current-password/i;

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
  'TD', 'TH', 'TR', 'UL',
]);

// ------------------------------------------------------------- flattening

interface Chunk {
  node: Text;
  start: number;
  end: number;
}

interface FlatText {
  text: string;
  chunks: Chunk[];
}

/**
 * Concatenates the editable's text nodes into one string, remembering where
 * each came from, so a plain-text offset can be turned back into a DOM Range.
 * Block boundaries and `<br>` become newlines; those positions belong to no
 * text node and are therefore not editable targets.
 */
function flatten(root: HTMLElement): FlatText {
  const chunks: Chunk[] = [];
  let text = '';

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = (node as Text).data;
      if (!value) continue;
      chunks.push({ node: node as Text, start: text.length, end: text.length + value.length });
      text += value;
      continue;
    }

    const element = node as Element;
    if (element.tagName === 'BR') {
      text += '\n';
    } else if (BLOCK_TAGS.has(element.tagName) && text.length > 0 && !text.endsWith('\n')) {
      text += '\n';
    }
  }

  return { text, chunks };
}

function locate(flat: FlatText, offset: number): { node: Text; offset: number } | null {
  for (const chunk of flat.chunks) {
    if (offset >= chunk.start && offset <= chunk.end) {
      return { node: chunk.node, offset: offset - chunk.start };
    }
  }
  return null;
}

function rangeFor(flat: FlatText, start: number, end: number): Range | null {
  const from = locate(flat, start);
  const to = locate(flat, end);
  if (!from || !to) return null;

  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return null;
  }
  return range;
}

function offsetOfPoint(flat: FlatText, node: Node, offset: number): number | null {
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const chunk = flat.chunks.find((candidate) => candidate.node === node);
  return chunk ? chunk.start + Math.min(offset, chunk.node.data.length) : null;
}

// ------------------------------------------------------------------ read

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
      if (
        active.selectionStart !== null &&
        active.selectionEnd !== null &&
        active.selectionStart !== active.selectionEnd
      ) {
        start = active.selectionStart;
        end = active.selectionEnd;
      }
    } catch {
      // Some input types throw on selection access; the whole value is fine.
    }

    return { kind: 'input', node: active, start, end, text: active.value.slice(start, end) };
  }

  const selection = window.getSelection();

  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    const host = closestEditableHost(range.commonAncestorContainer);

    if (host) {
      if (isSensitive(host)) return null;
      const flat = flatten(host);
      const start = offsetOfPoint(flat, range.startContainer, range.startOffset);
      const end = offsetOfPoint(flat, range.endContainer, range.endOffset);

      // A selection whose endpoints are not plain text (across elements, say)
      // cannot be mapped reliably — treat it as the whole field instead.
      return start !== null && end !== null && start < end
        ? { kind: 'contenteditable', node: host, start, end, text: flat.text.slice(start, end) }
        : { kind: 'contenteditable', node: host, start: 0, end: flat.text.length, text: flat.text };
    }

    // A selection outside any editor: readable, but there is nothing to write to.
    return { kind: 'readonly', text: selection.toString() };
  }

  if (active instanceof HTMLElement && active.isContentEditable) {
    if (isSensitive(active)) return null;
    const flat = flatten(active);
    return { kind: 'contenteditable', node: active, start: 0, end: flat.text.length, text: flat.text };
  }

  return null;
}

function closestEditableHost(node: Node): HTMLElement | null {
  const start = node instanceof HTMLElement ? node : node.parentElement;
  const host = start?.closest<HTMLElement>('[contenteditable]');
  return host?.isContentEditable ? host : null;
}

// ----------------------------------------------------------------- write

/** Returns false when the text could not be written, so the caller can fall back. */
export function applyToTarget(target: EditTarget, text: string): boolean {
  if (target.kind === 'readonly') return false;
  if (target.kind === 'input') return applyToInput(target.node, target.start, target.end, text);
  return applyToContentEditable(target, text);
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

/**
 * Applies the rewrite as a series of small edits rather than one block
 * replacement, so formatting outside the changed words survives.
 */
function applyToContentEditable(
  target: Extract<EditTarget, { kind: 'contenteditable' }>,
  replacement: string,
): boolean {
  const { node, start, end } = target;
  node.focus();

  const selection = window.getSelection();
  if (!selection) return false;

  const flat = flatten(node);
  const original = flat.text.slice(start, end);
  const changes = diffWords(original, replacement);

  if (changes === null) return replaceWholeRange(node, selection, start, end, replacement);
  if (changes.length === 0) return true;

  // Applied last-first: every edit shifts the text after it, so working
  // backwards keeps the remaining offsets valid against the original.
  for (const change of [...changes].reverse()) {
    // Re-flattened each time because insertText splits and merges text nodes.
    const current = flatten(node);
    const range = rangeFor(current, start + change.start, start + change.end);
    if (!range) return replaceWholeRange(node, selection, start, end, replacement);

    selection.removeAllRanges();
    selection.addRange(range);

    const applied = change.replacement
      ? document.execCommand('insertText', false, change.replacement)
      : document.execCommand('delete');

    if (!applied) return replaceWholeRange(node, selection, start, end, replacement);
  }

  return true;
}

/** Last resort: one flat replacement, which loses formatting inside the range. */
function replaceWholeRange(
  node: HTMLElement,
  selection: Selection,
  start: number,
  end: number,
  text: string,
): boolean {
  const range = rangeFor(flatten(node), start, end);
  if (!range) return false;

  selection.removeAllRanges();
  selection.addRange(range);

  if (document.execCommand('insertText', false, text)) return true;

  // Some editors block execCommand but must handle paste, since a user can
  // always paste. Returning false from dispatchEvent means it was handled.
  const transfer = new DataTransfer();
  transfer.setData('text/plain', text);
  return !node.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
  );
}
