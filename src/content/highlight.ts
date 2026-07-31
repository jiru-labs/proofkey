import type { Suggestion } from '../core/types';
import { flatten, rangeFor } from './target';

/**
 * Two renderers, because the browser gives us two very different surfaces.
 *
 * Rich text uses the CSS Custom Highlight API: ranges are handed to the engine
 * and painted without touching the DOM at all. That matters — wrapping words in
 * `<span>` inside a Slate or ProseMirror document corrupts the editor's model.
 *
 * `<input>` and `<textarea>` cannot style a range at all, so a mirror element is
 * positioned over the field with identical typography and the underlines drawn
 * there. This is the same trick Grammarly uses, and its accuracy depends
 * entirely on copying every property that affects text layout.
 */

export type FieldRef =
  | { kind: 'input'; node: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'contenteditable'; node: HTMLElement };

export interface Highlighter {
  render(suggestions: Suggestion[]): void;
  clear(): void;
  /** Viewport rect of a suggestion, for positioning the card. */
  rectFor(id: string): DOMRect | null;
  destroy(): void;
}

const HIGHLIGHT_NAMES = {
  grammar: 'proofkey-grammar',
  spelling: 'proofkey-spelling',
  style: 'proofkey-style',
} as const;

const supportsHighlightApi =
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

/**
 * Highlight pseudo-elements resolve against the document's own stylesheets, so
 * this one rule has to live in the page rather than in our shadow root. It is
 * scoped to our own highlight names and touches nothing else.
 */
let pageStyleInjected = false;
function ensurePageStyle(): void {
  if (pageStyleInjected) return;
  pageStyleInjected = true;

  const style = document.createElement('style');
  style.id = 'proofkey-highlight-style';
  style.textContent = `
::highlight(${HIGHLIGHT_NAMES.grammar}) {
  text-decoration: underline wavy #d92d20;
  text-decoration-skip-ink: none;
  background-color: rgba(217, 45, 32, 0.08);
}
::highlight(${HIGHLIGHT_NAMES.spelling}) {
  text-decoration: underline wavy #d92d20;
  text-decoration-skip-ink: none;
  background-color: rgba(217, 45, 32, 0.08);
}
::highlight(${HIGHLIGHT_NAMES.style}) {
  text-decoration: underline wavy #2970ff;
  text-decoration-skip-ink: none;
  background-color: rgba(41, 112, 255, 0.08);
}`.trim();
  document.head.append(style);
}

export function createHighlighter(field: FieldRef, shadow: ShadowRoot): Highlighter {
  return field.kind === 'contenteditable'
    ? createRangeHighlighter(field.node)
    : createOverlayHighlighter(field.node, shadow);
}

// -------------------------------------------------- rich text (Highlight API)

function createRangeHighlighter(node: HTMLElement): Highlighter {
  const ranges = new Map<string, Range>();

  function clear(): void {
    ranges.clear();
    if (!supportsHighlightApi) return;
    for (const name of Object.values(HIGHLIGHT_NAMES)) CSS.highlights.delete(name);
  }

  return {
    render(suggestions) {
      clear();
      if (!supportsHighlightApi || suggestions.length === 0) return;
      ensurePageStyle();

      const flat = flatten(node);
      const bySeverity = new Map<string, Range[]>();

      for (const suggestion of suggestions) {
        const range = rangeFor(flat, suggestion.start, suggestion.end);
        if (!range) continue;
        ranges.set(suggestion.id, range);
        const name = HIGHLIGHT_NAMES[suggestion.severity];
        const list = bySeverity.get(name) ?? [];
        list.push(range);
        bySeverity.set(name, list);
      }

      for (const [name, list] of bySeverity) {
        CSS.highlights.set(name, new Highlight(...list));
      }
    },
    clear,
    rectFor(id) {
      const rect = ranges.get(id)?.getBoundingClientRect();
      return rect && rect.width + rect.height > 0 ? rect : null;
    },
    destroy: clear,
  };
}

// --------------------------------------------------- inputs (mirror overlay)

/**
 * Every property here changes where a glyph lands. Missing one puts the
 * underline under the wrong word, which is worse than drawing nothing.
 */
const MIRRORED_PROPERTIES = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
  'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform', 'textIndent',
  'textAlign', 'direction', 'paddingTop', 'paddingRight', 'paddingBottom',
  'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
  'borderLeftWidth', 'boxSizing', 'tabSize', 'wordBreak', 'overflowWrap',
] as const;

function createOverlayHighlighter(
  node: HTMLInputElement | HTMLTextAreaElement,
  shadow: ShadowRoot,
): Highlighter {
  const overlay = document.createElement('div');
  overlay.className = 'pk-overlay';
  const content = document.createElement('div');
  content.className = 'pk-overlay__content';
  overlay.append(content);
  shadow.append(overlay);

  let current: Suggestion[] = [];
  let frame = 0;

  const reposition = () => {
    frame = 0;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);

    // A field scrolled out of view, hidden, or detached should draw nothing.
    if (rect.width === 0 || rect.height === 0 || style.display === 'none') {
      overlay.style.display = 'none';
      return;
    }
    overlay.style.display = 'block';
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.borderRadius = style.borderRadius;

    for (const property of MIRRORED_PROPERTIES) {
      content.style[property] = style[property];
    }
    // A textarea wraps; a single-line input never does.
    content.style.whiteSpace = node instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre';
    content.style.transform = `translate(${-node.scrollLeft}px, ${-node.scrollTop}px)`;
  };

  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(reposition);
  };

  const paint = () => {
    content.replaceChildren();
    const value = node.value;
    let cursor = 0;

    for (const suggestion of current) {
      if (suggestion.start < cursor || suggestion.end > value.length) continue;
      if (value.slice(suggestion.start, suggestion.end) !== suggestion.original) continue;

      content.append(document.createTextNode(value.slice(cursor, suggestion.start)));
      const mark = document.createElement('span');
      mark.className = `pk-u pk-u--${suggestion.severity}`;
      mark.dataset['pkId'] = suggestion.id;
      mark.textContent = suggestion.original;
      content.append(mark);
      cursor = suggestion.end;
    }

    content.append(document.createTextNode(value.slice(cursor)));
    schedule();
  };

  const onScrollOrResize = () => schedule();
  node.addEventListener('scroll', onScrollOrResize, { passive: true });
  window.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true });
  window.addEventListener('resize', onScrollOrResize, { passive: true });

  const observer = new ResizeObserver(schedule);
  observer.observe(node);

  return {
    render(suggestions) {
      current = [...suggestions].sort((a, b) => a.start - b.start);
      paint();
    },
    clear() {
      current = [];
      content.replaceChildren();
    },
    rectFor(id) {
      const mark = content.querySelector<HTMLElement>(`[data-pk-id="${CSS.escape(id)}"]`);
      const rect = mark?.getBoundingClientRect();
      return rect && rect.width + rect.height > 0 ? rect : null;
    },
    destroy() {
      observer.disconnect();
      node.removeEventListener('scroll', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, { capture: true });
      window.removeEventListener('resize', onScrollOrResize);
      if (frame) cancelAnimationFrame(frame);
      overlay.remove();
    },
  };
}
