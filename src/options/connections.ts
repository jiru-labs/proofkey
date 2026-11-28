import {
  describeProbe,
  findLocalServers,
  localServerOrigins,
  LOCAL_SERVERS,
  type LocalServerProbe,
} from '../core/localServers';
import { getPreset, normalizeBaseUrl, PRESETS, switchPreset, thinkingNote } from '../core/presets';
import { listModels, runCompletion, validateConnection } from '../core/providers';
import {
  builtinAvailability,
  BUILTIN_MODEL,
  builtinProblem,
  downloadBuiltinModel,
} from '../core/providers/chromeBuiltin';
import {
  describeInBrowserState,
  IN_BROWSER_DOWNLOAD_BYTES,
  IN_BROWSER_DOWNLOAD_HOST,
  type InBrowserState,
} from '../core/providers/inBrowserModel';
import { connectionFromPreset } from '../core/storage';
import type { AuthStyle, Connection, PresetId } from '../core/types';
import {
  button,
  checkbox,
  clear,
  el,
  field,
  input,
  nextFieldId,
  parseJsonObject,
  parseStringRecord,
  section,
  select,
  textarea,
} from './dom';
import {
  BUILTIN_POLL_MS,
  BUILTIN_STALL_MS,
  builtinCardProblem,
  ensureOriginPermission,
  store,
} from './state';

/** Providers offered by name under «Use your AI account»; the rest stay in the card's dropdown. */
const ACCOUNT_PRESETS: readonly PresetId[] = ['openai', 'anthropic', 'gemini', 'openrouter', 'groq'];

/** Active fetch-models abort controllers keyed by connection id. */
const fetchControllers = new Map<string, AbortController>();
/** Monotonic request counters per connection for testConnection. */
const testSeq = new Map<string, number>();

export function renderConnections(): HTMLElement {
  const list = el('div', { class: 'stack' });
  store.settings.connections.forEach((connection, index) => {
    list.append(renderConnectionCard(connection, index));
  });

  return section(
    'Providers',
    'The AI that reads your text. Your text and key go from this browser straight to the one you pick, and nowhere else. Add a second one and tick Backup on it: ProofKey tries it when the active one fails. Settings stay on this computer; to move them to another, use Back up your settings below.',
    isFreshDefault() ? renderFirstChoice() : null,
    list,
    el(
      'div',
      { class: 'row row--end' },
      button(
        '+ Add provider',
        () => {
          const connection = connectionFromPreset('custom', 'New provider');
          store.settings.connections.push(connection);
          store.expandedConnectionId = connection.id;
          store.pendingFocusSelector = `[data-conn-name-for="${CSS.escape(connection.id)}"]`;
          store.render();
        },
        'ghost',
      ),
    ),
  );
}

/** Whether the list still holds only the no-key connection a fresh install starts with. */
function isFreshDefault(): boolean {
  const [only] = store.settings.connections;
  return store.settings.connections.length === 1 && only?.transport === 'chrome_builtin' && !only.apiKey;
}

function renderFirstChoice(): HTMLElement {
  const accounts = el(
    'div',
    { class: 'row row--wrap' },
    ...ACCOUNT_PRESETS.map((id) => {
      const choose = button(getPreset(id).label, () => useAccountProvider(id));
      choose.dataset.accountPreset = id;
      return choose;
    }),
    button('Another one…', () => useAccountProvider('custom'), 'ghost'),
  );
  accounts.hidden = !store.firstChoiceAccountOpen;

  return el(
    'div',
    { class: 'first-choice', dataset: { firstChoice: '' } },
    el('p', { class: 'first-choice__lead', text: 'How do you want ProofKey to check your writing?' }),
    el(
      'div',
      { class: 'row row--wrap' },
      button('Free, on this computer', useFreeModel, store.firstChoiceAccountOpen ? 'secondary' : 'primary'),
      button(
        'Use your AI account',
        () => {
          store.firstChoiceAccountOpen = true;
          store.pendingFocusSelector = '[data-account-preset="openai"]';
          store.render();
        },
        store.firstChoiceAccountOpen ? 'primary' : 'secondary',
      ),
    ),
    el('p', {
      class: 'field__hint',
      text: store.firstChoiceAccountOpen
        ? 'Pick the company you have an account with. You paste its API key below; it stays in this browser.'
        : 'Free needs no account: the model runs on this computer, so your text stays here. An AI account (OpenAI, Anthropic, Google…) checks better and needs an API key from that company.',
    }),
    accounts,
  );
}

/** Chrome's own model where the browser has one; otherwise the model ProofKey runs in the browser. */
function useFreeModel(): void {
  store.firstChoiceAccountOpen = false;
  if (store.builtinState === 'no-api' || store.builtinState === 'unavailable') {
    useInBrowserModel();
    return;
  }
  const builtin = store.settings.connections.find((c) => c.transport === 'chrome_builtin');
  if (!builtin) return;
  store.settings.activeConnectionId = builtin.id;
  store.expandedConnectionId = builtin.id;
  store.pendingFocusSelector = `[data-conn-toggle="${CSS.escape(builtin.id)}"]`;
  store.render();
}

/** Adds a connection for the chosen company, makes it the one in use and opens it at the key field. */
function useAccountProvider(id: PresetId): void {
  const connection = connectionFromPreset(id);
  store.settings.connections.push(connection);
  store.settings.activeConnectionId = connection.id;
  store.expandedConnectionId = connection.id;
  store.firstChoiceAccountOpen = false;
  store.pendingFocusSelector = `[data-api-key-for="${CSS.escape(connection.id)}"]`;
  store.render();
}

interface CardHeaderHandles {
  nameEl: HTMLElement;
  modelEl: HTMLElement;
  warnBadge: HTMLElement;
  problemNotice: HTMLElement;
}

function renderConnectionCard(connection: Connection, index: number): HTMLElement {
  const preset = getPreset(connection.presetId);
  const isActive = connection.id === store.settings.activeConnectionId;
  const isExpanded = connection.id === store.expandedConnectionId;
  const problem = validateConnection(connection) ?? builtinCardProblem(connection);
  const bodyId = `conn-body-${connection.id}`;

  const nameEl = el('span', { class: 'conn__name', text: connection.label || preset.label });
  const modelEl = el('span', {
    class: 'conn__model',
    text: connection.transport === 'chrome_builtin' ? BUILTIN_MODEL : connection.model || 'no model set',
  });
  const warnBadge = el('span', { class: 'badge badge--warn', text: 'Needs setup' });
  warnBadge.hidden = !problem;

  const header = el(
    'button',
    {
      class: 'conn__header',
      type: 'button',
      dataset: { connToggle: connection.id },
      attrs: { 'aria-expanded': String(isExpanded), 'aria-controls': bodyId },
      on: { click: () => toggle(connection.id) },
    },
    el(
      'span',
      { class: 'conn__identity' },
      el('span', { class: 'conn__chevron', text: '▸', attrs: { 'aria-hidden': 'true' } }),
      nameEl,
      isActive ? el('span', { class: 'badge badge--active', text: 'Active' }) : null,
      !isActive && store.settings.fallbackConnectionIds.includes(connection.id)
        ? el('span', { class: 'badge', text: 'Backup' })
        : null,
      warnBadge,
    ),
    modelEl,
  );

  const problemNotice = el('p', {
    class: 'notice notice--warn',
    text: problem ?? '',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  problemNotice.hidden = !problem;

  const handles: CardHeaderHandles = { nameEl, modelEl, warnBadge, problemNotice };
  const card = el('div', { class: `conn ${isExpanded ? 'conn--open' : ''}` }, header);
  if (isExpanded) {
    const body = renderConnectionBody(connection, index, handles);
    body.id = bodyId;
    card.append(body);
  }
  return card;
}

function syncCardLive(connection: Connection, handles: CardHeaderHandles): void {
  const preset = getPreset(connection.presetId);
  handles.nameEl.textContent = connection.label || preset.label;
  handles.modelEl.textContent =
    connection.transport === 'chrome_builtin' ? BUILTIN_MODEL : connection.model || 'no model set';
  const problem = validateConnection(connection) ?? builtinCardProblem(connection);
  handles.warnBadge.hidden = !problem;
  handles.problemNotice.hidden = !problem;
  handles.problemNotice.textContent = problem ?? '';
}

function toggle(id: string): void {
  store.expandedConnectionId = store.expandedConnectionId === id ? null : id;
  store.pendingFocusSelector = `[data-conn-toggle="${CSS.escape(id)}"]`;
  store.render();
}

function renderConnectionBody(
  connection: Connection,
  index: number,
  handles: CardHeaderHandles,
): HTMLElement {
  const presetOptions = PRESETS.map((p) => ({
    value: p.id,
    label: p.label,
    group: p.group === 'primary' ? 'Common' : 'More providers',
  }));

  const nameField = field(
    'Name',
    input(connection.label, {
      placeholder: 'Work key, Local Ollama…',
      dataset: { connNameFor: connection.id },
      on: {
        input: (e) => {
          connection.label = (e.target as HTMLInputElement).value;
          syncCardLive(connection, handles);
        },
      },
    }),
  );

  const providerField = field(
    'Provider',
    select(presetOptions, connection.presetId, {
      dataset: { connProviderFor: connection.id },
      on: {
        change: (e) => {
          store.pendingFocusSelector = `[data-conn-provider-for="${CSS.escape(connection.id)}"]`;
          applyPreset(connection, (e.target as HTMLSelectElement).value as PresetId);
        },
      },
    }),
    getPreset(connection.presetId).hint,
  );

  const testStatus = el('p', {
    class: 'status',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });

  let specific: (Node | null)[];
  if (connection.transport === 'chrome_builtin') {
    specific = renderBuiltinFields();
  } else if (connection.transport === 'in_browser') {
    specific = renderInBrowserFields();
  } else {
    specific = renderRemoteFields(connection, handles);
  }

  return el(
    'div',
    { class: 'conn__body' },
    connection.transport !== 'chrome_builtin' && connection.transport !== 'in_browser'
      ? handles.problemNotice
      : null,
    nameField,
    providerField,
    ...specific,
    testStatus,
    connectionActions(connection, index, testStatus),
  );
}

function renderRemoteFields(connection: Connection, handles: CardHeaderHandles): (Node | null)[] {
  const preset = getPreset(connection.presetId);
  const modelId = nextFieldId();
  const modelInput = input(connection.model, {
    id: modelId,
    placeholder: 'model name',
    on: {
      input: (e) => {
        connection.model = (e.target as HTMLInputElement).value;
        syncCardLive(connection, handles);
      },
    },
  });

  const modelStatus = el('p', {
    class: 'field__hint',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  const modelPicker = el('div', { class: 'field__picker' });
  const fetchBtn = button('Fetch models', () => {
    void fetchModels(connection, modelInput, modelPicker, modelStatus, fetchBtn, handles);
  });
  const modelRow = el('div', { class: 'row' }, modelInput, fetchBtn);

  // API key field with Show/Hide toggle and clickable docs link.
  const apiKeyInput = input(connection.apiKey, {
    type: 'password',
    placeholder: preset.requiresApiKey ? 'required' : 'not required',
    dataset: { apiKeyFor: connection.id },
    attrs: { autocomplete: 'new-password', spellcheck: 'false' },
    on: {
      input: (e) => {
        connection.apiKey = (e.target as HTMLInputElement).value;
        syncCardLive(connection, handles);
      },
    },
  });
  const toggleKeyBtn = button(
    'Show',
    () => {
      const showing = apiKeyInput.type === 'text';
      apiKeyInput.type = showing ? 'password' : 'text';
      toggleKeyBtn.textContent = showing ? 'Show' : 'Hide';
      toggleKeyBtn.setAttribute('aria-label', showing ? 'Show API key' : 'Hide API key');
    },
    'secondary',
  );
  toggleKeyBtn.setAttribute('aria-label', 'Show API key');

  const keyHint = el('p', { class: 'field__hint' }, 'Kept on this computer only.');
  if (preset.docsUrl) {
    keyHint.append(
      ' Get one at ',
      el('a', {
        text: preset.docsUrl,
        attrs: { href: preset.docsUrl, target: '_blank', rel: 'noopener noreferrer' },
      }),
      '.',
    );
  }
  const apiKeyId = nextFieldId();
  apiKeyInput.id = apiKeyId;
  keyHint.id = `${apiKeyId}-hint`;
  apiKeyInput.setAttribute('aria-describedby', keyHint.id);

  // Numeric fields with explicit inline validation.
  const maxTokensError = el('p', {
    class: 'field__hint field__hint--error',
    attrs: { role: 'alert' },
  });
  maxTokensError.hidden = true;
  const maxTokensInput = input(String(connection.maxOutputTokens), {
    type: 'number',
    attrs: { min: '1', step: '1' },
    on: {
      input: (e) => {
        const node = e.target as HTMLInputElement;
        const parsed = Number(node.value);
        const valid = node.value.trim() !== '' && Number.isFinite(parsed) && parsed > 0;
        node.classList.toggle('input--invalid', !valid);
        node.setAttribute('aria-invalid', String(!valid));
        maxTokensError.hidden = valid;
        maxTokensError.textContent = valid ? '' : 'Enter a number greater than 0.';
        if (valid) connection.maxOutputTokens = Math.round(parsed);
      },
    },
  });

  const tempError = el('p', {
    class: 'field__hint field__hint--error',
    attrs: { role: 'alert' },
  });
  tempError.hidden = true;
  const tempInput = input(connection.temperature === undefined ? '' : String(connection.temperature), {
    placeholder: 'leave empty to omit',
    on: {
      input: (e) => {
        const node = e.target as HTMLInputElement;
        const raw = node.value.trim();
        if (!raw) {
          node.classList.remove('input--invalid');
          node.setAttribute('aria-invalid', 'false');
          tempError.hidden = true;
          tempError.textContent = '';
          connection.temperature = undefined;
          return;
        }
        const parsed = Number(raw);
        const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 2;
        node.classList.toggle('input--invalid', !valid);
        node.setAttribute('aria-invalid', String(!valid));
        tempError.hidden = valid;
        tempError.textContent = valid ? '' : 'Enter a number between 0 and 2, or leave empty.';
        if (valid) connection.temperature = parsed;
      },
    },
  });

  const advancedDetails = el(
    'details',
    {
      class: 'advanced',
      ...(store.openAdvancedIds.has(connection.id) ? { attrs: { open: '' } } : {}),
      on: {
        toggle: (e) => {
          const open = (e.target as HTMLDetailsElement).open;
          if (open) store.openAdvancedIds.add(connection.id);
          else store.openAdvancedIds.delete(connection.id);
        },
      },
    },
    el('summary', { text: 'Advanced — auth style, extra headers and body' }),
    field(
      'Key is sent as',
      select(
        [
          { value: 'bearer', label: 'Authorization: Bearer <key>' },
          { value: 'x-api-key', label: 'x-api-key: <key>' },
          { value: 'header', label: 'A custom header' },
          { value: 'query', label: 'A URL query parameter' },
          { value: 'none', label: 'Not sent (local server)' },
        ],
        connection.authStyle,
        {
          dataset: { authStyleFor: connection.id },
          on: {
            change: (e) => {
              connection.authStyle = (e.target as HTMLSelectElement).value as AuthStyle;
              store.openAdvancedIds.add(connection.id);
              store.pendingFocusSelector = `[data-auth-style-for="${CSS.escape(connection.id)}"]`;
              store.render();
            },
          },
        },
      ),
    ),
    connection.authStyle === 'header'
      ? field(
          'Header name',
          input(connection.authHeaderName ?? '', {
            placeholder: 'api-key',
            on: {
              input: (e) => {
                connection.authHeaderName = (e.target as HTMLInputElement).value;
                syncCardLive(connection, handles);
              },
            },
          }),
        )
      : null,
    connection.authStyle === 'query'
      ? field(
          'Query parameter name',
          input(connection.authQueryParam ?? '', {
            placeholder: 'key',
            on: {
              input: (e) => {
                connection.authQueryParam = (e.target as HTMLInputElement).value;
                syncCardLive(connection, handles);
              },
            },
          }),
        )
      : null,
    field(
      'Thinking',
      select(
        [
          { value: 'off', label: 'Turn it off where the provider allows it' },
          { value: 'default', label: "Leave the endpoint's own default" },
        ],
        connection.thinking,
        {
          dataset: { thinkingFor: connection.id },
          on: {
            change: (e) => {
              connection.thinking = (e.target as HTMLSelectElement).value as Connection['thinking'];
              store.openAdvancedIds.add(connection.id);
              store.pendingFocusSelector = `[data-thinking-for="${CSS.escape(connection.id)}"]`;
              store.render();
            },
          },
        },
      ),
      thinkingNote(connection),
    ),
    jsonField(
      'Extra headers',
      connection.extraHeaders,
      true,
      (value) => {
        connection.extraHeaders = value as Record<string, string>;
      },
      'JSON object with text values. Added to every request — useful for gateways that need attribution or routing headers.',
    ),
    jsonField(
      'Extra body fields',
      connection.extraBody,
      false,
      (value) => (connection.extraBody = value),
      'JSON object merged into the request body, e.g. provider routing preferences.',
    ),
    jsonField(
      'Extra query parameters',
      connection.extraQuery,
      true,
      (value) => {
        connection.extraQuery = value as Record<string, string>;
      },
      'JSON object with text values appended to the URL, e.g. {"api-version": "2024-10-21"} for Azure.',
    ),
    el('div', {}, field('Max output tokens', maxTokensInput), maxTokensError),
    el(
      'div',
      {},
      field(
        'Temperature',
        tempInput,
        'Best left empty. Current Anthropic models reject this parameter outright.',
      ),
      tempError,
    ),
  );

  return [
    field(
      'Base URL',
      input(connection.baseUrl, {
        placeholder: 'https://api.example.com/v1',
        on: {
          input: (e) => {
            connection.baseUrl = (e.target as HTMLInputElement).value;
            syncCardLive(connection, handles);
          },
          blur: (e) => {
            const node = e.target as HTMLInputElement;
            node.value = normalizeBaseUrl(node.value);
            connection.baseUrl = node.value;
            syncCardLive(connection, handles);
          },
        },
      }),
      'Pasting a full /chat/completions URL is fine — the endpoint path is trimmed off.',
    ),
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'field__label', htmlFor: apiKeyId, text: 'API key' }),
      el('div', { class: 'row' }, apiKeyInput, toggleKeyBtn),
      keyHint,
    ),
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'field__label', htmlFor: modelId, text: 'Model' }),
      modelRow,
      modelPicker,
      modelStatus,
    ),
    advancedDetails,
  ];
}

function jsonField(
  label: string,
  value: Record<string, unknown>,
  stringValuesOnly: boolean,
  onValid: (value: Record<string, unknown>) => void,
  hint: string,
): HTMLElement {
  const errNode = el('p', {
    class: 'field__hint field__hint--error',
    attrs: { role: 'alert' },
  });
  errNode.hidden = true;

  const area = textarea(Object.keys(value).length ? JSON.stringify(value, null, 2) : '', {
    rows: 3,
    placeholder: '{}',
    on: {
      input: (e) => {
        const node = e.target as HTMLTextAreaElement;
        const parsed = stringValuesOnly ? parseStringRecord(node.value) : parseJsonObject(node.value);
        const valid = parsed !== null;
        node.classList.toggle('input--invalid', !valid);
        node.setAttribute('aria-invalid', String(!valid));
        errNode.hidden = valid;
        errNode.textContent = valid
          ? ''
          : stringValuesOnly
            ? 'Must be a JSON object with string values only (e.g. {"X-Key": "value"}).'
            : 'Must be a valid JSON object (e.g. {"key": "value"}).';
        if (parsed) onValid(parsed);
      },
    },
  });

  return el('div', {}, field(label, area, hint), errNode);
}

function backupBox(connection: Connection): HTMLElement {
  const box = checkbox(
    'Backup: try this one when the active one fails',
    store.settings.fallbackConnectionIds.includes(connection.id),
    (on) => {
      const backups = new Set(store.settings.fallbackConnectionIds);
      if (on) backups.add(connection.id);
      else backups.delete(connection.id);
      store.settings.fallbackConnectionIds = store.settings.connections
        .map((c) => c.id)
        .filter((id) => backups.has(id));
      store.pendingFocusSelector = `[data-backup-for="${CSS.escape(connection.id)}"]`;
      store.render();
    },
  );
  const inputBox = box.querySelector('input');
  inputBox?.setAttribute('data-backup', '');
  inputBox?.setAttribute('data-backup-for', connection.id);
  return el(
    'div',
    { class: 'conn__backup' },
    box,
    el('p', {
      class: 'field__hint',
      text: 'Useful when the active one is not always there: a server on this computer that is not running, a provider that is down, an account out of credit. Backups are tried in the order the providers are listed.',
    }),
  );
}

function moveConnection(index: number, delta: -1 | 1): void {
  const list = store.settings.connections;
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  const [moved] = list.splice(index, 1);
  list.splice(target, 0, moved!);
  // Keep fallbackConnectionIds aligned with the visible connection order.
  const backups = new Set(store.settings.fallbackConnectionIds);
  store.settings.fallbackConnectionIds = list.map((c) => c.id).filter((id) => backups.has(id));
  store.pendingFocusSelector = `[data-conn-move="${CSS.escape(moved!.id)}-${delta < 0 ? 'up' : 'down'}"]`;
  store.render();
}

function removeConnection(connection: Connection): void {
  fetchControllers.get(connection.id)?.abort();
  fetchControllers.delete(connection.id);
  document.getElementById(`models-${connection.id}`)?.remove();
  store.openAdvancedIds.delete(connection.id);
  store.settings.connections = store.settings.connections.filter((c) => c.id !== connection.id);
  store.settings.fallbackConnectionIds = store.settings.fallbackConnectionIds.filter(
    (id) => id !== connection.id,
  );
  if (store.settings.activeConnectionId === connection.id) {
    store.settings.activeConnectionId = store.settings.connections[0]!.id;
  }
  if (store.settings.liveCheck.connectionId === connection.id) {
    delete store.settings.liveCheck.connectionId;
  }
  store.expandedConnectionId = store.settings.activeConnectionId;
  store.render();
}

function connectionActions(
  connection: Connection,
  index: number,
  testStatus: HTMLElement,
): HTMLElement {
  const isActive = connection.id === store.settings.activeConnectionId;
  const total = store.settings.connections.length;

  const testBtn = button(
    'Test',
    () => void testConnection(connection, testStatus, testBtn),
    'secondary',
  );

  // Two-step inline confirmation when removing a provider that holds an API key.
  let removeControl: HTMLElement | null = null;
  if (total > 1) {
    if (connection.apiKey.trim()) {
      const wrap = el('div', { class: 'row' });
      const showInitial = (): void => {
        clear(wrap);
        wrap.append(
          button(
            'Remove',
            () => {
              clear(wrap);
              wrap.append(
                button('Confirm remove', () => removeConnection(connection), 'danger'),
                button('Cancel', showInitial, 'ghost'),
              );
            },
            'danger',
          ),
        );
      };
      showInitial();
      removeControl = wrap;
    } else {
      removeControl = button('Remove', () => removeConnection(connection), 'danger');
    }
  }

  const moveUp =
    total > 1 && index > 0
      ? (() => {
          const b = button('↑', () => moveConnection(index, -1), 'ghost');
          b.title = 'Move provider up';
          b.setAttribute('aria-label', `Move ${connection.label} up`);
          b.dataset.connMove = `${connection.id}-up`;
          return b;
        })()
      : null;
  const moveDown =
    total > 1 && index < total - 1
      ? (() => {
          const b = button('↓', () => moveConnection(index, 1), 'ghost');
          b.title = 'Move provider down';
          b.setAttribute('aria-label', `Move ${connection.label} down`);
          b.dataset.connMove = `${connection.id}-down`;
          return b;
        })()
      : null;

  const row = el(
    'div',
    { class: 'row row--between' },
    el(
      'div',
      { class: 'row row--wrap' },
      testBtn,
      isActive
        ? null
        : button(
            'Make active',
            () => {
              store.settings.activeConnectionId = connection.id;
              store.settings.fallbackConnectionIds = store.settings.fallbackConnectionIds.filter(
                (id) => id !== connection.id,
              );
              store.pendingFocusSelector = `[data-conn-toggle="${CSS.escape(connection.id)}"]`;
              store.render();
            },
            'primary',
          ),
      moveUp,
      moveDown,
    ),
    removeControl,
  );
  return el('div', {}, isActive ? null : backupBox(connection), row);
}

// -------------------------------------------------------- in-browser model

async function askInBrowser(op: 'status' | 'download' | 'delete'): Promise<InBrowserState> {
  try {
    const reply = (await chrome.runtime.sendMessage({ type: 'proofkey:in-browser', op })) as
      | { ok: true; value: InBrowserState }
      | { ok: false; error: string }
      | undefined;
    if (!reply?.ok) return { kind: 'error', message: reply?.error ?? 'The in-browser model did not answer.' };
    return reply.value;
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

function renderInBrowserFields(): (Node | null)[] {
  const state = el('p', {
    class: 'field__hint',
    dataset: { inBrowserState: '' },
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  const progress = el('progress', {
    class: 'field__progress',
    max: 1,
    value: 0,
    dataset: { inBrowserProgress: '' },
  });
  let confirmingDelete = false;

  const download = button(
    `Download model (${(IN_BROWSER_DOWNLOAD_BYTES / 1e9).toFixed(1)} GB from ${IN_BROWSER_DOWNLOAD_HOST})`,
    () => void act('download'),
    'primary',
  );
  const remove = button(
    'Remove the downloaded model',
    () => {
      confirmingDelete = true;
      paint();
    },
    'danger',
  );
  const confirmRemove = button(
    `Confirm remove (${(IN_BROWSER_DOWNLOAD_BYTES / 1e9).toFixed(1)} GB)`,
    () => {
      confirmingDelete = false;
      void act('delete');
    },
    'danger',
  );
  const cancelRemove = button(
    'Cancel',
    () => {
      confirmingDelete = false;
      paint();
    },
    'ghost',
  );

  const paint = (): void => {
    const current = store.inBrowserState;
    const ready = current?.kind === 'ready';
    if (!ready) confirmingDelete = false;
    download.hidden = current?.kind !== 'not-downloaded' && current?.kind !== 'error';
    remove.hidden = !ready || confirmingDelete;
    confirmRemove.hidden = !ready || !confirmingDelete;
    cancelRemove.hidden = !ready || !confirmingDelete;
    progress.hidden = current?.kind !== 'downloading';
    if (current?.kind === 'downloading') progress.value = current.fraction;
    state.className =
      current?.kind === 'no-webgpu' || current?.kind === 'error'
        ? 'field__hint field__hint--error'
        : 'field__hint';
    state.textContent = current ? describeInBrowserState(current) : 'Checking this browser…';
  };

  let refreshing = false;
  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    clearTimeout(store.inBrowserPoll);
    if (!state.isConnected) return;
    refreshing = true;
    try {
      store.inBrowserState = await askInBrowser('status');
      if (!state.isConnected) return;
      paint();
      if (store.inBrowserState.kind === 'downloading') {
        store.inBrowserPoll = setTimeout(() => void refresh(), 1000);
      }
    } finally {
      refreshing = false;
    }
  };

  const act = async (op: 'download' | 'delete'): Promise<void> => {
    download.disabled = remove.disabled = confirmRemove.disabled = true;
    try {
      store.inBrowserState = await askInBrowser(op);
    } finally {
      download.disabled = remove.disabled = confirmRemove.disabled = false;
    }
    if (!state.isConnected) return;
    paint();
    void refresh();
  };

  paint();
  queueMicrotask(() => void refresh());

  return [
    el(
      'div',
      { class: 'field' },
      el('p', { class: 'field__label', text: 'Model' }),
      el('div', { class: 'row row--wrap' }, download, remove, confirmRemove, cancelRemove),
      progress,
      state,
    ),
  ];
}

// ------------------------------------------------------ local model finder

function renderLocalFinder(): HTMLElement {
  const status = el('div', {
    dataset: { localFinderStatus: '' },
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  if (store.localFinder) {
    status.className =
      store.localFinder.kind === 'error' ? 'field__hint field__hint--error' : 'field__hint';
    for (const line of store.localFinder.lines) status.append(el('p', { text: line }));
  }
  const find = button('Find a model on this computer', findLocalModel, 'primary');
  find.disabled = !!store.localFinder?.searching;
  const inside = button('Run a model inside this browser', useInBrowserModel, 'secondary');
  return el(
    'div',
    { class: 'field', dataset: { localFinder: '' } },
    el('p', { class: 'field__label', text: 'No key: a model on this computer' }),
    el('p', {
      class: 'field__hint',
      text:
        'LM Studio, Ollama or llama.cpp running here work the same way, with nothing sent off this computer. ' +
        `Or ProofKey can run one inside this browser on the GPU: a ${(IN_BROWSER_DOWNLOAD_BYTES / 1e9).toFixed(1)} GB download, once, then nothing leaves.`,
    }),
    el('div', { class: 'row row--wrap' }, find, inside),
    status,
  );
}

function useInBrowserModel(): void {
  let connection = store.settings.connections.find((c) => c.transport === 'in_browser');
  if (!connection) {
    connection = connectionFromPreset('in-browser');
    store.settings.connections.push(connection);
  }
  store.settings.activeConnectionId = connection.id;
  store.expandedConnectionId = connection.id;
  store.render();
}

function findLocalModel(): void {
  const granted = chrome.permissions.request({ origins: localServerOrigins() });
  store.localFinder = { searching: true, lines: ['Looking on this computer…'], kind: 'info' };
  store.render();
  granted
    .catch(() => false)
    .then(async (ok) => {
      if (!ok) {
        store.localFinder = {
          searching: false,
          lines: ["Access to this computer's model servers was not granted, so nothing was checked."],
          kind: 'error',
        };
        return;
      }
      store.localFinder = { searching: false, ...adoptLocalServer(await findLocalServers()) };
    })
    .catch((error: unknown) => {
      store.localFinder = { searching: false, lines: [String(error)], kind: 'error' };
    })
    .finally(() => store.render());
}

function adoptLocalServer(probes: LocalServerProbe[]): { lines: string[]; kind: 'ok' | 'error' | 'info' } {
  const seen = probes.map(describeProbe).filter((line): line is string => !!line);
  const usable = probes.find(
    (p): p is Extract<LocalServerProbe, { status: 'found' }> => p.status === 'found' && p.models.length > 0,
  );
  if (!usable) {
    return {
      kind: seen.length > 0 ? 'error' : 'info',
      lines: [
        ...(seen.length > 0 ? seen : ['Nothing is running on the usual ports (LM Studio 1234, Ollama 11434, llama.cpp 8080).']),
        "Start a model server here, load a model, then click again. On Ollama, gemma4:e4b scored 12.7 of 14 on ProofKey's live check with no false alarms, against 13.0 for Chrome's built-in model; on llama.cpp, Qwen3-4B-Instruct-2507 scored 11.0. LM Studio speaks the same protocol but has not been measured here.",
      ],
    };
  }
  const { server, models } = usable;
  let connection = store.settings.connections.find(
    (c) => c.transport !== 'chrome_builtin' && normalizeBaseUrl(c.baseUrl) === normalizeBaseUrl(server.baseUrl),
  );
  if (!connection) {
    connection = connectionFromPreset(server.presetId, server.label);
    connection.baseUrl = server.baseUrl;
    store.settings.connections.push(connection);
  }
  if (!models.includes(connection.model)) connection.model = models[0]!;
  store.settings.activeConnectionId = connection.id;
  return {
    kind: 'ok',
    lines: [
      ...seen,
      `Added ${server.label} with the model ${connection.model}, and made it the provider ProofKey tries first. Click Save to keep it.`,
    ],
  };
}

// --------------------------------------------------- Chrome built-in model

function startBuiltinDownload(): void {
  const running = downloadBuiltinModel((fraction) => {
    if (store.builtinDownload) {
      if (fraction !== store.builtinDownload.fraction) store.builtinDownload.movedAt = Date.now();
      store.builtinDownload.fraction = fraction;
    }
    paintBuiltinProgress();
  });
  store.builtinDownload = { fraction: 0, movedAt: Date.now() };
  store.builtinDownloadError = null;
  store.render();
  clearInterval(store.builtinDownloadPoll);
  store.builtinDownloadPoll = setInterval(() => {
    void builtinAvailability().then((state) => {
      if (!store.builtinDownload) return;
      if (state === 'available') {
        finishBuiltinDownload();
        store.builtinState = state;
        store.render();
      } else {
        paintBuiltinProgress();
      }
    });
  }, BUILTIN_POLL_MS);
  running.then(
    async () => {
      if (!store.builtinDownload) return;
      finishBuiltinDownload();
      store.builtinState = await builtinAvailability();
      store.render();
    },
    (error: unknown) => {
      if (!store.builtinDownload) return;
      finishBuiltinDownload(error);
      store.render();
    },
  );
}

function paintBuiltinProgress(): void {
  if (!store.builtinDownload) return;
  const bar = document.querySelector<HTMLProgressElement>('[data-builtin-progress]');
  const text = document.querySelector<HTMLElement>('[data-builtin-state]');
  if (bar) {
    bar.hidden = false;
    bar.value = store.builtinDownload.fraction;
  }
  if (!text) return;
  const percent = `Downloading… ${Math.round(store.builtinDownload.fraction * 100)}%`;
  text.textContent =
    Date.now() - store.builtinDownload.movedAt > BUILTIN_STALL_MS
      ? `${percent} — no progress for 2 minutes. If it stays like this, restart Chrome: the download carries on, and this card shows the model ready once it is.`
      : percent;
}

function finishBuiltinDownload(error: unknown = null): void {
  clearInterval(store.builtinDownloadPoll);
  store.builtinDownload = null;
  store.builtinDownloadError = error === null ? null : error instanceof Error ? error.message : String(error);
}

function renderBuiltinFields(): (Node | null)[] {
  const state = el('p', {
    class: 'field__hint',
    dataset: { builtinState: '' },
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  const progress = el('progress', {
    class: 'field__progress',
    max: 1,
    value: store.builtinDownload?.fraction ?? 0,
    dataset: { builtinProgress: '' },
  });
  const download = button('Download model', startBuiltinDownload, 'primary');
  const finder = renderLocalFinder();

  const paint = (): void => {
    const current = store.builtinDownload ? 'downloading' : store.builtinState;
    download.hidden = !!store.builtinDownload || current !== 'downloadable';
    progress.hidden = !store.builtinDownload;
    finder.hidden = !!store.builtinDownload || (current !== 'no-api' && current !== 'unavailable');
    if (store.builtinDownload) {
      state.className = 'field__hint';
      paintBuiltinProgress();
      return;
    }
    if (store.builtinDownloadError) {
      state.className = 'field__hint field__hint--error';
      state.textContent = store.builtinDownloadError;
      return;
    }
    state.className =
      current === 'no-api' || current === 'unavailable'
        ? 'field__hint field__hint--error'
        : 'field__hint';
    state.textContent =
      current === null
        ? 'Checking this browser…'
        : current === 'available'
          ? 'Ready. The model is on this computer, and ProofKey sends nothing you check anywhere.'
          : current === 'downloadable'
            ? 'Not downloaded yet. Click "Download model" — Chrome fetches it once, then it runs on this computer.'
            : (builtinProblem(current) ?? '');
  };
  paint();

  clearTimeout(store.builtinBgPoll);
  const poll = async (): Promise<void> => {
    if (!state.isConnected || store.builtinDownload) return;
    const latest = await builtinAvailability();
    if (!state.isConnected || store.builtinDownload) return;
    if (latest !== store.builtinState) {
      store.builtinState = latest;
      if (!store.cancelRecording) store.render();
    } else if (latest === 'downloading') {
      store.builtinBgPoll = setTimeout(() => void poll(), BUILTIN_POLL_MS);
    }
  };
  queueMicrotask(() => void poll());

  return [
    el(
      'div',
      { class: 'field' },
      el('p', { class: 'field__label', text: 'Model' }),
      el('div', { class: 'row' }, download),
      progress,
      state,
    ),
    finder,
  ];
}

// -------------------------------------------------- preset / fetch / test

function applyPreset(connection: Connection, presetId: PresetId): void {
  fetchControllers.get(connection.id)?.abort();
  fetchControllers.delete(connection.id);
  switchPreset(connection, presetId, LOCAL_SERVERS);
  store.render();
}

async function fetchModels(
  connection: Connection,
  target: HTMLInputElement,
  picker: HTMLElement,
  status: HTMLElement,
  trigger: HTMLButtonElement,
  handles: CardHeaderHandles,
): Promise<void> {
  fetchControllers.get(connection.id)?.abort();
  const controller = new AbortController();
  fetchControllers.set(connection.id, controller);

  trigger.disabled = true;
  status.textContent = 'Fetching…';
  status.className = 'field__hint';

  try {
    if (!(await ensureOriginPermission(connection))) {
      if (controller.signal.aborted || !status.isConnected) return;
      status.textContent = 'Access to that endpoint was not granted.';
      status.className = 'field__hint field__hint--error';
      return;
    }

    const preset = getPreset(connection.presetId);
    const models = (await listModels(connection, controller.signal)).map((id) =>
      preset.stripIdPrefix && id.startsWith(preset.stripIdPrefix)
        ? id.slice(preset.stripIdPrefix.length)
        : id,
    );
    if (controller.signal.aborted || !status.isConnected) return;

    clear(picker);
    if (models.length === 0) {
      status.textContent = 'The endpoint returned no models. Type the name manually.';
      return;
    }

    const list = el('datalist', { id: `models-${connection.id}` });
    for (const model of models) list.append(el('option', { value: model }));
    document.getElementById(list.id)?.remove();
    document.body.append(list);
    target.setAttribute('list', list.id);

    const BROWSE = '';
    picker.append(
      select(
        [
          { value: BROWSE, label: `Browse all ${models.length}…` },
          ...models.map((model) => ({ value: model, label: model })),
        ],
        BROWSE,
        {
          attrs: { 'aria-label': 'Browse fetched models' },
          on: {
            change: (event) => {
              const chosen = (event.target as HTMLSelectElement).value;
              if (!chosen) return;
              connection.model = chosen;
              target.value = chosen;
              syncCardLive(connection, handles);
              store.refreshUnsaved();
            },
          },
        },
      ),
    );

    if (!connection.model && preset.defaultModel && models.includes(preset.defaultModel)) {
      connection.model = preset.defaultModel;
      target.value = preset.defaultModel;
      syncCardLive(connection, handles);
      store.refreshUnsaved();
    }

    const count = models.length === 1 ? '1 model' : `${models.length} models`;
    status.textContent = connection.model
      ? `${count}. Type in the field to filter, or use the list to browse all of them.`
      : `${count}. Pick one from the list, or type a name.`;
  } catch (error) {
    if (controller.signal.aborted || !status.isConnected) return;
    status.textContent = error instanceof Error ? error.message : String(error);
    status.className = 'field__hint field__hint--error';
  } finally {
    if (fetchControllers.get(connection.id) === controller) fetchControllers.delete(connection.id);
    if (trigger.isConnected) trigger.disabled = false;
  }
}

async function testConnection(
  connection: Connection,
  status: HTMLElement,
  trigger: HTMLButtonElement,
): Promise<void> {
  const seq = (testSeq.get(connection.id) ?? 0) + 1;
  testSeq.set(connection.id, seq);
  const stale = () => testSeq.get(connection.id) !== seq || !status.isConnected;

  trigger.disabled = true;
  status.textContent = 'Testing…';
  status.className = 'status';

  try {
    if (!(await ensureOriginPermission(connection))) {
      if (stale()) return;
      status.textContent = 'Access to that endpoint was not granted.';
      status.className = 'status status--error';
      return;
    }

    if (connection.transport === 'in_browser') {
      const reply = (await chrome.runtime.sendMessage({ type: 'proofkey:in-browser', op: 'test' })) as
        | { ok: true; value: { model: string; text: string } }
        | { ok: false; error: string }
        | undefined;
      if (stale()) return;
      if (reply?.ok) {
        status.textContent = `Working — ${reply.value.model} replied "${reply.value.text.trim().slice(0, 40)}".`;
        status.className = 'status status--ok';
      } else {
        status.textContent = reply?.error ?? 'The in-browser model did not answer.';
        status.className = 'status status--error';
      }
      return;
    }

    const result = await runCompletion([connection], {
      systemPrompt: 'Reply with exactly: ok',
      userText: 'ping',
    });
    if (stale()) return;
    if (result.movedModel) {
      status.textContent = `${connection.label} does not serve ${result.movedModel.from}; it is not in its model list. ${result.movedModel.to} answered instead — pick it or another listed model.`;
      status.className = 'status status--error';
      return;
    }
    status.textContent = `Working — ${result.model} replied "${result.text.trim().slice(0, 40)}".`;
    status.className = 'status status--ok';
  } catch (error) {
    if (stale()) return;
    status.textContent = error instanceof Error ? error.message : String(error);
    status.className = 'status status--error';
  } finally {
    if (trigger.isConnected) trigger.disabled = false;
  }
}
