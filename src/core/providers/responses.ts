import type { Connection } from '../types';
import { listModels as listChatModels } from './chatCompletions';
import {
  buildHeaders,
  buildUrl,
  postJson,
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
} from './request';
import { sessionHeaders } from './session';

/**
 * The OpenAI Responses API (`POST /responses`). OpenCode Go serves its
 * `gpt-*-luna` and `grok-*` models only this way: on `/chat/completions` they
 * answer `ModelProtocolUnsupported` (measured 2026-10-10).
 */
export async function complete(
  connection: Connection,
  request: CompletionRequest,
): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    model: connection.model,
    instructions: request.systemPrompt,
    input: [{ role: 'user', content: request.userText }],
    max_output_tokens: connection.maxOutputTokens,
    stream: false,
    ...connection.extraBody,
  };
  // Only sent when the user set it: `gpt-6-luna` refuses the parameter.
  if (connection.temperature !== undefined) body['temperature'] = connection.temperature;

  const payload = await postJson(
    connection,
    buildUrl(connection, '/responses'),
    buildHeaders(connection, await sessionHeaders(connection)),
    body,
    request.signal,
  );

  return parseResponse(connection, payload);
}

function parseResponse(connection: Connection, payload: unknown): CompletionResult {
  if (!payload || typeof payload !== 'object') {
    throw new ProviderError('The endpoint returned an empty response.', connection.label);
  }
  const record = payload as Record<string, unknown>;
  const output = Array.isArray(record['output']) ? record['output'] : [];

  // Reasoning items come first on models that think; only `message` items are the reply.
  const text = output
    .filter((item) => (item as Record<string, unknown>)?.['type'] === 'message')
    .flatMap((item) => {
      const content = (item as Record<string, unknown>)['content'];
      return Array.isArray(content) ? content : [];
    })
    .map((part) => {
      const text = (part as Record<string, unknown>)?.['text'];
      return typeof text === 'string' ? text : '';
    })
    .join('');

  if (!text.trim()) {
    const details = record['incomplete_details'] as Record<string, unknown> | undefined;
    if (record['status'] === 'incomplete' && details?.['reason'] === 'max_output_tokens') {
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
    inputTokens: typeof usage?.['input_tokens'] === 'number' ? usage['input_tokens'] : undefined,
    outputTokens: typeof usage?.['output_tokens'] === 'number' ? usage['output_tokens'] : undefined,
  };
}

/** `GET /models` is the same endpoint whichever protocol the models answer. */
export const listModels = listChatModels;
