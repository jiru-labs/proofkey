import { disableThinkingBody } from '../presets';
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

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Headers the Messages API requires. `anthropic-dangerous-direct-browser-access`
 * opts in to the CORS response that lets a browser extension call the API
 * without a proxy; without it the request is blocked before it is sent.
 */
function anthropicHeaders(connection: Connection): Record<string, string> {
  return buildHeaders(connection, {
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  });
}

/**
 * The current Messages API (`POST /v1/messages`): a top-level `system` string
 * plus a `messages` array. This is not the retired `/v1/complete` format.
 */
export async function complete(
  connection: Connection,
  request: CompletionRequest,
): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    model: connection.model,
    max_tokens: connection.maxOutputTokens,
    system: request.systemPrompt,
    messages: [{ role: 'user', content: request.userText }],
    // No Anthropic preset declares a fragment — nobody has measured this
    // transport's dialect — so today this contributes nothing. Wired anyway, so
    // the day it is measured it is one line in `presets.ts` and no code change.
    ...disableThinkingBody(connection),
    ...connection.extraBody,
  };

  // Current Claude models reject `temperature` with a 400, so it is sent only
  // when the user deliberately set one (for an older model or a proxy).
  if (connection.temperature !== undefined) body['temperature'] = connection.temperature;

  const payload = await postJson(
    connection,
    buildUrl(connection, '/messages'),
    anthropicHeaders(connection),
    body,
    request.signal,
  );

  return parseMessage(connection, payload);
}

function parseMessage(connection: Connection, payload: unknown): CompletionResult {
  if (!payload || typeof payload !== 'object') {
    throw new ProviderError('Anthropic returned an empty response.', connection.label);
  }

  const record = payload as Record<string, unknown>;

  // A declined request is a successful HTTP 200, so it has to be checked
  // before reading the content array.
  if (record['stop_reason'] === 'refusal') {
    throw new ProviderError(
      'Claude declined this request. Try a different model or rephrase the text.',
      connection.label,
    );
  }

  const content = record['content'];
  const text = Array.isArray(content)
    ? content
        .filter(
          (block): block is Record<string, unknown> =>
            !!block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'text',
        )
        .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
        .join('')
    : '';

  if (!text.trim()) {
    if (record['stop_reason'] === 'max_tokens') {
      throw new ProviderError(
        'The reply hit the output token limit before producing any text. Raise "Max output tokens".',
        connection.label,
      );
    }
    throw new ProviderError('Claude returned an empty reply.', connection.label);
  }

  const usage = record['usage'] as Record<string, unknown> | undefined;
  return {
    text,
    model: typeof record['model'] === 'string' ? record['model'] : connection.model,
    inputTokens: numeric(usage?.['input_tokens']),
    outputTokens: numeric(usage?.['output_tokens']),
  };
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export async function listModels(
  connection: Connection,
  signal?: AbortSignal,
): Promise<string[]> {
  const payload = await getJson(
    connection,
    buildUrl(connection, '/models'),
    anthropicHeaders(connection),
    signal,
  );

  const data = (payload as Record<string, unknown> | undefined)?.['data'];
  if (!Array.isArray(data)) return [];

  return data
    .map((entry) => (entry as Record<string, unknown>)?.['id'])
    .filter((id): id is string => typeof id === 'string');
}
