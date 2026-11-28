import { exportBackup, parseBackup } from '../core/backup';
import { reportFormUrl } from '../core/news';
import { getPreset } from '../core/presets';
import { BUILT_IN_ACTIONS, DEFAULT_ACTION_ID, VARIETIES } from '../core/prompts';
import { suggestChord } from '../core/shortcuts';
import {
  defaultSettings,
  newConnectionId,
  normalizeSettings,
  resolveActions,
  shortcutConflicts,
} from '../core/storage';
import type { PresetId, WritingProfile } from '../core/types';
import {
  button,
  checkbox,
  el,
  field,
  input,
  lines,
  plural,
  section,
  select,
  textarea,
} from './dom';
import { renderOriginsField } from './originsField';
import { renderShortcutRow, takenChords } from './shortcutRecorder';
import {
  DEFAULT_ACTION_COMMAND,
  IS_MAC,
  isDirty,
  openShortcutSettings,
  shortcutLabel,
  store,
} from './state';

// ----------------------------------------------------------- writing rules

export function renderProfile(): HTMLElement {
  const { profile } = store.settings;

  const translateInput = input(profile.translateLanguage, {
    placeholder: translatePlaceholder(profile),
    on: {
      input: (e) => {
        profile.translateLanguage = (e.target as HTMLInputElement).value;
        syncTranslateHints();
      },
    },
  });
  const translateHintNode = el('p', { class: 'field__hint', text: translateHint(profile) });
  const syncTranslateHints = (): void => {
    translateInput.placeholder = translatePlaceholder(profile);
    translateHintNode.textContent = translateHint(profile);
  };

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
      'Plain language, one rule per line.',
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

    ...Object.entries(VARIETIES).map(([key, { language, options }]) =>
      field(
        `${language} variety`,
        select(
          [
            { value: '', label: "Keep the writer's own (default)" },
            ...options.map((option) => ({ value: option.code, label: `${option.label} — ${option.code}` })),
          ],
          profile.varieties?.[key] ?? '',
          {
            on: {
              change: (e) => {
                const value = (e.target as HTMLSelectElement).value;
                const varieties = { ...profile.varieties };
                if (value) varieties[key] = value;
                else delete varieties[key];
                profile.varieties = varieties;
              },
            },
          },
        ),
        `Spelling and wording in ${language} follow this variety, and the other one is corrected to it. Left on the default, ProofKey keeps whichever variety you write in.`,
      ),
    ),

    field(
      'Your first language',
      input(profile.nativeLanguage, {
        placeholder: 'Portuguese, Japanese, Arabic…',
        on: {
          input: (e) => {
            profile.nativeLanguage = (e.target as HTMLInputElement).value;
            syncTranslateHints();
          },
        },
      }),
      'Optional. When set, ProofKey watches for the mistakes speakers of that language characteristically make when writing in another one.',
    ),

    field(
      'Explain corrections in',
      input(profile.explainLanguage, {
        placeholder: 'leave empty to use the language of the text',
        on: {
          input: (e) => {
            profile.explainLanguage = (e.target as HTMLInputElement).value;
            syncTranslateHints();
          },
        },
      }),
      'Useful when you are writing in a language you are still learning.',
    ),

    field('Translate into', translateInput, translateHintNode),
  );
}

function translatePlaceholder(profile: WritingProfile): string {
  const inherited = profile.explainLanguage.trim() || profile.nativeLanguage.trim();
  return inherited ? `${inherited} — inherited from above` : 'Spanish, German, Japanese…';
}

function translateHint(profile: WritingProfile): string {
  const explain = profile.explainLanguage.trim();
  const native = profile.nativeLanguage.trim();
  if (profile.translateLanguage.trim()) {
    return 'The Translate action translates into this language.';
  }
  if (explain || native) {
    return `Falling back to the ${explain ? 'explanation' : 'first'} language above. Set one here only if you want Translate to use a different one.`;
  }
  return 'Translate needs a language before it will run. Nothing else here depends on it.';
}

// ----------------------------------------------------------------- actions

export function renderActions(): HTMLElement {
  const list = el('div', { class: 'stack' });
  const conflicts = shortcutConflicts(store.settings);
  const actions = resolveActions(store.settings);
  const globalCommand = store.commandChords.find((c) => c.name === DEFAULT_ACTION_COMMAND);

  for (const action of actions) {
    const isBuiltIn = action.builtIn;
    const overridden = isBuiltIn && !!store.settings.builtInOverrides[action.id]?.systemPrompt;
    const conflicted = !!action.shortcut && conflicts.has(action.shortcut);

    const enabledBox = checkbox(action.label, action.enabled, (enabled) => {
      setActionEnabled(action.id, isBuiltIn, enabled);
      // Re-evaluate shortcut conflicts and stranded-key counts when toggling an action with a shortcut.
      if (action.shortcut) {
        store.pendingFocusSelector = `[data-action-enabled="${CSS.escape(action.id)}"]`;
        store.render();
      }
    });
    const enabledInput = enabledBox.querySelector('input');
    if (enabledInput) enabledInput.dataset.actionEnabled = action.id;
    const summaryLabelSpan = enabledBox.querySelector('span');

    const nameField = isBuiltIn
      ? null
      : field(
          'Name',
          input(action.label, {
            placeholder: 'My action',
            dataset: { actionNameFor: action.id },
            on: {
              input: (e) => {
                const value = (e.target as HTMLInputElement).value;
                const custom = store.settings.customActions.find((a) => a.id === action.id);
                if (custom) custom.label = value;
                if (summaryLabelSpan) summaryLabelSpan.textContent = value || 'Untitled action';
              },
            },
          }),
        );

    list.append(
      el(
        'details',
        {
          class: 'action',
          open: store.openActionIds.has(action.id),
          on: {
            toggle: (event) => {
              const open = (event.target as HTMLDetailsElement).open;
              if (open) store.openActionIds.add(action.id);
              else store.openActionIds.delete(action.id);
            },
          },
        },
        el(
          'summary',
          { class: 'action__summary' },
          el('span', { on: { click: (event) => event.stopPropagation() } }, enabledBox),
          overridden ? el('span', { class: 'badge', text: 'edited' }) : null,
          action.shortcut
            ? el('span', {
                class: `badge badge--key ${conflicted ? 'badge--warn' : ''}`,
                text: shortcutLabel(action.shortcut),
              })
            : null,
          store.settings.defaultActionId === action.id
            ? el('span', {
                class: 'badge badge--active',
                text: globalCommand ? `${shortcutLabel(globalCommand.chord)} · default` : 'default',
              })
            : null,
        ),
        nameField,
        textarea(action.systemPrompt, {
          rows: 8,
          attrs: { 'aria-label': `Prompt for ${action.label}` },
          on: {
            input: (e) => setActionPrompt(action.id, isBuiltIn, (e.target as HTMLTextAreaElement).value),
          },
        }),
        renderShortcutRow(action, conflicts),
        el(
          'div',
          { class: 'row row--end' },
          store.settings.defaultActionId === action.id
            ? null
            : button(
                globalCommand ? `Run this on ${shortcutLabel(globalCommand.chord)}` : 'Make default',
                () => {
                  store.settings.defaultActionId = action.id;
                  store.render();
                },
                'ghost',
              ),
          overridden
            ? button(
                'Reset to default',
                () => {
                  delete store.settings.builtInOverrides[action.id]?.systemPrompt;
                  store.render();
                },
                'ghost',
              )
            : null,
          isBuiltIn
            ? null
            : button(
                'Delete',
                () => {
                  store.settings.customActions = store.settings.customActions.filter((a) => a.id !== action.id);
                  store.openActionIds.delete(action.id);
                  if (store.settings.defaultActionId === action.id) {
                    store.settings.defaultActionId = DEFAULT_ACTION_ID;
                  }
                  store.render();
                },
                'danger',
              ),
        ),
      ),
    );
  }

  const activeTransport = store.settings.connections.find(
    (c) => c.id === store.settings.activeConnectionId,
  )?.transport;
  const onBuiltinModel = activeTransport === 'chrome_builtin';
  const onInBrowserModel = activeTransport === 'in_browser';

  return section(
    'Actions',
    'Every action is just a prompt. Edit any of them, or add your own — they appear in the right-click menu, and each one can have its own key.',
    onBuiltinModel
      ? el(
          'div',
          { class: 'notice' },
          el('p', {
            class: 'notice__text',
            text:
              "Chrome's built-in model is active, so the menu offers Fix grammar and your own actions only. " +
              'Measured on it, the other built-in rewrites translated words borrowed from another language ("kickoff meeting" became "reunión de inicio"). ' +
              'They come back as soon as a provider with an API key is the active one.',
          }),
        )
      : onInBrowserModel
        ? el(
            'div',
            { class: 'notice' },
            el('p', {
              class: 'notice__text',
              text:
                'The in-browser model is active, so the menu offers Fix grammar, Convert to bullet points, Translate and your own actions. ' +
                'Measured on it, the other built-in rewrites translated words borrowed from another language ("Hola team" became "Hola equipo"). ' +
                'They come back as soon as a provider with an API key is the active one.',
            }),
          )
        : null,
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
          (() => {
            const free = suggestChord(takenChords(''), '', { mac: IS_MAC });
            return free
              ? el('p', {
                  class: 'notice__text',
                  dataset: { defaultShortcutSuggestion: '' },
                  text: `Suggested: ${shortcutLabel(free)}. On that page, click the pencil next to "Run the default action" and press it.`,
                })
              : null;
          })(),
          button('Open browser shortcut settings', openShortcutSettings),
        ),
    list,
    el(
      'div',
      { class: 'row row--end' },
      button('Browser shortcut settings', openShortcutSettings, 'ghost'),
      button(
        '+ Add action',
        () => {
          const id = `custom-${newConnectionId().slice(0, 8)}`;
          store.settings.customActions.push({
            id,
            label: 'My action',
            systemPrompt: 'Rewrite the text so that…',
            enabled: true,
          });
          store.openActionIds.add(id);
          store.pendingFocusSelector = `[data-action-name-for="${CSS.escape(id)}"]`;
          store.render();
        },
        'ghost',
      ),
    ),
    renderShortcutOrigins(),
  );
}

function renderShortcutOrigins(): HTMLElement {
  const bound = resolveActions(store.settings).filter((action) => action.enabled && action.shortcut);
  const stranded =
    bound.length > 0
      ? el('p', {
          class: 'notice notice--warn',
          text: `${bound.length === 1 ? 'A key is' : `${bound.length} keys are`} bound above, but no site is listed here — so ${bound.length === 1 ? 'it' : 'they'} cannot run anywhere. Add the site you want to use ${bound.length === 1 ? 'it' : 'them'} on, then Save.`,
          attrs: { 'data-stranded-warning': '' },
        })
      : null;
  if (stranded) stranded.hidden = store.settings.shortcutOrigins.length > 0;

  return el(
    'div',
    { class: 'shortcut-origins' },
    stranded,
    renderOriginsField({
      label: 'Shortcuts run on',
      values: store.settings.shortcutOrigins,
      rows: 3,
      placeholder: 'mail.google.com\ngithub.com\nhttps://www.notion.so',
      hint: 'One site per line. Your browser asks you to allow each one when you save; reload any tab that was already open. The right-click menu works on every site without this. When ProofKey offers to reach an editor inside a page and you accept, that address is added here too.',
      onChange: (next) => {
        store.settings.shortcutOrigins = next;
        syncStrandedWarnings();
      },
    }),
  );
}

function syncStrandedWarnings(): void {
  const none = store.settings.shortcutOrigins.length === 0;
  document.querySelectorAll<HTMLElement>('[data-stranded-warning]').forEach((node) => {
    node.hidden = !none;
  });
}

function setActionEnabled(id: string, isBuiltIn: boolean, enabled: boolean): void {
  if (isBuiltIn) {
    store.settings.builtInOverrides[id] = { ...store.settings.builtInOverrides[id], enabled };
  } else {
    const action = store.settings.customActions.find((a) => a.id === id);
    if (action) action.enabled = enabled;
  }
}

function setActionPrompt(id: string, isBuiltIn: boolean, systemPrompt: string): void {
  if (isBuiltIn) {
    const original = BUILT_IN_ACTIONS.find((a) => a.id === id);
    if (original && original.systemPrompt === systemPrompt) {
      delete store.settings.builtInOverrides[id]?.systemPrompt;
      return;
    }
    store.settings.builtInOverrides[id] = { ...store.settings.builtInOverrides[id], systemPrompt };
  } else {
    const action = store.settings.customActions.find((a) => a.id === id);
    if (action) action.systemPrompt = systemPrompt;
  }
}

// ------------------------------------------------------------- live checks

export function renderLiveCheck(): HTMLElement {
  const { liveCheck } = store.settings;

  const debounceErr = el('p', { class: 'field__hint field__hint--error', attrs: { role: 'alert' } });
  debounceErr.hidden = true;
  const debounceInput = input(String(liveCheck.debounceMs), {
    type: 'number',
    attrs: { min: '200', step: '50' },
    on: {
      input: (e) => {
        const node = e.target as HTMLInputElement;
        const value = Number(node.value);
        const valid = node.value.trim() !== '' && Number.isFinite(value) && value >= 200;
        node.classList.toggle('input--invalid', !valid);
        node.setAttribute('aria-invalid', String(!valid));
        debounceErr.hidden = valid;
        debounceErr.textContent = valid ? '' : 'Enter at least 200 ms.';
        if (valid) liveCheck.debounceMs = Math.round(value);
      },
    },
  });

  const minCharsErr = el('p', { class: 'field__hint field__hint--error', attrs: { role: 'alert' } });
  minCharsErr.hidden = true;
  const minCharsInput = input(String(liveCheck.minChars), {
    type: 'number',
    attrs: { min: '0', step: '1' },
    on: {
      input: (e) => {
        const node = e.target as HTMLInputElement;
        const value = Number(node.value);
        const valid = node.value.trim() !== '' && Number.isFinite(value) && value >= 0;
        node.classList.toggle('input--invalid', !valid);
        node.setAttribute('aria-invalid', String(!valid));
        minCharsErr.hidden = valid;
        minCharsErr.textContent = valid ? '' : 'Enter 0 or more.';
        if (valid) liveCheck.minChars = Math.round(value);
      },
    },
  });

  return section(
    'Live checking',
    'Underlines as you type, on the sites you choose. Each check spends your key, so this stays off until you switch it on for a site.',

    renderOriginsField({
      label: 'Enabled on',
      values: liveCheck.enabledOrigins,
      rows: 3,
      placeholder: 'https://mail.google.com\nhttps://github.com',
      hint: 'One site address per line. Or click the ProofKey button in the toolbar on any site to switch it on or off there.',
      onChange: (next) => (liveCheck.enabledOrigins = next),
    }),

    renderOriginsField({
      label: 'Never run on',
      values: liveCheck.blockedOrigins,
      rows: 2,
      placeholder: 'https://bank.example.com',
      hint: 'ProofKey stays off on these sites, even if they are in the list above.',
      onChange: (next) => (liveCheck.blockedOrigins = next),
    }),

    field(
      'Model for live checking',
      select(
        [
          { value: '', label: 'Same as the active provider' },
          ...store.settings.connections.map((connection) => ({
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
      'Live checking asks far more often than the right-click actions, so a cheaper, faster model is a good choice here. It does not try the backup providers: if this one fails, that check is just skipped.',
    ),

    el(
      'div',
      { class: 'field' },
      checkbox('Correct spelling automatically', liveCheck.autoCorrect === true, (value) => {
        liveCheck.autoCorrect = value;
      }),
      el('p', {
        class: 'field__hint',
        text: 'When you pause, typos, missing accents and capitals are fixed in place, with Undo on the notice. With an English or Spanish variety chosen under Your writing rules, its spelling is applied too. Grammar and wording stay underlined for you to decide, and a fix you undo is not made again.',
      }),
    ),

    field(
      'Personal dictionary',
      textarea(liveCheck.dictionary.join('\n'), {
        rows: 3,
        placeholder: 'Words you clicked "Always allow" on appear here, one per line.',
        on: { input: (e) => (liveCheck.dictionary = lines((e.target as HTMLTextAreaElement).value)) },
      }),
      'Words ignored by live checking. Remove a line to flag it again.',
    ),

    el(
      'details',
      {
        class: 'advanced',
        ...(store.liveTimingOpen ? { attrs: { open: '' } } : {}),
        on: { toggle: (e: Event) => (store.liveTimingOpen = (e.target as HTMLDetailsElement).open) },
      },
      el('summary', { text: 'Timing — when a check starts' }),
      el(
        'div',
        { class: 'row row--wrap' },
        el('div', { class: 'field' }, field('Wait after typing (milliseconds)', debounceInput), debounceErr),
        el('div', { class: 'field' }, field('Skip text shorter than (characters)', minCharsInput), minCharsErr),
      ),
    ),
  );
}

// ------------------------------------------------------------------ backup

export function renderBackup(): HTMLElement {
  const fileInput = el('input', {
    type: 'file',
    hidden: true,
    attrs: { accept: '.json,application/json', 'aria-label': 'Settings file to import' },
    dataset: { settingsFile: 'input' },
    on: {
      change: (event) => {
        const target = event.target as HTMLInputElement;
        const file = target.files?.[0];
        if (file) void importSettingsFile(file);
        target.value = '';
      },
    },
  });
  const secrets = checkbox('Include API keys and the extra fields you added', store.backupIncludeSecrets, (value) => {
    store.backupIncludeSecrets = value;
    store.pendingFocusSelector = '[data-settings-file="secrets"] input';
    store.render();
  });
  secrets.dataset.settingsFile = 'secrets';
  return section(
    'Back up your settings',
    'Save everything on this page to a file on your computer, to keep it safe or to move it to another computer. ' +
      'Open the file here later to bring it all back. The file stays on your computer; ProofKey sends it nowhere.',
    secrets,
    store.backupIncludeSecrets
      ? el('p', {
          class: 'field__hint status--warn',
          text: 'Anyone who gets this file can use your API keys. Keep it private, and do not attach it to a bug report.',
        })
      : el('p', {
          class: 'field__hint',
          text: 'Left unticked, the file holds no API keys and no header, query or body fields you added yourself (they can hold a token). You type those in again after importing.',
        }),
    el(
      'div',
      { class: 'row row--wrap settings-file' },
      button('Export to a file', exportSettingsFile),
      button('Import from a file…', () => fileInput.click()),
      fileInput,
    ),
    store.backupNotice
      ? el('p', {
          class: `status status--${store.backupNotice.kind}`,
          text: store.backupNotice.text,
          dataset: { settingsFile: 'notice' },
          attrs: { role: 'status', 'aria-live': 'polite' },
        })
      : null,
  );
}

function exportSettingsFile(): void {
  const includeSecrets = store.backupIncludeSecrets;
  const file = exportBackup(store.settings, {
    includeSecrets,
    presetDefaults: (id) => getPreset(id as PresetId),
    extensionVersion: chrome.runtime.getManifest().version,
    now: new Date(),
  });
  const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }));
  const link = el('a', { attrs: { href: url, download: file.fileName } });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  // Reset the secrets opt-in after export so a later export cannot carry keys by accident.
  store.backupIncludeSecrets = false;

  const parts = [
    file.leftOut.apiKeys ? plural(file.leftOut.apiKeys, 'API key', 'API keys') : '',
    file.leftOut.fields ? plural(file.leftOut.fields, 'extra field', 'extra fields') : '',
  ].filter(Boolean);
  const unsaved = isDirty() ? ' It holds this page as it is now, including changes not saved yet.' : '';
  store.backupNotice = {
    kind: 'ok',
    text: `Exported ${file.fileName}.${parts.length ? ` Left out: ${parts.join(' and ')}.` : ''}${unsaved}`,
  };
  store.render();
}

async function importSettingsFile(file: File): Promise<void> {
  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    store.backupNotice = {
      kind: 'error',
      text: `Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
    };
    store.render();
    return;
  }

  const parsed = parseBackup(text, defaultSettings());
  if ('error' in parsed) {
    store.backupNotice = { kind: 'error', text: `Nothing was imported. ${parsed.error}` };
    store.render();
    return;
  }
  const keys: Record<string, string> = {};
  for (const connection of store.settings.connections) {
    if (connection.apiKey) keys[connection.id] = connection.apiKey;
  }
  const imported = normalizeSettings(parsed.settings, keys);
  const ids = new Set(imported.connections.map((c) => c.id));
  if (!ids.has(imported.activeConnectionId)) imported.activeConnectionId = imported.connections[0]!.id;
  imported.fallbackConnectionIds = imported.fallbackConnectionIds.filter((id) => ids.has(id));

  store.settings = imported;
  store.importedPending = true;
  store.expandedConnectionId = store.settings.activeConnectionId;
  const missing = store.settings.connections.filter(
    (c) => !c.apiKey && getPreset(c.presetId).requiresApiKey,
  ).length;
  store.backupNotice = {
    kind: 'warn',
    text:
      `Loaded ${file.name}. Check it, then click Save to keep it.` +
      (missing ? ` ${plural(missing, 'provider needs its', 'providers need their')} API key typed in again.` : ''),
  };
  store.render();
}

// ----------------------------------------------------------------- reports

/**
 * Links to the GitHub issue forms, the only way a store user can tell us how it
 * went. A plain link: nothing is sent unless the user submits the form there,
 * and the only thing filled in for them is the installed version.
 */
export function renderReports(): HTMLElement {
  const version = chrome.runtime.getManifest().version;
  const link = (kind: 'site' | 'provider', label: string, hint: string) =>
    el(
      'li',
      {},
      el('a', {
        text: label,
        dataset: { report: kind },
        attrs: { href: reportFormUrl(kind, version), target: '_blank', rel: 'noopener noreferrer' },
      }),
      ` — ${hint}`,
    );
  return section(
    'Tell us how it went',
    'Working or broken, both help: a report is the only thing that moves a site or provider out of "untested". ' +
      'Each link opens a form on GitHub (a free account is needed to submit); nothing is sent unless you submit it there.',
    el(
      'ul',
      { class: 'reports' },
      link('site', 'Report a site', 'it works on Slack, or it scrambled your text'),
      link('provider', 'Report a provider', 'your provider and model worked with your key, or did not'),
    ),
  );
}
