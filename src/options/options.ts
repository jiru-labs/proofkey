import { getPreset, normalizeBaseUrl, PRESETS } from '../core/presets';
import { BUILT_IN_ACTIONS } from '../core/prompts';
import { listModels, originPattern, runCompletion, validateConnection } from '../core/providers';
import {
  connectionChain,
  connectionFromPreset,
  loadSettings,
  newConnectionId,
  resolveActions,
  saveSettings,
} from '../core/storage';
import type { AuthStyle, Connection, PresetId, Settings } from '../core/types';
import {
  button,
  checkbox,
  clear,
  el,
  field,
  input,
  lines,
  parseJsonObject,
  select,
  textarea,
} from './dom';

let settings: Settings;
let expandedConnectionId: string | null = null;

const app = document.querySelector<HTMLDivElement>('#app')!;

void init();

async function init(): Promise<void> {
  settings = await loadSettings();
  expandedConnectionId = settings.activeConnectionId;
  render();
}

function render(): void {
  clear(app);
  app.append(
    renderConnections(),
    renderProfile(),
    renderActions(),
    renderLiveCheck(),
    renderFooter(),
  );
}

function section(title: string, subtitle: string, ...children: (Node | null)[]): HTMLElement {
  return el(
    'section',
    { class: 'card' },
    el('h2', { class: 'card__title', text: title }),
    el('p', { class: 'card__subtitle', text: subtitle }),
    ...children,
  );
}

// ------------------------------------------------------------- connections

function renderConnections(): HTMLElement {
  const list = el('div', { class: 'stack' });
  for (const connection of settings.connections) {
    list.append(renderConnectionCard(connection));
  }

  return section(
    'Providers',
    'Your key goes straight from this browser to the endpoint you choose. Add more than one and ProofKey falls back down the list when a request fails.',
    list,
    el(
      'div',
      { class: 'row row--end' },
      button(
        '+ Add provider',
        () => {
          const connection = connectionFromPreset('custom', 'New provider');
          settings.connections.push(connection);
          expandedConnectionId = connection.id;
          render();
        },
        'ghost',
      ),
    ),
  );
}

function renderConnectionCard(connection: Connection): HTMLElement {
  const preset = getPreset(connection.presetId);
  const isActive = connection.id === settings.activeConnectionId;
  const isExpanded = connection.id === expandedConnectionId;
  const problem = validateConnection(connection);

  const header = el(
    'div',
    { class: 'conn__header', on: { click: () => toggle(connection.id) } },
    el(
      'div',
      { class: 'conn__identity' },
      el('span', { class: 'conn__name', text: connection.label || preset.label }),
      isActive ? el('span', { class: 'badge badge--active', text: 'Active' }) : null,
      problem ? el('span', { class: 'badge badge--warn', text: 'Needs setup' }) : null,
    ),
    el('span', { class: 'conn__model', text: connection.model || 'no model set' }),
  );

  const card = el('div', { class: `conn ${isExpanded ? 'conn--open' : ''}` }, header);
  if (isExpanded) card.append(renderConnectionBody(connection, problem));
  return card;
}

function toggle(id: string): void {
  expandedConnectionId = expandedConnectionId === id ? null : id;
  render();
}

function renderConnectionBody(connection: Connection, problem: string | null): HTMLElement {
  const presetOptions = PRESETS.map((p) => ({
    value: p.id,
    label: p.label,
    group: p.group === 'primary' ? 'Common' : 'More providers',
  }));

  const modelInput = input(connection.model, {
    placeholder: 'model name',
    on: { input: (e) => (connection.model = (e.target as HTMLInputElement).value) },
  });

  const modelStatus = el('p', { class: 'field__hint' });
  const modelRow = el(
    'div',
    { class: 'row' },
    modelInput,
    button('Fetch models', () => void fetchModels(connection, modelInput, modelStatus)),
  );

  const testStatus = el('p', { class: 'status' });

  return el(
    'div',
    { class: 'conn__body' },
    problem ? el('p', { class: 'notice notice--warn', text: problem }) : null,

    field(
      'Name',
      input(connection.label, {
        placeholder: 'Work key, Local Ollama…',
        on: { input: (e) => (connection.label = (e.target as HTMLInputElement).value) },
      }),
    ),

    field(
      'Provider',
      select(presetOptions, connection.presetId, {
        on: { change: (e) => applyPreset(connection, (e.target as HTMLSelectElement).value as PresetId) },
      }),
      getPreset(connection.presetId).hint,
    ),

    field(
      'Base URL',
      input(connection.baseUrl, {
        placeholder: 'https://api.example.com/v1',
        on: {
          input: (e) => (connection.baseUrl = (e.target as HTMLInputElement).value),
          blur: (e) => {
            const el_ = e.target as HTMLInputElement;
            el_.value = normalizeBaseUrl(el_.value);
            connection.baseUrl = el_.value;
          },
        },
      }),
      'Pasting a full /chat/completions URL is fine — the endpoint path is trimmed off.',
    ),

    field(
      'API key',
      input(connection.apiKey, {
        type: 'password',
        placeholder: getPreset(connection.presetId).requiresApiKey ? 'required' : 'not required',
        on: { input: (e) => (connection.apiKey = (e.target as HTMLInputElement).value) },
      }),
      getPreset(connection.presetId).docsUrl
        ? `Get one at ${getPreset(connection.presetId).docsUrl}`
        : undefined,
    ),

    el('div', { class: 'field' }, el('label', { class: 'field__label', text: 'Model' }), modelRow, modelStatus),

    el(
      'details',
      { class: 'advanced' },
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
            on: {
              change: (e) => {
                connection.authStyle = (e.target as HTMLSelectElement).value as AuthStyle;
                render();
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
              on: { input: (e) => (connection.authHeaderName = (e.target as HTMLInputElement).value) },
            }),
          )
        : null,
      connection.authStyle === 'query'
        ? field(
            'Query parameter name',
            input(connection.authQueryParam ?? '', {
              placeholder: 'key',
              on: { input: (e) => (connection.authQueryParam = (e.target as HTMLInputElement).value) },
            }),
          )
        : null,
      field(
        'Extra headers',
        jsonEditor(connection.extraHeaders, (value) => {
          connection.extraHeaders = value as Record<string, string>;
        }),
        'JSON object. Added to every request — useful for gateways that need attribution or routing headers.',
      ),
      field(
        'Extra body fields',
        jsonEditor(connection.extraBody, (value) => (connection.extraBody = value)),
        'JSON object merged into the request body, e.g. provider routing preferences.',
      ),
      field(
        'Extra query parameters',
        jsonEditor(connection.extraQuery, (value) => {
          connection.extraQuery = value as Record<string, string>;
        }),
        'JSON object appended to the URL, e.g. {"api-version": "2024-10-21"} for Azure.',
      ),
      field(
        'Max output tokens',
        input(String(connection.maxOutputTokens), {
          type: 'number',
          on: {
            input: (e) => {
              const parsed = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(parsed) && parsed > 0) connection.maxOutputTokens = parsed;
            },
          },
        }),
      ),
      field(
        'Temperature',
        input(connection.temperature === undefined ? '' : String(connection.temperature), {
          placeholder: 'leave empty to omit',
          on: {
            input: (e) => {
              const raw = (e.target as HTMLInputElement).value.trim();
              const parsed = Number(raw);
              connection.temperature = raw && Number.isFinite(parsed) ? parsed : undefined;
            },
          },
        }),
        'Best left empty. Current Anthropic models reject this parameter outright.',
      ),
    ),

    testStatus,
    el(
      'div',
      { class: 'row row--between' },
      el(
        'div',
        { class: 'row' },
        button('Test', () => void testConnection(connection, testStatus), 'secondary'),
        connection.id === settings.activeConnectionId
          ? null
          : button(
              'Make active',
              () => {
                settings.activeConnectionId = connection.id;
                render();
              },
              'primary',
            ),
      ),
      settings.connections.length > 1
        ? button(
            'Remove',
            () => {
              settings.connections = settings.connections.filter((c) => c.id !== connection.id);
              settings.fallbackConnectionIds = settings.fallbackConnectionIds.filter(
                (id) => id !== connection.id,
              );
              if (settings.activeConnectionId === connection.id) {
                settings.activeConnectionId = settings.connections[0]!.id;
              }
              render();
            },
            'danger',
          )
        : null,
    ),
  );
}

function jsonEditor(
  value: Record<string, unknown>,
  onValid: (value: Record<string, unknown>) => void,
): HTMLElement {
  const area = textarea(Object.keys(value).length ? JSON.stringify(value, null, 2) : '', {
    rows: 3,
    placeholder: '{}',
    on: {
      input: (e) => {
        const node = e.target as HTMLTextAreaElement;
        const parsed = parseJsonObject(node.value);
        node.classList.toggle('input--invalid', parsed === null);
        if (parsed) onValid(parsed);
      },
    },
  });
  return area;
}

function applyPreset(connection: Connection, presetId: PresetId): void {
  const preset = getPreset(presetId);
  const previous = getPreset(connection.presetId);

  // Only overwrite fields the user has not personalised away from the old preset.
  if (!connection.baseUrl || connection.baseUrl === previous.baseUrl) {
    connection.baseUrl = preset.baseUrl;
  }
  if (!connection.model || connection.model === previous.defaultModel) {
    connection.model = preset.defaultModel;
  }
  if (!connection.label || connection.label === previous.label) {
    connection.label = preset.label;
  }

  connection.presetId = presetId;
  connection.transport = preset.transport;
  connection.authStyle = preset.authStyle;
  connection.authHeaderName = preset.authHeaderName;
  connection.authQueryParam = preset.authQueryParam;
  connection.extraHeaders = { ...(preset.extraHeaders ?? {}) };
  connection.extraBody = { ...(preset.extraBody ?? {}) };
  connection.extraQuery = { ...(preset.extraQuery ?? {}) };
  render();
}

async function fetchModels(
  connection: Connection,
  target: HTMLInputElement,
  status: HTMLElement,
): Promise<void> {
  status.textContent = 'Fetching…';
  status.className = 'field__hint';

  if (!(await ensureOriginPermission(connection))) {
    status.textContent = 'Access to that endpoint was not granted.';
    status.className = 'field__hint field__hint--error';
    return;
  }

  try {
    const models = await listModels(connection);
    if (models.length === 0) {
      status.textContent = 'The endpoint returned no models. Type the name manually.';
      return;
    }

    const list = el('datalist', { id: `models-${connection.id}` });
    for (const model of models) list.append(el('option', { value: model }));
    document.getElementById(list.id)?.remove();
    document.body.append(list);
    target.setAttribute('list', list.id);

    if (!connection.model) {
      connection.model = models[0]!;
      target.value = models[0]!;
    }
    status.textContent = `${models.length} models available — click the field to pick one.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.className = 'field__hint field__hint--error';
  }
}

async function testConnection(connection: Connection, status: HTMLElement): Promise<void> {
  status.textContent = 'Testing…';
  status.className = 'status';

  if (!(await ensureOriginPermission(connection))) {
    status.textContent = 'Access to that endpoint was not granted.';
    status.className = 'status status--error';
    return;
  }

  try {
    const result = await runCompletion([connection], {
      systemPrompt: 'Reply with exactly: ok',
      userText: 'ping',
    });
    status.textContent = `Working — ${result.model} replied "${result.text.trim().slice(0, 40)}".`;
    status.className = 'status status--ok';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.className = 'status status--error';
  }
}

/**
 * Host access is requested here, from a click, rather than declared in the
 * manifest — so the extension only ever holds permission for endpoints the user
 * actually configured.
 *
 * `request` is called directly rather than after a `contains` check: awaiting
 * anything first discards the user gesture the prompt requires. Already-granted
 * origins resolve to true without showing a dialog, so the check bought nothing.
 */
async function ensureOriginPermission(connection: Connection): Promise<boolean> {
  const pattern = originPattern(connection);
  if (!pattern) return false;
  return chrome.permissions.request({ origins: [pattern] });
}

// ----------------------------------------------------------- writing rules

function renderProfile(): HTMLElement {
  const { profile } = settings;

  return section(
    'Your writing rules',
    'House terminology, banned phrases and words to leave alone. These are sent with every request, so the model follows your rules instead of generic ones.',

    field(
      'Style guide',
      textarea(profile.styleGuide, {
        rows: 6,
        placeholder:
          'We write "e-mail", not "email".\nNever say "utilise" — use "use".\nAvoid superlatives and empty phrases in product copy.\nKeep sentences under 25 words where possible.',
        on: { input: (e) => (profile.styleGuide = (e.target as HTMLTextAreaElement).value) },
      }),
      'Plain language, one rule per line. This is the same thing that costs a rule-based checker an XML file and a self-hosted server.',
    ),

    field(
      'Never change these',
      textarea(profile.neverFlag.join('\n'), {
        rows: 4,
        placeholder: 'Jiru Labs\nProofKey\nkubectl\nblend fabric',
        on: { input: (e) => (profile.neverFlag = lines((e.target as HTMLTextAreaElement).value)) },
      }),
      'One per line. Multi-word phrases are fine — brand names, jargon, product names.',
    ),

    field(
      'Your first language',
      input(profile.nativeLanguage, {
        placeholder: 'Portuguese, Japanese, Arabic…',
        on: { input: (e) => (profile.nativeLanguage = (e.target as HTMLInputElement).value) },
      }),
      'Optional. When set, ProofKey watches for the mistakes speakers of that language characteristically make when writing in another one.',
    ),

    field(
      'Explain corrections in',
      input(profile.explainLanguage, {
        placeholder: 'leave empty to use the language of the text',
        on: { input: (e) => (profile.explainLanguage = (e.target as HTMLInputElement).value) },
      }),
      'Useful when you are writing in a language you are still learning.',
    ),
  );
}

// ----------------------------------------------------------------- actions

function renderActions(): HTMLElement {
  const list = el('div', { class: 'stack' });

  for (const action of resolveActions(settings)) {
    const isBuiltIn = action.builtIn;
    const overridden = isBuiltIn && !!settings.builtInOverrides[action.id]?.systemPrompt;

    list.append(
      el(
        'details',
        { class: 'action' },
        el(
          'summary',
          { class: 'action__summary' },
          // Without this the checkbox click bubbles to <summary> and collapses
          // the very panel the user is trying to work in.
          el(
            'span',
            { on: { click: (event) => event.stopPropagation() } },
            checkbox(action.label, action.enabled, (enabled) =>
              setActionEnabled(action.id, isBuiltIn, enabled),
            ),
          ),
          overridden ? el('span', { class: 'badge', text: 'edited' }) : null,
          settings.defaultActionId === action.id
            ? el('span', { class: 'badge badge--active', text: 'shortcut' })
            : null,
        ),
        textarea(action.systemPrompt, {
          rows: 8,
          on: {
            input: (e) => setActionPrompt(action.id, isBuiltIn, (e.target as HTMLTextAreaElement).value),
          },
        }),
        el(
          'div',
          { class: 'row row--end' },
          settings.defaultActionId === action.id
            ? null
            : button(
                'Use for shortcut',
                () => {
                  settings.defaultActionId = action.id;
                  render();
                },
                'ghost',
              ),
          overridden
            ? button(
                'Reset to default',
                () => {
                  delete settings.builtInOverrides[action.id]?.systemPrompt;
                  render();
                },
                'ghost',
              )
            : null,
          isBuiltIn
            ? null
            : button(
                'Delete',
                () => {
                  settings.customActions = settings.customActions.filter((a) => a.id !== action.id);
                  render();
                },
                'danger',
              ),
        ),
      ),
    );
  }

  return section(
    'Actions',
    'Every action is just a prompt. Edit any of them, or add your own — they appear in the right-click menu.',
    list,
    el(
      'div',
      { class: 'row row--end' },
      button(
        '+ Add action',
        () => {
          settings.customActions.push({
            id: `custom-${newConnectionId().slice(0, 8)}`,
            label: 'My action',
            systemPrompt: 'Rewrite the text so that…',
            enabled: true,
          });
          render();
        },
        'ghost',
      ),
    ),
  );
}

function setActionEnabled(id: string, isBuiltIn: boolean, enabled: boolean): void {
  if (isBuiltIn) {
    settings.builtInOverrides[id] = { ...settings.builtInOverrides[id], enabled };
  } else {
    const action = settings.customActions.find((a) => a.id === id);
    if (action) action.enabled = enabled;
  }
}

function setActionPrompt(id: string, isBuiltIn: boolean, systemPrompt: string): void {
  if (isBuiltIn) {
    const original = BUILT_IN_ACTIONS.find((a) => a.id === id);
    if (original && original.systemPrompt === systemPrompt) {
      delete settings.builtInOverrides[id]?.systemPrompt;
      return;
    }
    settings.builtInOverrides[id] = { ...settings.builtInOverrides[id], systemPrompt };
  } else {
    const action = settings.customActions.find((a) => a.id === id);
    if (action) action.systemPrompt = systemPrompt;
  }
}

// ------------------------------------------------------------- live checks

function renderLiveCheck(): HTMLElement {
  const { liveCheck } = settings;

  return section(
    'Live checking',
    'Underlines as you type, on the sites you choose. Each check spends your key, so this stays off until you switch it on for a site.',

    field(
      'Enabled on',
      textarea(liveCheck.enabledOrigins.join('\n'), {
        rows: 3,
        placeholder: 'https://mail.google.com\nhttps://github.com',
        on: {
          input: (e) => (liveCheck.enabledOrigins = lines((e.target as HTMLTextAreaElement).value)),
        },
      }),
      'One origin per line. The toolbar button toggles the current site without coming here.',
    ),

    field(
      'Never run on',
      textarea(liveCheck.blockedOrigins.join('\n'), {
        rows: 2,
        placeholder: 'https://bank.example.com',
        on: {
          input: (e) => (liveCheck.blockedOrigins = lines((e.target as HTMLTextAreaElement).value)),
        },
      }),
      'Takes priority over the list above.',
    ),

    el(
      'div',
      { class: 'row' },
      field(
        'Idle delay (ms)',
        input(String(liveCheck.debounceMs), {
          type: 'number',
          on: {
            input: (e) => {
              const value = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(value) && value >= 200) liveCheck.debounceMs = value;
            },
          },
        }),
      ),
      field(
        'Minimum characters',
        input(String(liveCheck.minChars), {
          type: 'number',
          on: {
            input: (e) => {
              const value = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(value) && value >= 0) liveCheck.minChars = value;
            },
          },
        }),
      ),
    ),
  );
}

// ------------------------------------------------------------------ footer

function renderFooter(): HTMLElement {
  const status = el('span', { class: 'status' });

  return el(
    'div',
    { class: 'footer' },
    status,
    button('Save', () => void save(status), 'primary'),
  );
}

async function save(status: HTMLElement): Promise<void> {
  status.className = 'status';
  status.textContent = 'Saving…';

  for (const connection of settings.connections) {
    connection.baseUrl = normalizeBaseUrl(connection.baseUrl);
  }

  // Requested before any await, while the click that authorises the prompt is
  // still in scope. Origins already granted resolve without a dialog.
  const patterns = [...new Set(settings.connections.map(originPattern).filter((p): p is string => !!p))];
  if (patterns.length > 0) {
    try {
      await chrome.permissions.request({ origins: patterns });
    } catch {
      // Declining is a legitimate choice; the settings still save.
    }
  }

  try {
    await saveSettings(settings);
    const usable = connectionChain(settings).some((c) => validateConnection(c) === null);
    status.className = usable ? 'status status--ok' : 'status status--error';
    status.textContent = usable
      ? 'Saved.'
      : 'Saved, but no provider is usable yet — check the warnings above.';
  } catch (error) {
    status.className = 'status status--error';
    // storage.sync rejects items over its per-item quota; long prompts get there.
    status.textContent = `Could not save: ${error instanceof Error ? error.message : String(error)}`;
  }
}
