# Chrome Web Store — permissions and privacy fields

> Last updated: 2026-10-05, against `dist/manifest.json` of 0.1.12. Layout from Google's
> `chrome-extensions` agent skill (`references/webstore/chromewebstore-template.md`, 2026-08-06).

One place for the text the developer dashboard asks for on its Privacy tab. The listing copy
(name, summary, description, screenshots) lives in the release tooling's store copy, not here.
This file is not in the package: `tools/release.ts` zips `dist/` only.

When a release adds or changes a permission, change this file in the same commit, and paste
the new justification into the dashboard before submitting.

## Single purpose

Check and rewrite the text you write or select on a web page, using the AI model you choose:
your own provider and key, a model on your computer, or one inside the browser.

## Permission justifications

| Permission | Why ProofKey needs it |
|---|---|
| `storage` | Keeps your settings: providers, API keys, prompts, shortcuts, the sites you switched live checking on for, your dictionary. |
| `contextMenus` | Puts the writing actions (Fix grammar, Translate…) on the right-click menu for selected text and text fields. |
| `activeTab` | Reads the selection or the focused field on the tab where you invoked an action from the menu, the shortcut or the toolbar button — that tab only, at that moment. |
| `scripting` | Injects ProofKey's field script into that tab when you invoke it, and registers it on the sites you switched live checking or shortcuts on. |
| `offscreen` | Runs the optional in-browser model (Qwen3.5 4B through WebLLM on WebGPU) in a hidden extension page, only if you choose it. The page reads no web page; its only request is the one model download from huggingface.co that you start with its own button. Reason: `WORKERS`. |
| Optional host permissions `http://*/*`, `https://*/*` | Never granted at install. Requested one origin at a time, when you ask for it: a site you switch live checking or shortcuts on, or the address of the provider or local model server you add. |

## Content Security Policy

`script-src 'self' 'wasm-unsafe-eval'` on extension pages: needed to instantiate the
in-browser model's WebAssembly, which ships inside the package
(`dist/webllm/*.wasm`, SHA-256 pinned in `src/core/providers/inBrowserModel.ts`).

## Remote code

**No.** All code is in the package. The in-browser model's weights are data, fetched from a
pinned Hugging Face revision with integrity checks on the config, tokenizer and library.

## Data handling (as the code does it — check the dashboard form against this)

- **Text you write or select:** sent only to the provider you configured, when you invoke an
  action or have live checking on for that site. With the built-in or in-browser model it
  never leaves the computer.
- **Authentication information (your API keys):** stored in `chrome.storage.sync`, sent only
  to the provider each key belongs to. With Chrome Sync on, the browser syncs it between
  your own signed-in browsers (see PRIVACY.md).
- **Nothing else:** no analytics, telemetry, crash reporting or usage statistics, and no
  server of ours. Not sold, not transferred, not used for anything but the feature.

Privacy policy: [PRIVACY.md](PRIVACY.md).
