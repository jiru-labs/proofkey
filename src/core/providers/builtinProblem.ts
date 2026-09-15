/**
 * What the built-in model's states tell the user. Kept apart from the transport in
 * `chromeBuiltin.ts` so it has no imports and `tools/builtin-check.ts` can load it
 * directly.
 */

export type BuiltinAvailability =
  | 'no-api'
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

/**
 * Brave, read the way it identifies itself. Measured 2026-09-15 in Brave 153, on
 * the options page and in the service worker alike: `navigator.userAgentData.brands`
 * lists "Brave" and `navigator.brave` is defined, while the user-agent string says
 * only Chrome. Either signal is taken, so a Brave that drops one still counts.
 */
function isBrave(): boolean {
  const nav = (globalThis as {
    navigator?: { brave?: unknown; userAgentData?: { brands?: { brand: string }[] } };
  }).navigator;
  if (!nav) return false;
  return typeof nav.brave === 'object' || !!nav.userAgentData?.brands?.some((b) => b.brand === 'Brave');
}

/** What to tell the user for each state that is not `available`. */
export function builtinProblem(state: BuiltinAvailability): string | null {
  switch (state) {
    case 'available':
      return null;
    case 'no-api':
      return 'This browser has no built-in model. It works in Google Chrome on desktop; here, add a provider with an API key instead.';
    case 'unavailable':
      // Not a hardware verdict in Brave: Brave Origin 153 answered it on the laptop
      // where Google Chrome 153 runs the model (2026-09-13).
      if (isBrave()) {
        return 'Brave reports Chrome\'s built-in model as unavailable, even on a computer where Google Chrome runs it. To use ProofKey with no key, use Google Chrome. In Brave, add a provider with an API key, or a self-hosted server such as llama.cpp.';
      }
      return 'This browser says its built-in model is unavailable. In Google Chrome that usually means the computer is below Chrome\'s requirements: 22 GB of free disk, and either a GPU with more than 4 GB of memory or 16 GB of RAM with 4 CPU cores. Add a provider with an API key instead.';
    case 'downloadable':
      return 'The built-in model is not downloaded yet. Open ProofKey settings and click "Download model".';
    case 'downloading':
      return 'Chrome is still downloading the built-in model. Try again when it finishes.';
  }
}
