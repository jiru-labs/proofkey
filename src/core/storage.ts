import { getPreset, PRESETS } from './presets';
import { BUILT_IN_ACTIONS, DEFAULT_ACTION_ID } from './prompts';
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
  };
}

export function defaultSettings(): Settings {
  const first = connectionFromPreset('custom');
  return {
    schemaVersion: SCHEMA_VERSION,
    connections: [first],
    activeConnectionId: first.id,
    fallbackConnectionIds: [],
    customActions: [],
    builtInOverrides: {},
    defaultActionId: DEFAULT_ACTION_ID,
    liveCheck: {
      enabledOrigins: [],
      blockedOrigins: [],
      debounceMs: 1000,
      minChars: 12,
      maxSentencesPerRequest: 8,
      dictionary: [],
    },
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(KEY_SETTINGS);
  const raw = stored[KEY_SETTINGS] as Partial<Settings> | undefined;
  if (!raw) return defaultSettings();

  // Shallow merge against defaults so a settings object written by an older
  // version keeps working after new fields are added.
  const defaults = defaultSettings();
  return {
    ...defaults,
    ...raw,
    liveCheck: { ...defaults.liveCheck, ...(raw.liveCheck ?? {}) },
    connections: raw.connections?.length ? raw.connections : defaults.connections,
    activeConnectionId: raw.activeConnectionId ?? defaults.activeConnectionId,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [KEY_SETTINGS]: settings });
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

export function findAction(settings: Settings, actionId: string): WritingAction | undefined {
  return resolveActions(settings).find((action) => action.id === actionId);
}

/** Preset rows split into the two option-page groups. */
export function groupedPresets() {
  return {
    primary: PRESETS.filter((preset) => preset.group === 'primary'),
    more: PRESETS.filter((preset) => preset.group === 'more'),
  };
}
