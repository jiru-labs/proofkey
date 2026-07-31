export interface ToastOptions {
  text: string;
  kind: 'info' | 'ok' | 'error' | 'busy';
  /** Stays until dismissed by the returned function. */
  sticky?: boolean;
  action?: { label: string; run: () => void };
}

const AUTO_DISMISS_MS = 4500;

let current: { node: HTMLElement; timer: number | undefined } | null = null;

/** Shows a single transient message; returns a function that removes it. */
export function toast(root: ShadowRoot, options: ToastOptions): () => void {
  dismissCurrent();

  const node = document.createElement('div');
  node.className = `pk-toast pk-toast--${options.kind}`;

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
    button.addEventListener('click', () => {
      options.action?.run();
      dismissCurrent();
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

  const timer = options.sticky
    ? undefined
    : window.setTimeout(dismissCurrent, AUTO_DISMISS_MS);
  current = { node, timer };

  return dismissCurrent;
}

function dismissCurrent(): void {
  if (!current) return;
  if (current.timer !== undefined) clearTimeout(current.timer);
  current.node.remove();
  current = null;
}
