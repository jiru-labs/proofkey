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
      return 'This browser has no built-in model; Google Chrome on desktop has one. With no key, run a model on this computer with LM Studio, Ollama or llama.cpp. Or add a provider with an API key.';
    case 'unavailable':
      // Not a hardware verdict in Brave: Brave Origin 153 answered it on the laptop
      // where Google Chrome 153 runs the model (2026-09-13), and on Windows Brave's
      // console gives the reason — "The feature flag gating model execution was
      // disabled" (2026-09-26, on an 8 GB GPU). At most 41 words: the in-page
      // toast gives 300 ms a word, and `test:render` holds it to that.
      if (isBrave()) {
        return 'Brave switches off Chrome\'s built-in model, even on computers where Google Chrome runs it. With no key, run a model on this computer with LM Studio, Ollama or llama.cpp, or use Google Chrome. Or add a provider with an API key.';
      }
      return 'This browser says its built-in model is unavailable. In Google Chrome that usually means the computer is below Chrome\'s requirements: 22 GB of free disk, and either a GPU with more than 4 GB of memory or 16 GB of RAM with 4 CPU cores. With no key, run a model on this computer with LM Studio, Ollama or llama.cpp instead. Or add a provider with an API key.';
    case 'downloadable':
      return 'The built-in model is not downloaded yet. Open ProofKey settings and click "Download model".';
    case 'downloading':
      return 'Chrome is still downloading the built-in model. Try again when it finishes.';
  }
}
