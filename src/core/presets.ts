import type { AuthStyle, Connection, PresetId, Transport } from './types';

/**
 * A registry row, not a code path. Base URLs are taken from Hermes Agent's
 * `PROVIDER_REGISTRY` (`hermes_cli/auth.py`) rather than guessed. Adding a
 * provider that speaks one of the two supported transports means adding an
 * entry here — no adapter code.
 */
export interface Preset {
  id: PresetId;
  label: string;
  transport: Transport;
  /** Prefilled base URL. Empty where the user must supply their own. */
  baseUrl: string;
  defaultModel: string;
  authStyle: AuthStyle;
  authHeaderName?: string;
  authQueryParam?: string;
  requiresApiKey: boolean;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  extraQuery?: Record<string, string>;
  /**
   * Namespace prefix this endpoint puts on the ids `GET /models` returns, which
   * the options page strips before offering them. Gemini answers with Google
   * resource names (`models/gemini-2.5-flash`), and the bare id is the only
   * form measured against `/chat/completions`.
   */
  stripIdPrefix?: string;
  /**
   * Body fragment that turns thinking off on this endpoint, or undefined when
   * nobody has measured a way to.
   *
   * A function of the model rather than a constant, because this is not a
   * provider-level property. On xAI only `grok-4.3` accepts the field: every
   * other Grok answers HTTP 400, either refusing the parameter or refusing the
   * value `none`. A preset that sent it unconditionally would break its own
   * default model.
   */
  disableThinking?: (model: string) => Record<string, unknown> | undefined;
  /** `primary` presets are listed first in the options page. */
  group: 'primary' | 'more';
  /** Shown under the fields in the options page. */
  hint?: string;
  docsUrl?: string;
}

/** Shorthand for the overwhelmingly common case: bearer auth, `/chat/completions`. */
function openaiCompatible(
  id: PresetId,
  label: string,
  baseUrl: string,
  extra: Partial<Preset> = {},
): Preset {
  return {
    id,
    label,
    transport: 'chat_completions',
    baseUrl,
    defaultModel: '',
    authStyle: 'bearer',
    requiresApiKey: true,
    group: 'more',
    ...extra,
  };
}

export const PRESETS: readonly Preset[] = [
  // ---------------------------------------------------------------- primary
  openaiCompatible('custom', 'Custom (any OpenAI-compatible endpoint)', '', {
    requiresApiKey: false,
    group: 'primary',
    hint: 'Paste the base URL up to and including /v1. ProofKey appends /chat/completions.',
  }),
  openaiCompatible('openai', 'OpenAI', 'https://api.openai.com/v1', {
    defaultModel: 'gpt-4.1-mini',
    group: 'primary',
    docsUrl: 'https://platform.openai.com/api-keys',
  }),
  openaiCompatible('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', {
    defaultModel: 'openai/gpt-4.1-mini',
    extraHeaders: { 'X-Title': 'ProofKey' },
    group: 'primary',
    hint: 'Models are namespaced, e.g. anthropic/claude-haiku-4.5 or meta-llama/llama-3.3-70b-instruct.',
    docsUrl: 'https://openrouter.ai/keys',
  }),
  openaiCompatible('groq', 'Groq', 'https://api.groq.com/openai/v1', {
    defaultModel: 'llama-3.3-70b-versatile',
    group: 'primary',
    docsUrl: 'https://console.groq.com/keys',
  }),
  openaiCompatible('ollama', 'Ollama (local)', 'http://localhost:11434/v1', {
    defaultModel: 'llama3.2',
    authStyle: 'none',
    requiresApiKey: false,
    group: 'primary',
    hint: 'Ollama must allow the extension origin: run it with OLLAMA_ORIGINS="chrome-extension://*".',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/faq.md',
  }),
  // 127.0.0.1 rather than localhost: localhost can resolve to ::1 first and
  // miss an IPv4-only local server.
  openaiCompatible('lmstudio', 'LM Studio (local)', 'http://127.0.0.1:1234/v1', {
    authStyle: 'none',
    requiresApiKey: false,
    group: 'primary',
    hint: 'Start the local server in LM Studio, then use "Fetch models" to list what is loaded.',
  }),
  openaiCompatible('opencode-go', 'OpenCode Go', 'https://opencode.ai/zen/go/v1', {
    defaultModel: 'gpt-5.6-luna',
    group: 'primary',
    hint: 'Flat-rate plan over coding models, which think — the fastest measured is 4.2s per live check and the slowest exceeds ProofKey\'s 60s timeout. gpt-5.6-luna is the measured pick; see MODELS.md. Do not set reasoning_effort: grok-4.5 and minimax-m2.5 reject it and the error does not say so. "Fetch models" over-reports — 3 of the 24 it lists cannot answer.',
    docsUrl: 'https://opencode.ai/docs/go/',
  }),
  {
    id: 'anthropic',
    label: 'Anthropic',
    transport: 'anthropic_messages',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-haiku-4-5',
    authStyle: 'x-api-key',
    requiresApiKey: true,
    group: 'primary',
    hint: 'Uses the Messages API (/v1/messages). Haiku is the cheapest tier and plenty for proofreading.',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },

  // ------------------------------------------------- OpenAI-compatible, more
  // A different product from OpenCode Go above, not a different URL for it:
  // pay-as-you-go over a 60-model catalogue, and a Go subscription buys none of
  // it — every paid model answers CreditsError without a balance.
  openaiCompatible('opencode-zen', 'OpenCode Zen', 'https://opencode.ai/zen/v1', {
    hint: 'Pay-as-you-go, and separate from an OpenCode Go plan — this needs its own balance. No model here has been measured; see MODELS.md for the prices.',
    docsUrl: 'https://opencode.ai/docs/zen/',
  }),
  openaiCompatible(
    'gemini',
    'Google Gemini',
    'https://generativelanguage.googleapis.com/v1beta/openai',
    {
      defaultModel: 'gemini-2.5-flash',
      // Sent on every model: 2.5-flash and 2.5-flash-lite honour it, and
      // 3.x and 2.5-pro drop it silently rather than erroring, so there is no
      // model here it can hurt. It rides on `disableThinking` rather than
      // `extraBody` precisely so it cannot outlive the endpoint it was measured
      // against — see `disableThinkingBody`.
      disableThinking: () => ({ reasoning_effort: 'none' }),
      stripIdPrefix: 'models/',
      hint: 'Gemini\'s OpenAI-compatible endpoint. Thinking is on at this endpoint by default and billed as output, so ProofKey turns it off — 2.5-flash and 2.5-flash-lite honour that, while Gemini 3.x and 2.5-pro ignore it and think anyway. See MODELS.md.',
      docsUrl: 'https://aistudio.google.com/apikey',
    },
  ),
  openaiCompatible('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', {
    defaultModel: 'deepseek-chat',
  }),
  openaiCompatible('mistral', 'Mistral', 'https://api.mistral.ai/v1', {
    defaultModel: 'mistral-small-latest',
  }),
  openaiCompatible('xai', 'xAI (Grok)', 'https://api.x.ai/v1', {
    defaultModel: 'grok-4.20-0309-non-reasoning',
    // Measured 2026-08-01, and the reason this is a function of the model:
    // grok-4.3 accepts the field and stops thinking; grok-4.5 refuses the value
    // `none`; grok-4.20-0309-* and grok-build-0.1 refuse the parameter itself.
    // All three refusals are HTTP 400 on every request, so the field is only
    // safe on the one id it was measured against.
    disableThinking: (model) =>
      model === 'grok-4.3' ? { reasoning_effort: 'none' } : undefined,
    hint: 'Grok models think by default, which costs seconds per live check and real money — 1,199 to 3,428 billed reasoning tokens. Only grok-4.3 can be told not to; the non-reasoning variant is the measured pick for everything else. See MODELS.md.',
    docsUrl: 'https://console.x.ai/',
  }),
  openaiCompatible('together', 'Together AI', 'https://api.together.xyz/v1'),
  openaiCompatible('fireworks', 'Fireworks AI', 'https://api.fireworks.ai/inference/v1'),
  openaiCompatible('cerebras', 'Cerebras', 'https://api.cerebras.ai/v1'),
  openaiCompatible('novita', 'Novita AI', 'https://api.novita.ai/v3/openai'),
  openaiCompatible('nvidia', 'NVIDIA NIM', 'https://integrate.api.nvidia.com/v1'),
  openaiCompatible('zai', 'Z.ai (GLM)', 'https://api.z.ai/api/paas/v4'),
  openaiCompatible('moonshot', 'Moonshot (Kimi)', 'https://api.moonshot.ai/v1'),
  openaiCompatible('moonshot-cn', 'Moonshot (Kimi, China)', 'https://api.moonshot.cn/v1'),
  openaiCompatible(
    'alibaba',
    'Qwen Cloud (DashScope)',
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  ),
  openaiCompatible(
    'alibaba-coding',
    'Alibaba Cloud (Coding Plan)',
    'https://coding-intl.dashscope.aliyuncs.com/v1',
  ),
  openaiCompatible('huggingface', 'Hugging Face', 'https://router.huggingface.co/v1', {
    hint: 'The token needs the "Inference Providers" permission.',
  }),
  openaiCompatible('vercel-ai-gateway', 'Vercel AI Gateway', 'https://ai-gateway.vercel.sh/v1'),
  openaiCompatible('kilocode', 'Kilo Code', 'https://api.kilo.ai/api/gateway'),
  openaiCompatible('stepfun', 'StepFun', 'https://api.stepfun.ai/step_plan/v1'),
  openaiCompatible('arcee', 'Arcee AI', 'https://api.arcee.ai/api/v1'),
  openaiCompatible('gmi', 'GMI Cloud', 'https://api.gmi-serving.com/v1'),
  openaiCompatible('xiaomi', 'Xiaomi MiMo', 'https://api.xiaomimimo.com/v1'),
  openaiCompatible('tencent-tokenhub', 'Tencent TokenHub', 'https://tokenhub.tencentmaas.com/v1'),
  openaiCompatible('ollama-cloud', 'Ollama Cloud', 'https://ollama.com/v1', {
    docsUrl: 'https://ollama.com/settings/keys',
  }),
  openaiCompatible('azure-openai', 'Azure OpenAI', '', {
    authStyle: 'header',
    authHeaderName: 'api-key',
    extraQuery: { 'api-version': '2024-10-21' },
    hint: 'Base URL is https://<resource>.openai.azure.com/openai/deployments/<deployment>. Model is the deployment name.',
  }),
  openaiCompatible('azure-foundry', 'Azure AI Foundry', '', {
    authStyle: 'header',
    authHeaderName: 'api-key',
    hint: 'Paste the endpoint shown in the Foundry portal, ending in /v1.',
  }),
  openaiCompatible('vllm', 'vLLM / llama.cpp (self-hosted)', 'http://localhost:8000/v1', {
    authStyle: 'none',
    requiresApiKey: false,
    hint: 'Any server exposing /v1/chat/completions works here.',
  }),

  // ------------------------------------------- Anthropic Messages wire format
  {
    id: 'minimax',
    label: 'MiniMax',
    transport: 'anthropic_messages',
    baseUrl: 'https://api.minimax.io/anthropic/v1',
    defaultModel: '',
    authStyle: 'x-api-key',
    requiresApiKey: true,
    group: 'more',
    hint: "MiniMax serves Anthropic's Messages format. If auth fails, switch the key style to Bearer.",
  },
  {
    id: 'minimax-cn',
    label: 'MiniMax (China)',
    transport: 'anthropic_messages',
    baseUrl: 'https://api.minimaxi.com/anthropic/v1',
    defaultModel: '',
    authStyle: 'x-api-key',
    requiresApiKey: true,
    group: 'more',
    hint: "MiniMax serves Anthropic's Messages format. If auth fails, switch the key style to Bearer.",
  },
];

export function getPreset(id: PresetId): Preset {
  return PRESETS.find((preset) => preset.id === id) ?? PRESETS[0]!;
}

/**
 * Normalises whatever the user pasted into a base URL we can append paths to:
 * trims trailing slashes and strips a trailing endpoint path, so pasting a full
 * `https://host/v1/chat/completions` URL works.
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\s+/g, '');
  if (!url) return '';
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/(chat\/completions|completions|messages|responses)$/i, '');
  return url;
}

/**
 * The body fragment that turns thinking off for this connection, or undefined
 * when there is nothing measured to send.
 *
 * Guarded on the base URL still matching the preset's, and that guard is the
 * whole reason this lives here rather than in `extraBody`. Only the provider
 * dropdown rewrites a connection's extra body, so a connection repointed at
 * another endpoint by editing its base URL alone keeps whatever it was carrying
 * — and `reasoning_effort` is HTTP 400 on most of xAI. Deriving the fragment
 * from the preset at request time means it simply stops being sent the moment
 * the connection no longer points where it was measured.
 */
export function disableThinkingBody(
  connection: Connection,
): Record<string, unknown> | undefined {
  if (connection.thinking !== 'off') return undefined;
  const preset = getPreset(connection.presetId);
  if (!preset.disableThinking || !preset.baseUrl) return undefined;
  if (normalizeBaseUrl(preset.baseUrl) !== normalizeBaseUrl(connection.baseUrl)) return undefined;
  return preset.disableThinking(connection.model.trim());
}

/** Why the thinking setting will or will not do anything, in the user's terms. */
export function thinkingNote(connection: Connection): string {
  const preset = getPreset(connection.presetId);

  if (!preset.disableThinking || !preset.baseUrl) {
    return 'No measured way to turn thinking off on this provider. If you know its dialect, put it in Extra body fields — but check it first, because a field the endpoint rejects fails every request rather than being ignored.';
  }
  if (normalizeBaseUrl(preset.baseUrl) !== normalizeBaseUrl(connection.baseUrl)) {
    return `Nothing is sent: the base URL no longer matches the ${preset.label} preset, and a switch measured on one endpoint is not safe on another. Pick the provider this endpoint really is.`;
  }
  if (connection.thinking !== 'off') {
    return 'Thinking is left on. It buys no accuracy on this workload and costs latency on every check.';
  }
  const body = preset.disableThinking(connection.model.trim());
  return body
    ? `Sends ${JSON.stringify(body)} with every request.`
    : `${preset.label} rejects that field on ${connection.model.trim() || 'this model'}, so nothing is sent and the model thinks anyway. Switch models if the latency matters.`;
}
