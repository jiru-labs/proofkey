/**
 * Extension API access, detected by capability rather than by object identity.
 *
 * The trap this module exists to avoid:
 *
 *     const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
 *     if (browserAPI === chrome) { chrome.scripting.executeScript(...) }
 *     else { browser.tabs.executeScript(...) }          // <- taken in Chrome
 *
 * Recent Chrome builds expose a `browser` global, so `browserAPI` becomes
 * `browser`, the identity check against `chrome` fails, and Chrome takes the
 * Firefox branch — calling an MV2-only API that does not exist. Ask what an API
 * can *do* instead of which object it happens to be.
 */

type Global = typeof globalThis & {
  chrome?: typeof chrome;
  browser?: typeof chrome;
};

const g = globalThis as Global;

/** True when the MV3 scripting API is usable (Chrome, Edge, MV3 Firefox). */
export function hasScriptingApi(): boolean {
  return typeof g.chrome?.scripting?.executeScript === 'function';
}

/** True when only the MV2 `tabs.executeScript` API is available. */
export function hasLegacyExecuteScript(): boolean {
  return (
    typeof g.browser?.tabs?.executeScript === 'function' ||
    typeof g.chrome?.tabs?.executeScript === 'function'
  );
}

/** True when content scripts can be registered at runtime (Chrome 96+). */
export function hasDynamicContentScripts(): boolean {
  return typeof g.chrome?.scripting?.registerContentScripts === 'function';
}

/**
 * Inject files into a tab using whichever injection API this browser provides.
 * Resolves once every file has been injected.
 */
export async function injectFiles(tabId: number, files: string[]): Promise<void> {
  if (hasScriptingApi()) {
    // allFrames for the same reason the registered script carries it: an editor
    // inside a frame is invisible to a top-frame-only injection. Host permission
    // is still checked per frame, so this reaches only frames already granted.
    await g.chrome!.scripting.executeScript({ target: { tabId, allFrames: true }, files });
    return;
  }

  const legacyTabs = (g.browser?.tabs ?? g.chrome?.tabs) as
    | { executeScript?: (tabId: number, details: { file: string }) => Promise<unknown> }
    | undefined;

  if (typeof legacyTabs?.executeScript === 'function') {
    // MV2 injects one file at a time and relies on declaration order.
    for (const file of files) {
      await legacyTabs.executeScript(tabId, { file });
    }
    return;
  }

  throw new Error('This browser exposes no script injection API.');
}

/**
 * What someone types into an origin list, turned into an origin — or null if
 * there is no reading of it that works.
 *
 * `github.com`, `https://github.com/` and a full page URL pasted from the
 * address bar all mean the same site, and all three are what people actually
 * type. Rejecting the first two would be correct and useless: the origin would
 * be dropped, no permission would be asked for, no script would be registered,
 * and the only symptom would be a key that does nothing.
 */
export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * `https://github.com` → `https://github.com/*`, the match-pattern form both
 * `permissions.request` and `registerContentScripts` expect. Null for anything
 * that is not an http(s) origin, including a URL with a path on it.
 */
export function originMatchPattern(origin: string): string | null {
  try {
    const url = new URL(origin.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

/** Injectable pages exclude the Web Store and browser-internal schemes. */
export function isInjectableUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (!/^https?:/i.test(url) && !/^file:/i.test(url)) return false;
  return !/^https:\/\/chromewebstore\.google\.com/i.test(url);
}
