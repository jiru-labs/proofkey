# Compatibility

What ProofKey is actually known to work with, and how we know.

ProofKey has to survive two things it does not control: the **editor** you are
typing into, and the **provider** you point it at. Neither can be covered
exhaustively by one person on one machine, so this file records evidence rather
than intentions. Most rows say `Untested`. That is honest, not a to-do list
someone forgot about — and it is where you can help. See
[Reporting what you find](#reporting-what-you-find).

## Evidence tiers

| Tier | Means | Evidence required |
|---|---|---|
| `Tested` | An automated test in this repo asserts it | The test name |
| `Verified` | A maintainer ran it by hand in a real browser | Date + commit |
| `Reported` | A user says it works for them | Link to the issue |
| `Untested` | Takes the same code path as something above, but nobody has run it | — |
| `Broken` | Known to fail | Link to the issue |
| `Not supported` | Cannot work by design | The reason |
| `Not recommended` | Measured, works, and deliberately excluded anyway | The measurement that excludes it |

`Not recommended` is the one marker here that is not an evidence level — it is a
scope decision sitting on top of one. A row carries it only when something was
measured and the measurement is the argument *against* using it, which is why it
still owes evidence like every other row.

**The rule that keeps this file worth reading: a row never moves up a tier
without a link.** No test name, no commit, no issue number — no promotion. A
compatibility table that drifts into optimism is worse than no table, because
then the `Verified` rows stop meaning anything either.

`Reported` is deliberately weaker than `Verified`. It is still valuable: two
independent reports on the same editor are strong evidence, and a report is how
almost every row here will eventually move.

## Editors

This is the table that actually predicts behaviour. Whether ProofKey works on
Notion is not a fact about Notion — it is a fact about ProseMirror. Sites change
editors; engines are what the code branches on (`src/content/target.ts`).

| Editor engine | How ProofKey handles it | Status | Evidence |
|---|---|---|---|
| `<textarea>` | Mirror overlay for underlines, `execCommand` to write | `Tested` | `test:render` — `plain`, `odd` fields: overlay typography, box alignment, underline containment, card, apply |
| `<input type=text>` | Same, single-line | `Tested` | `test:render` — `single` field |
| Plain `contenteditable` | CSS Custom Highlight API for underlines, word-level diff to write | `Tested` | `test:render` — `rich` field, incl. bold surviving both a single apply and a whole-field rewrite |
| `contenteditable` that re-renders on every input | Same, edits bounded and awaited | `Tested` | `test:render` — `rerender` field |
| **Lexical** (WhatsApp, Reddit) | `execCommand` through the browser's editing path; never a DOM mutation | `Tested` + `Verified` | `test:render` — `lexical` field, a real embedded Lexical instance (35a8351). Verified against WhatsApp Web 2026-08-01 (e2ae3b1) |
| **Quill** (Slack, LinkedIn) | Same path as Lexical | `Untested` | — |
| **ProseMirror** (Notion-like, many CMSes) | Same path as Lexical | `Untested` | — |
| **Slate** (Discord) | Same path as Lexical | `Untested` | — |
| **Draft.js** (older X/Twitter) | Same path as Lexical | `Untested` | — |
| CodeMirror / Monaco (code editors) | Out of scope; ProofKey is not a code assistant | `Untested` | — |
| Canvas-rendered text (Google Docs) | There is no DOM text to underline or replace | `Not supported` | Docs paints text to a canvas |

Quill, ProseMirror, Slate and Draft.js take the **same** code path as Lexical —
the one that was fixed in e2ae3b1 and is covered by a real Lexical instance in
`test:render`. So `Untested` there means "expected to work, nobody has run it",
rather than "no idea". The
failure mode to watch for is a framework that reconciles differently enough that
an awaited `execCommand` still loses characters. That is exactly what the
WhatsApp bug was, and exactly what a report should describe.

## Sites

Examples, to save you guessing which engine you are looking at. **Best-effort:
sites replace their editors without telling anyone.** If you find a wrong engine
here, that alone is worth a report.

| Site | Editor (best-effort) | Status | Evidence |
|---|---|---|---|
| WhatsApp Web | Lexical | `Verified` | Long Spanish message came back scrambled, fixed in e2ae3b1, confirmed by the maintainer 2026-08-01 |
| Gmail | `contenteditable` | `Untested` | — |
| Slack | Quill | `Untested` | — |
| Notion | ProseMirror-like | `Untested` | — |
| Discord | Slate | `Untested` | — |
| LinkedIn | Quill | `Untested` | — |
| X / Twitter | Draft.js / custom | `Untested` | — |
| Reddit | Lexical | `Untested` | — |
| GitHub (comments, issues) | `<textarea>`, CodeMirror in places | `Untested` | — |
| Google Docs | canvas | `Not supported` | See above |

WhatsApp Web is the only site any human has run this on.

## Providers

Thirty-four presets, but only **two transports** — so this is not thirty-four
separate integrations. What varies per provider is the auth style, the base URL
and the model naming, not the logic.

| Transport | What it sends | Status | Evidence |
|---|---|---|---|
| `chat_completions` | `POST {baseUrl}/chat/completions`, `Bearer` auth, system as the first message, no `temperature` | `Tested` | `test:ext` — asserted against the real service worker with the extension loaded (863d241) |
| `anthropic_messages` | `POST {baseUrl}/messages`, `x-api-key`, `anthropic-version`, `anthropic-dangerous-direct-browser-access`, system as a top-level string | `Tested` | `test:ext` |

`test:ext` asserts the shape of what goes on the wire against a stub that
records requests. It does **not** prove any real provider accepts it — a stub
agrees with whatever you send it. That is the gap this table exists to close.

### Providers a human has actually used

| Provider | Model | Transport | Status | Evidence |
|---|---|---|---|---|
| Google Gemini | `gemini-2.5-flash` (preset default) | `chat_completions` | `Verified` | The maintainer's daily driver — real corrections through the extension against a real key, not a stub |
| Google Gemini | `gemini-2.5-flash-lite`, `gemini-3.1-flash-lite` | `chat_completions` | `Verified` | `npm run eval`, 2026-08-01 — both reachable on the preset's base URL and both held the live-check contract over 3 runs. See [MODELS.md](MODELS.md) |
| Google Gemini | **Fetch models** | — | `Partly verified` | Observed 2026-08-01: `GET /v1beta/openai/models` populates, but returns Google resource names (`models/gemini-2.5-flash`) rather than bare ids. Only the bare form has been exercised against `/chat/completions`, so the options page strips the `models/` prefix. Whether the prefixed form also works is **untested** |
| xAI (Grok) | `grok-4.20-0309-non-reasoning` (preset default), `grok-4.3`, `grok-4.5`, `grok-build-0.1` | `chat_completions` | `Verified` | `npm run eval`, 2026-08-01 — all four reachable on the preset's base URL, all held the live-check contract over 3 runs, none produced a false alarm. `GET /v1/models` also works, so **Fetch models** will populate. See [MODELS.md](MODELS.md) |
| OpenRouter | `openai/gpt-4.1-mini` (preset default), `gpt-4.1-nano`, `gpt-oss-20b`, `anthropic/claude-haiku-4.5`, `google/gemini-2.5-flash-lite`, `meta-llama/llama-3.3-70b-instruct`, `deepseek/deepseek-v4-flash`, `qwen/qwen3.7-flash`, `mistralai/mistral-nemo`, `mistralai/mistral-small-3.2-24b-instruct` | `chat_completions` | `Verified` | `npm run eval`, 2026-08-01 — all ten reachable on the preset's base URL, all held the live-check contract over 3 runs. `GET /v1/models` returns 336 models, so **Fetch models** will populate. The preset's `X-Title` header is accepted. See [MODELS.md](MODELS.md) |
| OpenCode Go | `grok-4.5`, `gpt-5.6-luna`, `glm-5.2`, `glm-5.1`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `mimo-v2.5`, `mimo-v2.5-pro`, `minimax-m3`, `minimax-m2.7`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `deepseek-v4-pro`, `hy3` | `chat_completions` | `Verified` | `npm run eval`, 2026-08-01 — 16 of the plan's 17 models reachable on the preset's base URL, all held the live-check contract over **10** runs, none produced a false alarm. `GET /v1/models` works, so **Fetch models** will populate. One caveat that the contract does not catch: `minimax-m3` scored **0.0/14** by returning its reasoning instead of corrections. See [MODELS.md](MODELS.md) |
| OpenCode Go | `deepseek-v4-flash` | `chat_completions` | `Broken` | `npm run eval`, 2026-08-01 — answers `RegionError`: *"only available hosted in China and requires explicit opt in"*. Works only after opting in per-workspace |
| OpenCode Go | `mimo-v2-pro`, `mimo-v2-omni`, `hy3-preview` | `chat_completions` | `Broken` | `npm run eval`, 2026-08-01 — `mimo-v2-pro` and `mimo-v2-omni` answered HTTP 500 on all 10 runs; `hy3-preview` answered HTTP 400 *"not supported on the lite model list"*. All three are advertised by `GET /v1/models` |
| OpenCode Go | `minimax-m2.5`, `kimi-k2.5`, `glm-5`, `qwen3.5-plus` | `chat_completions` | `Verified` | `npm run eval`, 2026-08-01 — all four answered and held the contract over 10 runs, but none is in the plan's documented 17. `GET /v1/models` advertises **24**, so **Fetch models** lists models the subscription does not document covering; they may stop working without notice |
| OpenCode Zen | any | `chat_completions` | `Untested` | 2026-08-01 — `GET /v1/models` returns 60 models and the base URL is confirmed, but every paid model answered `CreditsError` on a key with no balance, and the free ones are out of scope by the rule below. Nothing was measured |
| Any provider | free tiers and `:free` model variants | — | `Not tested` | Project rule, not an outcome: free endpoints are deliberately not measured or recommended. They are rate-limited, silently rerouted and withdrawn, so publishing a score would imply a durability the tier does not have |
| OpenCode Go | `minimax-m3`, `deepseek-v4-pro`, `qwen3.6-plus` | `chat_completions` | `Not recommended` | Project rule, applied to a measurement: `minimax-m3` scores 0.0/14 by writing its reasoning into the reply; `deepseek-v4-pro` and `qwen3.6-plus` average 98s and 73s against a 60s timeout, so they fail rather than arrive late. Out of scope for every workload. See [MODELS.md](MODELS.md#forced-reasoning) |
| xAI, Gemini, OpenCode Go | `grok-4.5`, `grok-build-0.1`, `grok-4.20-0309-reasoning`, `gemini-2.5-pro`, `gemini-3.5-flash`, `gemini-3.6-flash`, and OpenCode Go apart from `gpt-5.6-luna` / `glm-5.1` / `glm-5.2` | `chat_completions` | `Not recommended` | Project rule, applied to a measurement: thinking cannot be turned off and costs 14.7s–48s per check, against ~1s on a flash-lite. Excluded from **live checking only** — fine for quick actions, where you wait on purpose. Note the rule keys on measured harm, not on forced thinking: `gemini-3.1-flash-lite` also cannot be turned off, and stays recommended at 918ms. See [MODELS.md](MODELS.md#forced-reasoning) |

These rows are narrower than they look: `npm run eval` calls the endpoint
directly rather than through the extension, so it confirms the base URL, the key
and the model IDs, not ProofKey's own transport. That is covered separately by
`test:ext` above.

One xAI caveat that is a property of the provider rather than of ProofKey: every
Grok model except `grok-4.3` rejects `reasoning_effort` with HTTP 400 rather
than ignoring it, so that field must not be set in **Extra body fields** on an
xAI connection. Live-check latency also runs 1.6s–22s depending on the model,
against roughly 1s on Gemini.

Two OpenRouter caveats, also properties of the provider:

- `reasoning_effort` is accepted by every model listed above **except**
  `openai/gpt-oss-20b`, which answers HTTP 400 *"Reasoning is mandatory for this
  endpoint and cannot be disabled"*. Setting it in **Extra body fields** is worth
  doing anyway — it cut the measured bill 10.8× on `qwen/qwen3.7-flash` — but it
  is a per-model decision, not a per-connection one.
- A model id does not identify one endpoint. Routing picks between as many as 22
  upstreams for a single id, and what you are charged follows the upstream, not
  the catalogue: three of ten models measured were billed 22% cheaper to 25%
  dearer than their listed price. `google/gemini-2.5-flash-lite` reached this way
  was also **bimodal** on quality — 14/14 on about 85% of requests and 9–10/14 on
  the rest, on byte-identical input. See [MODELS.md](MODELS.md).

Three OpenCode caveats, all properties of the provider:

- **The two presets are two different products.** `opencode-go`
  (`/zen/go/v1`) is a flat-rate subscription over open coding models;
  `opencode-zen` (`/zen/v1`) is pay-as-you-go over a 60-model catalogue. A key
  for one does not buy the other — the Go key used here answered `CreditsError`
  on every paid Zen model.
- **`reasoning_effort` is a per-model decision here too, and failures are
  disguised.** Most Go models accept and honour it, but `grok-4.5` and
  `minimax-m2.5` fail — and the gateway reports the upstream rejection as a
  generic *"Error from provider (Console Go): Upstream request failed"* rather
  than passing through the HTTP 400 and its reason. On xAI direct the same field
  gives a readable error; through OpenCode it does not.
- **Latency rules most of this catalogue out for live checking.** These are
  coding models and they think: measured live-check latency ran 3.5s to 100s.
  Two plan models — `deepseek-v4-pro` at 98s and `qwen3.6-plus` at 73s — average
  worse than ProofKey's own 60s request timeout
  (`src/core/providers/request.ts:79`), so they do not merely arrive late, they
  fail. A third, `qwen3.7-plus`, averages 58s and so straddles it.

### Everything else

The other 33 presets in `src/core/presets.ts` are `Untested` end-to-end: the
base URLs come from Hermes Agent's registry rather than from anyone here having
called them with a key. Three use `anthropic_messages` — Anthropic, MiniMax and
MiniMax (China) — and the rest use `chat_completions`.

If you have a key for any of them, confirming it takes about a minute — settings
page, paste key, **Fetch models**, then one quick action on a page. That is a
complete report.

Which *model* to run on a working provider is a separate question, with its own
page: [MODELS.md](MODELS.md) has the cost arithmetic, and measured results from
`npm run eval` for forty model configurations — three Gemini, five Grok, twelve
reached through OpenRouter and twenty on OpenCode Go. Adding a row there is the
same one-minute job as adding one here.

## Reporting what you find

Two issue templates, both short:

- **[Site report](https://github.com/jiru-labs/proofkey/issues/new?template=site-report.yml)**
  — a site works, or doesn't
- **[Provider report](https://github.com/jiru-labs/proofkey/issues/new?template=provider-report.yml)**
  — a provider works, or doesn't

A report that says "doesn't work on Notion" is hard to act on. The templates ask
for what actually distinguishes the failure modes: whether the underlines drew,
whether the card opened, and whether applying corrupted the text.

Maintainers: move the row, cite the issue number, same commit as the fix.
