import { askWorker, type RunResult } from '../core/messages';
import type { Suggestion } from '../core/types';

export interface CardHandlers {
  apply(suggestion: Suggestion): void;
  dismiss(suggestion: Suggestion): void;
  addToDictionary(suggestion: Suggestion): void;
}

export interface SuggestionCard {
  show(suggestion: Suggestion, anchor: DOMRect): void;
  hide(): void;
  isOpen(): boolean;
  currentId(): string | null;
  destroy(): void;
}

const GAP = 8;
const WIDTH = 320;

export function createCard(shadow: ShadowRoot, handlers: CardHandlers): SuggestionCard {
  const root = document.createElement('div');
  root.className = 'pk-card';
  root.hidden = true;
  shadow.append(root);

  let open: Suggestion | null = null;

  function hide(): void {
    open = null;
    root.hidden = true;
    root.replaceChildren();
  }

  function position(anchor: DOMRect): void {
    // Prefer below the word; flip above when there is no room.
    const below = anchor.bottom + GAP;
    const room = window.innerHeight - below;
    const left = Math.min(Math.max(GAP, anchor.left), window.innerWidth - WIDTH - GAP);

    root.style.left = `${left}px`;
    if (room < 140 && anchor.top > 160) {
      root.style.top = '';
      root.style.bottom = `${window.innerHeight - anchor.top + GAP}px`;
    } else {
      root.style.bottom = '';
      root.style.top = `${below}px`;
    }
  }

  function show(suggestion: Suggestion, anchor: DOMRect): void {
    open = suggestion;
    root.replaceChildren();
    root.hidden = false;

    const header = document.createElement('div');
    header.className = 'pk-card__header';
    const category = document.createElement('span');
    category.className = `pk-chip pk-chip--${suggestion.severity}`;
    category.textContent = suggestion.category;
    header.append(category);

    const close = document.createElement('button');
    close.className = 'pk-card__close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', hide);
    header.append(close);
    root.append(header);

    const change = document.createElement('div');
    change.className = 'pk-card__change';

    const before = document.createElement('span');
    before.className = 'pk-card__before';
    before.textContent = suggestion.original || '(nothing)';
    const arrow = document.createElement('span');
    arrow.className = 'pk-card__arrow';
    arrow.textContent = '→';
    const after = document.createElement('span');
    after.className = 'pk-card__after';
    after.textContent = suggestion.replacement || '(remove)';

    change.append(before, arrow, after);
    root.append(change);

    const explanation = document.createElement('p');
    explanation.className = 'pk-card__explanation';
    explanation.hidden = true;
    root.append(explanation);

    const actions = document.createElement('div');
    actions.className = 'pk-card__actions';

    actions.append(
      makeButton('Apply', 'primary', () => {
        handlers.apply(suggestion);
        hide();
      }),
      makeButton('Explain', 'ghost', async (button) => {
        button.disabled = true;
        button.textContent = 'Thinking…';
        const result = await askWorker<RunResult>({
          type: 'proofkey:explain',
          original: suggestion.original,
          replacement: suggestion.replacement,
        });
        button.remove();
        explanation.hidden = false;
        explanation.textContent = result.ok ? result.value.text : result.error;
      }),
      makeButton('Ignore', 'ghost', () => {
        handlers.dismiss(suggestion);
        hide();
      }),
    );

    if (suggestion.severity === 'spelling' && suggestion.original.trim()) {
      actions.append(
        makeButton('Always allow', 'ghost', () => {
          handlers.addToDictionary(suggestion);
          hide();
        }),
      );
    }

    root.append(actions);
    position(anchor);
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (!open) return;
    if (event.key === 'Escape') {
      hide();
      event.stopPropagation();
    } else if (event.key === 'Enter' && event.ctrlKey) {
      handlers.apply(open);
      hide();
      event.preventDefault();
    }
  };
  window.addEventListener('keydown', onKeydown, true);

  return {
    show,
    hide,
    isOpen: () => open !== null,
    currentId: () => open?.id ?? null,
    destroy() {
      window.removeEventListener('keydown', onKeydown, true);
      root.remove();
    },
  };
}

function makeButton(
  label: string,
  variant: 'primary' | 'ghost',
  run: (button: HTMLButtonElement) => void | Promise<void>,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `pk-btn pk-btn--${variant}`;
  button.textContent = label;
  button.addEventListener('click', () => void run(button));
  return button;
}
