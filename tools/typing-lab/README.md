# Typing lab

Measures how long each keystroke takes to paint (Event Timing: input delay +
processing + the next frame) while live checking runs, the numbers in
[MODELS.md](../../MODELS.md#typing-while-it-checks).

- `lab.html` — a textarea; records every keydown of 16 ms or more and when the
  number of ProofKey underlines changes, and posts a summary every 3 s.
- `server.mjs` — serves it on `127.0.0.1:<port>` (`node server.mjs 8777`), writes
  `results-<run>.json` and appends anything posted to `/log` to `log.jsonl`.
- `runner.mjs` — types into the page over the browser's own protocol
  (Playwright), 80 ms per key, 2 s after each sentence, so the computer stays
  usable while it runs: `node runner.mjs plan.json`. It reloads the extension
  first through the extensions page, because a restart can keep an old service
  worker. Plan:
  `{ exe, profile, ext, lab, expectVersion, window: [x, y, w, h], runs: [{ name, origin?, kind?: "type" | "long" | "action-mid", sentences? }] }`.
  Use a throwaway profile with live checking enabled for the lab's origin; a run
  on another origin (`http://localhost:8777` against `127.0.0.1`) is the control.
- `type.vbs` — the same typing from a Windows script (`SendKeys`, OS-level keys);
  it needs the window in front. `run.vbs` / `runall.vbs` start the runner with no
  window on Windows.
