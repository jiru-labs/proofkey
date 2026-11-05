import { effectiveTransport, getPreset, replacementModel } from '../presets';
import type { Connection } from '../types';
import * as anthropic from './anthropic';
import * as chatCompletions from './chatCompletions';
import * as chromeBuiltin from './chromeBuiltin';
import * as inBrowser from './inBrowser';
import * as responses from './responses';
import { ProviderError, type CompletionRequest, type CompletionResult } from './request';

export { ProviderError } from './request';
export type { CompletionRequest, CompletionResult } from './request';

interface Adapter {
  complete(connection: Connection, request: CompletionRequest): Promise<CompletionResult>;
  listModels(connection: Connection, signal?: AbortSignal): Promise<string[]>;
}

/**
 * Three network adapters cover every remote provider. Adding a provider that
 * speaks one of these transports is a row in `presets.ts`, not code. The other
 * two run a model on this computer and have no URL at all.
 */
const ADAPTERS: Record<Connection['transport'], Adapter> = {
  chat_completions: chatCompletions,
  openai_responses: responses,
  anthropic_messages: anthropic,
  chrome_builtin: chromeBuiltin,
  in_browser: inBrowser,
};

export interface ChainResult extends CompletionResult {
  /** Which connection actually served the request. */
  connection: Connection;
  /** Failures from earlier connections in the chain, if any. */
  fallbackErrors: { label: string; message: string }[];
  /** Set when the provider no longer served the stored model and `connection` carries its replacement. */
  movedModel?: { connectionId: string; from: string; to: string };
}

/**
 * A refused request whose model may simply be gone: 404 is OpenAI's and
 * Gemini's answer, 400 OpenRouter's and OpenCode Go's (each measured
 * 2026-11-04). Both also mean many other things, which is why the catalogue,
 * not the status, decides.
 */
function mayBeRetiredModel(error: unknown): boolean {
  return error instanceof ProviderError && (error.status === 400 || error.status === 404);
}

/**
 * One more request with the preset default, when the same provider's catalogue
 * says the stored model is gone and the default is there. The catalogue comes
 * from the endpoint the connection already talks to, with the same key, so no
 * request goes anywhere new. Undefined when there is nothing to move to.
 */
async function retryOnReplacement(
  connection: Connection,
  request: CompletionRequest,
): Promise<ChainResult | undefined> {
  const available = await listModels(connection, request.signal).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return [] as string[];
  });
  const to = replacementModel(connection, available);
  if (!to) return undefined;
  const moved = { ...connection, model: to };
  const result = await ADAPTERS[effectiveTransport(moved)].complete(moved, request);
  return {
    ...result,
    connection: moved,
    fallbackErrors: [],
    movedModel: { connectionId: connection.id, from: connection.model.trim(), to },
  };
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
      const result = await ADAPTERS[effectiveTransport(connection)].complete(connection, request);
      return { ...result, connection, fallbackErrors: failures };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      let message = error instanceof Error ? error.message : String(error);
      if (mayBeRetiredModel(error)) {
        try {
          const moved = await retryOnReplacement(connection, request);
          if (moved) return { ...moved, fallbackErrors: failures };
        } catch (retryError) {
          if (retryError instanceof DOMException && retryError.name === 'AbortError') throw retryError;
          // The replacement failed too; its reason is the current one.
          message = retryError instanceof Error ? retryError.message : String(retryError);
        }
      }
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
  return ADAPTERS[effectiveTransport(connection)].listModels(connection, signal);
}

/** Returns a human-readable problem with the connection, or null when it is usable. */
export function validateConnection(
  connection: Connection,
  options: { requireModel?: boolean } = {},
): string | null {
  const { requireModel = true } = options;

  // Nothing to configure: whether this browser can run the model is only
  // known asynchronously, and the adapter reports it at request time.
  if (connection.transport === 'chrome_builtin' || connection.transport === 'in_browser') return null;

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
  // No endpoint. The in-browser model's one download is a CORS fetch from the
  // offscreen document and needs no host access.
  if (connection.transport === 'chrome_builtin' || connection.transport === 'in_browser') return null;
  try {
    return `${new URL(connection.baseUrl).origin}/*`;
  } catch {
    return null;
  }
}
