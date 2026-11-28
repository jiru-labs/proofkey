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
  /** A live check, which the in-browser model runs as one continuing conversation. Other transports ignore it. */
  liveCheck?: boolean;
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Joins the base URL with an endpoint path and applies the connection's query params. */
export function buildUrl(connection: Connection, path: string): string {
  const url = new URL(connection.baseUrl.trim());
  const qIndex = path.indexOf('?');
  const pathPart = qIndex >= 0 ? path.slice(0, qIndex) : path;
  const queryPart = qIndex >= 0 ? path.slice(qIndex + 1) : '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${pathPart.replace(/^\/+/, '')}`;
  if (queryPart) {
    for (const [key, value] of new URLSearchParams(queryPart)) {
      url.searchParams.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(connection.extraQuery ?? {})) {
    url.searchParams.set(key, value);
  }
  const key = connection.apiKey.trim();
  if (connection.authStyle === 'query' && connection.authQueryParam && key) {
    url.searchParams.set(connection.authQueryParam, key);
  }
  return url.toString();
}

/**
 * Applies the connection's auth style plus any endpoint-specific headers.
 * `base` holds headers the transport itself requires and that the user's
 * `extraHeaders` may deliberately override (matched case-insensitively).
 */
export function buildHeaders(
  connection: Connection,
  base: Record<string, string>,
): Record<string, string> {
  const entries = new Map<string, [string, string]>();
  const set = (name: string, value: string): void => {
    entries.set(name.toLowerCase(), [name, value]);
  };

  for (const [name, value] of Object.entries(base)) set(name, value);

  const key = connection.apiKey.trim();
  if (key) {
    switch (connection.authStyle) {
      case 'bearer':
        set('authorization', `Bearer ${key}`);
        break;
      case 'x-api-key':
        set('x-api-key', key);
        break;
      case 'header':
        if (connection.authHeaderName) set(connection.authHeaderName, key);
        break;
      case 'query':
      case 'none':
        break;
    }
  }

  for (const [name, value] of Object.entries(connection.extraHeaders ?? {})) set(name, value);

  const headers: Record<string, string> = {};
  for (const [name, value] of entries.values()) headers[name] = value;
  return headers;
}

export const REQUEST_TIMEOUT_MS = 60_000;

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
  const withContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
    ? headers
    : { 'content-type': 'application/json', ...headers };
  return requestJson(connection, url, { method: 'POST', headers: withContentType, body: JSON.stringify(body) }, signal);
}

export async function getJson(
  connection: Connection,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson(connection, url, { method: 'GET', headers }, signal);
}

async function requestJson(
  connection: Connection,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Request cancelled.', 'AbortError');
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(url, { ...init, signal: combined });
    payload = await readBody(response);
  } catch (cause) {
    // Caller-initiated aborts must propagate unwrapped so `runCompletion` stops
    // instead of treating cancellation as a provider failure and hitting backups.
    if (signal?.aborted) {
      throw signal.reason ?? (cause instanceof Error ? cause : new DOMException('Request cancelled.', 'AbortError'));
    }
    throw new ProviderError(redactKey(describeNetworkFailure(cause, url), connection.apiKey), connection.label);
  }

  if (!response.ok) {
    throw new ProviderError(
      redactKey(extractErrorMessage(payload, response), connection.apiKey),
      connection.label,
      response.status,
    );
  }
  return payload;
}

function redactKey(message: string, apiKey: string | undefined): string {
  const key = apiKey?.trim();
  if (!key || key.length < 6 || !message.includes(key)) return message;
  return message.split(key).join('[redacted]');
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
  // Gemini's OpenAI-compatible endpoint wraps the error in a JSON *array* —
  // `[{"error": {"code": 429, "message": "..."}}]` — where every other provider
  // sends the object bare. An array is `typeof 'object'`, so the lookups below
  // all missed and every Google failure read as a bare "429 request failed",
  // dropping the one sentence that says which quota ran out. Verified against
  // the live endpoint on 2026-08-18.
  const body = Array.isArray(payload) ? payload[0] : payload;

  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 500);

  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const error = record['error'];
    if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 500);
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>)['message'];
      if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
    }
    if (typeof record['message'] === 'string' && record['message'].trim()) {
      return record['message'].trim().slice(0, 500);
    }
    // Ollama and llama.cpp report failures on a bare `detail` field.
    if (typeof record['detail'] === 'string' && record['detail'].trim()) {
      return record['detail'].trim().slice(0, 500);
    }
  }

  return `${response.status} ${response.statusText || 'request failed'}`;
}
