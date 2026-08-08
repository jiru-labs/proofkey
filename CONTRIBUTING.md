# Contributing

The single most useful contribution right now is **telling us whether it works
on your site, with your provider**. See [COMPATIBILITY.md](COMPATIBILITY.md) —
most rows say `Untested`, and one person cannot fix that.

Code contributions are welcome too. What follows is the workflow that this
codebase has been kept honest by.

## Licensing your contribution

By opening a pull request you agree that:

- you wrote the contribution, or have the right to submit it; and
- you license it to Jiru Labs under the [MIT License](LICENSE), the same terms
  the rest of the project carries; and
- you grant Jiru Labs the right to distribute it under other terms as well,
  should the project ever be offered under a second license alongside MIT.

The third point is the unusual one, so here is the reason. ProofKey is MIT and
is meant to stay that way — a tool that holds your API key has to be auditable,
and a licence that lets you fork it is part of that promise. The clause exists
so that a paid tier, if one is ever built for teams, does not require tracking
down every past contributor for permission. It does not take your copyright,
does not make your contribution any less MIT, and does not stop you doing
anything at all with your own code.

`ProofKey` and the ProofKey logo are trademarks of Jiru Labs and are not
licensed by MIT. Fork the code freely; give the fork its own name.

## Running it

```bash
npm install
npm run build          # into dist/, then Load unpacked in chrome://extensions
npm run dev            # rebuild on change (still press reload on the extension card)
npm run typecheck
```

## The tests

```bash
npm run serve          # in one terminal — a static server on 8777
npm run verify         # in another: everything below, in order. Run this before opening a PR
```

| Command | What it covers | Needs |
|---|---|---|
| `npm test` | The word diff, in Node. Invariant: applying the changes to the original reproduces the rewrite exactly. Then the shortcut chords: a chord survives a round trip through storage, matches only the event it was recorded from, and the unusable ones are refused | nothing |
| `npm run test:render` | The real built `dist/content.js` against `tools/harness.html`: underline rendering, overlay alignment, the card, apply, whole-field rewrite, and a bound key actually pressed | `npm run serve` on 8777, Playwright |
| `npm run test:ext` | The **actual** extension loaded in Chromium — real service worker, real provider code — pointed at a stub that records requests, so the wire format is asserted rather than assumed. Also that a recorded shortcut reaches `chrome.storage` and that removing it clears it | Playwright with `channel: 'chromium'` |

`test:render` loads `dist/content.js` as the browser would, so it tests the last
build, not the working tree — `npm run build` first, or the change under test is
not the one being measured. `npm run verify` orders it that way.

`test:render` takes `--headed` if you want to watch it. Screenshots land in
`.test-shots/`.

Two more tools sit outside `verify`, because one is arithmetic and the other
spends money:

| Command | What it does |
|---|---|
| `npm run cost` | Estimates cost per 1,000 operations per model, from prompt sizes measured out of `src/core/prompts.ts`. `-- --markdown` regenerates the tables in [MODELS.md](MODELS.md) |
| `npm run eval` | Scores a real model on ProofKey's real prompts — contract failures, false alarms, corrections. Needs `PROOFKEY_EVAL_KEY` and costs cents |

If you edit the prompts, `npm run cost` output changes and MODELS.md needs
regenerating. If you add an `npm run eval` fixture, add it because a model got
it wrong somewhere real.

Both browser tests need Playwright's Chromium (`npx playwright install
chromium`). `test:ext` specifically needs the `chromium` channel: the default
headless build loads no extensions at all and the MV3 service worker never
registers.

## Fixing a bug

The workflow, in order. It is stricter than it looks and the strictness is
earned:

1. **Reproduce it in `tools/harness.html` first.** Add a field, or a case, that
   fails the way the real site fails. The harness stubs the service worker with
   canned corrections, so you get a deterministic repro with no key and no
   network.
2. **Confirm the new test fails without the fix.** Run it against unmodified
   code and watch it go red. This step is not optional and it is not a
   formality — two tests in this repo were written, passed, and turned out to
   assert nothing at all. They were only caught by doing this. A test that has
   never failed has never been tested.
3. Then fix it, and watch the test go green.
4. If the bug came from a real site, move that row in
   [COMPATIBILITY.md](COMPATIBILITY.md) and cite the issue.

Reaching for a real site to reproduce is the tempting shortcut, and it is how
you end up with a fix that works once. If the harness cannot express the bug,
that is itself worth saying in the PR — it usually means the harness needs a new
kind of field, which is the more valuable change.

## Touching `src/content/`

Read the comment block at the top of `src/content/target.ts` before you change
anything in there. Three rules, learned from breakage:

- Never assign `.value` directly — frameworks revert it on the next render.
- Never mutate the DOM of a rich text editor — Slate, ProseMirror, Lexical and
  Quill reconcile against their own model and will fight or crash.
- In rich text, replace only what changed — selecting a block and inserting a
  flat string deletes every tag inside it.

`src/content/highlight.ts` has the equivalent reasoning for why underlines use
the CSS Custom Highlight API in `contenteditable` rather than wrapper elements.

The in-page UI lives in a shadow root so host-page CSS cannot reach it. Keep it
that way.

## Adding a provider

If it speaks `POST /v1/chat/completions` or Anthropic's `POST /v1/messages`, it
is one row in `src/core/presets.ts` and no adapter code:

```ts
openaiCompatible('acme', 'Acme AI', 'https://api.acme.com/v1'),
```

Please take the base URL from the provider's own documentation rather than
inferring it from a similar one. And if you have a key, **use it once and say
so in the PR** — that turns a new row from `Untested` into `Reported` on the
spot, which is the whole point.

Endpoints with quirks usually do not need code either: the connection editor
exposes extra headers, extra body fields, extra query parameters, and the auth
style. Try `Custom` with those before writing a transport.

## Style

Plain TypeScript, no UI framework, plain DOM. Match the surrounding code.

Comments here explain **why**, not what — particularly why a non-obvious
approach was chosen over the obvious one that fails. If you worked something out
the hard way, that reasoning is the part worth keeping.

## Reporting compatibility

- **[Site report](https://github.com/jiru-labs/proofkey/issues/new?template=site-report.yml)**
- **[Provider report](https://github.com/jiru-labs/proofkey/issues/new?template=provider-report.yml)**

Negative results are as useful as positive ones, and a report that ProofKey
scrambled your text is the most useful of all. Include the before and after if
you can — corrupted output usually diverges well into the string, and where it
diverges says which assumption broke.
