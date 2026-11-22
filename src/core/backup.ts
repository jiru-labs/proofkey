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
        if (presetValues && name in presetValues && JSON.stringify(presetValues[name]) === JSON.stringify(value)) {
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
  if (typeof file.formatVersion !== 'number' || file.formatVersion > BACKUP_FORMAT_VERSION) {
    return { error: 'This file was written by a newer ProofKey. Update ProofKey, then import it again.' };
  }
  const raw = file.settings;
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > defaults.schemaVersion) {
    return { error: 'These settings come from a newer ProofKey. Update ProofKey, then import them again.' };
  }

  const settings: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!(name in defaults)) continue;
    const expected = (defaults as unknown as Record<string, unknown>)[name];
    const problem = shapeProblem(value, expected, name);
    if (problem) return { error: `The file is damaged: ${problem}.` };
    if (isObject(value) && isObject(expected) && Object.keys(expected).length > 0) {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (!(inner in expected)) continue;
        const innerProblem = shapeProblem(innerValue, expected[inner], `${name}.${inner}`);
        if (innerProblem) return { error: `The file is damaged: ${innerProblem}.` };
      }
    }
    settings[name] = value;
  }

  const connections = settings.connections as unknown[] | undefined;
  if (connections) {
    const ids = new Set<string>();
    for (const connection of connections) {
      if (!isObject(connection) || !['id', 'presetId', 'transport', 'baseUrl', 'model'].every((k) => typeof connection[k] === 'string')) {
        return { error: 'The file is damaged: a provider is missing its id, address or model.' };
      }
      if (ids.has(connection.id as string)) return { error: 'The file is damaged: two providers share one id.' };
      ids.add(connection.id as string);
      for (const k of ['extraHeaders', 'extraQuery', 'extraBody']) {
        if (connection[k] !== undefined && !isObject(connection[k])) {
          return { error: `The file is damaged: a provider's ${k} is not a set of fields.` };
        }
      }
    }
  }

  return {
    settings: settings as Partial<Settings>,
    secretsIncluded: file.secretsIncluded === true,
    extensionVersion: typeof file.extensionVersion === 'string' ? file.extensionVersion : '',
  };
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
