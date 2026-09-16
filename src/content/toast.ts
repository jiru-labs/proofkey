export interface ToastOptions {
  text: string;
  kind: 'info' | 'ok' | 'error' | 'busy';
  /** Stays until dismissed by the returned function. */
  sticky?: boolean;
  action?: { label: string; run: () => void };
}

/** How long a short message stays; nothing goes sooner. */
const AUTO_DISMISS_MS = 4500;
/**
 * Reading time per word. Adults read English silently at about 240 words a
 * minute; 300 ms a word is a slower pace, for readers in a second language and
 * for a message that turns up while they were looking at their own text.
 * Brave's built-in-model message is 41 words and went after the flat 4.5 s.
 */
const MS_PER_WORD = 300;
/** What is left once the pointer or focus leaves: they have seen it by then. */
const AFTER_HOLD_MS = 3000;

function readingTime(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(AUTO_DISMISS_MS, 1500 + words * MS_PER_WORD);
}

let current: { node: HTMLElement; timer: number | undefined } | null = null;

/** Shows a single transient message; returns a function that removes it. */
export function toast(root: ShadowRoot, options: ToastOptions): () => void {
  dismissCurrent();

  const node = document.createElement('div');
  node.className = `pk-toast pk-toast--${options.kind}${options.action ? ' pk-toast--with-action' : ''}`;

  if (options.kind === 'busy') {
    const spinner = document.createElement('span');
    spinner.className = 'pk-spinner';
    node.append(spinner);
  }

  const label = document.createElement('span');
  label.className = 'pk-toast__text';
  label.textContent = options.text;
  node.append(label);

  if (options.action) {
    const button = document.createElement('button');
    button.className = 'pk-toast__action';
    button.type = 'button';
    button.textContent = options.action.label;
    // Dismissed first: an action that shows a toast of its own would otherwise
    // have it removed a moment later by this very handler, and a click that
    // asks the browser for a permission was left looking like nothing happened.
    button.addEventListener('click', () => {
      dismissCurrent();
      options.action?.run();
    });
    node.append(button);
  }

  const close = document.createElement('button');
  close.className = 'pk-toast__close';
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', dismissCurrent);
  node.append(close);

  root.append(node);

  const entry: { node: HTMLElement; timer: number | undefined } = { node, timer: undefined };
  current = entry;

  if (!options.sticky) {
    const schedule = (ms: number): void => {
      clearTimeout(entry.timer);
      entry.timer = window.setTimeout(dismissCurrent, ms);
    };
    // Held while the pointer rests on it or focus is inside it, so a message can
    // be finished and its button reached, whatever its length.
    let hovered = false;
    let focused = false;
    const hold = (): void => {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    };
    const release = (): void => {
      if (!hovered && !focused && current === entry) schedule(AFTER_HOLD_MS);
    };
    node.addEventListener('pointerenter', () => {
      hovered = true;
      hold();
    });
    node.addEventListener('pointerleave', () => {
      hovered = false;
      release();
    });
    node.addEventListener('focusin', () => {
      focused = true;
      hold();
    });
    node.addEventListener('focusout', () => {
      focused = false;
      release();
    });
    schedule(readingTime(options.text));
  }

  return dismissCurrent;
}

function dismissCurrent(): void {
  if (!current) return;
  if (current.timer !== undefined) clearTimeout(current.timer);
  current.node.remove();
  current = null;
}
