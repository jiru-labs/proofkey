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

## Browsers

ProofKey is a Chromium extension, so every Chromium browser runs the same code. What
differs between them is whether the extension loads, how they rename browser pages,
and whether Chrome's built-in model exists at all.

| Browser | Status | Evidence |
|---|---|---|
| Chromium (Playwright's build) | `Tested` | `npm run test:ext` and `npm run test:render` run in it by default |
| Microsoft Edge 153 (stable, Linux) | `Tested` | 2026-09-15, Edge 153.0.4234.32 headless: `PROOFKEY_BROWSER=<path to msedge> npm run test:ext` 78/78 and `npm run test:render` 95/95 against the stub provider; 2026-09-16 on the tree at `684f358`, 91/91 and 112/112. Edge honours `--load-extension`; its shortcuts page is `edge://extensions/shortcuts`. Not run against real sites or real providers in Edge, and not installed from the Web Store |
| Microsoft Edge, built-in model | `Not supported` on stable Linux | Same run: `LanguageModel` is undefined on a web page, in the service worker and on the options page, so the card reads "This browser has no built-in model". Microsoft documents its Prompt API as a developer preview in Edge Canary and Dev behind a flag, on Windows and macOS only, backed by **Phi-4-mini** rather than Gemini Nano. ProofKey has never been measured on that model; with the flag on, it would run under the "Chrome built-in AI" card, and none of the Nano numbers apply |
| Brave Origin 153 | `Tested` + `Verified` | 2026-09-16, Brave Origin 153.1.95.101, the tree at `684f358`, under `xvfb-run` with `--headed` (it cannot run headless): `test:ext` 91/91, `test:render` 112/112, `test:provider` 33/33 against a local `Qwen3-4B-Instruct-2507`, and the five editor demos below. 2026-09-14 on published 0.1.7: the frame-origin flow on iCloud Mail and Infomaniak, below. Its built-in model answers `unavailable`, see Providers |
| Google Chrome 153 | `Verified` | 2026-09-13: `tools/builtin-test.mjs`, a fresh install of the real build, 11 checks. 2026-09-16 on `684f358`: 12, the new one that no download bar is drawn once the model is ready |
| Vivaldi, Opera, others | `Untested` | Same code path; nobody has loaded it |

## Editors

This is the table that actually predicts behaviour. Whether ProofKey works on
Notion is not a fact about Notion — it is a fact about ProseMirror. Sites change
editors; engines are what the code branches on (`src/content/target.ts`).

| Editor engine | How ProofKey handles it | Status | Evidence |
|---|---|---|---|
| `<textarea>` | Mirror overlay for underlines, `execCommand` to write | `Tested` | `test:render` — `plain`, `odd` fields: overlay typography, box alignment, underline containment, card, apply. `chat` field: a lone unterminated sentence is checked rather than reported clean, and all three of its corrections apply in turn to reach the same text a single pass would produce |
| `<input type=text>` | Same, single-line | `Tested` | `test:render` — `single` field |
| Plain `contenteditable` | CSS Custom Highlight API for underlines, word-level diff to write | `Tested` | `test:render` — `rich` field, incl. bold surviving both a single apply and a whole-field rewrite. `blocks` field: an action run on a selected paragraph rewrites that paragraph and leaves the ones around it alone, asserted with the control that the selection really does have an element endpoint |
| `contenteditable` that re-renders on every input | Same, edits bounded and awaited | `Tested` | `test:render` — `rerender` field |
| **Lexical** (WhatsApp, Reddit) | `execCommand` through the browser's editing path; never a DOM mutation | `Tested` + `Verified` | `test:render` — `lexical` field, a real embedded Lexical instance (35a8351): whole-field rewrite, and live checking driven by a real clipboard paste. Verified against WhatsApp Web 2026-08-01 (e2ae3b1). **2026-09-16, playground.lexical.dev**, Brave Origin 153, `684f358`, local `Qwen3-4B-Instruct-2507`: live underline, Apply from the card with two reads agreeing, and `Alt+G` on the whole multi-paragraph document. Before `729c96a` that last one put the document in the field twice, see [MODELS.md](MODELS.md#text-in-one-language) |
| **Quill** (Slack, LinkedIn) | Same path as Lexical | `Verified` on the public demo | 2026-09-16, the editor on quilljs.com: as the editor-demo run below |
| **ProseMirror** (Notion-like, many CMSes) | Same path as Lexical | `Verified` on the public demo | 2026-09-16, prosemirror.net/examples/basic: as the editor-demo run below |
| **Slate** (Discord) | Same path as Lexical | `Verified` on the public demo | 2026-09-16, slatejs.org/examples/richtext: as the editor-demo run below |
| **Draft.js** (older X/Twitter) | Same path as Lexical | `Verified` on the public demo | 2026-09-16, draftjs.org: as the editor-demo run below |
| CodeMirror / Monaco (code editors) | Out of scope; ProofKey is not a code assistant | `Untested` | — |
| Canvas-rendered text (Google Docs) | There is no DOM text to underline or replace | `Not supported` | Docs paints text to a canvas |

Quill, ProseMirror, Slate and Draft.js take the **same** code path as Lexical —
the one that was fixed in e2ae3b1 and is covered by a real Lexical instance in
`test:render`.

**The editor-demo run, 2026-09-16.** The built extension at `684f358`, freshly
installed in Brave Origin 153 with a local `Qwen3-4B-Instruct-2507`, on each
engine's own public demo page: select all and delete (on Lexical's demo that
clears only part of the page; the rest stays in the document), type two
sentences with errors,
wait for live underlines, open the first card and Apply it, re-read the editor
twice a second and a half apart and require both reads to agree and to contain
the correction, then `Alt+G` (Fix grammar on the whole field) with the same
two-read check. 26 of 26 checks across Lexical, Quill, ProseMirror, Slate and
Draft.js, and no page errors from ProofKey. Driven by a script, not by hand, and
the script is not in the repo because it depends on five pages that change
without notice. A demo page is the engine, not the product: Slack, Notion or
Discord wrap it in their own code, and none of those was run. So `Verified on
the public demo` there means the engine takes ProofKey's writes, not that the
site does.

The failure mode to watch for is a framework that reconciles differently enough that
an awaited `execCommand` still loses characters. That is exactly what the
WhatsApp bug was, and exactly what a report should describe.

## Sites

Examples, to save you guessing which engine you are looking at. **Best-effort:
sites replace their editors without telling anyone.** If you find a wrong engine
here, that alone is worth a report.

| Site | Editor (best-effort) | Status | Evidence |
|---|---|---|---|
| WhatsApp Web | Lexical | `Verified` | **Live checking: 2026-09-10, published 0.1.5, switch on** — three error-filled sentences in the composer: badge 7, four spelling and three style underlines, `Ths`→`This` applied from the card, field re-read exact (two reads agreeing, after the ~20 s lag noted below), count fell to 6. **Quick actions: same visit.** `Alt+Shift+G` — a per-action shortcut bound in Options, sent by the automation so the OS-level Alt+Shift layout chord was bypassed — on three error-filled sentences in the composer: "Applied.", every correction landed, field re-read exact. **Live checking: the 2026-09-04 `Broken` reading is withdrawn.** It was taken with live checking switched *off* for this origin. The extension's stored settings, read off the profile's `Sync Extension Settings` log, show `web.whatsapp.com` dropped from `liveCheck.enabledOrigins` that day, in the write just before the two frame-origin grants, and absent from every write since — the toolbar button toggles, and a click meant to make sure it was on turned it off. Same symptoms reproduced on 2026-09-10 with the switch still off (script present, badge hidden, no highlights); one click on the toolbar button later, everything above. The old `Verified` (2026-08-01, e2ae3b1) was the **unpacked development build** |
| Gmail | `contenteditable` | `Verified` | Live check and apply, 2026-09-02, on the published 0.1.3 build: 9 underlines on a six-error sentence, `sentance`→`sentence` applied, field re-read exact, count fell to 8 |
| Telegram Web | `contenteditable` | `Verified` | 2026-09-02, published build: 8 underlines in the message box, apply exact |
| Outlook / Hotmail | Rooster (`contenteditable`) | `Verified` | 2026-09-02, published build: 4 underlines, `erors`→`errors` applied, count fell to 3. **Outlook's own autocorrect rewrote four of the six seeded errors before ProofKey saw the text**, and its native spelling popup renders underneath ProofKey's card — two correctors on one field |
| Infomaniak Mail | `contenteditable` inside a **cross-origin iframe** | `Verified` — **one extra origin, offered in the page** | **2026-09-14, published 0.1.7 build:** with `mail.infomaniak.com` revoked and unlisted, clicking New message showed the toast *Allow mail.infomaniak.com*; Allow in the toast, then the browser's own prompt, granted it, and without a reload the frame carried `#proofkey-root` and 7 underlines (4 spelling, 3 style), `sentance`→`sentence` applied, field re-read exact, count fell to 6. Before that, 2026-09-04, published 0.1.4 build. The whole app is one iframe at `mail.infomaniak.com` inside a `ksuite.infomaniak.com` shell. With `ksuite` alone the site did nothing (2026-09-02). After adding **`https://mail.infomaniak.com/`** to the origins list: 7 underlines, `sentance`→`sentence` applied, field re-read exact, count fell to 6. See *Editors in iframes* below |
| Tuta | `contenteditable` | `Verified` | 2026-09-02, published build: 8 underlines in the compose body, `sentance`→`sentence` applied and the field re-read exact. No iframes anywhere in the app, so the frame limitation below does not reach it |
| iCloud Mail | `contenteditable` inside a **cross-origin iframe, two levels down** | `Verified` — **one extra origin, offered in the page** | **2026-09-14, published 0.1.7 build:** with `www-mail.icloud-sandbox.com` revoked and unlisted, clicking into the compose body showed the toast *Allow www-mail.icloud-sandbox.com*; Allow in the toast, then the browser's own prompt, granted it, recorded under `www.icloud.com`, and without a reload the `mail2-rte` frame carried `#proofkey-root` and 7 underlines (4 spelling, 3 style), `sentance`→`sentence` applied, field re-read exact, count fell to 6. Before that, 2026-09-04, published 0.1.4 build. The compose editor is not in the same-origin `mail2` frame; it is one level deeper, cross-origin at `www-mail.icloud-sandbox.com/…/mail2-rte/`. With `https://www.icloud.com` alone: six seeded errors, no underlines, no badge. After adding **`https://www-mail.icloud-sandbox.com/`** to the origins list: 6 underlines, `sentance`→`sentence` applied, field re-read exact, count fell to 5. See *Editors in iframes* below |
| Slack | Quill | `Untested` | — |
| Notion | ProseMirror-like | `Untested` | — |
| Discord | Slate | `Untested` | — |
| LinkedIn | Quill | `Untested` | — |
| X / Twitter | Draft.js / custom | `Verified` | `Ctrl+Shift+K` run by the maintainer 2026-08-02. Live checking did nothing on that same visit — two universal bugs, not X ones — and was confirmed working by the maintainer after f56f4ec, same day. Live check and apply **re-confirmed on the published 0.1.3 build 2026-09-02**: 8 underlines, apply exact, count fell to 7 |
| Reddit | Lexical | `Verified` | 2026-09-02, published build: 9 underlines in the Lexical comment box, apply exact, count fell to 7. The write goes through `execCommand`, so Lexical's model stays in sync |
| GitHub (comments, issues) | `<textarea>`, CodeMirror in places | `Untested` | — |
| Google Docs | canvas | `Not supported` | See above |

Nine sites have now been run by hand. **Re-confirming WhatsApp Web on a published
build was the right call, and the first re-confirmation was wrong** (2026-09-04,
corrected 2026-09-10). The row had rested on the unpacked development build since
2026-08-01 — a different extension id with its own permissions, which is why the
caveat was written down — and on the store build live checking appeared to do
nothing. It had been switched off for that origin, by the toolbar button, the same
day. The button *toggles*: a click meant to make sure it is on turns it off, the
toast says so for four seconds, and after that nothing on the page distinguishes
"off for this site" from "broken" — the badge is hidden either way. The control
that was run, Infomaniak underlining minutes later, ruled out the key and the
global state and could not rule out a per-site switch, because that is the one
setting the two sites did not share. What settled it was the extension's own
stored settings read off disk, and a quick action succeeding in the same composer
on 2026-09-10. Check the origin lists before calling a site broken.

**A toolbar click could also turn live checking off where it was meant to start it**
(found 2026-09-16, fixed for 0.1.10). Whether this is what happened on WhatsApp on
2026-09-04 is not known: the settings log no longer holds that day's shortcut
origins, and with WhatsApp listed there the script would have loaded and the click
was an ordinary toggle. Up to 0.1.9 the content script was registered on shortcut
origins only, so a site with live checking on and no shortcuts got no script at the
next page load. The toolbar
button then injected it and flipped the stored switch, which still read on — so the
click that should have started it switched it off. Measured on the 0.1.9 code
through the real service worker: no script after a load with the site switched on,
and one click answered "Live checking is off for this site" and dropped the origin.
Now live-check origins are registered too once the browser grants them (Save asks,
and the toolbar path offers **Allow** in the page), and a click that has to inject
the script leaves live checking on. `test:ext` "live checking across a reload" and
`test:render` "toolbar button, live checking on for the site" cover both halves;
neither has been run on a real site yet.

Everything marked 2026-09-02 was run against the published 0.1.3 build, the
2026-09-04 rows against the published 0.1.4 build, and 2026-09-10 against 0.1.5.

**What is still not run on WhatsApp:** the right-click menu, which is browser UI
that automation cannot drive. It reaches the same `invoke` path the shortcut does,
so it is inferred rather than measured.

A read of the field straight after an apply can lag the rendered page by ~20 s
through the automation's DOM access, and it did here: the first read after the
card's Apply showed the old text and a count of 7 while the page already showed
`This` and 6. Re-read until two consecutive reads agree before calling an apply
failed.

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

**`allFrames` shipped in 0.1.4 and does what it claimed — and it is not enough.**
`allFrames: true` is set on both injection paths (9e531a5). It does **not** widen
exposure: every frame is still matched against the granted origins on its own url,
so a frame whose origin the user never granted is still skipped, ad iframes
included.

That last sentence is also the limitation, and it is the half nobody had measured.
**A granted *page* does not grant the frames inside it.** `allFrames` lets the
script into a frame; the frame's *own* origin still has to be one the user turned
on. So the flag alone rescues only a site whose editor frame shares an origin
that was already granted — and neither site this was written for does.

Measured end to end on the published 0.1.4 build, 2026-09-04, both halves:

| | granted | result |
|---|---|---|
| iCloud Mail | `www.icloud.com` only | 6 errors, **no underlines, no badge** |
| iCloud Mail | `+ www-mail.icloud-sandbox.com` | **6 underlines**, apply exact, count 6→5 |
| Infomaniak Mail | `ksuite.infomaniak.com` only | **nothing** (2026-09-02) |
| Infomaniak Mail | `+ mail.infomaniak.com` | **7 underlines**, apply exact, count 7→6 |

**The original iCloud diagnosis was incomplete.** The same-origin `mail2` frame
now carries `#proofkey-root` where it did not on 0.1.3, so the old control passes
and the flag is doing its job — but the compose editor is not in that frame. It is
a *third* frame down, cross-origin at
`www-mail.icloud-sandbox.com/applications/mail2-rte/`. The frame that got fixed
was not the frame that holds the editor.

**So the remaining bug is a permissions-UX bug, not an injection bug.** The fix
works; the user cannot reach it. The origins box in Options accepts any origin and
`syncShortcutOrigins` registers the script for it, which is why both sites above
went green. Nothing in the product tells anyone those origins exist: the toolbar
button toggles the origin in the address bar and nothing else, there is no
all-sites grant in the UI, and a site that fails this way still fails **silently**.
A user would have to open devtools and read the frame tree to find the string to
type.

**Fixed on 2026-09-10, shipped in 0.1.7, and run on both sites on 2026-09-14.**
The first plan was to offer the frame origins alongside the tab's, which needs the
tab's frame list and a permission the manifest does not request. It turned out not
to be needed. A frame on another origin is opaque, but focus moving into it is not:
the page around it loses window focus and its `activeElement` becomes the
`<iframe>`, whose `src` names the origin. The content script in the parent frame —
already there, because the parent's origin is the one the user granted — catches
that moment, asks the worker whether the origin is set up, and if not shows a
toast naming it with an *Allow* button. The same offer is made when a menu or
shortcut action lands while the cursor is in such a frame, which was the silent
case before.

The click on Allow is what makes it work, and it was measured rather than assumed.
The browser's permission prompt needs a user gesture, and the request has to come
from the service worker. `test:ext` now serves a page with two cross-origin frames
— one on an origin the test manifest grants but nobody listed, one on an origin it
never granted — clicks into each, clicks Allow in the parent's toast, and reads the
reply. For the granted-but-unlisted origin the worker's `permissions.request`
resolved, the origin was added to the shortcut list and the live-check list,
remembered as belonging to the page, and the script was injected into the frame
without a reload: the frame carried `#proofkey-root` where the control a moment
earlier had shown it bare. For the never-granted origin the worker got as far as
the prompt, which headless Chromium cannot answer — so what is measured there is
that the gesture survived the trip, not the grant itself. A click's gesture does
survive `runtime.sendMessage` into a service worker, provided the request is made
before anything is awaited.

Once granted, the frame origin follows the page: the toolbar toggle on
`www.icloud.com` switches `www-mail.icloud-sandbox.com` with it, so a frame the
user switched off does not keep spending the key. That is `frameOrigins` in the
settings, page origin to frame origins.

The fixture is the same shape as the real sites; it is not them, so both rows kept
`requires a manual origin grant` until the published 0.1.7 build was run on each,
on 2026-09-14, in Brave Origin 153. The starting state was a user who had granted
the page and never the frame: the frame origin removed from the browser's grants
and from both lists, the page origin still granted and switched on. On each site,
moving the cursor into the editor showed the toast naming the frame origin, the
click on Allow raised the browser's own permission prompt, and a person accepted
it — that prompt is browser chrome, outside the page the automation drives, so it
was handed to a human rather than attempted. The worker then did what the fixture said it would: the origin
was granted, added to both lists and recorded under its page in `frameOrigins`, and
the frame had the script without a reload. Typing a seven-error sentence gave seven
underlines on each site, and an apply from the card changed exactly one word. What
this does not cover: a toast declined at the prompt, and any browser but Brave.

`npm run test:ext` reproduces the bug against a real frame tree — a served page
with a same-origin iframe — rather than trusting the registration object, and the
assertion was watched failing before the fix went in. The test carries its own
control: *the content script lands in the top frame* passes while *and in a
same-origin subframe* fails, which is what pinned the cause to the flag rather
than to permissions.

**`npm run test:ext` passing was never going to settle this.** Its fixture is a
*same-origin* subframe, so it asserts the flag and nothing else. Both real sites
that motivated the fix put their editor **cross-origin**, where the flag is
necessary and a second grant is what actually decides it — a case the fixture
cannot express, which is why it stayed green through two `Broken` rows. It now
has two such frames, described above — one granted and unlisted, one never
granted.

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

Thirty-six presets, but only **two transports** — so this is not thirty-six
separate integrations. What varies per provider is the auth style, the base URL
and the model naming, not the logic.

| Transport | What it sends | Status | Evidence |
|---|---|---|---|
| `chat_completions` | `POST {baseUrl}/chat/completions`, `Bearer` auth, system as the first message, no `temperature` | `Tested` | `test:ext` — asserted against the real service worker with the extension loaded (863d241) |
| `anthropic_messages` | `POST {baseUrl}/messages`, `x-api-key`, `anthropic-version`, `anthropic-dangerous-direct-browser-access`, system as a top-level string | `Tested` | `test:ext` |
| `chrome_builtin` | No request: `LanguageModel.create` in the service worker, system prompt as `initialPrompts`, greedy (`temperature: 0`, `topK: 1`), languages `en es de fr ja` declared | `Tested` + `Verified` | `tools/builtin-test.mjs` — the real build, freshly loaded into Google Chrome 153 with nothing configured: 11 checks through the real worker, 2026-09-13. `test:ext` cannot run the model — its Playwright Chromium answers `unavailable` in the extension worker — so it asserts the other half instead: a fresh install fails with a message naming the built-in model, refuses non-offered actions, and sends no request (6 checks) |

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
| Chrome built-in AI | Gemini Nano (`nano_v3_gpu_component` 2025.8.8.1141), in Google Chrome 153 | `chrome_builtin` | `Verified` — **live checking and Fix grammar only** | 2026-09-13, one machine: Ryzen 7840U / Radeon 780M laptop. `npm run eval` through `tools/nano-bridge.mjs`, 10 runs: **13.0/14 on every run, 0.0 false alarms, contract held 10/10** with ProofKey's greedy sampling; Chrome's default sampling gave 12.8/14 (12–13). `tools/action-eval.ts --actions all`, 3 runs: Fix grammar kept mixed-language text in 21/24 checks; the rewrites translated borrowed words (9–18/24) and Translate obeyed the injection fixture 3/3, so ProofKey does not offer them while this model is active. Through the real extension, three runs: 8-sentence live check 8.6–8.8s, Fix grammar 4.8–4.9s. See [MODELS.md](MODELS.md#results--chromes-built-in-model) |
| Brave | Chrome built-in AI | `chrome_builtin` | `Not supported` | Measured 2026-09-13 on Brave Origin 153, on the same laptop Chrome runs it on: `LanguageModel` exists and `availability()` answers `unavailable`. Up to 0.1.9 the message for that state named Brave only as a possibility beside Chrome's hardware floor, and on 2026-09-15 a Brave user read it as a hardware problem and asked what it meant. On `main`, unreleased, it names Brave outright when `navigator.userAgentData.brands` lists Brave or `navigator.brave` exists — both signals measured 2026-09-15 in Brave 153 on the options page and in the service worker. The new wording is checked by `tools/builtin-check.ts` with stubbed browsers, and on 2026-09-16 was seen in Brave Origin 153.1.95.101 itself: the real service worker returned it to Fix grammar (`test:ext` run in Brave), and the options card and the in-page error toast showed it in full at 1000 px and 360 px wide |
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

Five caveats about Chrome's built-in model, all measured on the one machine
above:

- **The download is gated, and the gate is quiet.** Chrome will not start the
  4.0 GB download unless the volume holding the profile has 20 GB free, and it
  says so only on `chrome://on-device-internals` (*Enough disk space to install:
  false*) while `availability()` keeps answering `downloading`. A profile on a
  15 GB tmpfs sat at zero bytes for the ten minutes it was watched. The partial
  download is written to the system temp directory, not to the profile.
- **Automation can make it look absent.** Chrome launched by Playwright answers
  `unavailable` for the same profile and binary that answer `downloadable` when
  launched plainly. Playwright's defaults include `--disable-component-update`,
  `--disable-background-networking` and `--disable-field-trial-config`; which of
  them does it was not isolated. `tools/nano-bridge.mjs` spawns Chrome itself for
  that reason.
- **It adds full stops.** At greedy decoding Nano appended a full stop to five of
  the six eval lines that lacked one, scoring 8.0/14 with a false alarm on every
  run.
  ProofKey now takes an added stop back off any live-check line whose original
  had none (`dropAddedFullStops`, `src/core/prompts.ts`), for every provider —
  the prompt already forbade it, and two other models in MODELS.md do the same.
  With that, 13.0/14.
- **Its rewrites absorb borrowed words.** "Hola team, mañana tenemos el kickoff
  meeting" came back from Improve writing as "Hola equipo, mañana tenemos la
  reunión de inicio" on 3 of 3 runs. The output reads well, which is what makes
  it a bad default: the writer never sees what was dropped. Declaring a single
  language would not help — the output already stays in the sentence's main
  language, and that is the problem.
- **Latency is an iGPU figure.** 8.6–8.8s for an eight-sentence live check is
  comparable to `Qwen3-4B` on the same laptop's llama.cpp (7.5s) and far behind
  the cloud models above. No other hardware has been measured.

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

## Actions

Until v0.1.6 this page said nothing about the **actions** themselves — Fix
grammar, Improve writing, Translate and the rest — because nothing had
measured them. `tools/action-eval.ts` now does: it sends each action's real,
composed prompt to a live provider and checks one specific promise —
`PRESERVATION_RULES` says a message mixing two languages keeps the mixture
rather than being collapsed into one — because that promise is exactly what a
user reported broken (38168f8). Everything below is measured on
**`gemini-2.5-flash` only**, the Gemini preset's quick-actions default, and
says nothing about another model, another provider, or (unless stated
otherwise) a real browser.

**The run count matters more than the score.** Five control runs against the
identical, unmodified prompt — same model, same fixtures, nothing changed
between sessions — scored 16, 19, 21, 22 and 22 out of 25 at 5 runs each: a
six-point spread on one unchanging input. One fixture in that set scored 3/3
in one session and 0/5 in the next. Every score below ran at 20 runs, four
times what produced that spread, which is better but still a handful of
sessions on one model. Read it the way [MODELS.md](MODELS.md) already asks a
three-run row to be read — as a direction, not a certainty — before quoting
any number from this section.

| Action | Measured? | Status | Evidence |
|---|---|---|---|
| `fix-grammar` | Yes | `Verified` (gemini-2.5-flash) | `tools/action-eval.ts`, 2026-09-09 (38168f8). The shipped mixed-language wording scored **160/160** over 20 runs on 8 fixtures, against **146/160** for the wording it replaced; on the original 5-fixture set — the one that caught the bug — the gap was **100/100 against a 74/100 control**, and the control is the bug itself: `El deadline es mañana pero todavia no tengo el draft.` → `El plazo es mañana, pero todavía no tengo el borrador.`, reproduced every run. Five reworded candidates were each measured against their own control rather than picked by argument, and all five beat theirs; a candidate that only moved the existing rule later in the prompt, without rewording it, scored 22/25 against a 21/25 control at 5 runs, and that one-point gap was read at the time as ruling out position. **Re-measured at 20 runs on 2026-09-10 it did not survive**: the old wording moved to the end of the prompt scores **160/160**, against **138/160** for the same words near the top. Position is a mechanism, and as strong a one as rewording. Both interventions now saturate this fixture set at 160/160, so it can no longer tell them apart, and no claim is made that the shipped rewording is the better of the two. Two shorter candidates reached 98/100 and 99/100 on the five-fixture set — the worked example that shipped is what closes the last two cases |
| `summarize` | Yes | `Verified` (gemini-2.5-flash) | `tools/action-eval.ts`, 2026-09-09 (38168f8) — **50/50 before the wording change and 50/50 after**. It never translated once in 100 checks either way; see the note below on why that mattered |
| `bullet-points` | Yes | `Verified` (gemini-2.5-flash) | Same measurement, same result as `summarize`: 50/50 before, 50/50 after |
| `translate` | Yes, harness only | `Partly verified` (gemini-2.5-flash) | `tools/action-eval.ts`, 2026-09-09 (75d51fd). Ships at **80/80** over 20 runs on 4 fixtures of its own, after two prompt bullets fixed two failures the harness only saw once its own fixtures were corrected. Before those bullets, the same corrected fixtures scored the old prompt **53/80**: one run in ten obeyed an injected instruction instead of translating it, and `#urgente` came back as `#urgent` though hashtags are promised to survive unchanged. The harness's very first reading had been a false **40/40** — its injection fixture then only checked that the Spanish was gone, and a bare `"OK"` satisfied that. **None of this ran through the extension.** No context menu, no keyboard shortcut, no field written into — every number above is a direct API call, and nobody has run Translate on a real site |
| `improve-writing` | Yes | `Broken` for mixed-language text (gemini-2.5-flash) | [#1](https://github.com/jiru-labs/proofkey/issues/1). `tools/action-eval.ts --fixtures mixed --runs 10`, 2026-09-23, prompts as shipped in 0.1.10: **kept the mixture 59/80** — the two Spanish-base fixtures lose their English nouns (`el deadline`→`el plazo`, `el draft`→`el borrador`, `team`→`equipo`) and the English-base one loses its Spanish (`mañana`→`tomorrow`). Text in one language is fine: all eight actions 640/640 over `--fixtures monolingual --runs 20` the same day |
| `make-professional` | Yes | `Broken` for mixed-language text (gemini-2.5-flash) | [#1](https://github.com/jiru-labs/proofkey/issues/1). `tools/action-eval.ts --fixtures mixed --runs 10`, 2026-09-23, prompts as shipped in 0.1.10: **kept the mixture 48/80** — the same three fixtures, plus a quoted English sentence inside Spanish translated (`"we will ship it on Friday"`→`viernes`). Text in one language is fine: all eight actions 640/640 over `--fixtures monolingual --runs 20` the same day |
| `make-friendly` | Yes | `Broken` for mixed-language text (gemini-2.5-flash) | [#1](https://github.com/jiru-labs/proofkey/issues/1). `tools/action-eval.ts --fixtures mixed --runs 10`, 2026-09-23, prompts as shipped in 0.1.10: **kept the mixture 46/80** — the same three fixtures, plus the French/English one (`numbers`→`chiffres`). Text in one language is fine: all eight actions 640/640 over `--fixtures monolingual --runs 20` the same day |
| `simplify` | Yes | `Broken` for mixed-language text (gemini-2.5-flash) | [#1](https://github.com/jiru-labs/proofkey/issues/1). `tools/action-eval.ts --fixtures mixed --runs 10`, 2026-09-23, prompts as shipped in 0.1.10: **kept the mixture 58/80** — the same three fixtures as `improve-writing`. Text in one language is fine: all eight actions 640/640 over `--fixtures monolingual --runs 20` the same day |
| `expand` | Yes | `Broken` for mixed-language text (gemini-2.5-flash) | [#1](https://github.com/jiru-labs/proofkey/issues/1). `tools/action-eval.ts --fixtures mixed --runs 10`, 2026-09-23, prompts as shipped in 0.1.10: **kept the mixture 32/80** — six of the eight fixtures, including the quoted sentence and the Portuguese/English one (`deploy`→`implantação`, `rollback`→`reversão`). Text in one language is fine: all eight actions 640/640 over `--fixtures monolingual --runs 20` the same day |

`fix-grammar`, `summarize` and `bullet-points` are marked `Verified` on the same
looser basis the Providers section above already uses that tier on: a script
talking to the real endpoint over `gemini-2.5-flash`, not a maintainer's hands
on a real page. The five rewrite rows were `Untested` until 2026-09-23, on the
reasoning that they run the identical shared prompt text. Pointed at the
harness, they showed that reasoning was wrong: the same `PRESERVATION_RULES`
that holds 80/80 in `fix-grammar` gives way in all five. Why is not
established. What separates them from `fix-grammar` is not where the rule
sits — it sits in the same place in all six — but what they are asked to do:
reword ("remove slang", "roughly double the length"), where `fix-grammar` is
told not to touch anything correct, and a borrowed word is easy to read as
something to reword. The first thing to try is still moving the rule after the
action's own instructions, since position was as strong a lever as wording when
`fix-grammar` had this bug; not measured for these actions yet. Ten runs per
fixture on one model, one session; details in
[#1](https://github.com/jiru-labs/proofkey/issues/1).

`translate` is marked down to `Partly verified` for a reason specific to it.
This whole file is otherwise a record of what happens in a real editor on a
real site, and Translate has none of that evidence — it is brand new, there is
no site row for it anywhere above, and every number in its row came from
`tools/action-eval.ts` talking to the API directly. That measures whether the
model translates correctly when asked; it says nothing about whether the
context menu resolves and shows the right language ("Translate to
Portuguese"), whether the refusal message fires correctly with nothing
configured, or whether the result writes back into a Lexical or ProseMirror
field the way `fix-grammar` has been shown to elsewhere on this page. Running
it once by hand on any `Verified` site above — Gmail, Telegram, Reddit, X —
would move that half of the row.

A diagnosis worth recording precisely because it did not survive: `summarize`
and `bullet-points` each carried their own restatement of the language rule —
"write the summary/bullets in the language of the text," singular, sitting
under `PRESERVATION_RULES`'s instruction to keep a mixture — and that
contradiction was the leading suspected cause of the bug before anything was
measured. It was not. Both actions scored 50/50 before any change and 50/50
after; they never translated once across either measurement, and the bug was
entirely in `fix-grammar`, which carried no such line. The restatements were
removed anyway, as a consistency change with no measured effect of its own —
three differently-worded copies of one rule is how the bug got written into
`fix-grammar` in the first place — and both actions gained `VOICE_RULES`, which
every other built-in action already had. That addition is unmeasured here on
purpose: this harness tests language mixing, not register.

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
