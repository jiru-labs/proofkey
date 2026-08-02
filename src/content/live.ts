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
 * the caret sits in is held back, because a half-typed sentence produces
 * confident nonsense and pays for the privilege.
 *
 * Held back, not dropped. Taken literally, that third rule meant a message of
 * one unterminated sentence — a tweet, a chat line, most of what this extension
 * is typed into — was never checked at all, and the badge reported the silence
 * as a clean result. The settle pass below is the correction: once typing has
 * stopped for longer than the ordinary debounce, the sentence is no longer
 * half-typed in any sense that matters, and it is sent — wherever in it the
 * caret happens to be sitting.
 *
 * Results are cached by sentence content, so going back to fix paragraph four
 * never re-sends paragraphs one through three.
 */

const TEXTUAL_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', '']);
const MIN_SENTENCE_LENGTH = 4;

/**
 * How much longer than the ordinary debounce the caret's own sentence waits
 * before being sent. Expressed as a multiplier so it scales with the user's
 * debounce setting instead of fighting it.
 *
 * The delay is what keeps the cost rule intact. Someone typing in bursts longer
 * than the debounce would otherwise pay for every growing prefix of the
 * sentence they are still writing — each prefix hashes differently, so each is
 * a fresh request. Waiting for a real stop collapses that to one.
 */
const SETTLE_MULTIPLIER = 3;

interface Session {
  field: FieldRef;
  highlighter: Highlighter;
  /** Sentence content hash -> the edits found in it. Empty array means clean. */
  cache: Map<string, Change[]>;
  suggestions: Suggestion[];
  dismissed: Set<string>;
  timer: number;
  /** Separate from `timer`: the longer wait before the caret's sentence is sent. */
  settleTimer: number;
  inFlight: boolean;
  dirtyWhileChecking: boolean;
  /** Watches rich-text fields for edits that emit no `input` event. */
  observer: MutationObserver | null;
  /** Last text seen, so a re-render that changes nothing cannot re-arm the debounce. */
  lastText: string;
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
    apply: (suggestion) => void applySuggestion(suggestion),
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
    const active: Session = {
      field,
      highlighter: createHighlighter(field, shadow),
      cache: new Map(),
      suggestions: [],
      dismissed: new Set(),
      timer: 0,
      settleTimer: 0,
      inFlight: false,
      dirtyWhileChecking: false,
      observer: null,
      lastText: fieldText(field),
    };
    session = active;
    field.node.addEventListener('input', onInput);

    // `input` is not enough on its own. A framework editor that handles a
    // command itself calls preventDefault and reconciles the DOM in its own
    // code, and a programmatic DOM change emits no `input` event at all.
    // Measured on the real Lexical editor (WhatsApp, X): typing fires one
    // `input` per keystroke, but select-all-and-paste fires none, and undo
    // fires none. Both still mutate the DOM. Listening only for `input` meant
    // the whole message could be replaced under a green tick and nothing would
    // look again — the badge was not wrong so much as answering an older
    // question.
    //
    // Text-compared rather than mutation-counted, because composers mutate
    // themselves constantly — placeholders, carets, decorations — and a bare
    // re-schedule per mutation would hold the debounce open forever and never
    // check anything.
    if (field.kind === 'contenteditable') {
      const observer = new MutationObserver(() => {
        if (session !== active) return;
        const text = fieldText(active.field);
        if (text === active.lastText) return;
        active.lastText = text;
        schedule();
      });
      observer.observe(field.node, { childList: true, characterData: true, subtree: true });
      active.observer = observer;
    }

    schedule();
  }

  function detach(): void {
    if (!session) return;
    clearTimeout(session.timer);
    clearTimeout(session.settleTimer);
    session.observer?.disconnect();
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
    // Keeps the observer's baseline current, so an edit that fires `input` is
    // not then re-reported as a mutation the observer has never seen.
    session.lastText = fieldText(session.field);
    if (session.inFlight) session.dirtyWhileChecking = true;
    schedule();
  };

  function schedule(): void {
    if (!session) return;
    clearTimeout(session.timer);
    // Any keystroke also cancels a pending settle: the sentence just changed,
    // so the pause it was waiting for did not happen.
    clearTimeout(session.settleTimer);
    session.timer = window.setTimeout(() => void check(false), state.debounceMs);
  }

  /**
   * Arms the settle pass, but only when there is something for it to do: a
   * long-enough sentence under the caret that nobody has checked yet.
   *
   * The gate is the pause, not where the caret happens to be. It used to also
   * require the caret at the end of everything written, on the reasoning that
   * anyone who had clicked back into the middle was mid-edit and should be left
   * alone. That reading has no exit: a one-sentence message is the caret's
   * sentence, the ordinary check skips it by design, and the settle pass refused
   * it too — so clicking into the middle of a tweet, or pasting one and clicking
   * anywhere in it, meant nothing was ever sent, and the badge sat grey saying
   * "not checked yet" until the caret happened to end up at the end again.
   *
   * Nothing is lost by dropping it. Any keystroke cancels a pending settle, so
   * the timer already means "typing has stopped" — which is the thing that was
   * actually being asked about, and it is true of a paused mid-text edit too.
   *
   * Self-terminating by construction. The settle pass caches that sentence, and
   * only the ordinary check arms a settle — so a settle never arms another, and
   * a failed one is retried by the next keystroke rather than by a loop.
   */
  function maybeScheduleSettle(): void {
    if (!session) return;
    const active = session;

    const text = fieldText(active.field);
    const caret = caretOffset(active.field);

    const sentences = segment(text);
    const sentence = sentences[sentenceAt(sentences, caret)];
    if (!sentence) return;
    if (sentence.text.trim().length < MIN_SENTENCE_LENGTH) return;
    if (active.cache.has(sentenceKey(sentence.text))) return;

    clearTimeout(active.settleTimer);
    active.settleTimer = window.setTimeout(
      () => void check(true),
      state.debounceMs * SETTLE_MULTIPLIER,
    );
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

  async function check(includeCaret: boolean): Promise<void> {
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
    const caret = caretOffset(active.field);
    // A settle pass is the one that has waited for typing to stop, so it is the
    // one allowed to send the sentence the caret is in.
    const skipIndex = includeCaret ? -1 : sentenceAt(sentences, caret);

    const pending = sentences.filter(
      (sentence, index) =>
        index !== skipIndex &&
        sentence.text.trim().length >= MIN_SENTENCE_LENGTH &&
        !active.cache.has(sentenceKey(sentence.text)),
    );

    if (pending.length === 0) {
      rebuild();
      if (!includeCaret) maybeScheduleSettle();
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
        } else if (!includeCaret) {
          maybeScheduleSettle();
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

    // An open card outlives nothing it describes. The user can paste, undo, or
    // type one more character while it is up, and the offsets it carries were
    // captured when it opened — so an offer left on screen after its underline
    // has gone is an offer to write over whatever replaced it. Surviving
    // suggestions can still have moved, and are re-anchored rather than closed.
    const openId = card.currentId();
    if (openId) {
      const rect = active.suggestions.some((suggestion) => suggestion.id === openId)
        ? active.highlighter.rectFor(openId)
        : null;
      if (rect) card.move(rect);
      else card.hide();
    }

    if (suggestions.length > 0) {
      setBadge('issues');
      return;
    }

    // A tick is a claim about text that was actually sent. Anything still
    // uncached has not been — the caret's sentence before the settle pass, or a
    // batch too big for one request — and reporting that as clean is how this
    // whole path came to look like it was working when it had done nothing.
    const unchecked = sentences.some(
      (sentence) =>
        sentence.text.trim().length >= MIN_SENTENCE_LENGTH &&
        !active.cache.has(sentenceKey(sentence.text)),
    );
    setBadge(unchecked ? 'waiting' : 'clean');
  }

  // ---------------------------------------------------------------- applying

  async function applySuggestion(suggestion: Suggestion): Promise<void> {
    if (!session) return;
    const active = session;

    const applied = await applyToTarget(
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
    if (!applied) {
      // Either the editor refused the write, or the text moved and it was
      // refused for us. Either way what is on screen no longer matches what was
      // offered, so re-derive from the field and let that close the card.
      rebuild();
      return;
    }

    // Applying is deliberately not recorded as a dismissal. `dismissed` is keyed
    // by sentence content and the cache never forgets, so marking the applied
    // finding dismissed retired it for that exact text for the rest of the
    // session. Bring the original back — paste it, undo, retype it — and the
    // findings returned from cache already suppressed, with no request sent to
    // contradict them. On a sentence carrying a single error that is a green
    // tick over text nobody corrected, which is what x.com and WhatsApp saw.
    //
    // Nothing is needed in its place. A corrected sentence hashes differently,
    // so the entry the finding came from no longer matches anything in the
    // field; and where it does still match — the same sentence written twice —
    // the other copy really does still have the error in it.

    // The corrected sentence hashes differently now, so the next pass would pay
    // to check it again. Carrying the findings across to the new hash avoids
    // that — but it has to carry the *remaining* ones. Recording the sentence
    // clean instead, as this used to, retired every other finding in it: fix
    // one word of three and the badge went green over the other two.
    //
    // Offsets here are relative to the trimmed sentence, and `delta` is a pure
    // length difference, so the same number shifts both coordinate systems.
    const hash = suggestion.id.lastIndexOf('#');
    const previousKey = suggestion.id.slice(0, hash);
    const appliedIndex = Number(suggestion.id.slice(hash + 1));
    const previous = active.cache.get(previousKey) ?? [];
    const appliedChange = previous[appliedIndex];
    const delta = suggestion.replacement.length - (suggestion.end - suggestion.start);

    const remaining = previous
      .filter((_, index) => index !== appliedIndex)
      .map((change) =>
        appliedChange && change.start > appliedChange.start
          ? { ...change, start: change.start + delta, end: change.end + delta }
          : change,
      );

    const sentences = segment(fieldText(active.field));
    const rewritten = sentences.find(
      (sentence) => suggestion.start >= sentence.start && suggestion.start <= sentence.end,
    );

    if (rewritten) {
      const key = sentenceKey(rewritten.text);
      active.cache.set(key, remaining);
      // Dismissals are keyed by position in the old array. Dropping one entry
      // renumbers everything after it, so they have to be re-indexed or a
      // suggestion the user dismissed reappears the moment they apply another.
      previous.forEach((_, index) => {
        if (index === appliedIndex) return;
        if (!active.dismissed.has(`${previousKey}#${index}`)) return;
        active.dismissed.add(`${key}#${index < appliedIndex ? index : index - 1}`);
      });
    }

    rebuild();
  }

  // ----------------------------------------------------------------- badge

  function setBadge(
    kind: 'checking' | 'clean' | 'issues' | 'error' | 'waiting',
    title = '',
  ): void {
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
      {
        checking: 'ProofKey is checking…',
        clean: 'No issues found',
        error: 'Check failed',
        waiting: 'Not checked yet — pause for a moment',
        issues: `${session.suggestions.length} suggestion(s)`,
      }[kind];
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
