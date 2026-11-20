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
import { LOCAL_SERVERS } from '../src/core/localServers.ts';
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
      openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
      openrouter: ['openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/gpt-4.1'],
    },
    date: '2027-01-14',
    source: 'developers.openai.com/api/docs/deprecations, announced 2026-10-14, read 2026-10-20',
  },
  {
    ids: { openai: ['gpt-4.1-mini'], openrouter: ['openai/gpt-4.1-mini'] },
    date: '2027-01-20',
    source: 'developers.openai.com/api/docs/deprecations, announced 2026-10-14, moved from 2027-01-14, read 2026-11-16',
  },
  {
    ids: { openai: ['gpt-4.1-nano'], openrouter: ['openai/gpt-4.1-nano'] },
    date: '2026-10-23',
    source: 'developers.openai.com/api/docs/deprecations, announced 2026-04-22, read 2026-10-20',
  },
  {
    ids: {
      openai: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro', 'o3', 'o3-pro'],
    },
    date: '2026-12-11',
    source: 'developers.openai.com/api/docs/deprecations, announced 2026-06-11, read 2026-11-02',
  },
  {
    // Not an error on the day: Google routes the id to gemini-3.5-flash-lite,
    // billed at its rates, and its migration guide lists breaking changes.
    ids: { gemini: ['gemini-2.5-flash'] },
    date: '2026-12-01',
    source: 'ai.google.dev/gemini-api/docs/deprecations, announced 2026-11-02, read 2026-11-09',
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
const PENDING: Partial<Record<PresetId, { until: string; why: string }>> = {};

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
  | ((c: Connection, today?: string) => string)
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
  // OpenRouter kept serving openai/gpt-4.1-nano from Azure after OpenAI shut it
  // down on 2026-10-23 (measured 2026-11-04), so OpenAI's dates say nothing
  // about OpenRouter's ids.
  check(
    'an OpenRouter connection on an OpenAI id OpenAI has shut down is left alone',
    liveModel(connection('openrouter', 'openai/gpt-4.1-nano'), '2026-11-04') === 'openai/gpt-4.1-nano' &&
      liveModel(connection('openrouter', 'openai/gpt-4.1-mini'), '2027-02-01') === 'openai/gpt-4.1-mini',
  );
  // OpenAI's dates, from SHUTDOWNS above: each move happens on the day, not before.
  const moves: [PresetId, string, string][] = [
    ['openai', 'gpt-5-mini', '2026-12-11'],
    ['openai', 'gpt-5', '2026-12-11'],
    ['openai', 'o3', '2026-12-11'],
    ['openai', 'gpt-4.1-mini', '2027-01-20'],
    ['openai', 'gpt-4o', '2027-01-14'],
    ['gemini', 'gemini-2.5-flash', '2026-12-01'],
  ];
  for (const [presetId, model, date] of moves) {
    const before = new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10);
    check(
      `${presetId} on ${model} stays put the day before ${date}`,
      liveModel(connection(presetId, model), before) === model,
    );
    check(
      `and moves to the ${presetId} default on ${date}`,
      liveModel(connection(presetId, model), date) === getPreset(presetId).defaultModel,
      liveModel(connection(presetId, model), date),
    );
  }
  check(
    'gpt-4.1-nano, already gone, moves today',
    liveModel(connection('openai', 'gpt-4.1-nano'), '2026-11-04') === getPreset('openai').defaultModel,
  );
}

// The dated list above only knows what someone copied in. When a provider
// refuses the stored model, its own catalogue decides instead: the preset
// default replaces a model the catalogue no longer lists, and only when the
// catalogue lists the default.
console.log('\na refused model against the provider\'s own catalogue');
const replacementModel = (presets as Record<string, unknown>)['replacementModel'] as
  | ((c: Connection, available: readonly string[]) => string | null)
  | undefined;
check('there is a way to pick a replacement from the catalogue', typeof replacementModel === 'function');
if (replacementModel) {
  const catalogue = ['gpt-4.1', 'gpt-6-luna', 'o4-mini'];
  check('a model the catalogue dropped moves to the preset default', replacementModel(connection('openai', 'gpt-4.1-nano'), catalogue) === 'gpt-6-luna');
  check('a model it still lists stays: the refusal was about something else', replacementModel(connection('openai', 'gpt-4.1'), catalogue) === null);
  check('nothing to move to when the catalogue lacks the default too', replacementModel(connection('openai', 'gpt-4.1-nano'), ['gpt-4.1']) === null);
  check('an empty catalogue proves nothing', replacementModel(connection('openai', 'gpt-4.1-nano'), []) === null);
  check('the default itself refused has nothing to move to', replacementModel(connection('openai', 'gpt-6-luna'), ['gpt-4.1']) === null);
  check('a preset with no default never moves', replacementModel(connection('custom', 'anything'), ['gpt-6-luna']) === null);
  check(
    'Gemini\'s models/ prefix is read off the catalogue',
    replacementModel(connection('gemini', 'gemini-1.5-flash'), ['models/gemini-3.5-flash-lite']) === 'gemini-3.5-flash-lite' &&
      replacementModel(connection('gemini', 'gemini-2.5-flash-lite'), ['models/gemini-3.5-flash-lite', 'models/gemini-2.5-flash-lite']) === null,
  );
  check('a stored id with stray spaces is still found in the catalogue', replacementModel(connection('openai', ' gpt-4.1 '), catalogue) === null);
}

// A llama.cpp found on this computer is saved on the self-hosted preset with
// llama-server's port, not the preset's own address. Picking Ollama for it
// must move the base URL, name and model too, or the card says Ollama and
// keeps sending to llama.cpp (reported 2026-11-20).
console.log('\nswitching the provider of a connection');
const switchPreset = (presets as Record<string, unknown>)['switchPreset'] as
  | ((c: Connection, id: PresetId, found?: readonly { presetId: PresetId; label: string; baseUrl: string }[]) => void)
  | undefined;
check('there is a pure preset switch', typeof switchPreset === 'function');
if (switchPreset) {
  const found = [{ presetId: 'vllm' as PresetId, label: 'llama.cpp (local)', baseUrl: 'http://127.0.0.1:8080/v1' }];
  const llama = connection('vllm', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', {
    label: 'llama.cpp (local)', baseUrl: 'http://127.0.0.1:8080/v1',
  });
  switchPreset(llama, 'ollama', found);
  check('a found llama.cpp switched to Ollama gets Ollama\'s base URL', llama.baseUrl === getPreset('ollama').baseUrl, llama.baseUrl);
  check('…and Ollama\'s name', llama.label === getPreset('ollama').label, llama.label);
  check('…and Ollama\'s default model, not the llama.cpp file', llama.model === getPreset('ollama').defaultModel, llama.model);

  const plain = connection('openai', 'gpt-4.1-mini');
  switchPreset(plain, 'groq', found);
  check('a preset left at its defaults takes the new preset\'s URL', plain.baseUrl === getPreset('groq').baseUrl, plain.baseUrl);

  const own = connection('vllm', 'my-model', { baseUrl: 'http://10.0.0.5:9000/v1', label: 'Work box' });
  switchPreset(own, 'ollama', found);
  check('a base URL the user typed is kept', own.baseUrl === 'http://10.0.0.5:9000/v1', own.baseUrl);
  check('…and so are their name and model', own.label === 'Work box' && own.model === 'my-model', `${own.label} / ${own.model}`);
  check('the switch sets the new preset id and transport', own.presetId === 'ollama' && own.transport === getPreset('ollama').transport);

  // Every pair, both from a fresh card and from each server ProofKey finds:
  // all three fields follow the dropdown, and nothing from the old preset leaks.
  const bad: string[] = [];
  const starts = [
    ...PRESETS.map((p) => ({ name: p.id, make: () => connection(p.id, p.defaultModel ?? '') })),
    ...LOCAL_SERVERS.map((f) => ({
      name: f.label,
      make: () => connection(f.presetId, 'some-file.gguf', { label: f.label, baseUrl: f.baseUrl }),
    })),
  ];
  for (const start of starts) {
    for (const to of PRESETS) {
      const c = start.make();
      switchPreset(c, to.id, LOCAL_SERVERS);
      const want = { baseUrl: to.baseUrl, model: to.defaultModel ?? '', label: to.label, transport: to.transport };
      const got = { baseUrl: c.baseUrl, model: c.model ?? '', label: c.label, transport: c.transport };
      if (JSON.stringify(want) !== JSON.stringify(got) || JSON.stringify(c.extraBody) !== JSON.stringify(to.extraBody ?? {})) {
        bad.push(`${start.name}→${to.id}: ${JSON.stringify(got)}`);
      }
    }
  }
  check(`every switch from defaults fills the new preset's fields (${starts.length}×${PRESETS.length})`, bad.length === 0, bad.slice(0, 5).join(' | '));
}

if (failures) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nPreset checks passed.');
