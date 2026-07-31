type Child = Node | string | null | undefined | false;

interface ElementProps {
  class?: string;
  text?: string;
  html?: never; // deliberately unavailable: nothing here needs innerHTML
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
  [key: string]: unknown;
}

/** Minimal element builder. Keeps the options page framework-free and CSP-safe. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    switch (key) {
      case 'class':
        node.className = String(value);
        break;
      case 'text':
        node.textContent = String(value);
        break;
      case 'dataset':
        Object.assign(node.dataset, value as Record<string, string>);
        break;
      case 'attrs':
        for (const [name, attr] of Object.entries(value as Record<string, string>)) {
          node.setAttribute(name, attr);
        }
        break;
      case 'on':
        for (const [event, handler] of Object.entries(value as Record<string, EventListener>)) {
          node.addEventListener(event, handler);
        }
        break;
      default:
        (node as unknown as Record<string, unknown>)[key] = value;
    }
  }

  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/** A labelled control with an optional hint underneath. */
export function field(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = control.id || `f${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return el(
    'div',
    { class: 'field' },
    el('label', { class: 'field__label', htmlFor: id, text: labelText }),
    control,
    hint ? el('p', { class: 'field__hint', text: hint }) : null,
  );
}

export function input(
  value: string,
  props: ElementProps & { placeholder?: string; type?: string } = {},
): HTMLInputElement {
  return el('input', { class: 'input', type: 'text', value, ...props });
}

export function textarea(
  value: string,
  props: ElementProps & { placeholder?: string; rows?: number } = {},
): HTMLTextAreaElement {
  return el('textarea', { class: 'input input--multiline', rows: 4, ...props }, value);
}

export function select(
  options: { value: string; label: string; group?: string }[],
  value: string,
  props: ElementProps = {},
): HTMLSelectElement {
  const node = el('select', { class: 'input', ...props });
  const groups = new Map<string, HTMLOptGroupElement>();

  for (const option of options) {
    const item = el('option', { value: option.value, text: option.label });
    if (!option.group) {
      node.appendChild(item);
      continue;
    }
    let group = groups.get(option.group);
    if (!group) {
      group = el('optgroup', { attrs: { label: option.group } });
      groups.set(option.group, group);
      node.appendChild(group);
    }
    group.appendChild(item);
  }

  node.value = value;
  return node;
}

export function button(
  label: string,
  onClick: () => void,
  variant: 'primary' | 'secondary' | 'ghost' | 'danger' = 'secondary',
): HTMLButtonElement {
  return el('button', {
    class: `btn btn--${variant}`,
    type: 'button',
    text: label,
    on: { click: onClick },
  });
}

export function checkbox(label: string, checked: boolean, onChange: (value: boolean) => void) {
  const box = el('input', {
    type: 'checkbox',
    checked,
    on: { change: (event) => onChange((event.target as HTMLInputElement).checked) },
  });
  return el('label', { class: 'checkbox' }, box, el('span', { text: label }));
}

/** Parses a JSON object field, returning `null` when the text is not usable. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Splits a textarea into trimmed, non-empty lines. */
export function lines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
