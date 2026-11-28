import { diffWords, type Change } from '../core/diff';

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
 *    changed span leaves the surrounding markup untouched.
 *
 * 4. One action, one undo. Every `execCommand` is its own undo transaction, so
 *    an edit issued as N commands costs N presses of Ctrl+Z to take back. The
 *    user pressed one shortcut and expects one undo to restore what they wrote.
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
const SENSITIVE =
  /password|passwd|passcode|passphrase|otp|one-time-code|credit-card|cc-number|cc-csc|cc-exp|cvv|cvc|new-password|current-password|secret|api[-_]?key/i;

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

export interface FlatText {
  text: string;
  chunks: Chunk[];
  /**
   * Non-editable islands (mention chips, embeds) as [start, end) spans of
   * `text`. Their text is kept — the model must see "I talked to @Ana" — but
   * no chunk covers it, so no range endpoint can land inside one.
   */
  islands: { start: number; end: number }[];
}

/**
 * Concatenates the editable's text nodes into one string, remembering where
 * each came from, so a plain-text offset can be turned back into a DOM Range.
 * Block boundaries and `<br>` become newlines; those positions belong to no
 * text node and are therefore not editable targets.
 */
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

export function flatten(root: HTMLElement): FlatText {
  const chunks: Chunk[] = [];
  const islands: { start: number; end: number }[] = [];
  let text = '';
  // The outermost non-editable island being walked through, if any. Its text
  // stays in `text` but gets no chunk, so no surgical range can start or end
  // inside the chip. Nested `contenteditable="false"` elements belong to the
  // outermost one.
  let island: Element | null = null;
  let islandStart = 0;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        // Skip non-content / Slate sentinel nodes outright: their text is
        // never part of the field. A `contenteditable="false"` island is
        // handled in the loop below, which keeps its text but no chunks.
        if (SKIPPED_TAGS.has(el.tagName) || el.hasAttribute('data-slate-zero-width')) {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    // The walker yields the island and then its subtree in order, so the
    // first node it yields outside it ends the island.
    if (island && !island.contains(node)) {
      islands.push({ start: islandStart, end: text.length });
      island = null;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const value = (node as Text).data;
      if (!value) continue;
      if (!island) chunks.push({ node: node as Text, start: text.length, end: text.length + value.length });
      text += value;
      continue;
    }

    const element = node as Element;
    if (!island && element.getAttribute('contenteditable') === 'false') {
      island = element;
      islandStart = text.length;
    }
    if (element.tagName === 'BR') {
      // Lexical manages its own line breaks; counting the placeholder it draws
      // puts phantom newlines into flat text.
      if (element.hasAttribute('data-lexical-managed-linebreak')) continue;
      // A trailing placeholder <br> only pads a block that already has text:
      // `<div>text<br></div>` is one line, not two. When the block is
      // otherwise empty the break IS the line — Gmail's `<div><br></div>`
      // between two paragraphs is a blank line the model has to see too.
      const block = element.parentElement;
      const trailing =
        element.classList.contains('ProseMirror-trailingBreak') ||
        (element.nextSibling === null && block !== null && BLOCK_TAGS.has(block.tagName));
      if (trailing && (block?.textContent ?? '').trim() !== '') continue;
      text += '\n';
    } else if (BLOCK_TAGS.has(element.tagName) && text.length > 0 && !text.endsWith('\n')) {
      text += '\n';
    }
  }
  if (island) islands.push({ start: islandStart, end: text.length });

  return { text, chunks, islands };
}

function locate(flat: FlatText, offset: number, affinity: 'start' | 'end' = 'start'): { node: Text; offset: number } | null {
  let fallback: { node: Text; offset: number } | null = null;
  for (const chunk of flat.chunks) {
    if (offset < chunk.start || offset > chunk.end) continue;
    const hit = { node: chunk.node, offset: offset - chunk.start };
    // Prefer the interior of the chunk matching the endpoint's direction so a
    // range starting right after `<strong>foo</strong>` lands in `"bar"` rather
    // than at the end of `<strong>`, which would leak bold onto plain text.
    if (affinity === 'start' && offset < chunk.end) return hit;
    if (affinity === 'end' && offset > chunk.start) return hit;
    fallback ??= hit;
  }
  return fallback;
}

export function rangeFor(flat: FlatText, start: number, end: number): Range | null {
  const collapsed = start === end;
  const from = locate(flat, start, 'start');
  const to = collapsed ? from : locate(flat, end, 'end');
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

export function offsetOfPoint(flat: FlatText, node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const chunk = flat.chunks.find((candidate) => candidate.node === node);
    return chunk ? chunk.start + Math.min(offset, chunk.node.data.length) : null;
  }

  // An element point means "before child N of this element", and it is what a
  // browser reports whenever a selection crosses a block boundary — triple-
  // clicking one paragraph of an email gives exactly that. Returning null here
  // made `readTarget` treat the selection as unmappable and fall back to the
  // whole field, so selecting one paragraph and running an action silently
  // rewrote every paragraph. Resolve the point instead.
  const children = [...node.childNodes];

  // Forwards from the point: the first text this position sits before.
  for (const child of children.slice(offset)) {
    const chunk = flat.chunks.find((c) => child === c.node || child.contains(c.node));
    if (chunk) return chunk.start;
  }

  // Nothing textual after it, so the point is at the end of this element's text.
  const last = flat.chunks.filter((c) => node.contains(c.node)).at(-1);
  return last ? last.end : null;
}

// ------------------------------------------------------------------ read

/** `document.activeElement` stops at a shadow boundary; walk through it. */
export function deepActiveElement(): Element | null {
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

export function isSensitive(node: Element): boolean {
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
    const host = outermostEditableHost(active);
    if (!host || isSensitive(host)) return null;
    const flat = flatten(host);
    return { kind: 'contenteditable', node: host, start: 0, end: flat.text.length, text: flat.text };
  }

  return null;
}

/** Walks up to the outermost contiguous `isContentEditable` host around `node`. */
export function outermostEditableHost(node: Node): HTMLElement | null {
  let current: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
  while (current && !current.isContentEditable) current = current.parentElement;
  if (!current) return null;
  while (current.parentElement?.isContentEditable) current = current.parentElement;
  return current;
}

function closestEditableHost(node: Node): HTMLElement | null {
  return outermostEditableHost(node);
}

// ----------------------------------------------------------------- write

/**
 * Whether the field still holds the text this target was built from.
 *
 * Every write below indexes the field by offsets captured earlier — when a
 * suggestion card was rendered, or when Ctrl+Shift+K read the selection. The
 * user can move the text out from under them in the meantime by pasting,
 * undoing, or typing one more character, and writing anyway puts the
 * replacement over whatever happens to occupy those offsets now. A card left
 * open over a pasted-over field did exactly that: Apply turned "at noon" into
 * "at noI", because the offsets still pointed at where "ai" used to be.
 *
 * `target.text` has always carried the expectation. Nothing checked it.
 */
export function targetIsCurrent(target: EditTarget): boolean {
  if (target.kind === 'readonly') return false;
  const current = target.kind === 'input' ? target.node.value : flatten(target.node).text;
  return current.slice(target.start, target.end) === target.text;
}

/** Returns false when the text could not be written, so the caller can fall back. */
export async function applyToTarget(target: EditTarget, text: string): Promise<boolean> {
  if (target.kind === 'readonly') return false;
  if (!targetIsCurrent(target)) return false;
  if (target.kind === 'input') return applyToInput(target.node, target.start, target.end, text);
  return applyToContentEditable(target, text);
}

/**
 * Waits for the editor to actually commit an edit.
 *
 * Frameworks queue DOM updates: Lexical (WhatsApp Web) applies `execCommand`
 * through its own model and flushes later. Reading the DOM straight after the
 * command shows the *previous* state, so a synchronous check passes no matter
 * how wrong the edit was. Two frames covers a microtask flush and the render
 * that follows it.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function applyToInput(node: TextInput, start: number, end: number, text: string): boolean {
  const before = node.value;
  const expected = before.slice(0, start) + text + before.slice(end);
  const { scrollTop, scrollLeft } = node;
  node.focus({ preventScroll: true });
  try {
    node.setSelectionRange(start, end);
  } catch {
    return false;
  }

  const applied = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
  if (applied && node.value === expected) {
    node.scrollTop = scrollTop;
    node.scrollLeft = scrollLeft;
    return true;
  }
  // If execCommand mutated the value into something unexpected (e.g. maxLength
  // truncation or a framework interceptor), do not write a second time on top.
  if (node.value !== before) return false;

  // execCommand is refused in a few editors. Fall back to the prototype setter,
  // which is what React's own value tracker reads, then announce the change.
  const prototype =
    node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) return false;

  setter.call(node, expected);
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
  try {
    node.setSelectionRange(start + text.length, start + text.length);
  } catch {
    /* ignore */
  }
  node.scrollTop = scrollTop;
  node.scrollLeft = scrollLeft;
  return node.value === expected;
}

/**
 * Applies the rewrite to the smallest region that changed, so formatting outside
 * it survives — but never trusts that it worked.
 *
 * Where it costs nothing, that region is one edit rather than one per changed
 * word, because every `execCommand` is a separate undo transaction. Four changed
 * words meant four presses of Ctrl+Z to take back a single shortcut, and five
 * when the surgical attempt was abandoned partway and the atomic replacement
 * landed on top of the edits already made. Reported from WhatsApp Web, where a
 * plain-text message is the whole field and collapsing is always free.
 *
 * It is only free when the span holds no markup of its own — replacing a range
 * containing a `<strong>` with a flat string deletes it. Where it does, the edits
 * stay separate and the extra presses come back with them. Costing the user their
 * bold to save a keystroke is the wrong way round.
 *
 * Framework-managed editors keep their own selection and document model. Lexical
 * (WhatsApp Web) and its relatives may apply an edit at the caret they remember
 * rather than the range we set, so text lands in the wrong place and nothing is
 * deleted — the text turns to noise. Because that cannot be detected up front,
 * every edit is verified against the text it should have produced, and the moment
 * reality diverges the surgical path is abandoned for one atomic replacement
 * whose result is checked too.
 *
 * The trade is deliberate: on a cooperative editor formatting is preserved, and
 * on a hostile one formatting is lost but the text is right. Wrong text is never
 * an acceptable outcome.
 */
async function applyToContentEditable(
  target: Extract<EditTarget, { kind: 'contenteditable' }>,
  replacement: string,
): Promise<boolean> {
  const { node, start, end } = target;
  node.focus();

  const selection = window.getSelection();
  if (!selection) return false;

  const before = flatten(node).text;
  const original = before.slice(start, end);
  if (sameText(original, replacement)) return true;

  const changes = diffWords(original, replacement);
  // What the whole field must read afterwards. The surgical paths are judged
  // against all of it, not only the span they touched: an editor can put text
  // somewhere nobody asked it to, and a check that only reads the span misses it.
  const expected = before.slice(0, start) + replacement + before.slice(end);

  if (changes && changes.length > 0) {
    const span = changedSpan(changes, original, replacement);
    const flat = flatten(node);

    if (span && spanIsFlat(flat, start + span.start, start + span.end)) {
      const outcome = await applyOneEdit(node, selection, start, original, span, expected);
      if (outcome !== 'fallback') return outcome === 'applied';
    } else if (changes.length <= MAX_SURGICAL_EDITS) {
      // Each surgical edit is a chance for an editor to place text somewhere we
      // did not ask for. A handful is worth the formatting it preserves; fifteen
      // is not, and a rewrite that large has usually restructured the text anyway.
      const outcome = await applyChanges(node, selection, start, original, changes, expected);
      if (outcome !== 'fallback') return outcome === 'applied';
    }
  }

  // Recomputed from the original text, so it is correct no matter how far the
  // surgical attempt got before it was abandoned.
  return replaceEverything(node, selection, expected);
}

const MAX_SURGICAL_EDITS = 4;

/**
 * Text equality as the user sees it, which is not codepoint equality.
 *
 * Browsers substitute U+00A0 for a space when an edit would otherwise leave one
 * collapsing at an element boundary: replacing "show" in
 * `<strong>report</strong> show` yields `report&nbsp;shows`. Nothing about the
 * rendered text changed, but an exact comparison reads it as corruption and
 * throws away a perfectly good edit. That is what sent the whole-field rewrite
 * down to `replaceEverything`, which then took the bold with it — the check
 * meant to protect the text was destroying the formatting instead.
 */
function sameText(a: string, b: string): boolean {
  return a.replace(/\u00a0/g, ' ') === b.replace(/\u00a0/g, ' ');
}

interface EditSpan {
  /** Offsets into the original text of the target range. */
  start: number;
  end: number;
  /** What that span becomes. Empty means the span is deleted outright. */
  text: string;
}

/**
 * The one contiguous edit that turns `original` into `replacement`: from the
 * start of the first change to the end of the last.
 *
 * Word-aligned, because the bounds come from `diffWords` rather than from a raw
 * character prefix/suffix scan. A character-tight span would be smaller but
 * could open mid-word, and half a word replaced mid-token is exactly where
 * framework editors misplace text.
 */
function changedSpan(changes: Change[], original: string, replacement: string): EditSpan | null {
  const first = changes[0]!;
  const last = changes[changes.length - 1]!;

  const suffixLength = original.length - last.end;
  const textEnd = replacement.length - suffixLength;
  if (textEnd < first.start) return null;

  return { start: first.start, end: last.end, text: replacement.slice(first.start, textEnd) };
}

/**
 * How a surgical attempt ended.
 *
 * `abort` means the field no longer matches what we read — a re-check of the
 * span failed, or the change would reach into an island — and nothing more may
 * be written: the whole-field fallback was computed from the earlier read, and
 * writing it would destroy whatever the user did in the meantime. `fallback`
 * means the attempt is ours to recover from — `execCommand` was refused, or
 * our own edits produced a field we did not expect — and the atomic
 * replacement may run.
 */
type SurgicalOutcome = 'applied' | 'fallback' | 'abort';

/** Whether [from, to) reaches into any non-editable island of the field. */
function crossesIsland(flat: FlatText, from: number, to: number): boolean {
  return flat.islands.some((island) => from < island.end && to > island.start);
}

/**
 * Whether replacing [from, to) with a flat string would cost any markup.
 *
 * True when every text node the span touches shares one parent, so there is no
 * element boundary inside it to lose. Conservative on purpose: two text nodes
 * under different parents may well carry identical formatting, but proving that
 * is guesswork and being wrong costs the user their bold. Guessing wrong the
 * other way only costs a second press of Ctrl+Z.
 */
function spanIsFlat(flat: FlatText, from: number, to: number): boolean {
  // A span reaching into an island has no chunks to write through, and an
  // insertText across one flattens the chip into plain text. The multi-edit
  // path refuses the change instead.
  if (crossesIsland(flat, from, to)) return false;

  const covered = flat.chunks.filter((chunk) => chunk.end > from && chunk.start < to);
  if (covered.length === 0) return false;

  const parent = covered[0]!.node.parentElement;
  return parent !== null && covered.every((chunk) => chunk.node.parentElement === parent);
}

/** Returns `abort` the moment the document stops matching what we expect. */
async function applyOneEdit(
  node: HTMLElement,
  selection: Selection,
  start: number,
  original: string,
  span: EditSpan,
  expected: string,
): Promise<SurgicalOutcome> {
  const flat = flatten(node);
  const from = start + span.start;
  const to = start + span.end;

  if (!sameText(flat.text.slice(from, to), original.slice(span.start, span.end))) return 'abort';

  const range = rangeFor(flat, from, to);
  // No range even though the text matches — the field has moved in a way
  // offsets cannot follow, so nothing may be written at them.
  if (!range) return 'abort';

  selection.removeAllRanges();
  selection.addRange(range);

  // Same reason `replaceEverything` waits: an editor that keeps its own
  // selection hears about this one through an asynchronously dispatched
  // `selectionchange`, and inserting before it arrives writes at the caret the
  // editor still believes in.
  await settle();
  // Re-verify after waiting: user typing during the two-frame settle must not
  // be overwritten.
  if (!sameText(flatten(node).text.slice(from, to), original.slice(span.start, span.end))) return 'abort';

  const applied = span.text
    ? document.execCommand('insertText', false, span.text)
    : document.execCommand('delete');
  if (!applied) return 'fallback';

  // Without this the check below reads pre-edit DOM and passes vacuously.
  await settle();

  return sameText(flatten(node).text, expected) ? 'applied' : 'fallback';
}

/** Returns `abort` the moment the document stops matching what we expect. */
async function applyChanges(
  node: HTMLElement,
  selection: Selection,
  start: number,
  original: string,
  changes: Change[],
  expected: string,
): Promise<SurgicalOutcome> {
  // Checked up front, before any edit goes in: a change reaching into an
  // island would flatten the chip, and applying the changes before it would
  // leave the field half-rewritten.
  const initial = flatten(node);
  if (changes.some((change) => crossesIsland(initial, start + change.start, start + change.end))) {
    return 'abort';
  }

  // A change that touches no text of its own — a paragraph break between two
  // blocks — or whose replacement carries a line break cannot be written by
  // one `insertText`: the command drops line breaks, and the range it needs
  // spans the blocks themselves. Attempting it wrecks the very structure it is
  // rewriting, so hand the whole run to the atomic path, which can express
  // line breaks.
  // An insertion is zero-width: it overlaps no chunk, but it is writable when
  // it sits in or at the edge of one ("done" → "done now" at the field's end).
  const writable = (change: Change): boolean => {
    if (change.replacement.includes('\n')) return false;
    const from = start + change.start;
    const to = start + change.end;
    return initial.chunks.some((chunk) =>
      from === to ? chunk.start <= from && from <= chunk.end : chunk.end > from && chunk.start < to,
    );
  };
  if (!changes.every(writable)) return 'fallback';

  let delta = 0;

  for (const change of changes) {
    // Re-read every time: insertText splits and merges text nodes, and a
    // framework editor may have rebuilt the subtree entirely.
    const flat = flatten(node);
    const from = start + change.start + delta;
    const to = start + change.end + delta;

    if (!sameText(flat.text.slice(from, to), original.slice(change.start, change.end))) return 'abort';

    const range = rangeFor(flat, from, to);
    if (!range) return 'abort';

    selection.removeAllRanges();
    selection.addRange(range);
    // Let framework editors sync their internal selection before execCommand.
    await settle();
    if (!sameText(flatten(node).text.slice(from, to), original.slice(change.start, change.end))) return 'abort';

    const applied = change.replacement
      ? document.execCommand('insertText', false, change.replacement)
      : document.execCommand('delete');
    if (!applied) return 'fallback';

    // Without this the next check reads pre-edit DOM and passes vacuously.
    await settle();

    delta += change.replacement.length - (change.end - change.start);
  }

  // The whole field, because this is where Lexical goes wrong: in a message
  // ending on Shift+Enter, the second of two edits also wrote the first one's
  // text onto the empty last line. Every span read back correctly, so the old
  // check — the span alone — passed with a stray word at the end.
  return sameText(flatten(node).text, expected) ? 'applied' : 'fallback';
}

/**
 * One atomic replacement of the whole field. `selectAll` is issued as an editing
 * command rather than by setting a DOM range, because that is the path a user's
 * own Ctrl+A takes and therefore the one a framework editor keeps in sync with
 * its internal model.
 */
async function replaceEverything(
  node: HTMLElement,
  selection: Selection,
  text: string,
): Promise<boolean> {
  node.focus();
  const flat = flatten(node);

  // A flat write turns every island in the field — the mention chip, the date
  // embed — into plain text. Refuse the whole-field write while one is there
  // and let the caller say so.
  if (flat.islands.length > 0) return false;
  const before = flat.text;

  if (!document.execCommand('selectAll')) {
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // An editor that keeps its own selection learns about this one from a
  // `selectionchange` event, which is dispatched asynchronously. Inserting
  // immediately means it still believes the caret is where it last left it,
  // and the replacement lands there instead of over the selection.
  await settle();

  // Line breaks do not survive `execCommand('insertText')` in Lexical: it took
  // "one\ntwo" and wrote "onetwo", so a rewrite of a multi-line WhatsApp message
  // came back as one run-on line. Offered as the `beforeinput` a browser's own
  // spelling replacement sends, Lexical builds real line breaks in its model.
  // (As `insertText` it kept the text but put the newlines inside one text node;
  // as `insertFromPaste` it claimed the event and wrote nothing.) An editor that
  // ignores the event leaves it unhandled, and the paths below still run.
  if (text.includes('\n')) {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', text);
    const offer = new InputEvent('beforeinput', {
      inputType: 'insertReplacementText',
      dataTransfer: transfer,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    node.dispatchEvent(offer);
    if (offer.defaultPrevented) {
      await settle();
      const after = flatten(node).text;
      if (sameContent(after, text)) return true;
      if (after !== before) return false;
    }
  }

  if (document.execCommand('insertText', false, text)) {
    await settle();
    const after = flatten(node).text;
    if (sameContent(after, text)) return true;

    // The editor took the insert and wrote something else. Pasting now lands on
    // top of what it wrote: on playground.lexical.dev on 2026-09-16 a model's
    // two trailing spaces per line moved every line break, the comparison
    // failed, and the paste put the whole document in the field a second time.
    // So stop here and report it; the caller tells the user to look the text
    // over. Not `execCommand('undo')`: tried the same day on the harness's
    // Lexical, it left the field as it was, and nothing says which entry of an
    // editor's history an undo takes back.
    if (after !== before) return false;
  }

  // Editors that block execCommand still have to accept a paste, since a user
  // can always paste. A handled event returns false from dispatchEvent.
  const transfer = new DataTransfer();
  transfer.setData('text/plain', text);
  node.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
  );
  await settle();

  return sameContent(flatten(node).text, text);
}

/**
 * Equal once spaces at the ends of lines are set aside. Editors drop them —
 * Lexical does — and a reader sees the same text either way; everything else,
 * line breaks included, still has to match.
 */
function sameContent(a: string, b: string): boolean {
  const tidy = (text: string): string =>
    text.replace(/\u00a0/g, ' ').replace(/[ \t]+(?=\n|$)/g, '').trim();
  return tidy(a) === tidy(b);
}
