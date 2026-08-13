# ProofKey

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/loibjoemoahkajjnfioajcibcamhdafc)
[![Version](https://img.shields.io/chrome-web-store/v/loibjoemoahkajjnfioajcibcamhdafc?label=version&color=4285F4)](https://chromewebstore.google.com/detail/loibjoemoahkajjnfioajcibcamhdafc)
[![License](https://img.shields.io/github/license/jiru-labs/proofkey)](LICENSE)

A Grammarly-style writing assistant for Chrome that talks to **your** LLM, using **your** API key.

No backend, no account, no telemetry. Your text goes from your browser straight to the provider you picked, and nowhere else.

> **[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/loibjoemoahkajjnfioajcibcamhdafc)** — or [build it from source](#install-from-source) if you would rather read the code first.
>
> **New here?** [Start with Gemini](#no-api-key-yet-start-with-gemini): about two minutes from nothing to working underlines, and ordinary use usually costs nothing.
>
> **What is actually known to work is a much shorter list than what is built.** Two sites (WhatsApp Web, X) and four providers (Google Gemini, xAI, OpenRouter, OpenCode Go) have been confirmed by hand against real keys; the rest is covered by automated tests, or by nothing. [COMPATIBILITY.md](COMPATIBILITY.md) says exactly which is which — and [reports](CONTRIBUTING.md) are the fastest way to grow that list.

---

## Why

Grammarly and LanguageTool are excellent, and both route your writing through their servers. ProofKey keeps the interaction model — inline underlines, a suggestion card, quick rewrite actions — and swaps the engine for an endpoint you control. Point it at a local Ollama and nothing leaves your machine at all.

## Features

- **Quick actions** on any selected text, from the right-click menu or `Ctrl+Shift+K`: fix grammar, improve writing, make professional, make friendly, simplify, summarize, expand, convert to bullet points.
- **Editable prompts.** Every built-in action is a prompt you can rewrite, and you can add your own.
- **A key per action.** Any action, including one you wrote, can be given its own shortcut in the options page — press the combination, and it is recorded. These are handled inside the page rather than by Chrome's shortcut system, which is limited to four keys fixed at build time and can only be changed from `chrome://extensions/shortcuts`. The trade is that ProofKey has to be loaded in a page to see a keypress there, so these keys run on the sites you list and nowhere else. `Ctrl+Shift+K` and the right-click menu keep working everywhere, with no site permission.
- **Live checking is quieter than the quick actions, on purpose.** It fires on a pause you did not ask for, so it treats messaging conventions as valid: no full stop added to a line that lacks one, no capitalising a lowercase sentence start, no expanding slang. `Ctrl+Shift+K` you pressed deliberately, so it completes the correction, capitals included.
- **36 provider presets** over two transports, plus a free-form Custom option for any OpenAI-compatible endpoint. Prefilled is not the same as confirmed — four have been used against a real key so far, see [COMPATIBILITY.md](COMPATIBILITY.md).
- **Fallback chain.** Put a local model first and a cloud key second; ProofKey moves down the list when one fails, and tells you which one failed.
- **Any language the model knows.** The interface is English; the text doesn't have to be. The prompts are written to detect the language and work inside it — including text that mixes two languages, which rule-based checkers cannot handle at all.
- **Doesn't flatten your voice.** Regional variety (en-GB/en-US, pt-BR/pt-PT, zh-Hans/zh-Hant) and politeness register (tú/usted, du/Sie, tu/vous, Japanese registers) are treated as choices to preserve, not errors to normalise.

## Install

**[Get it from the Chrome Web Store](https://chromewebstore.google.com/detail/loibjoemoahkajjnfioajcibcamhdafc)**, then click the ProofKey icon → **Settings** and set up a provider. If you have never used an LLM API before, [start here](#no-api-key-yet-start-with-gemini).

### Install from source

```bash
git clone https://github.com/jiru-labs/proofkey.git
cd proofkey
npm install
npm run build
```

Then:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `dist/` folder
4. Click the ProofKey icon → **Settings**, and configure a provider

`npm run dev` rebuilds on change; press the reload button on the extension card in `chrome://extensions` to pick changes up.

## Configuring a provider

Every provider needs the same three things: a **base URL**, an **API key**, and a **model**. Picking a preset fills in the base URL for you; **Fetch models** lists what your key can actually reach.

### No API key yet? Start with Gemini

"Bring your own key" is the whole point of ProofKey, but it does mean there is a step before anything works. If you have never done it, this is the shortest path — about two minutes, and for ordinary use Google's free allowance usually covers it.

1. Open **[Google AI Studio](https://aistudio.google.com/apikey)** and sign in with any Google account.
2. Click **Create API key**, and accept the terms if you are asked.
3. Copy the key. It starts with `AIza`.
4. In Chrome, click the **ProofKey** icon → **Settings**.
5. Choose **Google Gemini** from the provider list — the base URL fills itself in.
6. Paste your key into **API key**, click **Fetch models**, and pick `gemini-2.5-flash`.
7. Save, then reload any tab you already had open.

Two things are worth understanding before you paste anything sensitive:

- **The free tier is the one tier where the provider may keep what you send.** Google's free-tier data handling differs from paid: text sent on a free key may be used to improve their products. ProofKey itself never sees your writing, and that does not change — but "no telemetry" is a promise about ProofKey, not about the provider you point it at. For anything confidential, use a paid key or a [local model](#local-models), where nothing leaves your machine. Google's [API terms](https://ai.google.dev/gemini-api/terms) are the authority on this, not us.
- **If underlines quietly stop appearing, you have hit the free limit.** Live checking sends a request each time you pause typing, which a daily cap notices. It is pinned to one connection and does not fall through the fallback chain, so it goes silent rather than reporting an error. Switch live checking off in Settings and the quick actions (`Ctrl+Shift+K`, right-click menu) carry on working. Your current limits are shown in [AI Studio](https://aistudio.google.com/rate-limit); they vary by account, so this page quotes no numbers.

Once that works, [MODELS.md](MODELS.md) covers what to move to and what it costs. We deliberately publish no quality scores for free tiers on any provider — [why](MODELS.md#the-free-tier).

### The ones most people want

| Provider | Base URL | Key from |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Anthropic | `https://api.anthropic.com/v1` | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| OpenRouter | `https://openrouter.ai/api/v1` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Groq | `https://api.groq.com/openai/v1` | [console.groq.com/keys](https://console.groq.com/keys) |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | your OpenCode account |
| Ollama (local) | `http://localhost:11434/v1` | not needed |
| LM Studio (local) | `http://127.0.0.1:1234/v1` | not needed |
| Custom | whatever you paste | depends |

<details>
<summary><b>All 34 presets</b></summary>

OpenAI · Anthropic · OpenRouter · Groq · Ollama · LM Studio · OpenCode Go · OpenCode Zen · Google Gemini · DeepSeek · Mistral · xAI (Grok) · Together AI · Fireworks AI · Cerebras · Novita AI · NVIDIA NIM · Z.ai (GLM) · Moonshot (Kimi) · Moonshot China · Qwen Cloud (DashScope) · Alibaba Coding Plan · Hugging Face · Vercel AI Gateway · Kilo Code · StepFun · Arcee AI · GMI Cloud · Xiaomi MiMo · Tencent TokenHub · Ollama Cloud · Azure OpenAI · Azure AI Foundry · MiniMax (+ China) · vLLM / llama.cpp · Custom

</details>

### Local models

**Ollama** refuses cross-origin requests by default. Start it so it accepts the extension:

```bash
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

**LM Studio**: start the local server from the Developer tab, then hit **Fetch models**.

### Anything not on the list

Use **Custom**. Paste the base URL up to and including `/v1` — ProofKey appends `/chat/completions`. If the endpoint has quirks, the connection editor exposes escape hatches for them: extra headers, extra body fields, extra query parameters, and the auth style (`Bearer`, `x-api-key`, a custom header name, or a URL parameter). Between those, most gateways and proxies work without code changes.

## Does it work where you need it?

Honestly: probably, but nobody has checked. ProofKey has to survive two things it doesn't control — the editor you're typing into and the provider you point it at — and neither can be covered exhaustively by one person.

[COMPATIBILITY.md](COMPATIBILITY.md) tracks both, and separates *an automated test asserts this* from *a maintainer ran it* from *a user reported it* from *nobody has tried*. Today that is one site and three providers confirmed by a human; almost everything else is untested. A row only moves when there's a link to point at.

Which makes the most useful contribution right now a one-minute report:

- **[Site report](https://github.com/jiru-labs/proofkey/issues/new?template=site-report.yml)** — it works on Slack, or it scrambled your text
- **[Provider report](https://github.com/jiru-labs/proofkey/issues/new?template=provider-report.yml)** — you have a key for one of the other 33 presets

Reports that it *worked* matter as much as bug reports. Nothing else moves a row out of `Untested`.

## Privacy

- Your key and settings live in `chrome.storage.sync`. There is no ProofKey server to send them to.
- Requests go directly from your browser to the provider's endpoint.
- No analytics, no error reporting, no remote logging.
- **The extension declares no host permissions up front.** It asks for access to a specific API origin when you save a connection, and for access to a site only when you switch on inline checking there.

One honest caveat: `chrome.storage.sync` means Chrome syncs your settings — including the API key — across devices signed into the same Google profile, encrypted in transit and at rest by Chrome. If you would rather it never left the machine, that is a `storage.local` change and a setting worth opening an issue for.

### On cost

Live checking spends your key. ProofKey is built to keep that small: it checks about a second after you stop typing rather than on every keystroke, sends only sentences whose text changed, holds back the sentence your cursor is inside until you have stopped at the end of it for about three seconds, and caches results per sentence. Inline checking is off by default and is enabled per site.

That hold-back used to be permanent, which quietly meant a one-sentence message — a tweet, a chat line — was never checked at all, and the badge showed a green tick for text nothing had looked at. The tick now means a verdict on text that was actually sent; grey means not checked yet.

Which model you pick matters more than any of that — the cost spread across current Gemini models is about 20×, and the fastest one measured is also nearly the cheapest. Across providers the spread is wider still: the same live check costs $0.02 per 1,000 on the cheapest model measured through OpenRouter, $0.14 on Gemini and $1.50 on Grok, and takes 0.3s against 1s against 1.6–22s — while OpenCode Go's coding models are flat-rate but run 4s to 100s, past ProofKey's own request timeout at the slow end. [MODELS.md](MODELS.md) has the arithmetic, worked out from ProofKey's real prompt sizes, plus measured quality and latency for forty model configurations. Free tiers are deliberately not measured on any provider, and models whose thinking cannot be turned off are excluded from live checking where that measurably costs you latency, money or a usable reply — by measured harm, not by mechanism, so the fastest model on the page stays recommended despite thinking. `npm run cost` recalculates it; `npm run eval` measures a model you are considering.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save your settings and connections |
| `contextMenus` | The right-click menu |
| `activeTab` + `scripting` | Inject the assistant into the tab you're using, on demand |
| `optional_host_permissions` | Requested per origin — for your API endpoint, for sites where you enable inline checking, and for sites where you enable per-action shortcuts |

There is no static `content_scripts` block, so ProofKey does not run on pages you have not turned it on for.

Per-action shortcuts are the one feature that needs ProofKey loaded in a page before you act, rather than after — a key pressed in a page it is not in cannot reach it. So for each origin you list under **Shortcuts run on**, and only those, it asks for access and registers its content script there. Revoking that access from `chrome://extensions` unregisters it; ProofKey re-checks on every permission change rather than assuming the grant it was given still holds.

## Development

```bash
npm run build       # production build into dist/
npm run dev         # rebuild on change
npm run typecheck   # tsc --noEmit
npm run verify      # typecheck, build, and the browser tests (needs `npm run serve` alongside)
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers what each test actually asserts, and the workflow for fixing a bug — reproduce it in `tools/harness.html` first, and confirm the new test fails *before* the fix. Two tests here passed while asserting nothing until that check was applied.

Stack: TypeScript, Vite 8, Manifest V3, no UI framework. The options page and the in-page card are plain DOM; the in-page UI lives in a shadow root so host-page CSS cannot reach it.

```
src/
├─ core/
│  ├─ types.ts       settings and suggestion shapes
│  ├─ presets.ts     the provider registry
│  ├─ prompts.ts     built-in action prompts
│  ├─ browser.ts     extension-API capability detection
│  ├─ storage.ts     settings load/save and merging
│  ├─ shortcuts.ts   chord parsing, matching and labelling
│  └─ providers/     two transports: chat_completions, anthropic_messages
├─ background/       service worker: menus, shortcuts, injection
├─ content/          inline assistant
└─ options/          settings page
```

### Adding a provider

If it speaks `POST /v1/chat/completions` or Anthropic's `POST /v1/messages`, it is one row in `src/core/presets.ts` — no adapter code:

```ts
openaiCompatible('acme', 'Acme AI', 'https://api.acme.com/v1'),
```

## Prior art

- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** (Apache-2.0) — the provider model here follows its `api_mode` abstraction and named-provider design. Base URLs are taken from its `PROVIDER_REGISTRY` rather than guessed.
- **[chatGPTBox](https://github.com/josStorer/chatGPTBox)** (MIT) — selection-triggered UI and per-site adapters.
- **[WritingTools](https://github.com/theJayTea/WritingTools)** (GPL-3.0) — action-set design. Referenced for ideas only; no code from it is used, as GPL-3.0 is incompatible with this project's MIT license.
- **Grammarly** and **LanguageTool** — the interaction model this imitates.

## License

MIT — see [LICENSE](LICENSE). Fork it, ship it, sell it; the code is yours to use.

The MIT grant covers the code. `ProofKey` and the ProofKey logo are trademarks of
Jiru Labs, and a fork needs its own name — that is the only thing being kept
back, and it is what stops a copy of this extension being uploaded under this
name with a key logger in it.
