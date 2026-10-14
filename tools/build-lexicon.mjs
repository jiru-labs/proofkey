/**
 * Builds the word lists the rewrite actions use to find English words inside
 * Spanish, French or Portuguese text (issue #1), into `public/lexicon/`:
 *
 *     mkdir debs && cd debs && apt-get download hunspell-en-us hunspell-es \
 *       hunspell-fr-classical hunspell-pt-pt hunspell-tools libhunspell-1.7-0
 *     node tools/build-lexicon.mjs debs
 *
 * Output, committed so a clone builds without Debian:
 *
 * - `en.txt`: every lowercase English word of three letters or more, sorted,
 *   one per line, from the Hunspell en_US dictionary (SCOWL, whose licence
 *   allows redistribution; `public/THIRD_PARTY_NOTICES.txt`).
 * - `es.bin`, `fr.bin`, `pt.bin`: one bit per line of `en.txt`, set when that
 *   word is not a word of the language, with or without its accents. They are
 *   computed from that language's Hunspell dictionary (MPL-2.0), which is only
 *   read here: no word of it is in the output, only the fact that an English
 *   word is absent from it.
 *
 * German is left out on purpose: its dictionary already holds `Meeting`,
 * `Team` and `Bug`, so the words worth keeping are the ones it cannot tell.
 *
 * The packages are the ones Debian 13 (trixie) shipped on 2026-10-13. Each is
 * refused unless its SHA-256 matches, so the output can only change by editing
 * this file.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = {
  'hunspell-en-us': '962d774fd74f94ea8e781291319706fc5172d7d02c806e4c3a0c6af3ec9ccdc7',
  'hunspell-es': '47d81d5d888c206c62305331e75ca4789d830070c9e6374af6ae9e77295b24cf',
  'hunspell-fr-classical': '188ba594a75271107b0589aa4704cbe83060ec210cda40e9566890c7ddbd0b4a',
  'hunspell-pt-pt': '836ca40c249b6fc6201251260b21ff759482a0e0369da672652d29dafded980c',
  'hunspell-tools': '58c1dd274ec55877e201d90e6da16cac7ca3b73910aea54d8082710fb77d4690',
  'libhunspell-1.7-0': 'a9427e5220e71f8c04c6c0f87826c6fef98e2bab6994a87d6d82e8a120790ecf',
};
const BASES = { es: 'es_ES', fr: 'fr_FR', pt: 'pt_PT' };

const debs = process.argv[2];
if (!debs) throw new Error('Usage: node tools/build-lexicon.mjs <directory with the .deb files>');

const root = mkdtempSync(join(tmpdir(), 'proofkey-lexicon-'));
try {
  const files = readdirSync(debs);
  for (const [name, sha256] of Object.entries(PACKAGES)) {
    const file = files.find((f) => f.startsWith(`${name}_`) && f.endsWith('.deb'));
    if (!file) throw new Error(`${name}: no ${name}_*.deb in ${debs}`);
    const got = createHash('sha256').update(readFileSync(join(debs, file))).digest('hex');
    if (got !== sha256) throw new Error(`${file}: SHA-256 ${got}, expected ${sha256}`);
    execFileSync('dpkg-deb', ['-x', join(debs, file), root]);
  }

  const hunspell = join(root, 'usr/share/hunspell');
  const expand = (dictionary) => {
    const aff = realpathSync(join(hunspell, `${dictionary}.aff`));
    const dic = realpathSync(join(hunspell, `${dictionary}.dic`));
    const encoding = readFileSync(aff, 'latin1').match(/^SET\s+(\S+)/m)?.[1] ?? 'UTF-8';
    const out = execFileSync(join(root, 'usr/bin/unmunch'), [dic, aff], {
      env: { ...process.env, LD_LIBRARY_PATH: join(root, 'usr/lib/x86_64-linux-gnu') },
      maxBuffer: 1 << 30,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // A line is the word, then optional flags after a slash and morphology
    // fields after whitespace ("nous po:pro").
    const words = new Set();
    for (const line of new TextDecoder(encoding).decode(out).split('\n')) {
      const word = line.trim().split(/\s/)[0].split('/')[0].toLowerCase();
      if (word) words.add(word);
    }
    return words;
  };
  const unaccented = (word) => word.normalize('NFD').replace(/\p{M}/gu, '');

  const english = [...expand('en_US')].filter((word) => /^[a-z]{3,}$/.test(word)).sort();
  const out = fileURLToPath(new URL('../public/lexicon/', import.meta.url));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'en.txt'), `${english.join('\n')}\n`);
  console.log(`en.txt: ${english.length} words`);

  for (const [language, dictionary] of Object.entries(BASES)) {
    const words = expand(dictionary);
    for (const word of [...words]) words.add(unaccented(word));
    const mask = new Uint8Array(Math.ceil(english.length / 8));
    let set = 0;
    english.forEach((word, i) => {
      if (words.has(word)) return;
      mask[i >> 3] |= 1 << (i & 7);
      set++;
    });
    writeFileSync(join(out, `${language}.bin`), mask);
    console.log(`${language}.bin: ${set} of ${english.length} English words are not ${dictionary} words`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
