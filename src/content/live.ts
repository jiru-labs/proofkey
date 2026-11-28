import { autoFixable, classifyChange, diffWords, type Change } from '../core/diff';
import { askWorker, type CheckResult, type ContentState } from '../core/messages';
import { segment, sentenceAt, sentenceKey } from '../core/sentences';
import type { Suggestion } from '../core/types';
import { createCard, type SuggestionCard } from './card';
import { createHighlighter, type FieldRef, type Highlighter } from './highlight';
import { offerNews } from './news';
import { noteApplied } from './review';
import { toast } from './toast';
import { applyToTarget, deepActiveElement, flatten, isSensitive, offsetOfPoint, outermostEditableHost, rangeFor, type FlatText } from './target';

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

// `<input type="email">` rejects `setSelectionRange` per HTML spec and should
// not be live-proofread anyway.
const TEXTUAL_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', '']);
const MIN_SENTENCE_LENGTH = 4;
const MAX_CACHE_ENTRIES = 500;

/** Events that mean a person is editing the field, as opposed to ProofKey writing to it. */
const USER_EDIT_EVENTS = ['keydown', 'paste', 'compositionstart', 'drop'] as const;

/** Upper bound on fixes written in one pause. */
const MAX_AUTO_FIXES = 24;

/** How long the notice carrying Undo stays up, at least. */
const UNDO_NOTICE_MS = 8000;

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

/** How often, at most, typing tells the worker to keep the model ready. */
const WARM_EVERY_MS = 60_000;

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
  /** When the worker was last asked to keep the model ready, so typing does not ask on every key. */
  warmedAt: number;
  /** Watches rich-text fields for edits that emit no `input` event. */
  observer: MutationObserver | null;
  /** Last text seen, so a re-render that changes nothing cannot re-arm the debounce. */
  lastText: string;
  /** When the user last typed, pasted or composed in the field. Our own writes do not count. */
  lastUserAt: number;
  /** True while automatic correction is writing, so its own `input` events are not read as typing. */
  autoRunning: boolean;
  /** True during an active IME/dead-key composition; checking and auto-correct stand down. */
  composing: boolean;
  /** Last badge state, so scroll/resize can reposition it without recomputing suggestions. */
  badgeKind: 'checking' | 'clean' | 'issues' | 'error' | 'waiting' | null;
  badgeTitle: string;
  /**
   * Sentence texts automatic correction has already written into, by content
   * hash. A sentence that comes back to one of these — Undo, Ctrl+Z, a paste —
   * is the user saying they meant it, so its findings stay underlines.
   */
  autoTouched: Set<string>;
  /**
   * Fixes the user took back, as `original\u0000replacement`. Seen in a
   * sentence restored to one of `autoTouched`, and kept by the pair rather than
   * the sentence: the next keystroke in that sentence gives it a new hash, and
   * without this the fix it just undid would be written straight back.
   */
  rejected: Set<string>;
}

export interface LiveController {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  setAutoCorrect(enabled: boolean, englishVarietyPinned: boolean): void;
  updateState(next: ContentState): void;
  destroy(): void;
}

/** Splits a per-occurrence suggestion id (`key#index@start`) into its parts. */
function parseSuggestionId(id: string): { key: string; index: number; dismissId: string } {
  const at = id.lastIndexOf('@');
  const base = at >= 0 ? id.slice(0, at) : id;
  const hash = base.lastIndexOf('#');
  return {
    key: hash >= 0 ? base.slice(0, hash) : base,
    index: hash >= 0 ? Number(base.slice(hash + 1)) : -1,
    dismissId: base,
  };
}

function capMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function capSet<T>(set: Set<T>, max: number): void {
  while (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

export function createLive(shadow: ShadowRoot, initialState: ContentState): LiveController {
  let state = { ...initialState };
  let enabled = state.liveEnabled;
  let autoCorrectOn = state.autoCorrect === true;
  let englishPinned = state.englishVarietyPinned === true;
  let session: Session | null = null;
  let dictionary = new Set(state.dictionary.map((word) => word.toLowerCase()));
  let repositionFrame = 0;

  const badge = document.createElement('button');
  badge.className = 'pk-badge';
  badge.type = 'button';
  badge.hidden = true;
  shadow.append(badge);

  const card: SuggestionCard = createCard(shadow, {
    apply: (suggestion) => void applySuggestion(suggestion),
    dismiss: (suggestion) => {
      if (session) {
        session.dismissed.add(parseSuggestionId(suggestion.id).dismissId);
        capSet(session.dismissed, MAX_CACHE_ENTRIES);
      }
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
    if (!(node instanceof Element)) return null;
    if (node instanceof HTMLTextAreaElement && !node.readOnly && !node.disabled) {
      return isSensitive(node) ? null : { kind: 'input', node };
    }
    if (
      node instanceof HTMLInputElement &&
      !node.readOnly &&
      !node.disabled &&
      TEXTUAL_INPUT_TYPES.has(node.type.toLowerCase()) &&
      node.type.toLowerCase() !== 'password'
    ) {
      return isSensitive(node) ? null : { kind: 'input', node };
    }
    if (node instanceof HTMLElement && node.isContentEditable) {
      const host = outermostEditableHost(node);
      return host && !isSensitive(host) ? { kind: 'contenteditable', node: host } : null;
    }
    return null;
  }

  function readField(field: FieldRef): { text: string; flat?: FlatText } {
    if (field.kind === 'input') return { text: field.node.value };
    const flat = flatten(field.node);
    return { text: flat.text, flat };
  }

  const syncFloating = () => {
    repositionFrame = 0;
    if (!session) return;
    if (!session.field.node.isConnected) {
      detach();
      return;
    }
    if (session.badgeKind) setBadge(session.badgeKind, session.badgeTitle);
    const openId = card.currentId();
    if (openId) {
      const rect = session.highlighter.rectFor(openId);
      if (rect) card.move(rect);
      else card.hide();
    }
  };

  const onViewportChange = () => {
    if (!session || repositionFrame !== 0) return;
    repositionFrame = requestAnimationFrame(syncFloating);
  };

  const onCompositionStart = () => {
    if (!session) return;
    session.composing = true;
    session.lastUserAt = performance.now();
    clearTimeout(session.timer);
    clearTimeout(session.settleTimer);
  };

  const onCompositionEnd = () => {
    if (!session) return;
    session.composing = false;
    session.lastUserAt = performance.now();
    session.lastText = fieldText(session.field);
    if (session.inFlight) session.dirtyWhileChecking = true;
    schedule();
  };

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
      warmedAt: performance.now(),
      observer: null,
      lastText: fieldText(field),
      lastUserAt: 0,
      autoRunning: false,
      composing: false,
      badgeKind: null,
      badgeTitle: '',
      autoTouched: new Set(),
      rejected: new Set(),
    };
    session = active;
    field.node.addEventListener('input', onInput);
    field.node.addEventListener('compositionstart', onCompositionStart, true);
    field.node.addEventListener('compositionend', onCompositionEnd, true);
    for (const type of USER_EDIT_EVENTS) field.node.addEventListener(type, onUserEdit, true);
    window.addEventListener('scroll', onViewportChange, { passive: true, capture: true });
    window.addEventListener('resize', onViewportChange, { passive: true });
    void askWorker({ type: 'proofkey:warm' }).catch(() => undefined);
    offerNews(shadow);

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
        if (session !== active || active.autoRunning || active.composing) return;
        if (!active.field.node.isConnected) {
          detach();
          return;
        }
        const { text, flat } = readField(active.field);
        if (text === active.lastText) return;
        active.lastText = text;
        active.lastUserAt = performance.now();
        if (active.inFlight) active.dirtyWhileChecking = true;
        noteTakenBack(active, text, caretOffset(active.field, flat));
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
    if (repositionFrame) {
      cancelAnimationFrame(repositionFrame);
      repositionFrame = 0;
    }
    session.observer?.disconnect();
    session.field.node.removeEventListener('input', onInput);
    session.field.node.removeEventListener('compositionstart', onCompositionStart, true);
    session.field.node.removeEventListener('compositionend', onCompositionEnd, true);
    for (const type of USER_EDIT_EVENTS) session.field.node.removeEventListener(type, onUserEdit, true);
    window.removeEventListener('scroll', onViewportChange, { capture: true });
    window.removeEventListener('resize', onViewportChange);
    session.highlighter.destroy();
    session = null;
    card.hide();
    badge.hidden = true;
  }

  const onFocusIn = (event: FocusEvent) => {
    if (!enabled) return;
    const rawTarget = event.composedPath()[0] ?? event.target;
    const field = eligible(rawTarget);
    // Focus moving into our own card must not tear the session down.
    if (!field) return;
    if (session && field.node === session.field.node) return;
    attach(field);
  };

  const onUserEdit = () => {
    if (session) session.lastUserAt = performance.now();
  };

  const onInput = (event: Event) => {
    if (!session) return;
    if ((event as InputEvent).isComposing || session.composing) return;
    if (!session.autoRunning) session.lastUserAt = performance.now();
    // Keeps the observer's baseline current, so an edit that fires `input` is
    // not then re-reported as a mutation the observer has never seen.
    const { text, flat } = readField(session.field);
    session.lastText = text;
    noteTakenBack(session, text, caretOffset(session.field, flat));
    if (session.inFlight) session.dirtyWhileChecking = true;
    // Typing keeps the in-browser model loaded: it is unloaded after a quiet
    // spell, and loading it again stalls the page while it happens.
    const now = performance.now();
    if (now - session.warmedAt > WARM_EVERY_MS) {
      session.warmedAt = now;
      void askWorker({ type: 'proofkey:warm' }).catch(() => undefined);
    }
    schedule();
  };

  function schedule(): void {
    if (!session || session.composing) return;
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
  function maybeScheduleSettle(precomputed?: { text: string; flat?: FlatText }): void {
    if (!session || session.composing) return;
    const active = session;
    if (!active.field.node.isConnected) {
      detach();
      return;
    }

    const { text, flat } = precomputed ?? readField(active.field);
    const caret = caretOffset(active.field, flat);

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

  function caretOffset(field: FieldRef, precomputedFlat?: FlatText): number {
    if (field.kind === 'input') return field.node.selectionStart ?? -1;
    const selection = window.getSelection();
    if (!selection?.focusNode) return -1;
    if (!field.node.contains(selection.focusNode)) return -1;
    return offsetOfPoint(precomputedFlat ?? flatten(field.node), selection.focusNode, selection.focusOffset) ?? -1;
  }

  async function check(includeCaret: boolean): Promise<void> {
    if (!session || session.inFlight || session.composing) return;
    const active = session;
    if (!active.field.node.isConnected || isSensitive(active.field.node)) {
      detach();
      return;
    }
    if (document.hidden) return;
    const startedAt = performance.now();

    const snapshot = readField(active.field);
    const { text, flat } = snapshot;
    if (text.trim().length < state.minChars) {
      active.suggestions = [];
      active.highlighter.clear();
      active.badgeKind = null;
      badge.hidden = true;
      return;
    }

    const sentences = segment(text);
    const caret = caretOffset(active.field, flat);
    // A settle pass is the one that has waited for typing to stop, so it is the
    // one allowed to send the sentence the caret is in.
    const skipIndex = includeCaret ? -1 : sentenceAt(sentences, caret);

    // Deduplicate identical uncached sentences so repeated lines in one field
    // are not sent and billed twice in the same batch.
    const seenKeys = new Set<string>();
    const pending = sentences.filter((sentence, index) => {
      if (index === skipIndex) return false;
      if (sentence.text.trim().length < MIN_SENTENCE_LENGTH) return false;
      const key = sentenceKey(sentence.text);
      if (active.cache.has(key) || seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    if (pending.length === 0) {
      rebuild(snapshot);
      void autoCorrect(active, startedAt);
      if (!includeCaret) maybeScheduleSettle(snapshot);
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
      if (!active.field.node.isConnected) {
        detach();
        return;
      }

      if (!result.ok) {
        setBadge('error', result.error);
        return;
      }

      if (result.value.notice) toast(shadow, { kind: 'info', text: result.value.notice });

      batch.forEach((sentence, index) => {
        const corrected = result.value.corrections[index];
        const original = sentence.text.trim();
        const changes =
          corrected === undefined || corrected === original
            ? []
            : (diffWords(original, corrected) ?? []);
        active.cache.set(sentenceKey(sentence.text), changes);
      });
      capMap(active.cache, MAX_CACHE_ENTRIES);

      const fresh = readField(active.field);
      rebuild(fresh);
      await autoCorrect(active, startedAt);
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
  function rebuild(precomputed?: { text: string; flat?: FlatText }): void {
    if (!session) return;
    const active = session;
    if (!active.field.node.isConnected) {
      detach();
      return;
    }
    const { text, flat } = precomputed ?? readField(active.field);
    const sentences = segment(text);
    const suggestions: Suggestion[] = [];
    const keyCounts = new Map<string, number>();

    for (const sentence of sentences) {
      const key = sentenceKey(sentence.text);
      const occ = keyCounts.get(key) ?? 0;
      keyCounts.set(key, occ + 1);
      const changes = active.cache.get(key);
      if (!changes || changes.length === 0) continue;

      // The cache was built from the trimmed sentence; realign to the field.
      const offset = sentence.start + (sentence.text.length - sentence.text.trimStart().length);
      const source = sentence.text.trim();

      changes.forEach((change, index) => {
        const dismissId = `${key}#${index}`;
        if (active.dismissed.has(dismissId)) return;

        const original = source.slice(change.start, change.end);
        if (original.trim() && dictionary.has(original.trim().toLowerCase())) return;

        const start = offset + change.start;
        const end = offset + change.end;
        // Guard against the text having moved since the check.
        if (text.slice(start, end) !== original) return;

        // Tag by occurrence count (not character offset) so repeated identical
        // sentences get distinct highlight ids while an open card on a later
        // sentence keeps its id when an earlier sentence changes length.
        const id = occ === 0 ? dismissId : `${dismissId}@${occ}`;
        const { category, severity } = classifyChange(change, source);
        suggestions.push({ id, start, end, original, replacement: change.replacement, category, severity });
      });
    }

    active.suggestions = suggestions.sort((a, b) => a.start - b.start);
    active.highlighter.render(active.suggestions, flat);

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

  async function applySuggestion(suggestion: Suggestion, automatic = false): Promise<boolean> {
    if (!session) return false;
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
      return false;
    }
    // A fix nobody clicked is not something the user did, so it does not count
    // towards the rating question.
    if (!automatic) void noteApplied(shadow);

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
    const { key: previousKey, index: appliedIndex } = parseSuggestionId(suggestion.id);
    const previous = active.cache.get(previousKey) ?? [];
    const appliedChange = previous[appliedIndex];
    const delta = suggestion.replacement.length - (suggestion.end - suggestion.start);

    const afterSnapshot = readField(active.field);
    active.lastText = afterSnapshot.text;
    const sentences = segment(afterSnapshot.text);
    // Strict `< sentence.end` prevents a suggestion on the first word of
    // sentence `i + 1` (where `suggestion.start === sentences[i].end`) from
    // overwriting sentence `i`'s cache entry.
    const rewritten =
      sentences.find((sentence) => suggestion.start >= sentence.start && suggestion.start < sentence.end) ??
      sentences.find((sentence) => suggestion.start >= sentence.start && suggestion.start <= sentence.end);

    if (rewritten) {
      // If a pure deletion at the start of the sentence exposed leading
      // whitespace, `.trimStart()` drops it too — fold that into the offset delta.
      const trimmedLeadShift =
        appliedChange && appliedChange.start === 0 && !suggestion.replacement.trim()
          ? (rewritten.text.length - rewritten.text.trimStart().length)
          : 0;
      const shift = delta - trimmedLeadShift;
      const remaining = previous
        .filter((_, index) => index !== appliedIndex)
        .map((change) =>
          appliedChange && change.start > appliedChange.start
            ? { ...change, start: Math.max(0, change.start + shift), end: Math.max(0, change.end + shift) }
            : change,
        );
      const key = sentenceKey(rewritten.text);
      active.cache.set(key, remaining);
      capMap(active.cache, MAX_CACHE_ENTRIES);
      // Dismissals are keyed by position in the old array. Dropping one entry
      // renumbers everything after it, so they have to be re-indexed or a
      // suggestion the user dismissed reappears the moment they apply another.
      previous.forEach((_, index) => {
        if (index === appliedIndex) return;
        if (!active.dismissed.has(`${previousKey}#${index}`)) return;
        active.dismissed.add(`${key}#${index < appliedIndex ? index : index - 1}`);
      });
      capSet(active.dismissed, MAX_CACHE_ENTRIES);
    }

    rebuild(afterSnapshot);
    return true;
  }

  // ------------------------------------------------------ automatic correction

  /**
   * Writes the spelling-level findings into the field, on the same pause that
   * found them.
   *
   * On a pause rather than per word, for the reasons the whole layer already
   * runs on one: a word-by-word check is a request per word on the user's key,
   * a half-typed sentence draws confident nonsense, and an edit landing while
   * someone types puts their next keystroke inside the correction. The pause
   * also gives the timing that reads as "while I write": a finished sentence is
   * sent on the first short pause, while the caret moves on into the next one;
   * only the sentence still under the caret waits for the longer settle.
   *
   * Only what `autoFixable` passes: accents, capitals, and typos small enough
   * that the word stays the same word — a pinned variety's spelling included
   * ("color" → "colour"). Grammar and wording change meaning often enough that
   * they stay the user's call.
   *
   * It stands down the moment anything says the user is busy: a keystroke since
   * the pause began, focus somewhere else, or a selection held open.
   */
  async function autoCorrect(active: Session, since: number): Promise<void> {
    if (!autoCorrectOn || active.autoRunning) return;

    const done: Suggestion[] = [];
    active.autoRunning = true;
    try {
      // Bounded: every pass writes one fix and re-keys its sentence, so a model
      // whose correction is itself "wrong" can never ping-pong forever.
      for (let step = 0; step < MAX_AUTO_FIXES; step++) {
        if (session !== active || !autoCorrectOn || active.lastUserAt > since) break;
        if (!userIsIdleIn(active.field)) break;

        const next = nextAutoFix(active);
        if (!next) break;
        active.autoTouched.add(parseSuggestionId(next.id).key);
        capSet(active.autoTouched, MAX_CACHE_ENTRIES);

        const caret = caretOffset(active.field);
        if (!(await applySuggestion(next, true))) break;
        if (session !== active) break;
        placeCaret(active.field, shiftedCaret(caret, next));
        done.push(next);
      }
    } finally {
      active.autoRunning = false;
    }

    if (done.length > 0 && session === active) announceFixes(active, done);
  }

  /** The last spelling fix in the field, outside any sentence already written into. */
  function nextAutoFix(active: Session): Suggestion | null {
    let best: Suggestion | null = null;
    for (const suggestion of active.suggestions) {
      if (!autoFixable(suggestion.original, suggestion.replacement, suggestion.category, englishPinned)) continue;
      if (active.rejected.has(fixPair(suggestion.original, suggestion.replacement))) continue;
      if (active.autoTouched.has(parseSuggestionId(suggestion.id).key)) continue;
      // Last first, so writing one never moves the offsets of the ones before it.
      if (!best || suggestion.start > best.start) best = suggestion;
    }
    return best;
  }

  /**
   * Records as rejected every fix in a sentence that is back to text automatic
   * correction once wrote into. Run on each edit rather than on the next
   * check, because Ctrl+Z and a keystroke can both land inside one debounce,
   * and by the time a check looks the restored sentence is already gone.
   */
  function noteTakenBack(active: Session, text: string, caret = -1): void {
    if (active.autoTouched.size === 0 || active.autoRunning) return;
    const sentences = segment(text);
    const caretIdx = caret >= 0 ? sentenceAt(sentences, caret) : -1;
    const inspect = caretIdx >= 0 ? [sentences[caretIdx]!] : sentences;
    for (const sentence of inspect) {
      const key = sentenceKey(sentence.text);
      if (!active.autoTouched.has(key)) continue;
      const source = sentence.text.trim();
      for (const change of active.cache.get(key) ?? []) {
        const original = source.slice(change.start, change.end);
        if (autoFixable(original, change.replacement, classifyChange(change, source).category, englishPinned)) {
          active.rejected.add(fixPair(original, change.replacement));
          capSet(active.rejected, MAX_CACHE_ENTRIES);
        }
      }
    }
  }

  function fixPair(original: string, replacement: string): string {
    return `${original.trim()}\u0000${replacement.trim()}`;
  }

  function userIsIdleIn(field: FieldRef): boolean {
    if (session?.composing) return false;
    const focused = deepActiveElement();
    if (!focused || !(focused === field.node || field.node.contains(focused))) return false;
    if (field.kind === 'input') {
      return field.node.selectionStart !== null && field.node.selectionStart === field.node.selectionEnd;
    }
    const selection = window.getSelection();
    return !!selection && selection.isCollapsed;
  }

  /** Where the caret belongs once `fix` has been written, measured before it was. */
  function shiftedCaret(caret: number, fix: Suggestion): number {
    if (caret < 0) return caret;
    if (caret >= fix.end) return caret + fix.replacement.length - (fix.end - fix.start);
    if (caret > fix.start) return fix.start + fix.replacement.length;
    return caret;
  }

  /**
   * Puts the caret back where the user left it. The write path has to select
   * the misspelt word to replace it, and leaving the caret there would send the
   * next keystroke into the middle of an earlier sentence.
   */
  function placeCaret(field: FieldRef, offset: number): void {
    if (offset < 0) return;
    if (field.kind === 'input') {
      try {
        field.node.setSelectionRange(offset, offset);
      } catch {
        // Some input types refuse selection; their caret stays where the write left it.
      }
      return;
    }
    const range = rangeFor(flatten(field.node), offset, offset);
    const selection = window.getSelection();
    if (!range || !selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function announceFixes(active: Session, fixes: Suggestion[]): void {
    const first = fixes[0]!;
    toast(shadow, {
      kind: 'ok',
      text:
        fixes.length === 1
          ? `Corrected “${first.original.trim()}” → “${first.replacement.trim()}”`
          : `Corrected ${fixes.length} words`,
      action: { label: 'Undo', run: () => void undoFixes(active, fixes) },
      // The words take a second to read; noticing that something you did not
      // type has changed, and reaching Undo, takes longer.
      minMs: UNDO_NOTICE_MS,
    });
  }

  /**
   * Takes the fixes back, last written first, which is what returns each one to
   * the offsets it was written at. The restored sentences are already in
   * `autoTouched`, so the next pass underlines them instead of fixing them again.
   */
  async function undoFixes(active: Session, fixes: Suggestion[]): Promise<void> {
    if (session !== active) return;
    for (const fix of [...fixes].reverse()) {
      const end = fix.start + fix.replacement.length;
      const undone = await applyToTarget(
        active.field.kind === 'input'
          ? { kind: 'input', node: active.field.node, start: fix.start, end, text: fix.replacement }
          : { kind: 'contenteditable', node: active.field.node, start: fix.start, end, text: fix.replacement },
        fix.original,
      );
      if (!undone) {
        toast(shadow, { kind: 'info', text: 'The text has changed since — use Ctrl+Z to undo.' });
        break;
      }
    }
    if (session === active) rebuild();
  }

  // ----------------------------------------------------------------- badge

  function setBadge(
    kind: 'checking' | 'clean' | 'issues' | 'error' | 'waiting',
    title = '',
  ): void {
    if (!session || !enabled || !session.field.node.isConnected) {
      badge.hidden = true;
      return;
    }
    session.badgeKind = kind;
    session.badgeTitle = title;

    const rect = session.field.node.getBoundingClientRect();
    const outOfView =
      rect.width === 0 ||
      rect.height === 0 ||
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth;
    if (outOfView) {
      badge.hidden = true;
      return;
    }

    const rtl = getComputedStyle(session.field.node).direction === 'rtl';
    const left = rtl ? Math.max(4, rect.left + 6) : Math.min(window.innerWidth - 26, rect.right - 26);
    const top = Math.max(4, Math.min(window.innerHeight - 26, rect.bottom - 26));

    badge.hidden = false;
    badge.className = `pk-badge pk-badge--${kind}`;
    badge.style.left = `${left}px`;
    badge.style.top = `${top}px`;
    badge.textContent =
      kind === 'issues' ? String(session.suggestions.length) : kind === 'clean' ? '✓' : '';
    const label =
      title ||
      {
        checking: 'ProofKey is checking…',
        clean: 'No issues found',
        error: 'Check failed',
        waiting: 'Not checked yet — pause for a moment',
        issues: `${session.suggestions.length} suggestion(s)`,
      }[kind];
    badge.title = label;
    badge.setAttribute('aria-label', label);
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
   * overlay, so neither can be clicked directly. Hit-testing against each
   * line-box rect works for both, handles multi-line wraps accurately, and
   * keeps the field itself interactive.
   */
  function suggestionAtPoint(x: number, y: number): { suggestion: Suggestion; rect: DOMRect } | null {
    if (!session) return null;
    for (const suggestion of session.suggestions) {
      for (const rect of session.highlighter.rectsFor(suggestion.id)) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return { suggestion, rect };
        }
      }
    }
    return null;
  }

  const onClick = (event: MouseEvent) => {
    if (!enabled || !session) return;
    // Clicks inside ProofKey's own shadow UI (card buttons like Explain/Apply,
    // badge, toast) are handled by those controls; never close the card in
    // capture phase before their own click handlers run.
    if (event.composedPath().includes(shadow.host)) return;
    const hit = suggestionAtPoint(event.clientX, event.clientY);
    if (hit) {
      card.show(hit.suggestion, hit.rect);
    } else if (card.isOpen()) {
      card.hide();
    }
  };

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('click', onClick, true);
  // A page with live checking on is likely to be typed into: have the model
  // loaded while the page is still being read, not on the first sentence.
  if (enabled) void askWorker({ type: 'proofkey:warm' }).catch(() => undefined);

  return {
    isEnabled: () => enabled,
    setAutoCorrect(next, pinned) {
      autoCorrectOn = next;
      englishPinned = pinned;
    },
    setEnabled(next) {
      enabled = next;
      if (!next) {
        detach();
        return;
      }
      void askWorker({ type: 'proofkey:warm' }).catch(() => undefined);
      const field = eligible(deepActiveElement());
      if (field) attach(field);
    },
    updateState(next) {
      const prevSignature = state.checkSignature;
      const prevDict = state.dictionary.join('\u0000');
      state = { ...next };
      autoCorrectOn = next.autoCorrect === true;
      englishPinned = next.englishVarietyPinned === true;
      dictionary = new Set(next.dictionary.map((word) => word.toLowerCase()));

      if (next.liveEnabled !== enabled) {
        enabled = next.liveEnabled;
        if (!enabled) {
          detach();
          return;
        }
        void askWorker({ type: 'proofkey:warm' }).catch(() => undefined);
        const field = eligible(deepActiveElement());
        if (field) attach(field);
        return;
      }

      if (session) {
        if (prevSignature && next.checkSignature && prevSignature !== next.checkSignature) {
          session.cache.clear();
          session.autoTouched.clear();
          schedule();
        } else if (prevDict !== next.dictionary.join('\u0000')) {
          rebuild();
        }
      }
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
