import type { Connection } from '../types';

/**
 * Raised for any provider failure.
 *
 * Nothing branches on `status` — it is carried for diagnosis. This class used
 * to expose a `retryable` getter gating 408/429/5xx, which no caller ever read,
 * and gating on it would have been wrong: `runCompletion` tries the next
 * connection on *every* failure, deliberately. A mistyped key on the primary
 * answers 401, and covering that is precisely what a fallback connection is
 * for — one provider's rejection says nothing about the next one's, which is a
 * different question from whether re-sending to the *same* endpoint is
 * worthwhile. Nowhere in ProofKey re-sends to the same endpoint.
 */
export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly connectionLabel: string;

  constructor(message: string, connectionLabel: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.connectionLabel = connectionLabel;
    this.status = status;
  }
}

export interface CompletionRequest {
  systemPrompt: string;
  userText: string;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Joins the base URL with an endpoint path and applies the connection's query params. */
export function buildUrl(connection: Connection, path: string): string {
  const url = new URL(`${connection.baseUrl.replace(/\/+$/, '')}${path}`);
  for (const [key, value] of Object.entries(connection.extraQuery)) {
    url.searchParams.set(key, value);
  }
  if (connection.authStyle === 'query' && connection.authQueryParam) {
    url.searchParams.set(connection.authQueryParam, connection.apiKey);
  }
  return url.toString();
}

/**
 * Applies the connection's auth style plus any endpoint-specific headers.
 * `base` holds headers the transport itself requires and that the user's
 * `extraHeaders` may deliberately override.
 */
export function buildHeaders(
  connection: Connection,
  base: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...base };
  const key = connection.apiKey.trim();

  if (key) {
    switch (connection.authStyle) {
      case 'bearer':
        headers['authorization'] = `Bearer ${key}`;
        break;
      case 'x-api-key':
        headers['x-api-key'] = key;
        break;
      case 'header':
        if (connection.authHeaderName) headers[connection.authHeaderName] = key;
        break;
      case 'query':
      case 'none':
        break;
    }
  }

  return { ...headers, ...connection.extraHeaders };
}

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * POSTs JSON and returns the parsed body, turning non-2xx responses into a
 * `ProviderError` carrying whatever message the endpoint provided.
 */
export async function postJson(
  connection: Connection,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (cause) {
    throw new ProviderError(describeNetworkFailure(cause, url), connection.label);
  }

  const payload = await readBody(response);
  if (!response.ok) {
    throw new ProviderError(extractErrorMessage(payload, response), connection.label, response.status);
  }
  return payload;
}

export async function getJson(
  connection: Connection,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers, signal: combined });
  } catch (cause) {
    throw new ProviderError(describeNetworkFailure(cause, url), connection.label);
  }

  const payload = await readBody(response);
  if (!response.ok) {
    throw new ProviderError(extractErrorMessage(payload, response), connection.label, response.status);
  }
  return payload;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * A cross-origin fetch that never reaches the server is indistinguishable from
 * a network outage, so point at the two causes users actually hit.
 */
function describeNetworkFailure(cause: unknown, url: string): string {
  if (cause instanceof DOMException && cause.name === 'TimeoutError') {
    return 'The request timed out after 60 seconds.';
  }
  if (cause instanceof DOMException && cause.name === 'AbortError') {
    return 'Request cancelled.';
  }
  let host = url;
  try {
    host = new URL(url).origin;
  } catch {
    /* keep the raw string */
  }
  return (
    `Could not reach ${host}. Grant ProofKey access to this endpoint in the options page, ` +
    'and for a local server check that it is running and allows the extension origin.'
  );
}

function extractErrorMessage(payload: unknown, response: Response): string {
  if (typeof payload === 'string' && payload.trim()) return payload.trim().slice(0, 500);

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const error = record['error'];
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>)['message'];
      if (typeof message === 'string') return message;
    }
    if (typeof record['message'] === 'string') return record['message'] as string;
    // Ollama and llama.cpp report failures on a bare `detail` field.
    if (typeof record['detail'] === 'string') return record['detail'] as string;
  }

  return `${response.status} ${response.statusText || 'request failed'}`;
}
