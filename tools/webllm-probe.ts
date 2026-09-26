/**
 * Measures a model running *inside the browser* through WebLLM on the same job
 * `tools/eval.ts` measures every provider on: the real composed live-check
 * prompt, the real `parseCheckReply`, the same 14 fixtures, greedy decoding.
 *
 *     node tools/build-webllm-probe.mjs     → tools/webllm-probe.html (one file)
 *
 * Open that file in the browser under test — double-click is enough, it needs
 * no server — and it reports, for that exact browser and GPU:
 *
 *   1. Whether WebGPU exists, which adapter it picked and whether it has
 *      `shader-f16`. Chromium blocklists some GPU/driver pairs, and a
 *      browser's own settings can turn WebGPU off, so this is measured, not
 *      assumed from the browser's name.
 *   2. For each model: download-and-compile time, then per run the latency,
 *      WebLLM's own prefill and decode tokens/s, contract failures, false
 *      alarms and correct fixtures — the columns MODELS.md already uses.
 *
 * It exists to decide whether an in-browser model is worth building into
 * ProofKey for browsers without Chrome's built-in model (Brave, Edge on Linux).
 * It is a measuring tool, not the product: it loads WebLLM from jsDelivr, the
 * model's compiled WebGPU library from raw.githubusercontent.com and the weights
 * from huggingface.co, and the page says so before anything is fetched. The
 * extension could not do the first two at all — MV3 forbids code fetched at
 * runtime — so a shipped version would have to bundle WebLLM and the `.wasm`.
 *
 * Reply handling matches the worker: no `<think>` stripping, because
 * `chatCompletions.ts` does none, so a reply is scored exactly as the extension
 * would score it. `parseCheckReply` tolerates a short `<think>` block ahead of
 * the numbered lines (measured with a stubbed engine, 2026-09-26), so thinking is
 * flagged separately — only when the block has something in it, because Qwen3.5
 * emits an empty one with thinking off. Its cost is latency, which the project's
 * policy excludes.
 */

import {
  BUILT_IN_ACTIONS,
  composeCheckPrompt,
  composeSystemPrompt,
  dropAddedFullStops,
  formatCheckPayload,
  parseCheckReply,
} from '../src/core/prompts';
import type { WritingAction, WritingProfile } from '../src/core/types';
import {
  FIXTURES as ACTION_MIXED,
  isTranslating,
  MONOLINGUAL_FIXTURES as ACTION_MONOLINGUAL,
  scoreOutput,
  TRANSLATE_FIXTURES as ACTION_TRANSLATE,
  type Fixture as ActionFixture,
} from './action-eval-fixtures';
import { FIXTURES } from './eval-fixtures';

/** Pinned: a measurement names the version it was taken on. */
const WEBLLM_VERSION = '0.2.85';
const WEBLLM_URL = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/+esm`;

/**
 * Candidates, smallest useful first. Qwen3-4B is here because its 2507
 * instruct sibling scored 11.0/14 through llama.cpp, and WebLLM ships only the
 * original hybrid checkpoint — whether that one holds up is the question.
 */
const MODELS = [
  { id: 'Qwen3.5-4B-q4f16_1-MLC', checked: true },
  { id: 'Qwen3.5-2B-q4f16_1-MLC', checked: true },
  // 7.0/14 on the RX 6600 (2026-09-26): it handed every error back unchanged.
  { id: 'Qwen3-4B-q4f16_1-MLC', checked: false },
  { id: 'Qwen3-1.7B-q4f16_1-MLC', checked: false },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', checked: false },
  { id: 'Phi-4-mini-instruct-q4f16_1-MLC', checked: false },
];

const EMPTY_PROFILE: WritingProfile = {
  styleGuide: '',
  neverFlag: [],
  nativeLanguage: '',
  explainLanguage: '',
  translateLanguage: '',
};

/** Whitespace-insensitive, everything else exact — the same rule as `tools/eval.ts`. */
const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();
const isClean = (index: number): boolean =>
  normalise(FIXTURES[index]!.input) === normalise(FIXTURES[index]!.expect);

interface RunResult {
  ms: number;
  prefillTokensPerSecond?: number;
  decodeTokensPerSecond?: number;
  promptTokens?: number;
  completionTokens?: number;
  contractBroken: boolean;
  thoughtOutLoud: boolean;
  correct: number;
  falseAlarms: number;
  /** Fixture index → what came back, only where it was wrong. */
  wrong: Record<number, string>;
  rawReply?: string;
}

interface ActionFixtureResult {
  set: 'mixed' | 'monolingual' | 'translate';
  input: string;
  ok: number;
  of: number;
  translated: string[];
  dropped: string[];
  respelled: string[];
  /** Every distinct output, for a human to read — the real result, as in action-eval.ts. */
  outputs: string[];
}

interface ActionResult {
  action: string;
  ok: number;
  of: number;
  mixed: string;
  monolingual: string;
  translate: string;
  meanSeconds: number;
  fixtures: ActionFixtureResult[];
}

interface ModelResult {
  model: string;
  loadSeconds?: number;
  error?: string;
  runs: RunResult[];
  actions?: ActionResult[];
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const log = (line: string): void => {
  const out = $('log');
  out.textContent += `${line}\n`;
  out.scrollTop = out.scrollHeight;
};

const report: {
  tool: string;
  webllm: string;
  startedAt: string;
  userAgent: string;
  brands?: string;
  webgpu: Record<string, unknown>;
  runsPerModel: number;
  actionRunsPerFixture?: number;
  results: ModelResult[];
} = {
  tool: 'proofkey webllm-probe',
  webllm: WEBLLM_VERSION,
  startedAt: new Date().toISOString(),
  userAgent: navigator.userAgent,
  webgpu: {},
  runsPerModel: 0,
  results: [],
};

function showReport(): void {
  $<HTMLTextAreaElement>('result').value = JSON.stringify(report);
}

async function probeWebGpu(): Promise<boolean> {
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } })
    .userAgentData?.brands?.map((b) => b.brand).join(' | ');
  report.brands = brands;
  log(`Navegador: ${brands ?? navigator.userAgent}`);

  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) {
    report.webgpu = { available: false, reason: 'navigator.gpu is undefined' };
    log('WebGPU: NO disponible (navigator.gpu no existe).');
    return false;
  }
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    report.webgpu = { available: false, reason: 'requestAdapter() returned null' };
    log('WebGPU: NO disponible (requestAdapter() devolvió null: GPU bloqueada o desactivada).');
    return false;
  }
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  report.webgpu = {
    available: true,
    vendor: info?.vendor,
    architecture: info?.architecture,
    device: info?.device,
    description: info?.description,
    shaderF16: adapter.features.has('shader-f16'),
    maxBufferSizeMB: Math.round(adapter.limits.maxBufferSize / 2 ** 20),
    maxStorageBufferBindingSizeMB: Math.round(adapter.limits.maxStorageBufferBindingSize / 2 ** 20),
  };
  log(`WebGPU: sí — ${JSON.stringify(report.webgpu)}`);
  return true;
}

function score(reply: string): Omit<RunResult, 'ms'> {
  const inputs = FIXTURES.map((f) => f.input);
  // Qwen3.5 in WebLLM 0.2.85 emits an empty `<think></think>` even with
  // thinking off (measured on the RX 6600, 2026-09-26); only content counts.
  const thoughtOutLoud = /<think>\s*\S[\s\S]*?<\/think>/i.test(reply) || /<think>(?![\s\S]*<\/think>)/i.test(reply);
  const lines = parseCheckReply(reply, inputs.length);
  const parsed = lines && dropAddedFullStops(inputs, lines);
  if (!parsed) {
    return {
      contractBroken: true,
      thoughtOutLoud,
      correct: 0,
      falseAlarms: 0,
      wrong: {},
      rawReply: reply.slice(0, 2000),
    };
  }
  let correct = 0;
  let falseAlarms = 0;
  const wrong: Record<number, string> = {};
  parsed.forEach((got, index) => {
    if (normalise(got) === normalise(FIXTURES[index]!.expect)) {
      correct++;
      return;
    }
    wrong[index] = got;
    if (isClean(index)) falseAlarms++;
  });
  return { contractBroken: false, thoughtOutLoud, correct, falseAlarms, wrong };
}

type Engine = { chat: { completions: { create: (r: unknown) => Promise<any> } }; unload: () => Promise<void> };

/**
 * The quick actions, scored like `tools/action-eval.ts`: every enabled built-in
 * action on the mixed-language and the one-language fixtures, and Translate on
 * its own four, into English. Greedy, like the live check.
 */
async function measureActions(engine: Engine, model: string, runs: number): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const actions: WritingAction[] = BUILT_IN_ACTIONS.filter((a) => a.enabled).map((a) => ({ ...a }));
  for (const action of actions) {
    const translating = isTranslating(action);
    const profile: WritingProfile = translating
      ? { ...EMPTY_PROFILE, translateLanguage: 'English' }
      : EMPTY_PROFILE;
    const sets: [ActionFixtureResult['set'], ActionFixture[]][] = translating
      ? [['translate', ACTION_TRANSLATE]]
      : [['mixed', ACTION_MIXED], ['monolingual', ACTION_MONOLINGUAL]];
    const perFixture: ActionFixtureResult[] = [];
    let spent = 0;
    let calls = 0;
    for (const [set, fixtures] of sets) {
      for (const fixture of fixtures) {
        const row: ActionFixtureResult = { set, input: fixture.input, ok: 0, of: 0, translated: [], dropped: [], respelled: [], outputs: [] };
        for (let i = 0; i < runs; i++) {
          const started = performance.now();
          const reply = await engine.chat.completions.create({
            messages: [
              { role: 'system', content: composeSystemPrompt(action, profile) },
              { role: 'user', content: fixture.input },
            ],
            temperature: 0,
            max_tokens: 1024,
            ...(model.startsWith('Qwen3') ? { extra_body: { enable_thinking: false } } : {}),
          });
          spent += performance.now() - started;
          calls++;
          const raw: string = reply?.choices?.[0]?.message?.content ?? '';
          // The worker strips nothing, so neither does this; an empty think block
          // is taken off only for the reader, not for the score.
          const score = scoreOutput(action, fixture, raw);
          row.of++;
          if (score.ok) row.ok++;
          for (const w of score.appeared) if (!row.translated.includes(w)) row.translated.push(w);
          if (score.dropped) for (const w of score.lost) if (!row.dropped.includes(w)) row.dropped.push(w);
          if (score.respelled) for (const w of score.lost) if (!row.respelled.includes(w)) row.respelled.push(w);
          const shown = raw.replace(/<think>\s*<\/think>\s*/i, '').trim().slice(0, 600);
          if (!row.outputs.includes(shown)) row.outputs.push(shown);
        }
        perFixture.push(row);
      }
    }
    const tally = (set: ActionFixtureResult['set']): string => {
      const rows = perFixture.filter((r) => r.set === set);
      return rows.length ? `${rows.reduce((a, r) => a + r.ok, 0)}/${rows.reduce((a, r) => a + r.of, 0)}` : '';
    };
    const result: ActionResult = {
      action: action.id,
      ok: perFixture.reduce((a, r) => a + r.ok, 0),
      of: perFixture.reduce((a, r) => a + r.of, 0),
      mixed: tally('mixed'),
      monolingual: tally('monolingual'),
      translate: tally('translate'),
      meanSeconds: Math.round(spent / Math.max(1, calls) / 100) / 10,
      fixtures: perFixture,
    };
    results.push(result);
    const parts = translating
      ? `traducción ${result.translate}`
      : `mezcla ${result.mixed} · un idioma ${result.monolingual}`;
    const bad = perFixture.filter((r) => r.ok < r.of).map((r) => [...r.translated, ...r.dropped].join('/') || '?');
    log(`  ${action.id}: ${parts} · ${result.meanSeconds} s de media${bad.length ? ` · fallos: ${bad.join(', ')}` : ''}`);
    showReport();
  }
  return results;
}

async function measure(): Promise<void> {
  $<HTMLButtonElement>('start').disabled = true;
  const doLive = $<HTMLInputElement>('do-live').checked;
  const doActions = $<HTMLInputElement>('do-actions').checked;
  const runs = doLive ? Math.max(1, Number($<HTMLInputElement>('runs').value) || 10) : 0;
  const actionRuns = Math.max(1, Number($<HTMLInputElement>('action-runs').value) || 1);
  report.runsPerModel = runs;
  if (doActions) report.actionRunsPerFixture = actionRuns;
  const chosen = MODELS.filter((m) => $<HTMLInputElement>(`m-${m.id}`).checked).map((m) => m.id);

  if (!(await probeWebGpu())) {
    log('Sin WebGPU no se puede medir ningún modelo en este navegador. Copia el resultado de abajo.');
    showReport();
    return;
  }

  log(`Cargando WebLLM ${WEBLLM_VERSION} desde jsDelivr…`);
  const url = WEBLLM_URL;
  const webllm = await import(/* @vite-ignore */ url);
  const messages = [
    { role: 'system', content: composeCheckPrompt(EMPTY_PROFILE, FIXTURES.length) },
    { role: 'user', content: formatCheckPayload(FIXTURES.map((f) => f.input)) },
  ];

  for (const model of chosen) {
    const result: ModelResult = { model, runs: [] };
    report.results.push(result);
    log(`\n== ${model} ==`);
    let engine: Engine | undefined;
    try {
      const t0 = performance.now();
      let lastShown = -1;
      engine = await webllm.CreateMLCEngine(model, {
        initProgressCallback: (p: { progress: number; text: string }) => {
          const pct = Math.floor(p.progress * 100);
          if (pct !== lastShown && pct % 5 === 0) {
            lastShown = pct;
            log(`  ${p.text}`);
          }
        },
      });
      result.loadSeconds = Math.round((performance.now() - t0) / 100) / 10;
      log(`  cargado en ${result.loadSeconds} s`);

      for (let i = 1; i <= runs; i++) {
        const started = performance.now();
        const reply = await engine!.chat.completions.create({
          messages,
          temperature: 0,
          max_tokens: 1024,
          ...(model.startsWith('Qwen3') ? { extra_body: { enable_thinking: false } } : {}),
        });
        const ms = Math.round(performance.now() - started);
        const text: string = reply?.choices?.[0]?.message?.content ?? '';
        const usage = reply?.usage ?? {};
        const run: RunResult = {
          ms,
          prefillTokensPerSecond: usage.extra?.prefill_tokens_per_s,
          decodeTokensPerSecond: usage.extra?.decode_tokens_per_s,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          ...score(text),
        };
        result.runs.push(run);
        log(
          `  run ${i}/${runs}: ${run.contractBroken ? 'CONTRATO ROTO' : `${run.correct}/${FIXTURES.length}, falsas alarmas ${run.falseAlarms}`}` +
            ` · ${(ms / 1000).toFixed(1)} s · prefill ${run.prefillTokensPerSecond?.toFixed(0) ?? '?'} tok/s · decode ${run.decodeTokensPerSecond?.toFixed(0) ?? '?'} tok/s` +
            (run.thoughtOutLoud ? ' · ⚠ razonó en voz alta' : ''),
        );
        showReport();
      }
      if (runs > 0) {
        const ok = result.runs.filter((r) => !r.contractBroken);
        const mean = ok.length ? ok.reduce((a, r) => a + r.correct, 0) / ok.length : 0;
        log(`  MEDIA ${mean.toFixed(1)}/${FIXTURES.length} en ${ok.length}/${runs} runs con contrato válido`);
      }
      if (doActions) {
        log('  acciones rápidas (casos de tools/action-eval.ts):');
        result.actions = await measureActions(engine!, model, actionRuns);
      }
    } catch (error) {
      result.error = String((error as Error)?.message ?? error);
      log(`  ERROR: ${result.error}`);
    } finally {
      await engine?.unload().catch(() => undefined);
      showReport();
    }
  }
  log('\nTerminado. Copia el resultado de abajo (botón «Copiar») y pégamelo.');
  $<HTMLButtonElement>('start').disabled = false;
}

function init(): void {
  // `?models=a,b&runs=1` replaces the list — for testing the page itself on a
  // small model, e.g. under a software WebGPU adapter.
  const params = new URLSearchParams(location.search);
  const override = params.get('models')?.split(',').filter(Boolean);
  if (override?.length) MODELS.splice(0, MODELS.length, ...override.map((id) => ({ id, checked: true })));
  if (params.get('runs')) $<HTMLInputElement>('runs').value = params.get('runs')!;
  if (params.get('live')) $<HTMLInputElement>('do-live').checked = params.get('live') === '1';
  if (params.get('actions')) $<HTMLInputElement>('do-actions').checked = params.get('actions') === '1';
  if (params.get('arun')) $<HTMLInputElement>('action-runs').value = params.get('arun')!;
  $('models').innerHTML = MODELS.map(
    (m) =>
      `<label><input type="checkbox" id="m-${m.id}" ${m.checked ? 'checked' : ''}> ${m.id}</label>`,
  ).join('');
  $('start').addEventListener('click', () => {
    measure().catch((error) => {
      log(`ERROR: ${error}`);
      showReport();
      $<HTMLButtonElement>('start').disabled = false;
    });
  });
  $('copy').addEventListener('click', () => {
    const area = $<HTMLTextAreaElement>('result');
    area.select();
    navigator.clipboard?.writeText(area.value).catch(() => document.execCommand('copy'));
  });
  $('gpu').addEventListener('click', () => {
    probeWebGpu().then(showReport).catch((error) => log(`ERROR: ${error}`));
  });
}

init();
