import type { AuthStyle, PresetId, Transport } from './types';

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
    group: 'primary',
    hint: 'Use "Fetch models" to list the models your account can reach.',
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
  openaiCompatible('opencode-zen', 'OpenCode Zen', 'https://opencode.ai/zen/v1'),
  openaiCompatible(
    'gemini',
    'Google Gemini',
    'https://generativelanguage.googleapis.com/v1beta/openai',
    {
      defaultModel: 'gemini-2.5-flash',
      hint: "Gemini's OpenAI-compatible endpoint.",
      docsUrl: 'https://aistudio.google.com/apikey',
    },
  ),
  openaiCompatible('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', {
    defaultModel: 'deepseek-chat',
  }),
  openaiCompatible('mistral', 'Mistral', 'https://api.mistral.ai/v1', {
    defaultModel: 'mistral-small-latest',
  }),
  openaiCompatible('xai', 'xAI (Grok)', 'https://api.x.ai/v1'),
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
