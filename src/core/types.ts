/**
 * Wire format a connection speaks. Borrowed from Hermes Agent's `api_mode`
 * abstraction: almost every provider is OpenAI-compatible, so only genuinely
 * different protocols get their own adapter. Everything else is registry data.
 */
export type Transport = 'chat_completions' | 'anthropic_messages';

/** How the API key is attached to the request. */
export type AuthStyle =
  | 'bearer' // Authorization: Bearer <key> — OpenAI and most others
  | 'x-api-key' // x-api-key: <key> — Anthropic
  | 'header' // <authHeaderName>: <key> — Azure ("api-key") and friends
  | 'query' // ?<authQueryParam>=<key>
  | 'none'; // local servers

/**
 * Every provider ProofKey ships a prefilled entry for. Base URLs are taken from
 * Hermes Agent's `PROVIDER_REGISTRY` rather than guessed.
 *
 * Providers Hermes supports that are deliberately absent: those authenticating
 * by OAuth device flow (Nous Portal, OpenAI Codex, Qwen, GitHub Copilot) or by
 * cloud IAM (AWS Bedrock's SigV4, Vertex AI's service accounts). None fit a
 * bring-your-own-key extension without an auth backend, which this project
 * does not have. Any of them still works through the `custom` preset if the
 * user has a gateway in front of it.
 */
export type PresetId =
  | 'custom'
  | 'openai'
  | 'openrouter'
  | 'groq'
  | 'ollama'
  | 'lmstudio'
  | 'opencode-go'
  | 'anthropic'
  // OpenAI-compatible
  | 'opencode-zen'
  | 'gemini'
  | 'deepseek'
  | 'mistral'
  | 'xai'
  | 'together'
  | 'fireworks'
  | 'cerebras'
  | 'novita'
  | 'nvidia'
  | 'zai'
  | 'moonshot'
  | 'moonshot-cn'
  | 'alibaba'
  | 'alibaba-coding'
  | 'huggingface'
  | 'vercel-ai-gateway'
  | 'kilocode'
  | 'stepfun'
  | 'arcee'
  | 'gmi'
  | 'xiaomi'
  | 'tencent-tokenhub'
  | 'ollama-cloud'
  | 'azure-openai'
  | 'azure-foundry'
  | 'vllm'
  // Anthropic Messages wire format
  | 'minimax'
  | 'minimax-cn';

/**
 * One configured endpoint. ProofKey stores a list of these and switches between
 * them, so a local Ollama and a cloud key can coexist (Hermes calls these
 * "named custom providers").
 *
 * `extraHeaders` / `extraBody` / `extraQuery` are the compatibility escape
 * hatch: they cover OpenRouter's attribution headers, Azure's api-version,
 * provider routing preferences, and anything else a given endpoint expects
 * without needing new code.
 */
export interface Connection {
  id: string;
  /** User-facing name, e.g. "Local Ollama" or "Work proxy". */
  label: string;
  /** Preset this was created from. Drives hints and the "Fetch models" button. */
  presetId: PresetId;
  transport: Transport;
  /** Root URL the endpoint path is appended to, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  authStyle: AuthStyle;
  /** Header name when `authStyle` is `'header'`. */
  authHeaderName?: string;
  /** Query parameter name when `authStyle` is `'query'`. */
  authQueryParam?: string;
  extraHeaders: Record<string, string>;
  extraBody: Record<string, unknown>;
  extraQuery: Record<string, string>;
  /**
   * Omitted from the request when undefined. Current Anthropic models reject
   * `temperature` outright, so "unset" has to be representable.
   */
  temperature?: number;
  maxOutputTokens: number;
}

/** A prompt the user can invoke from the context menu or the inline card. */
export interface WritingAction {
  id: string;
  label: string;
  systemPrompt: string;
  /** False for actions the user created themselves. */
  builtIn: boolean;
  enabled: boolean;
}

/** A user-authored action. Built-ins live in `prompts.ts`, not in storage. */
export interface CustomAction {
  id: string;
  label: string;
  systemPrompt: string;
  enabled: boolean;
}

/**
 * Per-built-in tweaks. Only the fields the user actually changed are stored,
 * so improvements to the shipped prompts still reach existing installs.
 */
export interface BuiltInOverride {
  enabled?: boolean;
  label?: string;
  systemPrompt?: string;
}

/**
 * The as-you-type underline layer.
 *
 * Every check spends the user's own key, so this runs only on origins the user
 * explicitly enabled. Cost is kept down by checking on idle rather than per
 * keystroke, sending only sentences whose text changed, and never sending the
 * sentence the caret is currently inside.
 */
export interface LiveCheckSettings {
  /** Origins where live checking runs, e.g. `https://mail.google.com`. */
  enabledOrigins: string[];
  /** Never run here, even if the origin was enabled. */
  blockedOrigins: string[];
  /** Connection used for live checks. Falls back to the active connection. */
  connectionId?: string;
  /** Idle time after the last keystroke before a check fires. */
  debounceMs: number;
  /** Skip fields whose text is shorter than this. */
  minChars: number;
  /** Upper bound on sentences batched into a single request. */
  maxSentencesPerRequest: number;
  /** Words the user marked as correct; matching suggestions are suppressed. */
  dictionary: string[];
}

/**
 * The user's own writing rules, injected into every action.
 *
 * This is the thing rule-based checkers make expensive: LanguageTool needs XML
 * files and a self-hosted server to enforce house terminology, and its personal
 * dictionary cannot even hold a multi-word phrase. Against a language model the
 * same requirement is a paragraph of prose and a list of strings.
 */
export interface WritingProfile {
  /** Free-text house rules, e.g. "We write e-mail, not email. Avoid superlatives." */
  styleGuide: string;
  /** Terms never to flag or alter: brand names, product names, jargon. Phrases allowed. */
  neverFlag: string[];
  /**
   * The author's first language, in English, e.g. "Portuguese". When set, the
   * model is told to watch for the interference errors typical of its speakers —
   * something no per-language ruleset can express.
   */
  nativeLanguage: string;
  /** Language for explanations. Empty means explain in the text's own language. */
  explainLanguage: string;
}

export interface Settings {
  schemaVersion: number;
  connections: Connection[];
  activeConnectionId: string;
  /** Tried in order when the active connection fails. Hermes's fallback chain. */
  fallbackConnectionIds: string[];
  customActions: CustomAction[];
  builtInOverrides: Record<string, BuiltInOverride>;
  /** Action run by the keyboard shortcut and the inline card's main button. */
  defaultActionId: string;
  profile: WritingProfile;
  liveCheck: LiveCheckSettings;
}

/**
 * One correction, derived by diffing the model's rewrite against the original.
 * Offsets are into the field's plain text and are re-validated before the fix
 * is applied, since the user may have kept typing.
 */
export interface Suggestion {
  id: string;
  start: number;
  end: number;
  original: string;
  replacement: string;
  /** Heuristic label from the diff shape, e.g. "Tilde" or "Concordancia". */
  category: string;
  severity: 'grammar' | 'spelling' | 'style';
}
