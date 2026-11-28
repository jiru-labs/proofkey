/**
 * Checks when the worker injects the content script:
 *
 *     node --experimental-strip-types tools/injection-check.ts
 *
 * A tab opened before an extension update keeps the old script's
 * `#proofkey-root` in the page with nothing listening behind it. Trusting that
 * marker left the tab without toolbar, menu or shortcut until a reload.
 */

import { ensureInjected, type InjectionDeps } from '../src/background/injection.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function rig(opts: { alive: boolean; bareFinds: boolean }) {
  const calls: string[] = [];
  let alive = opts.alive;
  const deps: InjectionDeps = {
    ping: async () => alive,
    injectBare: async () => {
      calls.push('bare');
      if (opts.bareFinds) alive = true;
      return opts.bareFinds;
    },
    injectTarget: async () => {
      calls.push('target');
      alive = true;
    },
  };
  return { deps, calls };
}

console.log('content script injection');
{
  const { deps, calls } = rig({ alive: true, bareFinds: false });
  check('a script that answers is left alone', (await ensureInjected(deps)) === 'present' && calls.length === 0, calls.join());
}
{
  const { deps, calls } = rig({ alive: false, bareFinds: true });
  check('a bare frame is injected through the marker probe', (await ensureInjected(deps)) === 'injected' && calls.join() === 'bare', calls.join());
}
{
  // The orphan: the marker is in the page, so the probe finds no bare frame.
  const { deps, calls } = rig({ alive: false, bareFinds: false });
  const result = await ensureInjected(deps);
  check('an orphaned marker with no listener is injected anyway', result === 'injected' && calls.join() === 'bare,target', `${result} ${calls.join()}`);
}

console.log(failures === 0 ? '\nAll injection checks passed.' : `\n${failures} injection check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
