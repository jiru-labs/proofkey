import { normalizeOrigin, originMatchPattern } from '../core/browser';
import { getPreset, normalizeBaseUrl, PRESETS } from '../core/presets';
import { BUILT_IN_ACTIONS } from '../core/prompts';
import { listModels, originPattern, runCompletion, validateConnection } from '../core/providers';
import {
  chordFromEvent,
  chordProblem,
  chordWarning,
  describeShortcut,
  formatChord,
  isModifierCode,
  parseChord,
  parseCommandShortcut,
  serializeChord,
  suggestChord,
} from '../core/shortcuts';
import {
  connectionChain,
  connectionFromPreset,
  loadSettings,
  newConnectionId,
  resolveActions,
  saveSettings,
  setActionShortcut,
  shortcutConflicts,
} from '../core/storage';
import type { AuthStyle, Connection, PresetId, Settings, WritingAction } from '../core/types';
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

/**
 * Which action panels are open, so a re-render does not close the one the user
 * is working in. `<details>` keeps its open state in the DOM, and every edit
 * here rebuilds the DOM.
 */
const openActionIds = new Set<string>();

/** Survives the re-render that follows binding a key, so the result is readable. */
let shortcutNotice: { actionId: string; text: string; kind: 'ok' | 'error' } | null = null;
/** Action whose recorder should regain focus after that re-render. */
let focusShortcutFor: string | null = null;

/** Key legends as printed on this user's keyboard, when the browser will say. */
let layoutMap: Map<string, string> | null = null;
/** Chords the browser has given to ProofKey's own manifest commands. */
let commandChords: { name: string; chord: string; label: string }[] = [];

/** The manifest command that runs `defaultActionId`. Matches `background/index.ts`. */
const DEFAULT_ACTION_COMMAND = 'run-default-action';

const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.userAgent);

const app = document.querySelector<HTMLDivElement>('#app')!;

void init();

async function init(): Promise<void> {
  settings = await loadSettings();
  expandedConnectionId = settings.activeConnectionId;
  // Awaited before the first paint so shortcut labels never visibly change from
  // the US legend to the real one a moment later.
  await Promise.all([loadLayoutMap(), loadCommandChords()]);
  render();
}

/**
 * `navigator.keyboard` is Chromium-only and needs a focused document. Without
 * it, `keyLabel` falls back to the US legend, which is wrong on AZERTY but is
 * the only guess available.
 */
async function loadLayoutMap(): Promise<void> {
  const keyboard = (
    navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }
  ).keyboard;

  try {
    layoutMap = (await keyboard?.getLayoutMap?.()) ?? null;
  } catch {
    layoutMap = null;
  }
}

async function loadCommandChords(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    commandChords = commands.flatMap((command) => {
      const chord = parseCommandShortcut(command.shortcut ?? '');
      if (!chord) return [];
      return [
        {
          name: command.name ?? '',
          chord,
          label: command.description || command.name || 'a ProofKey command',
        },
      ];
    });
  } catch {
    commandChords = [];
  }
}

/** A stored chord as this user would read it. */
function shortcutLabel(chord: string): string {
  return describeShortcut(chord, { mac: IS_MAC, layout: layoutMap });
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

  if (focusShortcutFor) {
    app
      .querySelector<HTMLButtonElement>(`[data-shortcut-for="${CSS.escape(focusShortcutFor)}"]`)
      ?.focus();
    focusShortcutFor = null;
  }
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
  // Filled in by "Fetch models" with a browse list. Kept out of the row so a
  // long model id does not squeeze the input.
  const modelPicker = el('div', { class: 'field__picker' });
  const modelRow = el(
    'div',
    { class: 'row' },
    modelInput,
    button('Fetch models', () =>
      void fetchModels(connection, modelInput, modelPicker, modelStatus),
    ),
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

    el(
      'div',
      { class: 'field' },
      el('label', { class: 'field__label', text: 'Model' }),
      modelRow,
      modelPicker,
      modelStatus,
    ),

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
  picker: HTMLElement,
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
    const preset = getPreset(connection.presetId);
    const models = (await listModels(connection)).map((id) =>
      preset.stripIdPrefix && id.startsWith(preset.stripIdPrefix)
        ? id.slice(preset.stripIdPrefix.length)
        : id,
    );
    clear(picker);
    if (models.length === 0) {
      status.textContent = 'The endpoint returned no models. Type the name manually.';
      return;
    }

    // The datalist filters against whatever the input holds, so once the field
    // contains a full model id it narrows to that single line. That is correct
    // autocomplete behaviour and it reads as "the endpoint only has one model",
    // which is why the browse list below exists: it always shows all of them.
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
          on: {
            change: (event) => {
              const chosen = (event.target as HTMLSelectElement).value;
              if (!chosen) return;
              connection.model = chosen;
              target.value = chosen;
            },
          },
        },
      ),
    );

    // Never adopt models[0]. The list is sorted alphabetically, so the winner is
    // whatever sorts first rather than whatever is usable — on Gemini that is
    // `antigravity-preview-05-2026`, ahead of every gemini-* entry. Take the
    // preset's own default when the endpoint offers it, else leave the field
    // empty so the browse list opens unfiltered.
    if (!connection.model && preset.defaultModel && models.includes(preset.defaultModel)) {
      connection.model = preset.defaultModel;
      target.value = preset.defaultModel;
    }

    const count = models.length === 1 ? '1 model' : `${models.length} models`;
    status.textContent = connection.model
      ? `${count}. Type in the field to filter, or use the list to browse all of them.`
      : `${count}. Pick one from the list, or type a name.`;
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
  const conflicts = shortcutConflicts(settings);
  const actions = resolveActions(settings);
  // Undefined when the user has cleared it at chrome://extensions/shortcuts, in
  // which case naming a key here would be a lie.
  const globalCommand = commandChords.find((c) => c.name === DEFAULT_ACTION_COMMAND);

  for (const action of actions) {
    const isBuiltIn = action.builtIn;
    const overridden = isBuiltIn && !!settings.builtInOverrides[action.id]?.systemPrompt;
    const conflicted = !!action.shortcut && conflicts.has(action.shortcut);

    list.append(
      el(
        'details',
        {
          class: 'action',
          open: openActionIds.has(action.id),
          on: {
            toggle: (event) => {
              const open = (event.target as HTMLDetailsElement).open;
              if (open) openActionIds.add(action.id);
              else openActionIds.delete(action.id);
            },
          },
        },
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
          action.shortcut
            ? el('span', {
                class: `badge badge--key ${conflicted ? 'badge--warn' : ''}`,
                text: shortcutLabel(action.shortcut),
              })
            : null,
          settings.defaultActionId === action.id
            ? el('span', {
                class: 'badge badge--active',
                text: globalCommand ? `${shortcutLabel(globalCommand.chord)} · default` : 'default',
              })
            : null,
        ),
        textarea(action.systemPrompt, {
          rows: 8,
          on: {
            input: (e) => setActionPrompt(action.id, isBuiltIn, (e.target as HTMLTextAreaElement).value),
          },
        }),
        renderShortcutRow(action, conflicts),
        el(
          'div',
          { class: 'row row--end' },
          settings.defaultActionId === action.id
            ? null
            : button(
                globalCommand ? `Run this on ${shortcutLabel(globalCommand.chord)}` : 'Make default',
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
                  openActionIds.delete(action.id);
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
    'Every action is just a prompt. Edit any of them, or add your own — they appear in the right-click menu, and each one can have its own key.',
    // Chrome hands out `suggested_key` first-come-first-served: if another
    // extension already held the combination when ProofKey was installed, this
    // command is left unbound with no error anywhere. The key then reaches the
    // page instead, where a site is free to act on it — on WhatsApp Web
    // Ctrl+Shift+K inserts an empty monospace block, which reads as ProofKey
    // mangling the text rather than as ProofKey never having run.
    globalCommand
      ? null
      : el(
          'div',
          { class: 'notice notice--warn' },
          el('p', {
            class: 'notice__text',
            text:
              'No browser shortcut is assigned, so the default action can only be run from the right-click menu. ' +
              'Chrome leaves this unset when another extension already claimed the combination, and does not let ' +
              `an extension set it back — only you can, on the page below. ${IS_MAC ? '⌘⇧K' : 'Ctrl+Shift+K'} is the intended default.`,
          }),
          // The most an extension is permitted to do about its own command:
          // open the page. `tabs.create` may open chrome:// URLs even though
          // nothing else can touch them, and it needs no permission.
          button(
            'Open Chrome’s shortcut settings',
            () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }),
          ),
        ),
    list,
    el(
      'div',
      { class: 'row row--end' },
      button(
        '+ Add action',
        () => {
          const id = `custom-${newConnectionId().slice(0, 8)}`;
          settings.customActions.push({
            id,
            label: 'My action',
            systemPrompt: 'Rewrite the text so that…',
            enabled: true,
          });
          openActionIds.add(id);
          render();
        },
        'ghost',
      ),
    ),
    renderShortcutOrigins(),
  );
}

/** The per-action recorder: current key, a way to change it, a way to remove it. */
function renderShortcutRow(
  action: WritingAction,
  conflicts: Map<string, string[]>,
): HTMLElement {
  const trigger = el('button', {
    class: `btn shortcut__key ${action.shortcut ? '' : 'shortcut__key--empty'}`,
    type: 'button',
    text: action.shortcut ? shortcutLabel(action.shortcut) : 'Set a key…',
    dataset: { shortcutFor: action.id },
    on: { click: () => startRecording(action, trigger, hint) },
  });

  const hint = el('p', { class: 'field__hint' });

  if (shortcutNotice?.actionId === action.id) {
    hint.textContent = shortcutNotice.text;
    hint.className = `field__hint ${shortcutNotice.kind === 'error' ? 'field__hint--error' : ''}`;
    shortcutNotice = null;
  } else if (action.shortcut && conflicts.has(action.shortcut)) {
    const others = (conflicts.get(action.shortcut) ?? [])
      .filter((id) => id !== action.id)
      .map((id) => labelOf(id));
    hint.textContent = `Also bound to ${others.join(', ')} — only the first one in this list will run.`;
    hint.className = 'field__hint field__hint--error';
  } else if (action.shortcut && warningFor(action.shortcut)) {
    hint.textContent = warningFor(action.shortcut)!;
    hint.className = 'field__hint field__hint--error';
  } else if (!action.shortcut) {
    hint.textContent = 'Optional. Runs only on the sites listed at the bottom of this section.';
  }

  // Kept separate from `hint`, and not an `else` branch, because it has to
  // survive the "Set to Ctrl+Shift+H" confirmation. A key bound with no site
  // listed cannot fire anywhere, and the confirmation used to be the last thing
  // said on the subject — which reads as "done" when nothing is done.
  const stranded =
    action.shortcut && settings.shortcutOrigins.length === 0
      ? el('p', {
          class: 'field__hint field__hint--error',
          text: 'No sites are listed under "Shortcuts run on" below, so this key cannot run anywhere yet.',
        })
      : null;

  return el(
    'div',
    { class: 'shortcut' },
    el(
      'div',
      { class: 'row' },
      trigger,
      action.shortcut
        ? button(
            'Remove',
            () => {
              setActionShortcut(settings, action.id, null);
              shortcutNotice = { actionId: action.id, text: 'Key removed.', kind: 'ok' };
              focusShortcutFor = action.id;
              render();
            },
            'ghost',
          )
        : // Offered exactly where the user gets stuck. Recording alone could say
          // a chord was taken but never name one that was free, which turned
          // setting a key into guesswork against Chrome, the OS and the site.
          button('Suggest one', () => applySuggestion(action), 'ghost'),
    ),
    hint,
    stranded,
  );
}

function labelOf(actionId: string): string {
  return resolveActions(settings).find((a) => a.id === actionId)?.label ?? actionId;
}

/** The caution for a stored chord, if it has one. */
function warningFor(stored: string): string | null {
  const chord = parseChord(stored);
  return chord ? chordWarning(chord) : null;
}

/**
 * Every chord already spoken for — other actions, and the browser command the
 * manifest owns. Passed to `suggestChord` so it never offers a key that would
 * immediately have to be taken back off something else.
 */
function takenChords(exceptActionId: string): string[] {
  const bound = resolveActions(settings)
    .filter((other) => other.id !== exceptActionId && other.shortcut)
    .map((other) => other.shortcut!);
  return [...bound, ...commandChords.map((command) => command.chord)];
}

function applySuggestion(action: WritingAction): void {
  const chord = suggestChord(takenChords(action.id));
  shortcutNotice = chord
    ? {
        actionId: action.id,
        text: `Set to ${shortcutLabel(chord)}. Nothing else claims it — remember to save.`,
        kind: 'ok',
      }
    : {
        // Only reachable once every pooled chord is bound, which needs more
        // actions than the built-in set has. Still said rather than silent.
        actionId: action.id,
        text: 'Every key ProofKey can vouch for is already in use. Record one yourself.',
        kind: 'error',
      };

  if (chord) setActionShortcut(settings, action.id, chord);
  focusShortcutFor = action.id;
  render();
}

/**
 * Listens for one chord and stores it.
 *
 * Modifier-only keydowns are shown as a live preview rather than rejected, so
 * holding Ctrl+Alt before choosing the letter looks like it is working. The
 * check that matters happens on the first non-modifier key.
 */
function startRecording(
  action: WritingAction,
  trigger: HTMLButtonElement,
  hint: HTMLParagraphElement,
): void {
  cancelRecording?.();

  const restore = trigger.textContent ?? '';
  trigger.classList.add('shortcut__key--recording');
  trigger.textContent = PROMPT;
  hint.className = 'field__hint';
  hint.textContent = 'Press the combination you want. Esc cancels.';

  const stop = (): void => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onModifierRelease, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    trigger.classList.remove('shortcut__key--recording');
    cancelRecording = null;
  };

  const abandon = (message: string): void => {
    stop();
    trigger.textContent = restore;
    hint.className = 'field__hint';
    hint.textContent = message;
  };

  // Repaints the preview when a modifier is released without a key being chosen.
  const onModifierRelease = (event: KeyboardEvent): void => {
    if (isModifierCode(event.code)) trigger.textContent = modifierPreview(event);
  };

  // Clicking anywhere else means the user moved on; leaving the recorder armed
  // would swallow the next key they pressed for some other purpose.
  const onPointerDown = (event: PointerEvent): void => {
    if (event.target !== trigger) abandon('Left unchanged.');
  };

  const onKey = (event: KeyboardEvent): void => {
    // Everything, including Tab and Space: while recording, no key means what it
    // usually means, and Space would otherwise re-activate the focused button.
    event.preventDefault();
    event.stopImmediatePropagation();

    if (event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      abandon('Left unchanged.');
      return;
    }

    if (isModifierCode(event.code)) {
      trigger.textContent = modifierPreview(event);
      return;
    }

    const chord = chordFromEvent(event);
    const problem = chordProblem(chord);
    if (problem) {
      trigger.textContent = PROMPT;
      hint.className = 'field__hint field__hint--error';
      // Naming a free key here is the difference between a dead end and a next
      // step: the recorder is still armed, so the user can press what it names.
      const free = suggestChord(takenChords(action.id));
      hint.textContent = free ? `${problem} ${shortcutLabel(free)} is free.` : problem;
      return;
    }

    const serialized = serializeChord(chord);
    const taken = commandChords.find((command) => command.chord === serialized);
    if (taken) {
      trigger.textContent = PROMPT;
      hint.className = 'field__hint field__hint--error';
      hint.textContent = `${shortcutLabel(serialized)} is ProofKey's own browser shortcut (${taken.label}), so the page never sees it. Change that one at chrome://extensions/shortcuts.`;
      return;
    }

    stop();

    // Reassign rather than refuse. A duplicate would leave the later action
    // looking bound while only the first could ever fire.
    const previous = resolveActions(settings).find(
      (other) => other.id !== action.id && other.shortcut === serialized,
    );
    if (previous) setActionShortcut(settings, previous.id, null);

    setActionShortcut(settings, action.id, serialized);
    const caution = chordWarning(chord);
    shortcutNotice = {
      actionId: action.id,
      text: previous
        ? `Set to ${shortcutLabel(serialized)}, taken from "${previous.label}".`
        : `Set to ${shortcutLabel(serialized)}. Remember to save.`,
      kind: 'ok',
    };
    // The caution replaces the confirmation rather than following it: a chord
    // Chrome also uses is worth reading about, and "Set to Ctrl+S." on its own
    // reads as nothing more to know.
    if (caution) shortcutNotice = { actionId: action.id, text: caution, kind: 'error' };
    focusShortcutFor = action.id;
    render();
  };

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onModifierRelease, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  cancelRecording = () => abandon('Left unchanged.');
}

/** What the button reads while it is waiting for a key. */
const PROMPT = 'Press a key…';

/** Only one recorder can be armed at a time. */
let cancelRecording: (() => void) | null = null;

/** The modifiers currently held, so holding Ctrl+Alt looks like progress. */
function modifierPreview(event: KeyboardEvent): string {
  const held = formatChord(
    { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, code: '' },
    { mac: IS_MAC, layout: layoutMap },
  );
  return held || PROMPT;
}

/**
 * The origins where the in-page listener is registered.
 *
 * This list is the whole reason shortcuts need a permission at all. ProofKey
 * ships no static content script, so a key pressed on a page it was never
 * loaded into cannot reach it — these are the sites where it is loaded up front.
 */
function renderShortcutOrigins(): HTMLElement {
  const problems = el('p', { class: 'field__hint field__hint--error' });

  /** Names the lines that would be dropped, rather than dropping them quietly. */
  const validate = (raw: string): void => {
    const unusable = lines(raw).filter((line) => normalizeOrigin(line) === null);
    problems.textContent = unusable.length
      ? `Not a site address, so ${unusable.length === 1 ? 'it' : 'they'} will be ignored: ${unusable.join(', ')}`
      : '';
  };

  const box = textarea(settings.shortcutOrigins.join('\n'), {
    rows: 3,
    placeholder: 'mail.google.com\ngithub.com\nhttps://www.notion.so',
    on: {
      input: (e) => {
        const raw = (e.target as HTMLTextAreaElement).value;
        settings.shortcutOrigins = lines(raw);
        validate(raw);
      },
      // Rewritten on the way out rather than as you type, which would fight the
      // cursor. `github.com` and a pasted page URL both become the origin.
      blur: (e) => {
        const node = e.target as HTMLTextAreaElement;
        const cleaned = [
          ...new Set(lines(node.value).map(normalizeOrigin).filter((o): o is string => !!o)),
        ];
        const unusable = lines(node.value).filter((line) => normalizeOrigin(line) === null);
        node.value = [...cleaned, ...unusable].join('\n');
        settings.shortcutOrigins = cleaned;
        validate(node.value);
      },
    },
  });

  validate(box.value);

  const bound = resolveActions(settings).filter((action) => action.enabled && action.shortcut);
  const stranded = bound.length > 0 && settings.shortcutOrigins.length === 0;

  return el(
    'div',
    { class: 'shortcut-origins' },
    stranded
      ? el('p', {
          class: 'notice notice--warn',
          text: `${bound.length === 1 ? 'A key is' : `${bound.length} keys are`} bound above, but no site is listed here — so ${bound.length === 1 ? 'it' : 'they'} cannot run anywhere. Add the site you want to use ${bound.length === 1 ? 'it' : 'them'} on, then Save.`,
        })
      : null,
    field(
      'Shortcuts run on',
      box,
      'One site per line. Saving asks for access to each of them — ProofKey has to be loaded in a page before it can see a keypress there. Changing this list takes effect on the next page load, so reload any tab you already have open. The right-click menu and the browser shortcut keep working everywhere, with no permission.',
    ),
    problems,
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

    field(
      'Connection',
      select(
        [
          { value: '', label: 'Same as the active connection' },
          ...settings.connections.map((connection) => ({
            value: connection.id,
            label: connection.model ? `${connection.label} — ${connection.model}` : connection.label,
          })),
        ],
        liveCheck.connectionId ?? '',
        {
          on: {
            change: (e) => {
              const value = (e.target as HTMLSelectElement).value;
              if (value) liveCheck.connectionId = value;
              else delete liveCheck.connectionId;
            },
          },
        },
      ),
      'Live checking runs far more often than the quick actions do, so it is worth pointing at a cheaper and faster model. Unlike the actions, this one does not fall through a chain — if it fails, the check is skipped.',
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

  // Normalised here as well as on blur: Save can be reached by keyboard without
  // the box ever losing focus, and an origin that survives to storage unparsed
  // is one the worker will silently skip.
  settings.shortcutOrigins = [
    ...new Set(settings.shortcutOrigins.map(normalizeOrigin).filter((o): o is string => !!o)),
  ];

  // Requested before any await, while the click that authorises the prompt is
  // still in scope. Origins already granted resolve without a dialog.
  const patterns = [
    ...new Set([
      ...settings.connections.map(originPattern),
      ...settings.shortcutOrigins.map(originMatchPattern),
    ].filter((p): p is string => !!p)),
  ];
  let shortcutsGranted = true;
  if (patterns.length > 0) {
    try {
      await chrome.permissions.request({ origins: patterns });
    } catch {
      // Declining is a legitimate choice; the settings still save.
    }
  }

  // Checked rather than inferred from the request's result: the request covers
  // API endpoints too, so a `false` there does not say which half was refused —
  // and saying "shortcuts are on" when the listener could not be registered is
  // exactly the kind of claim that leaves a user pressing a dead key.
  const shortcutPatterns = settings.shortcutOrigins
    .map(originMatchPattern)
    .filter((p): p is string => !!p);
  if (shortcutPatterns.length > 0) {
    shortcutsGranted = await chrome.permissions
      .contains({ origins: shortcutPatterns })
      .catch(() => false);
  }

  try {
    await saveSettings(settings);
    const usable = connectionChain(settings).some((c) => validateConnection(c) === null);
    status.className = usable && shortcutsGranted ? 'status status--ok' : 'status status--error';
    status.textContent = !usable
      ? 'Saved, but no provider is usable yet — check the warnings above.'
      : shortcutsGranted
        ? 'Saved.'
        : 'Saved, but access to some shortcut sites was not granted, so the keys will not work there.';
  } catch (error) {
    status.className = 'status status--error';
    // storage.sync rejects items over its per-item quota; long prompts get there.
    status.textContent = `Could not save: ${error instanceof Error ? error.message : String(error)}`;
  }
}
