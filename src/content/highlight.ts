import type { Suggestion } from '../core/types';
import { flatten, rangeFor, type FlatText } from './target';

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
  render(suggestions: Suggestion[], flat?: FlatText): void;
  clear(): void;
  /** Viewport rect of a suggestion, for positioning the card. */
  rectFor(id: string): DOMRect | null;
  /** Individual line-box rects of a suggestion, for accurate hit-testing on wrapped text. */
  rectsFor(id: string): DOMRect[];
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
const PAGE_STYLE_ID = 'proofkey-highlight-style';

function ensurePageStyle(): void {
  if (document.getElementById(PAGE_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = PAGE_STYLE_ID;
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
  (document.head ?? document.documentElement).append(style);
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
    render(suggestions, precomputedFlat) {
      clear();
      if (!supportsHighlightApi || suggestions.length === 0) return;
      ensurePageStyle();

      const flat = precomputedFlat ?? flatten(node);
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
    rectsFor(id) {
      const range = ranges.get(id);
      if (!range) return [];
      const rects = [...range.getClientRects()].filter((r) => r.width + r.height > 0);
      if (rects.length > 0) return rects;
      const fallback = range.getBoundingClientRect();
      return fallback.width + fallback.height > 0 ? [fallback] : [];
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
  let stylesDirty = true;

  const isSingleInput = node instanceof HTMLInputElement;

  const syncPosition = () => {
    frame = 0;
    if (!node.isConnected) {
      overlay.style.display = 'none';
      return;
    }
    const rect = node.getBoundingClientRect();

    // A field scrolled out of view, hidden, or detached should draw nothing.
    if (rect.width === 0 || rect.height === 0) {
      overlay.style.display = 'none';
      return;
    }

    let style: CSSStyleDeclaration | null = null;
    if (stylesDirty) {
      style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') {
        overlay.style.display = 'none';
        return;
      }
      overlay.style.borderRadius = style.borderRadius;
      for (const property of MIRRORED_PROPERTIES) {
        content.style[property] = style[property];
      }
      // A textarea wraps; a single-line input never does.
      content.style.whiteSpace = isSingleInput ? 'pre' : 'pre-wrap';
      // A scrollbar takes its width out of the field's text, not out of the
      // mirror's: the lines broke in different places and every underline after
      // the first wrap sat words away from its own (seen in Brave on Windows,
      // 2026-10-04, in a textarea long enough to scroll).
      const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      const scrollbar = Math.max(0, node.offsetWidth - node.clientWidth - Math.round(borders));
      const inner = style.boxSizing === 'border-box'
        ? 0
        : borders + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      content.style.width = `${rect.width - scrollbar - inner}px`;
      content.style.marginLeft = style.direction === 'rtl' && scrollbar > 0 ? `${scrollbar}px` : '';
      stylesDirty = false;
    }

    // Clip against scrolling ancestors so fixed underlines never paint over
    // page headers or modal chrome.
    let clipTop = rect.top;
    let clipRight = rect.right;
    let clipBottom = rect.bottom;
    let clipLeft = rect.left;
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      const aStyle = getComputedStyle(ancestor);
      if (/(auto|scroll|hidden|clip)/.test(`${aStyle.overflowX} ${aStyle.overflowY}`)) {
        const aRect = ancestor.getBoundingClientRect();
        clipTop = Math.max(clipTop, aRect.top);
        clipRight = Math.min(clipRight, aRect.right);
        clipBottom = Math.min(clipBottom, aRect.bottom);
        clipLeft = Math.max(clipLeft, aRect.left);
      }
      ancestor = ancestor.parentElement;
    }
    const visWidth = clipRight - clipLeft;
    const visHeight = clipBottom - clipTop;
    if (visWidth <= 0 || visHeight <= 0) {
      overlay.style.display = 'none';
      return;
    }

    overlay.style.display = isSingleInput ? 'flex' : 'block';
    overlay.style.alignItems = isSingleInput ? 'center' : '';
    overlay.style.left = `${clipLeft}px`;
    overlay.style.top = `${clipTop}px`;
    overlay.style.width = `${visWidth}px`;
    overlay.style.height = `${visHeight}px`;

    const offsetX = rect.left - clipLeft;
    const offsetY = rect.top - clipTop;
    content.style.transform = `translate(${offsetX - node.scrollLeft}px, ${offsetY - node.scrollTop}px)`;
  };

  const schedule = (resyncStyles = false) => {
    if (resyncStyles) stylesDirty = true;
    if (frame === 0) frame = requestAnimationFrame(syncPosition);
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
    schedule(true);
  };

  const onScroll = () => schedule(false);
  const onResize = () => schedule(true);
  node.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('resize', onResize, { passive: true });

  const observer = new ResizeObserver(() => schedule(true));
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
    rectsFor(id) {
      const mark = content.querySelector<HTMLElement>(`[data-pk-id="${CSS.escape(id)}"]`);
      if (!mark) return [];
      const rects = [...mark.getClientRects()].filter((r) => r.width + r.height > 0);
      if (rects.length > 0) return rects;
      const fallback = mark.getBoundingClientRect();
      return fallback.width + fallback.height > 0 ? [fallback] : [];
    },
    destroy() {
      observer.disconnect();
      node.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onResize);
      if (frame) cancelAnimationFrame(frame);
      overlay.remove();
    },
  };
}
