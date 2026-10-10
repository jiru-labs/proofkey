import { getPreset } from '../presets';
import type { Connection } from '../types';

let session: Promise<string> | null = null;

/**
 * The session header a preset's endpoint requires, if any. The id is random
 * and kept in `chrome.storage.session`, which the browser clears when it
 * closes: it groups one browsing session's requests for the provider's routing
 * and caching, and identifies nothing across sessions. The API key already
 * tells the provider whose requests they are.
 */
export async function sessionHeaders(connection: Connection): Promise<Record<string, string>> {
  const header = getPreset(connection.presetId).sessionHeader;
  if (!header) return {};
  session ??= (async () => {
    const key = 'proofkey:providerSession';
    try {
      const stored = (await chrome.storage.session.get(key))[key];
      if (typeof stored === 'string') return stored;
      const id = crypto.randomUUID();
      await chrome.storage.session.set({ [key]: id });
      return id;
    } catch {
      // No extension storage (a test harness, a page): one id for this process.
      return crypto.randomUUID();
    }
  })();
  return { [header]: await session };
}
