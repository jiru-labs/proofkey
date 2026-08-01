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
| xAI (Grok) | `grok-4.20-0309-non-reasoning` (preset default), `grok-4.3`, `grok-4.5`, `grok-build-0.1` | `chat_completions` | `Verified` | `npm run eval`, 2026-08-01 — all four reachable on the preset's base URL, all held the live-check contract over 3 runs, none produced a false alarm. `GET /v1/models` also works, so **Fetch models** will populate. See [MODELS.md](MODELS.md) |

The last two rows are narrower than they look: `npm run eval` calls the endpoint
directly rather than through the extension, so it confirms the base URL, the key
and the model IDs, not ProofKey's own transport. That is covered separately by
`test:ext` above.

One xAI caveat that is a property of the provider rather than of ProofKey: every
Grok model except `grok-4.3` rejects `reasoning_effort` with HTTP 400 rather
than ignoring it, so that field must not be set in **Extra body fields** on an
xAI connection. Live-check latency also runs 1.6s–22s depending on the model,
against roughly 1s on Gemini.

### Everything else

The other 32 presets in `src/core/presets.ts` are `Untested` end-to-end: the
base URLs come from Hermes Agent's registry rather than from anyone here having
called them with a key. Three use `anthropic_messages` — Anthropic, MiniMax and
MiniMax (China) — and the rest use `chat_completions`.

If you have a key for any of them, confirming it takes about a minute — settings
page, paste key, **Fetch models**, then one quick action on a page. That is a
complete report.

Which *model* to run on a working provider is a separate question, with its own
page: [MODELS.md](MODELS.md) has the cost arithmetic, and measured results from
`npm run eval` for three Gemini models and five Grok configurations. Adding a row
there is the same one-minute job as adding one here.

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
