import type { Connection, Settings } from './types';

/**
 * The settings file behind Export and Import on the settings page.
 *
 * It is the user's own copy, written by their browser to their disk: nothing
 * here touches the network. What it must not do is put a secret in a file by
 * surprise. An API key gives anyone holding the file the use of that account,
 * and so can a header, query or body field the user added — gateways take
 * their token there (Cloudflare's `cf-aig-authorization`, a `key` parameter).
 * So unless the user ticks the box, the file carries no key and none of the
 * fields they added; the ones the preset itself fills in are not secret and
 * stay, so an imported Ollama connection still turns its thinking off.
 *
 * Only type imports: the Node checks run this file as it is.
 */

const MARKER = 'proofkey-settings';
export const BACKUP_FORMAT_VERSION = 1;

type Extras = Partial<Pick<Connection, 'extraHeaders' | 'extraQuery' | 'extraBody'>>;

export interface BackupOptions {
  includeSecrets: boolean;
  /** The extras a connection starts with on its preset; anything else is the user's. */
  presetDefaults: (presetId: string) => Extras | undefined;
  extensionVersion: string;
  now: Date;
}

export interface BackupFile {
  text: string;
  fileName: string;
  /** What the file does not hold, so the page can say what to type in again. */
  leftOut: { apiKeys: number; fields: number };
}

export function exportBackup(settings: Settings, options: BackupOptions): BackupFile {
  const leftOut = { apiKeys: 0, fields: 0 };
  const connections = settings.connections.map((connection) => {
    if (options.includeSecrets) return connection;
    if (connection.apiKey) leftOut.apiKeys++;
    const preset = options.presetDefaults(connection.presetId);
    const keep = <T>(values: Record<string, T>, presetValues: Record<string, T> | undefined) => {
      const kept: Record<string, T> = {};
      for (const [name, value] of Object.entries(values ?? {})) {
        if (presetValues && Object.hasOwn(presetValues, name) && JSON.stringify(presetValues[name]) === JSON.stringify(value)) {
          kept[name] = value;
        } else {
          leftOut.fields++;
        }
      }
      return kept;
    };
    return {
      ...connection,
      apiKey: '',
      extraHeaders: keep(connection.extraHeaders, preset?.extraHeaders),
      extraQuery: keep(connection.extraQuery, preset?.extraQuery),
      extraBody: keep(connection.extraBody, preset?.extraBody),
    };
  });

  // `apiKeysLocal` describes what sync holds, not this file.
  const { apiKeysLocal: _sync, ...rest } = settings;
  const file = {
    proofkey: MARKER,
    formatVersion: BACKUP_FORMAT_VERSION,
    extensionVersion: options.extensionVersion,
    exportedAt: options.now.toISOString(),
    secretsIncluded: options.includeSecrets,
    settings: { ...rest, connections },
  };
  return {
    text: `${JSON.stringify(file, null, 2)}\n`,
    fileName: `proofkey-settings-${options.now.toISOString().slice(0, 10)}.json`,
    leftOut,
  };
}

export type ParsedBackup =
  | { settings: Partial<Settings>; secretsIncluded: boolean; extensionVersion: string }
  | { error: string };

/**
 * Reads a file Export wrote. Refuses rather than half-applies: a wrong shape
 * that got as far as storage would break the settings page and the worker
 * alike. Fields are checked against `defaults` one level down, which is as
 * deep as the load-time merge goes; unknown top-level fields are dropped.
 */
const VALID_TRANSPORTS = new Set([
  'chat_completions',
  'openai_responses',
  'anthropic_messages',
  'chrome_builtin',
  'in_browser',
]);
const VALID_AUTH_STYLES = new Set(['bearer', 'x-api-key', 'header', 'query', 'none']);

const STRING_ARRAY_FIELDS = new Set(['shortcutOrigins', 'fallbackConnectionIds']);
const NESTED_STRING_ARRAY_FIELDS = new Set([
  'liveCheck.enabledOrigins',
  'liveCheck.blockedOrigins',
  'liveCheck.dictionary',
  'profile.neverFlag',
]);

// Optional nested fields have no entry in the defaults, so the one-level walk
// below would drop them; the ones we know are listed with their type.
const OPTIONAL_NESTED_STRINGS = new Set(['liveCheck.connectionId']);

export function parseBackup(text: string, defaults: Settings): ParsedBackup {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return { error: 'This file is not a ProofKey settings file (it is not JSON).' };
  }
  if (!isObject(file) || file.proofkey !== MARKER || !isObject(file.settings)) {
    return { error: 'This file is not a ProofKey settings file.' };
  }
  if (typeof file.formatVersion !== 'number' || !Number.isInteger(file.formatVersion) || file.formatVersion < 1) {
    return { error: 'The file is damaged: formatVersion is not valid.' };
  }
  if (file.formatVersion > BACKUP_FORMAT_VERSION) {
    return { error: 'This file was written by a newer ProofKey. Update ProofKey, then import it again.' };
  }
  const raw = file.settings;
  if (raw.schemaVersion !== undefined) {
    if (typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) {
      return { error: 'The file is damaged: schemaVersion is not valid.' };
    }
    if (raw.schemaVersion > defaults.schemaVersion) {
      return { error: 'These settings come from a newer ProofKey. Update ProofKey, then import them again.' };
    }
  }

  const settings: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(raw)) {
    if (!Object.hasOwn(defaults, name)) continue;
    const expected = (defaults as unknown as Record<string, unknown>)[name];
    const problem = shapeProblem(value, expected, name);
    if (problem) return { error: `The file is damaged: ${problem}.` };
    if (STRING_ARRAY_FIELDS.has(name) && !isStringArray(value)) {
      return { error: `The file is damaged: ${name} should hold text entries.` };
    }
    if (isObject(value) && isObject(expected) && Object.keys(expected).length > 0) {
      const cleanNested: Record<string, unknown> = {};
      for (const [inner, innerValue] of Object.entries(value)) {
        const path = `${name}.${inner}`;
        if (!Object.hasOwn(expected, inner)) {
          if (OPTIONAL_NESTED_STRINGS.has(path) && innerValue !== undefined) {
            if (typeof innerValue !== 'string') return { error: `The file is damaged: ${path} should be text.` };
            cleanNested[inner] = innerValue;
          }
          continue;
        }
        const innerProblem = shapeProblem(innerValue, expected[inner], path);
        if (innerProblem) return { error: `The file is damaged: ${innerProblem}.` };
        if (NESTED_STRING_ARRAY_FIELDS.has(path) && !isStringArray(innerValue)) {
          return { error: `The file is damaged: ${path} should hold text entries.` };
        }
        if (path === 'profile.varieties' && isObject(innerValue)) {
          if (!Object.values(innerValue).every((entry) => entry === undefined || typeof entry === 'string')) {
            return { error: 'The file is damaged: profile.varieties should hold text values.' };
          }
        }
        cleanNested[inner] = innerValue;
      }
      settings[name] = cleanNested;
      continue;
    }
    settings[name] = value;
  }

  if (settings.frameOrigins !== undefined) {
    const frames = settings.frameOrigins as Record<string, unknown>;
    for (const [origin, list] of Object.entries(frames)) {
      if (origin === '__proto__' || !isStringArray(list)) {
        return { error: 'The file is damaged: frameOrigins should map origins to lists of origins.' };
      }
    }
  }

  if (settings.builtInOverrides !== undefined) {
    const overrides = settings.builtInOverrides as Record<string, unknown>;
    for (const [id, entry] of Object.entries(overrides)) {
      if (id === '__proto__' || !isObject(entry)) {
        return { error: 'The file is damaged: builtInOverrides has an invalid entry.' };
      }
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
        return { error: 'The file is damaged: builtInOverrides.enabled should be a boolean.' };
      }
      for (const k of ['label', 'systemPrompt', 'shortcut']) {
        if (entry[k] !== undefined && typeof entry[k] !== 'string') {
          return { error: `The file is damaged: builtInOverrides.${k} should be a string.` };
        }
      }
    }
  }

  if (settings.customActions !== undefined) {
    const actions = settings.customActions as unknown[];
    for (const action of actions) {
      if (
        !isObject(action) ||
        typeof action.id !== 'string' ||
        typeof action.label !== 'string' ||
        typeof action.systemPrompt !== 'string' ||
        typeof action.enabled !== 'boolean' ||
        (action.shortcut !== undefined && typeof action.shortcut !== 'string')
      ) {
        return { error: 'The file is damaged: a custom action is missing required fields.' };
      }
    }
  }

  const connections = settings.connections as unknown[] | undefined;
  if (connections) {
    const ids = new Set<string>();
    for (const connection of connections) {
      if (!isObject(connection) || !['id', 'presetId', 'transport', 'baseUrl', 'model'].every((k) => typeof connection[k] === 'string')) {
        return { error: 'The file is damaged: a provider is missing its id, address or model.' };
      }
      if (!VALID_TRANSPORTS.has(connection.transport as string)) {
        return { error: `The file is damaged: a provider has an unknown transport "${connection.transport}".` };
      }
      if (connection.authStyle !== undefined && (typeof connection.authStyle !== 'string' || !VALID_AUTH_STYLES.has(connection.authStyle))) {
        return { error: 'The file is damaged: a provider has an unknown authStyle.' };
      }
      if (connection.apiKey !== undefined && typeof connection.apiKey !== 'string') {
        return { error: 'The file is damaged: a provider apiKey should be a string.' };
      }
      if (connection.label !== undefined && typeof connection.label !== 'string') {
        return { error: 'The file is damaged: a provider label should be a string.' };
      }
      if (
        connection.maxOutputTokens !== undefined &&
        (typeof connection.maxOutputTokens !== 'number' || !Number.isFinite(connection.maxOutputTokens) || connection.maxOutputTokens <= 0)
      ) {
        return { error: 'The file is damaged: a provider maxOutputTokens should be a positive number.' };
      }
      if (connection.thinking !== undefined && connection.thinking !== 'off' && connection.thinking !== 'default') {
        return { error: 'The file is damaged: a provider thinking setting is invalid.' };
      }
      if (ids.has(connection.id as string)) return { error: 'The file is damaged: two providers share one id.' };
      ids.add(connection.id as string);
      for (const k of ['extraHeaders', 'extraQuery']) {
        if (connection[k] !== undefined) {
          const bag = connection[k];
          // 0.1.27 wrote whatever the user typed, so numbers and booleans exist in old files.
          if (!isObject(bag) || !Object.values(bag).every((v) => ['string', 'number', 'boolean'].includes(typeof v))) {
            return { error: `The file is damaged: a provider's ${k} should hold text values.` };
          }
          connection[k] = Object.fromEntries(Object.entries(bag).map(([name, v]) => [name, String(v)]));
        }
      }
      if (connection.extraBody !== undefined && !isObject(connection.extraBody)) {
        return { error: "The file is damaged: a provider's extraBody is not a set of fields." };
      }
    }
    // A live-check provider the file does not carry would fall back to whatever is
    // active on import, which is not what the user picked: drop it instead.
    const live = settings.liveCheck as Record<string, unknown> | undefined;
    if (live && typeof live.connectionId === 'string' && !ids.has(live.connectionId)) delete live.connectionId;
  }

  return {
    settings: { ...settings } as Partial<Settings>,
    secretsIncluded: file.secretsIncluded === true,
    extensionVersion: typeof file.extensionVersion === 'string' ? file.extensionVersion : '',
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shapeProblem(value: unknown, expected: unknown, name: string): string | null {
  if (expected === undefined) return null;
  if (Array.isArray(expected)) return Array.isArray(value) ? null : `${name} should be a list`;
  if (isObject(expected)) return isObject(value) ? null : `${name} should be a set of fields`;
  return typeof value === typeof expected ? null : `${name} should be a ${typeof expected}`;
}
