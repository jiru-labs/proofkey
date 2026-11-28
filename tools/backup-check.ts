/**
 * Checks the settings file that Export writes and Import reads:
 *
 *     node --experimental-strip-types tools/backup-check.ts
 *
 * 1. Without the box ticked, no API key and no header, query or body value the
 *    user added leaves in the file; the preset's own values stay.
 * 2. With it ticked, they all do.
 * 3. A file round-trips to the same settings.
 * 4. Anything that is not our file, or comes from a newer version, or has the
 *    wrong shape, is refused with a reason instead of half-applied.
 */

import type { Connection, Settings } from '../src/core/types.ts';
import { exportBackup, parseBackup, type BackupOptions } from '../src/core/backup.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const PRESET_DEFAULTS: Record<string, Pick<Connection, 'extraHeaders' | 'extraQuery' | 'extraBody'>> = {
  openrouter: { extraHeaders: { 'X-Title': 'ProofKey' }, extraQuery: {}, extraBody: {} },
  ollama: { extraHeaders: {}, extraQuery: {}, extraBody: { reasoning_effort: 'none' } },
};

function connection(id: string, presetId: string, extra: Partial<Connection> = {}): Connection {
  return {
    id,
    label: id,
    presetId: presetId as Connection['presetId'],
    transport: 'chat_completions',
    baseUrl: 'https://example.test/v1',
    apiKey: '',
    model: 'm',
    authStyle: 'bearer' as Connection['authStyle'],
    extraHeaders: { ...PRESET_DEFAULTS[presetId]!.extraHeaders },
    extraQuery: { ...PRESET_DEFAULTS[presetId]!.extraQuery },
    extraBody: { ...PRESET_DEFAULTS[presetId]!.extraBody },
    maxOutputTokens: 2048,
    thinking: 'off',
    ...extra,
  };
}

const defaults = {
  schemaVersion: 1,
  connections: [],
  activeConnectionId: '',
  fallbackConnectionIds: [],
  customActions: [],
  builtInOverrides: {},
  defaultActionId: 'fix',
  profile: { name: '' },
  liveCheck: { enabledOrigins: [], blockedOrigins: [], debounceMs: 1000, minChars: 12, maxSentencesPerRequest: 8, dictionary: [], autoCorrect: false },
  shortcutOrigins: [],
  frameOrigins: {},
} as unknown as Settings;

const settings = {
  ...defaults,
  apiKeysLocal: true,
  connections: [
    connection('a', 'openrouter', {
      apiKey: 'sk-or-v1-secret',
      extraHeaders: { 'X-Title': 'ProofKey', 'cf-aig-authorization': 'Bearer gateway-secret' },
      extraQuery: { token: 'query-secret' },
    }),
    connection('b', 'ollama', { extraBody: { reasoning_effort: 'none', api_key: 'body-secret' } }),
  ],
  activeConnectionId: 'a',
  liveCheck: { ...defaults.liveCheck, enabledOrigins: ['https://mail.example'], dictionary: ['ProofKey'], connectionId: 'a' },
} as Settings;

const options = (includeSecrets: boolean): BackupOptions => ({
  includeSecrets,
  presetDefaults: (id) => PRESET_DEFAULTS[id],
  extensionVersion: '9.9.9',
  now: new Date(Date.UTC(2026, 10, 22)),
});

const SECRETS = ['sk-or-v1-secret', 'gateway-secret', 'query-secret', 'body-secret'];

console.log('Export without secrets');
const plain = exportBackup(settings, options(false));
for (const secret of SECRETS) check(`leaves out ${secret}`, !plain.text.includes(secret));
check('counts what it left out', plain.leftOut.apiKeys === 1 && plain.leftOut.fields === 3, JSON.stringify(plain.leftOut));
check('keeps the preset header', plain.text.includes('"X-Title": "ProofKey"'));
check('keeps the preset body field', plain.text.includes('"reasoning_effort": "none"'));
check('keeps the rest (sites, dictionary)', plain.text.includes('https://mail.example') && plain.text.includes('"ProofKey"'));
check('does not carry the sync-only mark', !plain.text.includes('apiKeysLocal'));
check('does not change the settings it was given', settings.connections[0]!.apiKey === 'sk-or-v1-secret' && 'token' in settings.connections[0]!.extraQuery);
check('file name has the date', plain.fileName === 'proofkey-settings-2026-11-22.json', plain.fileName);

console.log('Export with secrets');
const full = exportBackup(settings, options(true));
for (const secret of SECRETS) check(`includes ${secret}`, full.text.includes(secret));
check('says it left nothing out', full.leftOut.apiKeys === 0 && full.leftOut.fields === 0);

console.log('Import');
const parsedFull = parseBackup(full.text, defaults);
check('a full file parses', 'settings' in parsedFull, 'error' in parsedFull ? parsedFull.error : '');
if ('settings' in parsedFull) {
  const want = { ...settings } as Partial<Settings>;
  delete want.apiKeysLocal;
  check('round-trips to the same settings', JSON.stringify(parsedFull.settings) === JSON.stringify(want));
  check('reports secrets present', parsedFull.secretsIncluded === true);
}
const parsedPlain = parseBackup(plain.text, defaults);
check('a plain file parses', 'settings' in parsedPlain, 'error' in parsedPlain ? parsedPlain.error : '');
if ('settings' in parsedPlain) {
  check('its keys are empty', parsedPlain.settings.connections!.every((c) => c.apiKey === ''));
  check('reports secrets absent', parsedPlain.secretsIncluded === false);
}


const envelope = JSON.parse(full.text) as Record<string, unknown>;
const refuse = (name: string, text: string) => {
  const result = parseBackup(text, defaults);
  check(`refuses ${name}`, 'error' in result && result.error.length > 0, 'error' in result ? result.error : 'accepted');
};
refuse('text that is not JSON', 'not json');
refuse('JSON that is not our file', JSON.stringify({ connections: [] }));
refuse('a newer file format', JSON.stringify({ ...envelope, formatVersion: 2 }));
refuse('settings from a newer version', JSON.stringify({ ...envelope, settings: { ...settings, schemaVersion: 2 } }));
refuse('connections that are not a list', JSON.stringify({ ...envelope, settings: { connections: 'x' } }));
refuse('a connection without an id', JSON.stringify({ ...envelope, settings: { connections: [{ baseUrl: 'x' }] } }));
refuse('two connections with one id', JSON.stringify({ ...envelope, settings: { connections: [settings.connections[0], settings.connections[0]] } }));
refuse('a list where a list of sites belongs', JSON.stringify({ ...envelope, settings: { shortcutOrigins: 'https://a' } }));
refuse('a wrong type inside live checking', JSON.stringify({ ...envelope, settings: { liveCheck: { enabledOrigins: 5 } } }));
refuse('formatVersion zero', JSON.stringify({ ...envelope, formatVersion: 0 }));
refuse('non-integer schemaVersion', JSON.stringify({ ...envelope, settings: { schemaVersion: '1' } }));
refuse('an unknown transport', JSON.stringify({ ...envelope, settings: { connections: [{ ...settings.connections[0], transport: 'bogus' }] } }));
refuse('a non-string apiKey', JSON.stringify({ ...envelope, settings: { connections: [{ ...settings.connections[0], apiKey: 123 }] } }));
refuse('a non-string shortcutOrigin entry', JSON.stringify({ ...envelope, settings: { shortcutOrigins: [42] } }));
refuse('a bad frameOrigins value', JSON.stringify({ ...envelope, settings: { frameOrigins: { 'https://a.test': 'not-a-list' } } }));
refuse('a customAction missing systemPrompt', JSON.stringify({ ...envelope, settings: { customActions: [{ id: 'c1', label: 'X', enabled: true }] } }));

console.log('Import edge cases');
const absent = parseBackup(
  JSON.stringify({ ...envelope, settings: { ...settings, liveCheck: { ...settings.liveCheck, connectionId: 'not-in-file' } } }),
  defaults,
);
check(
  'a live-check provider the file does not carry is dropped, not pointed at the active one',
  'settings' in absent && absent.settings.liveCheck?.connectionId === undefined,
  'error' in absent ? absent.error : JSON.stringify(absent.settings.liveCheck),
);
refuse('a live-check provider that is not an id', JSON.stringify({ ...envelope, settings: { ...settings, liveCheck: { ...settings.liveCheck, connectionId: 5 } } }));

const numerics = parseBackup(
  JSON.stringify({
    ...envelope,
    settings: {
      ...settings,
      connections: [{ ...settings.connections[0], extraHeaders: { 'X-Org': 1, 'X-Flat': true }, extraQuery: { org: 2 } }],
    },
  }),
  defaults,
);
check(
  'number and boolean header and query values import as text, as 0.1.27 accepted them',
  'settings' in numerics &&
    numerics.settings.connections![0]!.extraHeaders!['X-Org'] === '1' &&
    numerics.settings.connections![0]!.extraHeaders!['X-Flat'] === 'true' &&
    numerics.settings.connections![0]!.extraQuery!['org'] === '2',
  'error' in numerics ? numerics.error : JSON.stringify(numerics.settings.connections![0]),
);
refuse('a header value that is an object', JSON.stringify({ ...envelope, settings: { connections: [{ ...settings.connections[0], extraHeaders: { 'X-Org': { a: 1 } } }] } }));
refuse('a header value that is null', JSON.stringify({ ...envelope, settings: { connections: [{ ...settings.connections[0], extraHeaders: { 'X-Org': null } }] } }));


const protoPayload = `{"proofkey":"proofkey-settings","formatVersion":1,"settings":{"__proto__":{"polluted":true},"connections":[]}}`;
const protoParsed = parseBackup(protoPayload, defaults);
check('ignores __proto__ without polluting prototype', 'settings' in protoParsed && !('polluted' in protoParsed.settings) && !('polluted' in Object.prototype));

const extra = parseBackup(JSON.stringify({ ...envelope, settings: { connections: [], mystery: 1 } }), defaults);
check('drops fields it does not know', 'settings' in extra && !('mystery' in extra.settings));

console.log('Import keeps optional fields and 0.1.27-shaped values');
{
  const withConn = { ...settings, liveCheck: { ...defaults.liveCheck, connectionId: 'b' } } as Settings;
  const parsed = parseBackup(exportBackup(withConn, options(true)).text, defaults);
  check(
    'liveCheck.connectionId survives the round trip',
    'settings' in parsed && parsed.settings.liveCheck?.connectionId === 'b',
    JSON.stringify('settings' in parsed ? parsed.settings.liveCheck : parsed),
  );
  const legacy = JSON.parse(full.text) as { settings: { connections: Record<string, unknown>[] } };
  legacy.settings.connections[0]!.extraHeaders = { 'X-Num': 42, 'X-Flag': true };
  legacy.settings.connections[0]!.extraQuery = { n: 7 };
  const old = parseBackup(JSON.stringify(legacy), defaults);
  check('a 0.1.27 file with number/boolean header and query values is accepted', 'settings' in old, 'error' in old ? old.error : '');
  if ('settings' in old) {
    const c = old.settings.connections![0]!;
    check('and those values become text', c.extraHeaders['X-Num'] === '42' && c.extraHeaders['X-Flag'] === 'true' && c.extraQuery.n === '7', JSON.stringify([c.extraHeaders, c.extraQuery]));
  }
  legacy.settings.connections[0]!.extraHeaders = { 'X-Obj': { a: 1 } };
  refuse('an object as a header value', JSON.stringify(legacy));
}

console.log(failures === 0 ? '\nAll backup checks passed.' : `\n${failures} backup check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
