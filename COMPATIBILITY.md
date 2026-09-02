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
| `<textarea>` | Mirror overlay for underlines, `execCommand` to write | `Tested` | `test:render` — `plain`, `odd` fields: overlay typography, box alignment, underline containment, card, apply. `chat` field: a lone unterminated sentence is checked rather than reported clean, and all three of its corrections apply in turn to reach the same text a single pass would produce |
| `<input type=text>` | Same, single-line | `Tested` | `test:render` — `single` field |
| Plain `contenteditable` | CSS Custom Highlight API for underlines, word-level diff to write | `Tested` | `test:render` — `rich` field, incl. bold surviving both a single apply and a whole-field rewrite |
| `contenteditable` that re-renders on every input | Same, edits bounded and awaited | `Tested` | `test:render` — `rerender` field |
| **Lexical** (WhatsApp, Reddit) | `execCommand` through the browser's editing path; never a DOM mutation | `Tested` + `Verified` | `test:render` — `lexical` field, a real embedded Lexical instance (35a8351): whole-field rewrite, and live checking driven by a real clipboard paste. Verified against WhatsApp Web 2026-08-01 (e2ae3b1) |
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
| Gmail | `contenteditable` | `Verified` | Live check and apply, 2026-09-02, on the published 0.1.3 build: 9 underlines on a six-error sentence, `sentance`→`sentence` applied, field re-read exact, count fell to 8 |
| Telegram Web | `contenteditable` | `Verified` | 2026-09-02, published build: 8 underlines in the message box, apply exact |
| Outlook / Hotmail | Rooster (`contenteditable`) | `Verified` | 2026-09-02, published build: 4 underlines, `erors`→`errors` applied, count fell to 3. **Outlook's own autocorrect rewrote four of the six seeded errors before ProofKey saw the text**, and its native spelling popup renders underneath ProofKey's card — two correctors on one field |
| Infomaniak Mail | `contenteditable` inside a **cross-origin iframe** | `Broken` | 2026-09-02: nothing is underlined and no badge appears. The whole app is an iframe at `mail.infomaniak.com` inside a `ksuite.infomaniak.com` shell, and the content script never enters it — see *Editors in iframes* below. Granting **both** origins does not help |
| Tuta | `contenteditable` | `Untested` | — |
| iCloud Mail | `contenteditable` inside a **same-origin iframe** | `Broken` | 2026-09-02: the app runs in an iframe at `www.icloud.com/applications/mail2/…`. With `https://www.icloud.com` granted, the top frame has `#proofkey-root` and **the iframe does not** — same origin, same granted pattern, no injection. This is the control that isolates the cause to `allFrames`; see below |
| Slack | Quill | `Untested` | — |
| Notion | ProseMirror-like | `Untested` | — |
| Discord | Slate | `Untested` | — |
| LinkedIn | Quill | `Untested` | — |
| X / Twitter | Draft.js / custom | `Verified` | `Ctrl+Shift+K` run by the maintainer 2026-08-02. Live checking did nothing on that same visit — two universal bugs, not X ones — and was confirmed working by the maintainer after f56f4ec, same day. Live check and apply **re-confirmed on the published 0.1.3 build 2026-09-02**: 8 underlines, apply exact, count fell to 7 |
| Reddit | Lexical | `Verified` | 2026-09-02, published build: 9 underlines in the Lexical comment box, apply exact, count fell to 7. The write goes through `execCommand`, so Lexical's model stays in sync |
| GitHub (comments, issues) | `<textarea>`, CodeMirror in places | `Untested` | — |
| Google Docs | canvas | `Not supported` | See above |

Six sites have now been run by hand. WhatsApp Web is the one row still resting on
the **unpacked development build** (2026-08-01); everything marked 2026-09-02 was run
against the **published 0.1.3 build** from the store, which is a different
extension id with its own permissions. Re-confirm WhatsApp on the published build
before treating that row as current.

### Editors in iframes are not reached at all

Measured 2026-09-02 on Infomaniak Mail and iCloud Mail, and it is structural
rather than site-specific.

**The control that proves it is iCloud.** Infomaniak's frame is cross-origin, so
"the inner origin was never granted" stayed a live alternative explanation.
iCloud's frame is **same-origin** — `www.icloud.com` inside `www.icloud.com`,
matching the one pattern that was granted — and the top frame has `#proofkey-root`
while the frame has none. Same origin, same pattern, no injection. That leaves
only the flag.
The content script is registered with `matches`, `js` and `runAt` and **no
`allFrames`** (`src/background/index.ts:174`), and the on-demand path injects with
`target: { tabId }` and no `allFrames` either (`src/core/browser.ts:47`). Chrome
defaults that flag to `false`, so both paths reach **the top frame only**.

Any site whose editor lives in a child frame therefore gets nothing — no
underlines, no badge, no error. It fails silently, which is the worst shape for
this: the user sees an extension that simply does not work and has no way to tell
why.

**Fixed in `main`, not yet released.** `allFrames: true` is now set on both
injection paths (9e531a5). It does **not** widen exposure: every frame is still
matched against the granted origins on its own url, so a frame whose origin the
user never granted is still skipped, ad iframes included.

`npm run test:ext` reproduces the bug against a real frame tree — a served page
with a same-origin iframe — rather than trusting the registration object, and the
assertion was watched failing before the fix went in. The test carries its own
control: *the content script lands in the top frame* passes while *and in a
same-origin subframe* fails, which is what pinned the cause to the flag rather
than to permissions.

**The two `Broken` rows above still describe the published 0.1.3 build**, which is
what users have. They stay `Broken` until a release ships the fix and both sites
are re-run by hand — a passing test is not a verified site.

The X visit is worth reading as a method note. Live checking reported "no issues
found" on a tweet with four errors in it, and the tempting reading was that
Draft.js broke something. It had not: the composer held one unterminated
sentence, that sentence was the caret's, and the caret's sentence was never
sent — so the check had made no request and was showing a green tick for the
absence of findings. Any site would have done the same. The harness could not
express the case at all, because every field in it carried at least two
sentences *by design*, with a comment saying so; the assumption that hid the bug
had been written into the thing meant to catch it. It now has a `chat` field,
and live checking was re-run on X after the fix and confirmed working, which is
what moved the row above to `Verified` outright.

A third, found on WhatsApp Web 2026-08-13, is not a ProofKey bug at all and is
recorded because it is indistinguishable from one. `Ctrl+Shift+K` did nothing to
the text and appended six backticks to it, which reads exactly like the assistant
mangling the field. It was not: Chrome hands out `suggested_key`
first-come-first-served, another extension already held the combination, and
ProofKey's command was therefore left **unbound with no error reported
anywhere** — including on a clean install from the Web Store, where the user has
never touched a shortcut setting. The keypress then reached the page, and
WhatsApp acted on it, inserting an empty monospace block. The right-click menu
corrected the same text correctly on the same visit, which is what separated the
two explanations.

The options page now says so: when `chrome.commands.getAll()` reports no binding
for the default action, the Actions section carries a warning naming
`chrome://extensions/shortcuts` as the only place it can be fixed. The
information was already being fetched — it was used to avoid collisions when
recording a per-action chord, and unbound commands were dropped on the floor.
Verified in a real browser both ways: no warning when the command is bound, the
warning present when it is not.

The **Draft.js** row in the editors table stays `Untested` regardless. The engine
attribution for X is best-effort, as the heading of this section says, so what
was verified is a site, not the engine we guess it runs. Promoting an engine on
that basis is exactly the drift the tier rule exists to stop.

The same visit turned up a second one behind it, and it is the same mistake in a
different place: applying a correction rewrote the sentence, the rewritten
sentence hashed differently, and the apply path recorded that new hash as
**clean** so it would not be re-sent — discarding every other finding already
made in it. Fix one word of three and the badge went green over the other two.
Both bugs were a cache entry standing in for a verdict nobody had reached. The
tick is now only written when every sentence in the field is actually cached,
and `test:render` applies all three `chat` corrections in sequence, because a
single apply cannot see the difference.

A third, reported from **both X and WhatsApp** on 2026-08-02, completes the
pattern: applying a correction was also recorded as a **dismissal**. Dismissals
are keyed by sentence content and the cache never forgets, so a finding the user
had already accepted was suppressed for that exact sentence for the rest of the
session. Put the original text back — paste it, undo it, retype it — and the
findings came back from cache already silenced, with no request sent to
contradict them. On a sentence carrying one error that is a green tick over text
nobody corrected; with several, only the first was lost, which is quieter and
worse. Applying is no longer recorded as a dismissal at all: a corrected
sentence hashes differently, so the entry the finding came from no longer
matches anything in the field, and where it does still match — the same sentence
written twice — the other copy really does still have the error in it.
`test:render` now corrects a field down to a tick, pastes the original back and
asserts the count returns, on a `<textarea>` and on a rich-text field both,
since the two report sites compose in a contenteditable and the textarea is what
shows the fault was in the session bookkeeping rather than in either editor.

Chasing that one turned up a fourth, and this one could damage a message rather
than merely mislead about it. A suggestion card stayed open when the text under
it changed. Its offsets were captured when it opened, every write indexes the
field by exactly those offsets, and nothing verified that what sits there is
still what was offered — so pasting over a field with a card up and pressing
Apply wrote the replacement wherever those numbers happened to land. In the test
that reproduces it, `at noon` became `at noI`. `EditTarget.text` had carried the
expectation all along; no path checked it. Now `applyToTarget` refuses when the
field no longer matches, and `rebuild` closes a card whose suggestion is gone
and re-anchors one that merely moved. The same guard covers `Ctrl+Shift+K`,
where the gap is much wider — the whole model round-trip — and typing through it
would otherwise have landed the rewrite over text the model never saw; that case
now says so and leaves the result on the clipboard.

A fifth, and the one that answers the report those four came out of: **replace
the whole message and live checking does not notice**. `input` was the only
signal the live layer had. Measured on the embedded Lexical editor — typing
fires one `input` per keystroke, select-all-and-paste fires **none**, and undo
fires **none**. Lexical calls `preventDefault` on both and reconciles the DOM in
its own code, and a programmatic DOM change emits no `input` event, so the only
trace either leaves is a mutation. The badge was not reporting a wrong verdict
so much as answering an older question: the whole message could be swapped out
under a green tick and nothing would look again. Rich-text fields now carry a
`MutationObserver` alongside the `input` listener, comparing text rather than
counting mutations — composers mutate themselves constantly for placeholders and
carets, and re-arming the debounce on every mutation would mean never checking
at all.

That one is also a note on how it was nearly missed twice. The first attempt to
reproduce it used Playwright's `insertText`, which Lexical ignores; the second
used a synthetic `ClipboardEvent`, which Lexical also ignores. Both left the
field holding correct text, so the green tick was *honest* both times and the
run read as "cannot reproduce". Only a real clipboard paste through
`Ctrl+A`/`Ctrl+V` reaches the editor. `test:render` now does that, and asserts
the paste landed **before** asserting anything about the badge — a paste that
silently fails leaves the field genuinely clean, and every check after it passes
for the wrong reason.

A sixth, found while tracing the fifth, and it is the first one over again with
a different gate. The settle pass that rescues a one-sentence message required
the caret to be at the end of everything written — the reasoning being that
anyone who had clicked back into the middle was mid-edit and should be left
alone. That reading has no exit: the ordinary check skips the caret's sentence
by design, and for a tweet or a chat line that *is* the whole message, so
clicking into the middle of one — or pasting one and clicking anywhere in it —
meant nothing was ever sent. Measured: no request at all, and a grey badge
reading "not checked yet" still there five seconds later. Honest, and useless.
The gate is now the pause rather than the caret's position, which is what it was
trying to ask about in the first place: any keystroke cancels a pending settle,
so the timer already means typing has stopped, and that is just as true of a
paused mid-text edit.

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
| Google Gemini | **Error bodies** | `chat_completions` | `Tested` | `tools/errors-check.ts` — "Gemini wraps the error object in an array". Observed against the live endpoint 2026-08-18: a failure comes back as `[{"error": {"code": 429, "message": "…"}}]`, an array, where every other provider here sends that object bare. ProofKey read straight past it until this row existed, so every Google failure — dead key, wrong model id, exhausted quota — surfaced as a bare `429 request failed` with the provider's own explanation thrown away |
| xAI (Grok) | `grok-4.20-0309-non-reasoning` (preset default), `grok-4.3`, `grok-4.5`, `grok-build-0.1` | `chat_completions` | `Verified` | `npm run eval`, 2026-08-01 — all four reachable on the preset's base URL, all held the live-check contract over 3 runs, none produced a false alarm. `GET /v1/models` also works, so **Fetch models** will populate. See [MODELS.md](MODELS.md) |
| OpenRouter | `openai/gpt-4.1-mini` (preset default), `gpt-4.1-nano`, `gpt-oss-20b`, `anthropic/claude-haiku-4.5`, `google/gemini-2.5-flash-lite`, `meta-llama/llama-3.3-70b-instruct`, `deepseek/deepseek-v4-flash`, `qwen/qwen3.7-flash`, `mistralai/mistral-nemo`, `mistralai/mistral-small-3.2-24b-instruct` | `chat_completions` | `Verified` | `npm run eval`, 2026-08-01 — all ten reachable on the preset's base URL, all held the live-check contract over 3 runs. `GET /v1/models` returns 336 models, so **Fetch models** will populate. The preset's `X-Title` header is accepted. See [MODELS.md](MODELS.md) |
| OpenCode Go | `grok-4.5`, `gpt-5.6-luna`, `glm-5.2`, `glm-5.1`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `mimo-v2.5`, `mimo-v2.5-pro`, `minimax-m3`, `minimax-m2.7`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `deepseek-v4-pro`, `hy3` | `chat_completions` | `Verified` | `npm run eval`, 2026-08-01 — 16 of the plan's 17 models reachable on the preset's base URL, all held the live-check contract over **10** runs, none produced a false alarm. `GET /v1/models` works, so **Fetch models** will populate. One caveat that the contract does not catch: `minimax-m3` scored **0.0/14** by returning its reasoning instead of corrections. See [MODELS.md](MODELS.md) |
| OpenCode Go | `deepseek-v4-flash` | `chat_completions` | `Broken` | `npm run eval`, 2026-08-01 — answers `RegionError`: *"only available hosted in China and requires explicit opt in"*. Works only after opting in per-workspace |
| OpenCode Go | `mimo-v2-pro`, `mimo-v2-omni`, `hy3-preview` | `chat_completions` | `Broken` | `npm run eval`, 2026-08-01 — `mimo-v2-pro` and `mimo-v2-omni` answered HTTP 500 on all 10 runs; `hy3-preview` answered HTTP 400 *"not supported on the lite model list"*. All three are advertised by `GET /v1/models` |
| OpenCode Go | `minimax-m2.5`, `kimi-k2.5`, `glm-5`, `qwen3.5-plus` | `chat_completions` | `Verified` | `npm run eval`, 2026-08-01 — all four answered and held the contract over 10 runs, but none is in the plan's documented 17. `GET /v1/models` advertises **24**, so **Fetch models** lists models the subscription does not document covering; they may stop working without notice |
| OpenCode Zen | any | `chat_completions` | `Untested` | 2026-08-01 — `GET /v1/models` returns 60 models and the base URL is confirmed, but every paid model answered `CreditsError` on a key with no balance, and the free ones are out of scope by the rule below. Nothing was measured |
| llama.cpp (self-hosted) | `Qwen3-30B-A3B-Instruct-2507-abliterated` Q4_K_M, served by `llama-server` b9966 | `chat_completions` | `Verified` | `npm run eval` ×2 and a quick action through the real service worker, 2026-08-13, on a Ryzen 7840U / Radeon 780M laptop with no discrete GPU. Held the numbered-line contract **10/10 at the server's default sampling and 10/10 at `--temperature 0`**, scoring 8.0/14 both ways with zero spread. A real 8-sentence live check takes 9.6s (8.2–14.9s), 6.3× inside the 60s request timeout; a warm one-sentence quick action takes 0.9s. First local model measured on either transport. See the caveats below |
| llama.cpp (self-hosted) | `Qwen3-4B-Instruct-2507` Q4_K_M (stock) | `chat_completions` | `Verified` | `npm run eval`, 2026-08-13, 10 runs at `--temperature 0` on the same laptop. **11.0/14 with zero spread, 0.0 false alarms and the contract held 10/10** — better than the 30B above on every axis but one. Fully offloaded to the Radeon 780M via GTT, so the server holds **0.6 GB** of host RAM against the 30B's 22.4 GB, and a real 8-sentence live check takes 7.5s (7.4–7.9s) against 9.6s (8.2–14.9s). All three misses are English (`meating`, `projet`/`has`, and the same subject-verb agreement); every non-English and every already-correct fixture passed |
| llama.cpp (self-hosted) | `gemma-3-12b-it` Q4_K_M | `chat_completions` | `Verified` | `npm run eval`, 2026-08-13, 10 runs at `--temperature 0`. **13.0/14 with zero spread, 0.0 false alarms, contract held 10/10** — the highest score measured on any provider on this page. Its one miss is the subject-verb agreement in `There are a lot of things`, which every local model missed. Dense and fully offloaded to the 780M, so host RAM is negligible. **But it is slow**: 31.9 tok/s prefill and 8.6 tok/s generation, giving a 25.7s live check against the 4B's 7.5s — accurate enough for quick actions, too slow to underline as you type |
| llama.cpp (self-hosted) | `Huihui-Qwen3-4B-Instruct-2507-abliterated`, `Josiefied-Qwen3-4B-Instruct-2507-abliterated-v1`, both Q4_K_M | `chat_completions` | `Broken` | `npm run eval`, 2026-08-13 — **0.0/14, contract broke 10/10, on both.** They echo the input back uncorrected: no diacritics restored in Spanish or French, no typo fixed. Byte-identical replies from two independent abliterations of a base model that scores 11.0/14 unmodified, which makes the abliteration the cause rather than the size or the quant. At 10+ sentences they also emit `1 1.` for line 11, which `parseCheckReply` correctly rejects rather than mis-attribute |
| llama.cpp (self-hosted) | CORS and host permission | — | `Verified` | 2026-08-13 — `llama-server` echoes `chrome-extension://<id>` into `Access-Control-Allow-Origin` with `Access-Control-Allow-Headers: *`, so unlike Ollama it needs no origin flag. `http://127.0.0.1:8080/*` is a valid match pattern — ports are accepted by `chrome.permissions.contains` in a real browser, so `originPattern` (`src/core/providers/index.ts:109`) grants correctly for a local server |
| llama.cpp (self-hosted) | **Fetch models** | — | `Partly verified` | Observed 2026-08-13: `GET /v1/models` answers **200 without a key** while `POST /chat/completions` answers 401 `Invalid API Key`. On a server started with `--api-key-file` the list therefore populates and the connection looks configured while every request fails. **Test** is what catches it, and the preset ships `authStyle: 'none'` — labelled *"Not sent (local server)"* — which must be switched to Bearer before a typed key is sent at all (`src/core/providers/request.ts:59`) |
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
xAI connection. ProofKey's **Thinking** setting knows this — the preset sends the
field on `grok-4.3` and on no other Grok, asserted by `tools/thinking-check.ts`
— so the caveat applies only to setting it by hand. Live-check latency also runs
1.6s–22s depending on the model, against roughly 1s on Gemini.

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

Four llama.cpp caveats. The first is a property of ProofKey's preset, the rest
of the models rather than of the server:

- **The self-hosted preset assumes an open server.** It ships `authStyle: 'none'`
  and `baseUrl: http://localhost:8000/v1`, which is vLLM's default, not
  llama.cpp's 8080. A `llama-server` started with `--api-key-file` needs both
  changed plus the key pasted, and the failure mode is the asymmetry in the row
  above: the model list populates without a key, so the connection looks right
  until the first real request. Worse, it recurs: `applyPreset`
  (`src/options/options.ts:456`) resets `authStyle` unconditionally on every
  change of the provider dropdown, where `baseUrl`, `model` and `label` are only
  overwritten when they still hold the old preset's value. So a corrected key
  style silently reverts to *"Not sent"* if the preset is re-picked afterwards,
  with the key still visible in its field. Reproduced through the real service
  worker 2026-08-13: identical connection, key present in both, `authStyle:
  'none'` answers *"Invalid API Key"* and `'bearer'` returns the correction.
- **It over-applies formal punctuation, which is exactly what live checking is
  built to avoid.** Scoring 8.0/14 undersells it: 12 of 14 fixtures came back
  linguistically correct, and *four* of the six misses are a single behaviour —
  a full stop appended to a line that did not have one, in English, Spanish,
  French and German alike. The same tendency promoted a comma to a semicolon on
  a real message (`gets lost, its doing` → `gets lost; it's doing`) and rewrote
  `gonna push the fix tonight` as `I'm going to push the fix tonight.` Only two
  misses are ordinary errors: a missed subject-verb agreement (`There is a lot of
  things`) and that register rewrite. Since `Ctrl+Shift+K` is *meant* to complete
  a correction and live checking is meant not to, this model suits the quick
  actions better than the inline underlines.
- **Sampling is not the cause, and `temperature 0` is still worth setting.** The
  score, spread and false-alarm rate are identical at the server's default 0.8
  and at 0, so the added full stops are the model, not the sampler. What
  determinism buys is repeatability: at 0.8 the informal-register fixture came
  back three different ways across ten runs, and at 0 it came back one way. Live
  checking caches per sentence, so a stable answer is worth having.
- **Abliteration costs more than it looks like on a small model, and the two
  local failure modes are opposites.** The 30B survives it; the 4B does not, in
  two independent abliterations, while the same 4B unmodified scores 11.0/14.
  Between the two working local models the errors point in opposite directions:
  the 30B *over*-corrects — added full stops, commas promoted to semicolons,
  slang formalised, 1.0 false alarms — and the 4B *under*-corrects, missing
  English typos but flagging nothing it should not. Since the live-check prompt
  holds that an unnecessary change is worse than a missed error, the smaller
  model is the better fit for inline checking here, which is not the ordering
  size alone would predict.
- **On an iGPU, accuracy and latency pull apart hard enough to want two
  connections.** Generation is memory-bandwidth-bound on shared LPDDR5, so
  latency tracks the weights streamed per token rather than the parameter
  count: 23.7 tok/s for a 4B dense, 24.3 for a 30B MoE with only 3B active, and
  8.6 for a 12B dense. Measured on the same machine, a real 8-sentence live
  check takes 7.5s on `Qwen3-4B-Instruct-2507` (11.0/14) and 25.7s on
  `gemma-3-12b-it` (13.0/14). Neither is the right answer alone, and ProofKey
  already has the seam for both: pin live checking to its own connection
  (`liveCheck.connectionId`) on the 4B and leave the quick actions on the 12B.
  Together they occupy 9.2 GB of the 780M's 14.8 GB GTT budget, so both servers
  run at once — verified 2026-08-13 with `llama-server` on ports 8080 and 8081.

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
