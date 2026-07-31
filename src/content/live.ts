import { classifyChange, diffWords, type Change } from '../core/diff';
import { askWorker, type CheckResult, type ContentState } from '../core/messages';
import { segment, sentenceAt, sentenceKey } from '../core/sentences';
import type { Suggestion } from '../core/types';
import { createCard, type SuggestionCard } from './card';
import { createHighlighter, type FieldRef, type Highlighter } from './highlight';
import { applyToTarget, flatten, offsetOfPoint } from './target';

/**
 * The as-you-type layer.
 *
 * Cost is the whole design constraint: every check spends the user's own key,
 * so three rules keep requests rare. Checks fire only after typing stops; only
 * sentences whose text changed since the last check are sent; and the sentence
 * the caret sits in is never sent, because a half-typed sentence produces
 * confident nonsense and pays for the privilege.
 *
 * Results are cached by sentence content, so going back to fix paragraph four
 * never re-sends paragraphs one through three.
 */

const TEXTUAL_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', '']);
const MIN_SENTENCE_LENGTH = 4;

interface Session {
  field: FieldRef;
  highlighter: Highlighter;
  /** Sentence content hash -> the edits found in it. Empty array means clean. */
  cache: Map<string, Change[]>;
  suggestions: Suggestion[];
  dismissed: Set<string>;
  timer: number;
  inFlight: boolean;
  dirtyWhileChecking: boolean;
}

export interface LiveController {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  destroy(): void;
}

export function createLive(shadow: ShadowRoot, state: ContentState): LiveController {
  let enabled = state.liveEnabled;
  let session: Session | null = null;
  const dictionary = new Set(state.dictionary.map((word) => word.toLowerCase()));

  const badge = document.createElement('button');
  badge.className = 'pk-badge';
  badge.type = 'button';
  badge.hidden = true;
  shadow.append(badge);

  const card: SuggestionCard = createCard(shadow, {
    apply: (suggestion) => applySuggestion(suggestion),
    dismiss: (suggestion) => {
      session?.dismissed.add(suggestion.id);
      rebuild();
    },
    addToDictionary: (suggestion) => {
      const word = suggestion.original.trim();
      dictionary.add(word.toLowerCase());
      void askWorker({ type: 'proofkey:add-word', word });
      rebuild();
    },
  });

  // ------------------------------------------------------------ field wiring

  function eligible(node: EventTarget | null): FieldRef | null {
    if (node instanceof HTMLTextAreaElement && !node.readOnly && !node.disabled) {
      return { kind: 'input', node };
    }
    if (
      node instanceof HTMLInputElement &&
      !node.readOnly &&
      !node.disabled &&
      TEXTUAL_INPUT_TYPES.has(node.type.toLowerCase()) &&
      node.type.toLowerCase() !== 'password'
    ) {
      return { kind: 'input', node };
    }
    if (node instanceof HTMLElement && node.isContentEditable) {
      return { kind: 'contenteditable', node };
    }
    return null;
  }

  function attach(field: FieldRef): void {
    detach();
    session = {
      field,
      highlighter: createHighlighter(field, shadow),
      cache: new Map(),
      suggestions: [],
      dismissed: new Set(),
      timer: 0,
      inFlight: false,
      dirtyWhileChecking: false,
    };
    field.node.addEventListener('input', onInput);
    schedule();
  }

  function detach(): void {
    if (!session) return;
    clearTimeout(session.timer);
    session.field.node.removeEventListener('input', onInput);
    session.highlighter.destroy();
    session = null;
    card.hide();
    badge.hidden = true;
  }

  const onFocusIn = (event: FocusEvent) => {
    if (!enabled) return;
    const field = eligible(event.target);
    // Focus moving into our own card must not tear the session down.
    if (!field) return;
    if (session && field.node === session.field.node) return;
    attach(field);
  };

  const onInput = () => {
    if (!session) return;
    if (session.inFlight) session.dirtyWhileChecking = true;
    schedule();
  };

  function schedule(): void {
    if (!session) return;
    clearTimeout(session.timer);
    session.timer = window.setTimeout(() => void check(), state.debounceMs);
  }

  // ------------------------------------------------------------- the check

  function fieldText(field: FieldRef): string {
    return field.kind === 'input' ? field.node.value : flatten(field.node).text;
  }

  function caretOffset(field: FieldRef): number {
    if (field.kind === 'input') return field.node.selectionStart ?? -1;
    const selection = window.getSelection();
    if (!selection?.focusNode) return -1;
    if (!field.node.contains(selection.focusNode)) return -1;
    return offsetOfPoint(flatten(field.node), selection.focusNode, selection.focusOffset) ?? -1;
  }

  async function check(): Promise<void> {
    if (!session || session.inFlight) return;
    const active = session;

    const text = fieldText(active.field);
    if (text.trim().length < state.minChars) {
      active.suggestions = [];
      active.highlighter.clear();
      badge.hidden = true;
      return;
    }

    const sentences = segment(text);
    const caretIndex = sentenceAt(sentences, caretOffset(active.field));

    const pending = sentences.filter(
      (sentence, index) =>
        index !== caretIndex &&
        sentence.text.trim().length >= MIN_SENTENCE_LENGTH &&
        !active.cache.has(sentenceKey(sentence.text)),
    );

    if (pending.length === 0) {
      rebuild();
      return;
    }

    const batch = pending.slice(0, state.maxSentencesPerRequest);
    active.inFlight = true;
    setBadge('checking');

    try {
      const result = await askWorker<CheckResult>({
        type: 'proofkey:check',
        sentences: batch.map((sentence) => sentence.text.trim()),
      });

      if (session !== active) return; // focus moved on while we waited

      if (!result.ok) {
        setBadge('error', result.error);
        return;
      }

      batch.forEach((sentence, index) => {
        const corrected = result.value.corrections[index];
        const original = sentence.text.trim();
        const changes =
          corrected === undefined || corrected === original
            ? []
            : (diffWords(original, corrected) ?? []);
        active.cache.set(sentenceKey(sentence.text), changes);
      });

      rebuild();
    } finally {
      if (session === active) {
        active.inFlight = false;
        if (active.dirtyWhileChecking || pending.length > batch.length) {
          active.dirtyWhileChecking = false;
          schedule();
        }
      }
    }
  }

  /** Rebuilds suggestions from the cache against the field's current text. */
  function rebuild(): void {
    if (!session) return;
    const active = session;
    const text = fieldText(active.field);
    const sentences = segment(text);
    const suggestions: Suggestion[] = [];

    for (const sentence of sentences) {
      const key = sentenceKey(sentence.text);
      const changes = active.cache.get(key);
      if (!changes || changes.length === 0) continue;

      // The cache was built from the trimmed sentence; realign to the field.
      const offset = sentence.start + (sentence.text.length - sentence.text.trimStart().length);
      const source = sentence.text.trim();

      changes.forEach((change, index) => {
        const id = `${key}#${index}`;
        if (active.dismissed.has(id)) return;

        const original = source.slice(change.start, change.end);
        if (original.trim() && dictionary.has(original.trim().toLowerCase())) return;

        const start = offset + change.start;
        const end = offset + change.end;
        // Guard against the text having moved since the check.
        if (text.slice(start, end) !== original) return;

        const { category, severity } = classifyChange(change, source);
        suggestions.push({ id, start, end, original, replacement: change.replacement, category, severity });
      });
    }

    active.suggestions = suggestions.sort((a, b) => a.start - b.start);
    active.highlighter.render(active.suggestions);
    setBadge(suggestions.length === 0 ? 'clean' : 'issues');
  }

  // ---------------------------------------------------------------- applying

  function applySuggestion(suggestion: Suggestion): void {
    if (!session) return;
    const active = session;

    const applied = applyToTarget(
      active.field.kind === 'input'
        ? {
            kind: 'input',
            node: active.field.node,
            start: suggestion.start,
            end: suggestion.end,
            text: suggestion.original,
          }
        : {
            kind: 'contenteditable',
            node: active.field.node,
            start: suggestion.start,
            end: suggestion.end,
            text: suggestion.original,
          },
      suggestion.replacement,
    );
    if (!applied) return;

    active.dismissed.add(suggestion.id);
    // The corrected sentence hashes differently, so it would be re-sent on the
    // next pass. Record it as clean instead.
    const delta = suggestion.replacement.length - (suggestion.end - suggestion.start);
    for (const other of active.suggestions) {
      if (other.start > suggestion.start) {
        other.start += delta;
        other.end += delta;
      }
    }
    for (const sentence of segment(fieldText(active.field))) {
      const key = sentenceKey(sentence.text);
      if (!active.cache.has(key)) active.cache.set(key, []);
    }
    rebuild();
  }

  // ----------------------------------------------------------------- badge

  function setBadge(kind: 'checking' | 'clean' | 'issues' | 'error', title = ''): void {
    if (!session || !enabled) {
      badge.hidden = true;
      return;
    }
    const rect = session.field.node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      badge.hidden = true;
      return;
    }

    badge.hidden = false;
    badge.className = `pk-badge pk-badge--${kind}`;
    badge.style.left = `${rect.right - 26}px`;
    badge.style.top = `${rect.bottom - 26}px`;
    badge.textContent =
      kind === 'issues' ? String(session.suggestions.length) : kind === 'clean' ? '✓' : '';
    badge.title =
      title ||
      (kind === 'checking'
        ? 'ProofKey is checking…'
        : kind === 'clean'
          ? 'No issues found'
          : kind === 'error'
            ? 'Check failed'
            : `${session.suggestions.length} suggestion(s)`);
  }

  badge.addEventListener('click', () => {
    const first = session?.suggestions[0];
    if (!first) return;
    const rect = session?.highlighter.rectFor(first.id);
    if (rect) card.show(first, rect);
  });

  // ------------------------------------------------------- pointer handling

  /**
   * Underlines are painted by the highlight engine or by a pointer-transparent
   * overlay, so neither can be clicked directly. Hit-testing against the rects
   * we already track works for both and keeps the field itself interactive.
   */
  function suggestionAtPoint(x: number, y: number): Suggestion | null {
    if (!session) return null;
    for (const suggestion of session.suggestions) {
      const rect = session.highlighter.rectFor(suggestion.id);
      if (rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return suggestion;
      }
    }
    return null;
  }

  const onClick = (event: MouseEvent) => {
    if (!enabled || !session) return;
    const hit = suggestionAtPoint(event.clientX, event.clientY);
    if (hit) {
      const rect = session.highlighter.rectFor(hit.id);
      if (rect) card.show(hit, rect);
    } else if (card.isOpen() && !event.composedPath().includes(badge)) {
      card.hide();
    }
  };

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('click', onClick, true);

  return {
    isEnabled: () => enabled,
    setEnabled(next) {
      enabled = next;
      if (!next) {
        detach();
        return;
      }
      const field = eligible(document.activeElement);
      if (field) attach(field);
    },
    destroy() {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('click', onClick, true);
      detach();
      card.destroy();
      badge.remove();
    },
  };
}
