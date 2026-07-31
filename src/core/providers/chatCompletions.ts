import type { Connection } from '../types';
import {
  buildHeaders,
  buildUrl,
  getJson,
  postJson,
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
} from './request';

/**
 * The OpenAI `/chat/completions` shape, which OpenRouter, Groq, Ollama,
 * LM Studio, DeepSeek, Mistral, Together, Azure and most self-hosted servers
 * also speak. One adapter covers all of them.
 */
export async function complete(
  connection: Connection,
  request: CompletionRequest,
): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    model: connection.model,
    messages: [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userText },
    ],
    max_tokens: connection.maxOutputTokens,
    stream: false,
    ...connection.extraBody,
  };

  // Only sent when the user set it, so endpoints that reject sampling
  // parameters are not handed one by default.
  if (connection.temperature !== undefined) body['temperature'] = connection.temperature;

  const payload = await postJson(
    connection,
    buildUrl(connection, '/chat/completions'),
    buildHeaders(connection, {}),
    body,
    request.signal,
  );

  return parseCompletion(connection, payload);
}

function parseCompletion(connection: Connection, payload: unknown): CompletionResult {
  if (!payload || typeof payload !== 'object') {
    throw new ProviderError('The endpoint returned an empty response.', connection.label);
  }

  const record = payload as Record<string, unknown>;
  const choices = record['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError('The endpoint returned no choices.', connection.label);
  }

  const message = (choices[0] as Record<string, unknown>)['message'] as
    | Record<string, unknown>
    | undefined;
  const text = readContent(message?.['content']);

  if (!text.trim()) {
    const reason = (choices[0] as Record<string, unknown>)['finish_reason'];
    if (reason === 'length') {
      throw new ProviderError(
        'The reply hit the output token limit before producing any text. Raise "Max output tokens".',
        connection.label,
      );
    }
    throw new ProviderError('The model returned an empty reply.', connection.label);
  }

  const usage = record['usage'] as Record<string, unknown> | undefined;
  return {
    text,
    model: typeof record['model'] === 'string' ? record['model'] : connection.model,
    inputTokens: numeric(usage?.['prompt_tokens']),
    outputTokens: numeric(usage?.['completion_tokens']),
  };
}

/**
 * `content` is a plain string on most endpoints, but some return the
 * multi-part array shape instead. Reasoning models may also put their chain of
 * thought on a sibling field, which is deliberately ignored.
 */
function readContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>)['text'];
        if (typeof text === 'string') return text;
      }
      return '';
    })
    .join('');
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** Lists model ids from `GET /models`, used by the options page. */
export async function listModels(
  connection: Connection,
  signal?: AbortSignal,
): Promise<string[]> {
  const payload = await getJson(
    connection,
    buildUrl(connection, '/models'),
    buildHeaders(connection, {}),
    signal,
  );

  const data = (payload as Record<string, unknown> | undefined)?.['data'];
  if (!Array.isArray(data)) return [];

  return data
    .map((entry) => (entry as Record<string, unknown>)?.['id'])
    .filter((id): id is string => typeof id === 'string')
    .sort((a, b) => a.localeCompare(b));
}
