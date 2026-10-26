/**
 * Checks that no preset's default model is one its provider has shut down or
 * scheduled for shutdown:
 *
 *     node --experimental-strip-types tools/presets-check.ts
 *
 * The default is what a new connection is saved with, so a retired default
 * hands every new user a connection that fails on its first request. Groq's
 * preset defaulted to `llama-3.3-70b-versatile` for two months after Groq shut
 * it down. The list below is copied from each provider's own deprecation page,
 * with the date it was read; it only catches what someone has copied in.
 */

import * as presets from '../src/core/presets.ts';
import type { Connection, PresetId } from '../src/core/types.ts';

const { PRESETS, getPreset } = presets;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

interface Shutdown {
  /** The ids exactly as each preset sends them; OpenRouter namespaces OpenAI's. */
  ids: Partial<Record<PresetId, string[]>>;
  date: string;
  source: string;
}

const SHUTDOWNS: Shutdown[] = [
  {
    ids: {
      openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
      openrouter: ['openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/gpt-4.1', 'openai/gpt-4.1-mini'],
    },
    date: '2027-01-14',
    source: 'developers.openai.com/api/docs/deprecations, announced 2026-10-14, read 2026-10-20',
  },
  {
    ids: { openai: ['gpt-4.1-nano'], openrouter: ['openai/gpt-4.1-nano'] },
    date: '2026-10-23',
    source: 'developers.openai.com/api/docs/deprecations, announced 2026-04-22, read 2026-10-20',
  },
  {
    ids: { groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
    date: '2026-08-16',
    source: 'console.groq.com/docs/deprecations (free and developer tiers), read 2026-10-20',
  },
  {
    ids: { deepseek: ['deepseek-chat', 'deepseek-reasoner'] },
    date: '2026-07-24',
    source: 'api-docs.deepseek.com/updates, 2026-04-24 entry, read 2026-10-20',
  },
];

/**
 * A preset allowed to keep a retiring default for now, and until when. The
 * date is a tripwire: past it this check fails, a month before the shutdown.
 */
const PENDING: Partial<Record<PresetId, { until: string; why: string }>> = {
  openai: {
    until: '2026-12-15',
    why:
      'its replacement has not been measured on api.openai.com (no OpenAI key here); the ' +
      'preset sends `max_completion_tokens` to the reasoning models since 0.1.18, from ' +
      'OpenAI\'s docs, also unmeasured — measure with a real key before changing it',
  },
};

const today = new Date().toISOString().slice(0, 10);

console.log('\npreset defaults against announced shutdowns');
for (const preset of PRESETS) {
  const hit = SHUTDOWNS.find((s) => s.ids[preset.id]?.includes(preset.defaultModel));
  if (!hit) continue;
  const pending = PENDING[preset.id];
  if (pending && today < pending.until && today < hit.date) {
    console.log(
      `  WAIT  ${preset.id} still defaults to ${preset.defaultModel} (shut down ${hit.date}) ` +
        `— allowed until ${pending.until}: ${pending.why}`,
    );
    continue;
  }
  check(
    `${preset.id} does not default to a model its provider retires`,
    false,
    `${preset.defaultModel} shuts down ${hit.date} (${hit.source})`,
  );
}
check(
  'every preset default was compared',
  PRESETS.length > 30,
  `${PRESETS.length} presets`,
);

function connection(presetId: PresetId, model: string, overrides: Partial<Connection> = {}): Connection {
  const preset = getPreset(presetId);
  return {
    id: 't', label: preset.label, presetId, transport: preset.transport, baseUrl: preset.baseUrl,
    apiKey: 'k', model, authStyle: preset.authStyle, extraHeaders: {}, extraBody: {}, extraQuery: {},
    maxOutputTokens: 512, thinking: 'off', ...overrides,
  } as Connection;
}

// A connection saved before the shutdown keeps the dead id and fails every
// request, so it moves to the preset's replacement when settings are loaded.
console.log('\nstored connections on a shut-down model');
const liveModel = (presets as Record<string, unknown>)['liveModel'] as
  | ((c: Connection) => string)
  | undefined;
check('there is a way to move a stored connection off a shut-down model', typeof liveModel === 'function');
if (liveModel) {
  check(
    'a Groq connection on llama-3.3-70b-versatile moves to the Groq default',
    liveModel(connection('groq', 'llama-3.3-70b-versatile')) === getPreset('groq').defaultModel,
  );
  check(
    'so does one on llama-3.1-8b-instant',
    liveModel(connection('groq', 'llama-3.1-8b-instant')) === getPreset('groq').defaultModel,
  );
  check(
    'a model Groq still serves is left alone',
    liveModel(connection('groq', 'openai/gpt-oss-20b')) === 'openai/gpt-oss-20b',
  );
  check(
    'not once the base URL points elsewhere — a self-hosted Llama is not Groq\'s',
    liveModel(connection('groq', 'llama-3.3-70b-versatile', { baseUrl: 'http://localhost:8080/v1' })) ===
      'llama-3.3-70b-versatile',
  );
  check(
    'a model only scheduled for shutdown is left alone until it is gone',
    liveModel(connection('openrouter', 'openai/gpt-4.1-mini')) === 'openai/gpt-4.1-mini',
  );
}

if (failures) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nPreset checks passed.');
