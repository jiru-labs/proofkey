# ProofKey

A Grammarly-style writing assistant for Chrome that talks to **your** LLM, using **your** API key.

No backend, no account, no telemetry. Your text goes from your browser straight to the provider you picked, and nowhere else.

> **Status: in development.** The provider layer and settings model are in place; the inline assistant and options UI are being built. Not yet on the Chrome Web Store.

---

## Why

Grammarly and LanguageTool are excellent, and both route your writing through their servers. ProofKey keeps the interaction model — inline underlines, a suggestion card, quick rewrite actions — and swaps the engine for an endpoint you control. Point it at a local Ollama and nothing leaves your machine at all.

## Features

- **Quick actions** on any selected text, from the right-click menu or `Ctrl+Shift+K`: fix grammar, improve writing, make professional, make friendly, simplify, summarize, expand, convert to bullet points.
- **Editable prompts.** Every built-in action is a prompt you can rewrite, and you can add your own.
- **34 providers** prefilled, plus a free-form Custom option for any OpenAI-compatible endpoint.
- **Fallback chain.** Put a local model first and a cloud key second; ProofKey moves down the list when one fails, and tells you which one failed.
- **Any language the model knows.** The interface is English; the text doesn't have to be. The prompts are written to detect the language and work inside it — including text that mixes two languages, which rule-based checkers cannot handle at all.
- **Doesn't flatten your voice.** Regional variety (en-GB/en-US, pt-BR/pt-PT, zh-Hans/zh-Hant) and politeness register (tú/usted, du/Sie, tu/vous, Japanese registers) are treated as choices to preserve, not errors to normalise.

## Install (unpacked)

Chrome Web Store publication comes later. For now:

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

## Privacy

- Your key and settings live in `chrome.storage.sync`. There is no ProofKey server to send them to.
- Requests go directly from your browser to the provider's endpoint.
- No analytics, no error reporting, no remote logging.
- **The extension declares no host permissions up front.** It asks for access to a specific API origin when you save a connection, and for access to a site only when you switch on inline checking there.

One honest caveat: `chrome.storage.sync` means Chrome syncs your settings — including the API key — across devices signed into the same Google profile, encrypted in transit and at rest by Chrome. If you would rather it never left the machine, that is a `storage.local` change and a setting worth opening an issue for.

### On cost

Live checking spends your key. ProofKey is built to keep that small: it checks about a second after you stop typing rather than on every keystroke, sends only sentences whose text changed, never sends the sentence your cursor is inside, and caches results per sentence. Inline checking is off by default and is enabled per site.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save your settings and connections |
| `contextMenus` | The right-click menu |
| `activeTab` + `scripting` | Inject the assistant into the tab you're using, on demand |
| `optional_host_permissions` | Requested per origin — for your API endpoint, and for sites where you enable inline checking |

There is no static `content_scripts` block, so ProofKey does not run on pages you have not turned it on for.

## Development

```bash
npm run build       # production build into dist/
npm run dev         # rebuild on change
npm run typecheck   # tsc --noEmit
```

Stack: TypeScript, Vite 8, Manifest V3, no UI framework. The options page and the in-page card are plain DOM; the in-page UI lives in a shadow root so host-page CSS cannot reach it.

```
src/
├─ core/
│  ├─ types.ts       settings and suggestion shapes
│  ├─ presets.ts     the provider registry
│  ├─ prompts.ts     built-in action prompts
│  ├─ browser.ts     extension-API capability detection
│  ├─ storage.ts     settings load/save and merging
│  └─ providers/     two transports: chat_completions, anthropic_messages
├─ background/       service worker: menus, shortcut, injection
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

MIT — see [LICENSE](LICENSE).
