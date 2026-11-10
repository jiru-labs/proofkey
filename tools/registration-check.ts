/**
 * Checks that content-script registration passes cannot overtake each other,
 * runnable without a browser:
 *
 *     node --experimental-strip-types tools/registration-check.ts
 *
 * The extension test failed now and then on "removing the origin unregisters it
 * again", leaving registered exactly the origins from before the clear. The
 * model here is the same shape: a pass that read the old settings is slow in
 * `permissions.contains`, a second pass for the new (empty) settings
 * unregisters, and the end state has to be the second pass's.
 */

import { coalesced } from '../src/background/coalesce.ts';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A fake browser: stored origins, a registration, and a contains() whose delay the test sets. */
function fakeBrowser() {
  const state = {
    stored: ['https://a.test/*', 'https://b.test/*'],
    registered: null as string[] | null,
    containsDelay: [] as number[],
    passes: 0,
  };
  async function pass(): Promise<void> {
    state.passes++;
    const wanted = [...state.stored];
    const delay = state.containsDelay.shift() ?? 0;
    const granted: string[] = [];
    for (const pattern of wanted) {
      await tick(delay);
      granted.push(pattern);
    }
    state.registered = granted.length ? granted : null;
  }
  return { state, pass };
}

console.log('\nregistration passes:');

{
  const { state, pass } = fakeBrowser();
  const sync = coalesced(pass);
  state.containsDelay = [30, 0];
  const first = sync(); // reads a, b and stalls
  await tick(1);
  state.stored = []; // the user clears the origins
  const second = sync();
  await Promise.all([first, second]);
  check(
    'a slow pass with old settings does not re-register after the clear',
    state.registered === null,
    `left registered: ${JSON.stringify(state.registered)}`,
  );
}

{
  const { state, pass } = fakeBrowser();
  const sync = coalesced(pass);
  state.containsDelay = [20, 0, 0, 0];
  const first = sync();
  await tick(1);
  state.stored = ['https://c.test/*'];
  const later = [sync(), sync(), sync()];
  await Promise.all([first, ...later]);
  check('calls made during a pass share one follow-up pass', state.passes === 2, `${state.passes} passes`);
  check(
    'and that pass reads the latest settings',
    JSON.stringify(state.registered) === JSON.stringify(['https://c.test/*']),
    JSON.stringify(state.registered),
  );
}

{
  let runs = 0;
  const sync = coalesced(async () => {
    runs++;
    if (runs === 1) throw new Error('boom');
  });
  const outcome = await sync().then(
    () => 'resolved',
    () => 'rejected',
  );
  await sync();
  check('a failed pass reports its error to its caller', outcome === 'rejected', outcome);
  check('and does not block the next pass', runs === 2, `${runs} runs`);
}

{
  let runs = 0;
  const sync = coalesced(async () => {
    runs++;
  });
  await sync();
  await sync();
  check('calls made after a pass finished each get their own', runs === 2, `${runs} runs`);
}

if (failures) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nRegistration checks passed.');
