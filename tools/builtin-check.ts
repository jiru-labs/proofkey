/**
 * Checks what the built-in model's "unavailable" state tells the user, by browser:
 *
 *     node --experimental-strip-types tools/builtin-check.ts
 *
 * `unavailable` means two different things. Brave Origin 153 answered it on the
 * laptop where Google Chrome 153 runs the model (2026-09-13), so in Brave it says
 * nothing about the computer, and pointing a Brave user at 22 GB of disk and GPU
 * memory sends them after the wrong cause. In Google Chrome it usually is the
 * hardware floor. The message has to tell the two apart.
 *
 * The browser is read the way Brave identifies itself, measured 2026-09-15 in the
 * user's Brave 153 on both the options page and the service worker:
 * `navigator.userAgentData.brands` lists "Brave" and `navigator.brave` exists.
 * The user-agent string itself says only Chrome, so it cannot be used.
 */

import { builtinProblem } from '../src/core/providers/builtinProblem.ts';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

function as(navigator: object): string {
  Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true });
  return builtinProblem('unavailable') ?? '';
}

console.log('unavailable, by browser:');

const brave = as({
  userAgent: CHROME_UA,
  userAgentData: { brands: [{ brand: 'Brave', version: '153' }, { brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '153' }] },
  brave: { isBrave: async () => true },
});
check('Brave is named as the reason', /\bBrave\b/.test(brave), brave);
check('Brave is pointed at Google Chrome for the no-key model', /Google Chrome/.test(brave), brave);
check('Brave is not sent after disk space or GPU memory', !/GB/.test(brave), brave);
check('Brave is still told what works here', /API key/.test(brave), brave);

const braveBrandsOnly = as({ userAgent: CHROME_UA, userAgentData: { brands: [{ brand: 'Brave', version: '153' }] } });
check('the brand alone is enough', /\bBrave\b/.test(braveBrandsOnly) && !/GB/.test(braveBrandsOnly), braveBrandsOnly);

const braveObjectOnly = as({ userAgent: CHROME_UA, brave: { isBrave: async () => true } });
check('navigator.brave alone is enough', /\bBrave\b/.test(braveObjectOnly) && !/GB/.test(braveObjectOnly), braveObjectOnly);

const chrome = as({
  userAgent: CHROME_UA,
  userAgentData: { brands: [{ brand: 'Google Chrome', version: '153' }, { brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '153' }] },
});
check('Google Chrome gets the hardware requirements', /22 GB/.test(chrome), chrome);
check('Google Chrome is not told about Brave', !/Brave/.test(chrome), chrome);

const unknown = as({ userAgent: CHROME_UA });
check('a browser that says nothing about itself gets the hardware requirements', /22 GB/.test(unknown) && !/Brave/.test(unknown), unknown);

if (failures) {
  console.log(`\n${failures} built-in model check(s) failed.`);
  process.exit(1);
}
console.log('\nBuilt-in model checks passed.');
