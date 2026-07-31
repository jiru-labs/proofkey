import { getPreset } from '../presets';
import type { Connection } from '../types';
import * as anthropic from './anthropic';
import * as chatCompletions from './chatCompletions';
import { ProviderError, type CompletionRequest, type CompletionResult } from './request';

export { ProviderError } from './request';
export type { CompletionRequest, CompletionResult } from './request';

interface Adapter {
  complete(connection: Connection, request: CompletionRequest): Promise<CompletionResult>;
  listModels(connection: Connection, signal?: AbortSignal): Promise<string[]>;
}

/**
 * Two adapters cover every supported provider. Adding a provider that speaks
 * one of these transports is a row in `presets.ts`, not code.
 */
const ADAPTERS: Record<Connection['transport'], Adapter> = {
  chat_completions: chatCompletions,
  anthropic_messages: anthropic,
};

export interface ChainResult extends CompletionResult {
  /** Which connection actually served the request. */
  connection: Connection;
  /** Failures from earlier connections in the chain, if any. */
  fallbackErrors: { label: string; message: string }[];
}

/**
 * Runs the request against each connection in order until one succeeds.
 * Earlier failures are reported alongside the result rather than swallowed, so
 * a mistyped key on the primary connection stays visible even when a fallback
 * covers for it.
 */
export async function runCompletion(
  chain: Connection[],
  request: CompletionRequest,
): Promise<ChainResult> {
  if (chain.length === 0) {
    throw new ProviderError('No provider is configured. Open ProofKey settings first.', '—');
  }

  const failures: { label: string; message: string }[] = [];

  for (const connection of chain) {
    const invalid = validateConnection(connection);
    if (invalid) {
      failures.push({ label: connection.label, message: invalid });
      continue;
    }

    try {
      const result = await ADAPTERS[connection.transport].complete(connection, request);
      return { ...result, connection, fallbackErrors: failures };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ label: connection.label, message });
    }
  }

  const detail = failures.map((f) => `${f.label}: ${f.message}`).join('\n');
  throw new ProviderError(
    failures.length === 1 ? failures[0]!.message : `Every provider failed.\n${detail}`,
    failures[0]?.label ?? '—',
  );
}

export function listModels(connection: Connection, signal?: AbortSignal): Promise<string[]> {
  const invalid = validateConnection(connection, { requireModel: false });
  if (invalid) return Promise.reject(new ProviderError(invalid, connection.label));
  return ADAPTERS[connection.transport].listModels(connection, signal);
}

/** Returns a human-readable problem with the connection, or null when it is usable. */
export function validateConnection(
  connection: Connection,
  options: { requireModel?: boolean } = {},
): string | null {
  const { requireModel = true } = options;

  if (!connection.baseUrl.trim()) return 'No base URL set.';
  try {
    new URL(connection.baseUrl);
  } catch {
    return `"${connection.baseUrl}" is not a valid URL.`;
  }

  if (requireModel && !connection.model.trim()) return 'No model set.';

  const preset = getPreset(connection.presetId);
  if (preset.requiresApiKey && !connection.apiKey.trim()) {
    return `${preset.label} requires an API key.`;
  }

  if (connection.authStyle === 'header' && !connection.authHeaderName?.trim()) {
    return 'Auth header name is required when using a custom header.';
  }
  if (connection.authStyle === 'query' && !connection.authQueryParam?.trim()) {
    return 'Query parameter name is required when passing the key in the URL.';
  }

  return null;
}

/** Origin pattern to request host access for, e.g. `https://api.openai.com/*`. */
export function originPattern(connection: Connection): string | null {
  try {
    return `${new URL(connection.baseUrl).origin}/*`;
  } catch {
    return null;
  }
}
