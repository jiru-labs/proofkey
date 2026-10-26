// The version lives in four places, and `npm run release` bumps them together.
// package-lock.json carries it twice (top level and packages[""]); release.ts
// used to bump only the manifest and package.json, so the lock drifted behind.
import { readFileSync } from 'node:fs';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const manifest = read('public/manifest.json');
const pkg = read('package.json');
const lock = read('package-lock.json');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('\nversion:');
check('package.json matches the manifest', pkg.version === manifest.version, `${pkg.version} / ${manifest.version}`);
check('package-lock.json matches at the top', lock.version === manifest.version, lock.version);
check('and under packages[""]', lock.packages?.['']?.version === manifest.version, lock.packages?.['']?.version);

if (failures) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nVersion checks passed.');
