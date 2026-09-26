/**
 * Finds a model server already running on this computer, for browsers that
 * have no built-in model. Measured: Brave answers `unavailable` on Linux and
 * Windows, Edge on Linux has no `LanguageModel` at all (COMPATIBILITY.md). For
 * those users the no-key route is a local server, which ProofKey already speaks
 * to as an ordinary OpenAI-compatible provider; what was missing was finding it.
 *
 * Only ever called from a click, never on its own: every probe is a request,
 * and ProofKey makes none the user did not ask for. The requests go to
 * loopback addresses and nowhere else.
 *
 * Kept free of runtime imports, `chrome.*` and the DOM so
 * `tools/local-servers-check.ts` can load it directly and run it against real
 * loopback servers; that check also holds these addresses to the presets'.
 */

import type { PresetId } from './types';

export interface LocalServer {
  presetId: PresetId;
  label: string;
  baseUrl: string;
}

/**
 * Each server's own default address. llama.cpp shares the self-hosted preset,
 * whose base URL is vLLM's port; `llama-server` listens on 8080 by default.
 */
export const LOCAL_SERVERS: LocalServer[] = [
  { presetId: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://127.0.0.1:1234/v1' },
  { presetId: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1' },
  { presetId: 'vllm', label: 'llama.cpp (local)', baseUrl: 'http://127.0.0.1:8080/v1' },
];

export type LocalServerProbe =
  | { server: LocalServer; status: 'found'; models: string[] }
  /** Something answered, but with an error: running, and refusing this extension. */
  | { server: LocalServer; status: 'refused'; httpStatus: number }
  | { server: LocalServer; status: 'absent' };

/** Host patterns to request before probing, so an error status can be read at all. */
export function localServerOrigins(servers: LocalServer[] = LOCAL_SERVERS): string[] {
  return servers.map((s) => `${new URL(s.baseUrl).origin}/*`);
}

/**
 * `GET {base}/models`. A refused connection and a timeout both mean nothing is
 * listening; any HTTP answer means something is. With host access granted the
 * status is readable even when the server sends no CORS headers, which is how a
 * default Ollama — which answers 403 to an origin it was not told to allow — is
 * told apart from no Ollama.
 */
export async function probeLocalServer(
  server: LocalServer,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<LocalServerProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${server.baseUrl}/models`, { signal: controller.signal });
    if (!response.ok) return { server, status: 'refused', httpStatus: response.status };
    const body = (await response.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
    const models = (body?.data ?? [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return { server, status: 'found', models };
  } catch {
    return { server, status: 'absent' };
  } finally {
    clearTimeout(timer);
  }
}

export function findLocalServers(
  fetchImpl: typeof fetch = fetch,
  servers: LocalServer[] = LOCAL_SERVERS,
): Promise<LocalServerProbe[]> {
  return Promise.all(servers.map((server) => probeLocalServer(server, fetchImpl)));
}

/** One line per server that answered, for the options page. */
export function describeProbe(probe: LocalServerProbe): string | null {
  switch (probe.status) {
    case 'absent':
      return null;
    case 'found':
      return probe.models.length > 0
        ? `${probe.server.label}: running, with ${probe.models.length === 1 ? '1 model' : `${probe.models.length} models`}.`
        : `${probe.server.label}: running, but no model is loaded. Load one, then use "Fetch models".`;
    case 'refused':
      if (probe.server.presetId === 'ollama' && probe.httpStatus === 403) {
        return 'Ollama: running, but it refuses browser extensions. Restart it with OLLAMA_ORIGINS="chrome-extension://*".';
      }
      return `${probe.server.label}: running, but it answered HTTP ${probe.httpStatus}.`;
  }
}
