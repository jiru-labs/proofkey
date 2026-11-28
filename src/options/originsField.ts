import { normalizeOrigin } from '../core/browser';
import { el, field, lines, textarea } from './dom';

export interface OriginsFieldOptions {
  label: string;
  values: string[];
  rows?: number;
  placeholder: string;
  hint: string;
  onChange: (next: string[]) => void;
}

/**
 * Shared origin-list textarea used by Shortcuts and Live checking.
 * Names unparseable lines live (aria-live) and normalises valid entries on blur.
 */
export function renderOriginsField(options: OriginsFieldOptions): HTMLElement {
  const problems = el('p', {
    class: 'field__hint field__hint--error',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });

  const validate = (raw: string): void => {
    const unusable = lines(raw).filter((line) => normalizeOrigin(line) === null);
    problems.textContent = unusable.length
      ? `Not a site address, so ${unusable.length === 1 ? 'it' : 'they'} will be ignored: ${unusable.join(', ')}`
      : '';
  };

  const box = textarea(options.values.join('\n'), {
    rows: options.rows ?? 3,
    placeholder: options.placeholder,
    on: {
      input: (e) => {
        const raw = (e.target as HTMLTextAreaElement).value;
        options.onChange(lines(raw));
        validate(raw);
      },
      blur: (e) => {
        const node = e.target as HTMLTextAreaElement;
        const rawLines = lines(node.value);
        const cleaned = [...new Set(rawLines.map(normalizeOrigin).filter((o): o is string => !!o))];
        const unusable = rawLines.filter((line) => normalizeOrigin(line) === null);
        node.value = [...cleaned, ...unusable].join('\n');
        options.onChange(cleaned);
        validate(node.value);
      },
    },
  });

  validate(box.value);

  return el('div', {}, field(options.label, box, options.hint), problems);
}
