import { getPreset, liveModel, PRESETS } from './presets';
import { ACTIONS_ON_BUILTIN_MODEL } from './providers/chromeBuiltin';
import { ACTIONS_ON_IN_BROWSER_MODEL } from './providers/inBrowserModel';
import { BUILT_IN_ACTIONS, DEFAULT_ACTION_ID, emptyProfile } from './prompts';
import { parseChord, type ShortcutBinding } from './shortcuts';
import type { Connection, PresetId, Settings, WritingAction } from './types';

export const SCHEMA_VERSION = 1;

/** Storage keys. Split so one oversized item cannot break the rest. */
const KEY_SETTINGS = 'proofkey:settings';

export function newConnectionId(): string {
  return crypto.randomUUID();
}

/** Builds a connection pre-filled from a preset. */
export function connectionFromPreset(presetId: PresetId, label?: string): Connection {
  const preset = getPreset(presetId);
  return {
    id: newConnectionId(),
    label: label ?? preset.label,
    presetId,
    transport: preset.transport,
    baseUrl: preset.baseUrl,
    apiKey: '',
    model: preset.defaultModel,
    authStyle: preset.authStyle,
    ...(preset.authHeaderName ? { authHeaderName: preset.authHeaderName } : {}),
    ...(preset.authQueryParam ? { authQueryParam: preset.authQueryParam } : {}),
    extraHeaders: { ...(preset.extraHeaders ?? {}) },
    extraBody: { ...(preset.extraBody ?? {}) },
    extraQuery: { ...(preset.extraQuery ?? {}) },
    maxOutputTokens: 2048,
    thinking: 'off',
  };
}

export function defaultSettings(): Settings {
  // Chrome's on-device model, so a fresh install can check text before anyone
  // has signed up for anything. Where the browser has no model, the first
  // request says so and points at settings.
  const first = connectionFromPreset('chrome-builtin');
  return {
    schemaVersion: SCHEMA_VERSION,
    connections: [first],
    activeConnectionId: first.id,
    fallbackConnectionIds: [],
    customActions: [],
    builtInOverrides: {},
    defaultActionId: DEFAULT_ACTION_ID,
    profile: emptyProfile(),
    liveCheck: {
      enabledOrigins: [],
      blockedOrigins: [],
      debounceMs: 1000,
      minChars: 12,
      maxSentencesPerRequest: 8,
      dictionary: [],
    },
    shortcutOrigins: [],
    frameOrigins: {},
  };
}

/**
 * Settings as the rest of the extension sees them: what sync holds, with each
 * connection's API key filled in from this computer's own copy. A key still in
 * sync wins — it was written by a computer that has not stopped syncing keys
 * yet, and `mirrorApiKeys` takes it out of sync and into the copy.
 */
export async function loadSettings(): Promise<Settings> {
  const [stored, keys] = await Promise.all([chrome.storage.sync.get(KEY_SETTINGS), localApiKeys()]);
  const raw = stored[KEY_SETTINGS] as Partial<Settings> | undefined;
  if (!raw) return defaultSettings();

  // Shallow merge against defaults so a settings object written by an older
  // version keeps working after new fields are added.
  const defaults = defaultSettings();
  return {
    ...defaults,
    ...raw,
    profile: { ...defaults.profile, ...(raw.profile ?? {}) },
    liveCheck: { ...defaults.liveCheck, ...(raw.liveCheck ?? {}) },
    connections: raw.connections?.length
      ? raw.connections.map((connection) => ({
          ...migrateConnection(connection),
          apiKey: connection.apiKey || keys[connection.id] || '',
        }))
      : defaults.connections,
    activeConnectionId: raw.activeConnectionId ?? defaults.activeConnectionId,
  };
}

/**
 * Fills in per-connection fields added after this object was written. The merge
 * in `loadSettings` is shallow and only reaches the top level, so this is where
 * a connection stored by an older version picks up a new field's default.
 *
 * `thinking` defaults to `off` for connections that predate it, which changes
 * what they send. That is intended: it is the setting they would have wanted,
 * and anyone who deliberately set `reasoning_effort` by hand keeps it, because
 * `extraBody` is merged after this and wins.
 *
 * A model the provider has shut down moves to its replacement (`liveModel`):
 * Groq's preset default stopped answering on 2026-08-16.
 */
function migrateConnection(stored: Connection): Connection {
  const partial = stored as Partial<Connection>;
  return { ...stored, model: liveModel(stored), thinking: partial.thinking ?? 'off' };
}

/**
 * Saves settings with every API key kept on this computer only: the keys go to
 * `chrome.storage.local`, which never syncs, and sync gets the rest with the
 * keys emptied and `apiKeysLocal` set. The caller's object keeps its keys.
 *
 * Local is written first, so when the sync write wakes `mirrorApiKeys` on this
 * computer the copy it finds is already the new one.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const keys: Record<string, string> = {};
  for (const connection of settings.connections) {
    if (connection.apiKey) keys[connection.id] = connection.apiKey;
  }
  await writeLocalApiKeys(await localApiKeys(), keys);
  await chrome.storage.sync.set({ [KEY_SETTINGS]: withoutApiKeys(settings) });
}

/** API keys by connection id, in `chrome.storage.local`, which never syncs. */
const KEY_API_KEYS = 'proofkey:apiKeys';

async function localApiKeys(): Promise<Record<string, string>> {
  return ((await chrome.storage.local.get(KEY_API_KEYS))[KEY_API_KEYS] ?? {}) as Record<string, string>;
}

async function writeLocalApiKeys(stored: Record<string, string>, keys: Record<string, string>): Promise<void> {
  if (JSON.stringify(stored) === JSON.stringify(keys)) return;
  if (Object.keys(keys).length > 0) await chrome.storage.local.set({ [KEY_API_KEYS]: keys });
  else await chrome.storage.local.remove(KEY_API_KEYS);
}

function withoutApiKeys<T extends Partial<Settings>>(settings: T): T {
  return {
    ...settings,
    apiKeysLocal: true,
    connections: settings.connections?.map((connection) => ({ ...connection, apiKey: '' })),
  };
}

/**
 * Keeps this computer's copy of the keys in step with sync, and takes any key
 * still in sync out of it.
 *
 * A key reaches sync two ways now: settings written before this release, and a
 * computer still running an older one. Either way it is copied here first,
 * then sync is rewritten without it. From 0.1.16 a computer that sees the
 * emptied key with `apiKeysLocal` keeps its own copy and picks it up when it
 * updates; 0.1.14 and 0.1.15 drop theirs, which is why this waited until 0.1.16
 * had been out for weeks.
 *
 * Without the mark, an empty key is a key the user cleared, and the copy goes
 * too. With it, a copy only goes when its connection is removed.
 */
export async function mirrorApiKeys(): Promise<void> {
  const readSync = async () => (await chrome.storage.sync.get(KEY_SETTINGS))[KEY_SETTINGS] as Partial<Settings> | undefined;
  const raw = await readSync();
  const stored = await localApiKeys();
  const keys: Record<string, string> = {};
  for (const connection of raw?.connections ?? []) {
    const key = connection.apiKey || (raw?.apiKeysLocal ? stored[connection.id] : undefined);
    if (key) keys[connection.id] = key;
  }
  await writeLocalApiKeys(stored, keys);
  if (!raw?.connections?.some((connection) => connection.apiKey)) return;
  // Settings saved in the meantime are newer than these and already hold no
  // keys; writing these back over them would undo that save.
  if (JSON.stringify(await readSync()) !== JSON.stringify(raw)) return;
  await chrome.storage.sync.set({ [KEY_SETTINGS]: withoutApiKeys(raw) });
}

/**
 * The settings a page that has been open a while should save.
 *
 * The worker writes some of them too — the sites live checking and the
 * shortcuts run on, the frames allowed from a page, the dictionary — whenever
 * the user acts on a page. Settings opened before that held the old lists, and
 * Save wrote them back whole: switching live checking on in a tab, then saving
 * a provider change in settings, switched it off again (seen in Brave,
 * 2026-10-04). So those lists are taken from storage as it is now, with only
 * this page's own additions and removals applied on top.
 *
 * In place: the page's inputs hold references to these objects, and a copy
 * would leave every later edit writing to the one that is no longer saved.
 */
export function mergeOnSave(edited: Settings, loaded: Settings, stored: Settings): void {
  const merge = (now: string[], before: string[], mine: string[]): string[] => {
    const removed = new Set(before.filter((item) => !mine.includes(item)));
    const added = mine.filter((item) => !before.includes(item));
    return [...new Set([...now.filter((item) => !removed.has(item)), ...added])];
  };
  const { liveCheck } = edited;
  edited.shortcutOrigins = merge(stored.shortcutOrigins, loaded.shortcutOrigins, edited.shortcutOrigins);
  edited.frameOrigins = stored.frameOrigins;
  liveCheck.enabledOrigins = merge(stored.liveCheck.enabledOrigins, loaded.liveCheck.enabledOrigins, liveCheck.enabledOrigins);
  liveCheck.blockedOrigins = merge(stored.liveCheck.blockedOrigins, loaded.liveCheck.blockedOrigins, liveCheck.blockedOrigins);
  liveCheck.dictionary = merge(stored.liveCheck.dictionary, loaded.liveCheck.dictionary, liveCheck.dictionary);
}

export function activeConnection(settings: Settings): Connection | undefined {
  return (
    settings.connections.find((c) => c.id === settings.activeConnectionId) ??
    settings.connections[0]
  );
}

/** The active connection followed by any configured fallbacks, in order. */
export function connectionChain(settings: Settings): Connection[] {
  const byId = new Map(settings.connections.map((c) => [c.id, c]));
  const chain: Connection[] = [];
  const active = activeConnection(settings);
  if (active) chain.push(active);
  for (const id of settings.fallbackConnectionIds) {
    const connection = byId.get(id);
    if (connection && connection.id !== active?.id) chain.push(connection);
  }
  return chain;
}

/** Built-ins with user overrides applied, followed by the user's own actions. */
export function resolveActions(settings: Settings): WritingAction[] {
  const builtIns = BUILT_IN_ACTIONS.map((action) => {
    const override = settings.builtInOverrides[action.id];
    return override ? { ...action, ...override } : action;
  });
  const custom = settings.customActions.map<WritingAction>((action) => ({
    ...action,
    builtIn: false,
  }));
  return [...builtIns, ...custom];
}

/**
 * What the menu, the card and the shortcuts offer right now: enabled actions,
 * narrowed to the ones measured to work when Chrome's built-in model is the
 * active connection. Actions the user wrote are always offered — which prompt
 * suits which model is their call.
 */
export function offeredActions(settings: Settings): WritingAction[] {
  return resolveActions(settings).filter(
    (action) => action.enabled && runsOnActiveConnection(settings, action),
  );
}

/**
 * Whether the active connection may run this action at all, enabled or not. A
 * disabled action can still arrive — it may be the default action behind
 * `Ctrl+Shift+K` — so the worker asks this, not `offeredActions`.
 */
export function runsOnActiveConnection(settings: Settings, action: WritingAction): boolean {
  const transport = activeConnection(settings)?.transport;
  const offered =
    transport === 'chrome_builtin'
      ? ACTIONS_ON_BUILTIN_MODEL
      : transport === 'in_browser'
        ? ACTIONS_ON_IN_BROWSER_MODEL
        : null;
  return !offered || !action.builtIn || offered.has(action.id);
}

export function findAction(settings: Settings, actionId: string): WritingAction | undefined {
  return resolveActions(settings).find((action) => action.id === actionId);
}

/**
 * Bindings the content script should listen for: enabled actions with a chord
 * that still parses.
 *
 * A chord kept by a disabled action is not a binding — the action is not in the
 * menu either — but it is still stored, so switching the action back on
 * restores the key the user chose rather than silently losing it.
 */
export function shortcutBindings(settings: Settings): ShortcutBinding[] {
  const bindings: ShortcutBinding[] = [];
  const claimed = new Set<string>();

  for (const action of offeredActions(settings)) {
    if (!action.shortcut) continue;
    if (!parseChord(action.shortcut)) continue;
    // First one wins, matching the order the options page lists conflicts in.
    if (claimed.has(action.shortcut)) continue;
    claimed.add(action.shortcut);
    bindings.push({ actionId: action.id, chord: action.shortcut });
  }

  return bindings;
}

/**
 * Actions sharing a chord, keyed by chord. Only the first of each group would
 * ever fire, so the options page has to say so rather than let the later ones
 * look bound.
 */
export function shortcutConflicts(settings: Settings): Map<string, string[]> {
  const byChord = new Map<string, string[]>();

  for (const action of resolveActions(settings)) {
    if (!action.enabled || !action.shortcut) continue;
    const existing = byChord.get(action.shortcut);
    if (existing) existing.push(action.id);
    else byChord.set(action.shortcut, [action.id]);
  }

  for (const [chord, ids] of byChord) {
    if (ids.length < 2) byChord.delete(chord);
  }
  return byChord;
}

/** Writes or clears one action's chord, in whichever of the two places it lives. */
export function setActionShortcut(settings: Settings, id: string, chord: string | null): void {
  const custom = settings.customActions.find((action) => action.id === id);
  if (custom) {
    if (chord) custom.shortcut = chord;
    else delete custom.shortcut;
    return;
  }

  const override = { ...settings.builtInOverrides[id] };
  if (chord) override.shortcut = chord;
  else delete override.shortcut;

  // An override holding nothing is not the same as no override, but it should
  // be: settings live in `chrome.storage.sync`, which has a per-item quota that
  // long prompts already push against. Empty objects are not worth any of it.
  if (Object.keys(override).length > 0) settings.builtInOverrides[id] = override;
  else delete settings.builtInOverrides[id];
}

/** Preset rows split into the two option-page groups. */
export function groupedPresets() {
  return {
    primary: PRESETS.filter((preset) => preset.group === 'primary'),
    more: PRESETS.filter((preset) => preset.group === 'more'),
  };
}
