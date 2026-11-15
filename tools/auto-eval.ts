/**
 * Measures what "Correct spelling automatically" would write on its own, with a
 * real model behind it.
 *
 *     node --experimental-strip-types tools/auto-eval.ts --base http://127.0.0.1:8080/v1 --models qwen --runs 5
 *     PROOFKEY_EVAL_KEY=... node --experimental-strip-types tools/auto-eval.ts --base https://openrouter.ai/api/v1 --models google/gemini-2.5-flash-lite
 *
 * `tools/eval.ts` scores a whole corrected sentence. That is the wrong question
 * for automatic correction, which never writes a sentence: it writes the few
 * changes `autoFixable` lets through, one word each, with nobody clicking. So
 * this sends the same live-check prompt, turns each reply into changes with
 * the same `diffWords` → `classifyChange` → `autoFixable` path `live.ts` runs,
 * and judges every change that would have been written:
 *
 *   - right — the same change is in the diff from the input to the fixture's
 *     expected text;
 *   - wrong — anything else. On a clean sentence every write is wrong.
 *
 * Wrong writes are the number that matters, because each one is text changed
 * in someone's field without asking. Missed fixes stay underlined, which is
 * what happens with the setting off. Every wrong write is printed for a human
 * to read: a fixture can be stricter than the language.
 *
 * Batches the sentences in groups of `BATCH`, the size of a few sentences of a
 * field, rather than one request for all of them.
 */

import { autoFixable, classifyChange, diffWords, type Change } from '../src/core/diff.ts';
import {
  composeCheckPrompt,
  dropAddedFullStops,
  formatCheckPayload,
  parseCheckReply,
} from '../src/core/prompts.ts';
import type { WritingProfile } from '../src/core/types.ts';
import { FIXTURES, type Fixture } from './eval-fixtures.ts';

const EMPTY_PROFILE: WritingProfile = {
  styleGuide: '',
  neverFlag: [],
  nativeLanguage: '',
  explainLanguage: '',
  translateLanguage: '',
};

const BATCH = 8;

/**
 * Spelling-level cases: the ones automatic correction exists for, and the ones
 * where a model's "fix" would be a wrong write. A trap's `expect` is its input.
 */
const AUTO_FIXTURES: Fixture[] = [
  // ------------------------------------------------------ should be written
  { input: 'I recieved your email yesterday.', expect: 'I received your email yesterday.', tests: 'swap' },
  { input: 'Can you send me the adress?', expect: 'Can you send me the address?', tests: 'missing letter' },
  { input: 'Teh results look good.', expect: 'The results look good.', tests: 'swap, sentence start' },
  { input: 'We should definately ship it this week.', expect: 'We should definitely ship it this week.', tests: 'two edits, long word' },
  { input: 'Thanks for your patience, see you on monday.', expect: 'Thanks for your patience, see you on Monday.', tests: 'weekday capital' },
  { input: 'The goverment announced new rules.', expect: 'The government announced new rules.', tests: 'missing letter' },
  { input: 'This is a seperate issue.', expect: 'This is a separate issue.', tests: 'one letter' },
  { input: 'I will call you tommorow.', expect: 'I will call you tomorrow.', tests: 'two edits' },
  { input: 'She is very freindly.', expect: 'She is very friendly.', tests: 'swap' },
  { input: 'His english is excellent.', expect: 'His English is excellent.', tests: 'language capital' },
  { input: 'I got a letter form the bank.', expect: 'I got a letter from the bank.', tests: 'real-word swap' },
  { input: 'No se si podre ir a la reunion.', expect: 'No sé si podré ir a la reunión.', tests: 'Spanish accents' },
  { input: 'El examen fue mas dificil de lo que pensaba.', expect: 'El examen fue más difícil de lo que pensaba.', tests: 'Spanish accents' },
  { input: 'Estoy trabjando en el proyecto.', expect: 'Estoy trabajando en el proyecto.', tests: 'Spanish typo' },
  { input: 'La aplicacion no funciona en mi telefono.', expect: 'La aplicación no funciona en mi teléfono.', tests: 'Spanish accents' },

  // ------------------------------------------- traps: any write is wrong
  { input: 'Jon and Sara will join the call.', expect: 'Jon and Sara will join the call.', tests: 'names one letter from others' },
  { input: 'Ping Kat about the Figma file.', expect: 'Ping Kat about the Figma file.', tests: 'name, product' },
  { input: 'Run npm install and restart the dev server.', expect: 'Run npm install and restart the dev server.', tests: 'command' },
  { input: 'The bug is in useEffect, not in the reducer.', expect: 'The bug is in useEffect, not in the reducer.', tests: 'identifier' },
  { input: 'I bought a new iPhone and a MacBook.', expect: 'I bought a new iPhone and a MacBook.', tests: 'brand casing' },
  { input: 'Our startup Zentrik launches next week.', expect: 'Our startup Zentrik launches next week.', tests: 'invented brand' },
  { input: 'The export is saved as exprt.csv in the root folder.', expect: 'The export is saved as exprt.csv in the root folder.', tests: 'file name' },
  { input: 'Our CTO, Mateo Ruiz, approved it.', expect: 'Our CTO, Mateo Ruiz, approved it.', tests: 'names' },
  { input: "Let's meet at the cafe on Main Street.", expect: "Let's meet at the cafe on Main Street.", tests: 'English "cafe" needs no accent' },
  { input: 'I need to resume my work after lunch.', expect: 'I need to resume my work after lunch.', tests: 'resume is not résumé' },
  { input: 'The colour of the logo is off.', expect: 'The colour of the logo is off.', tests: 'British spelling, no variety pinned' },
  { input: 'We analyze the logs every morning.', expect: 'We analyze the logs every morning.', tests: 'American spelling, no variety pinned' },
  { input: 'Solo quiero saber si vienes.', expect: 'Solo quiero saber si vienes.', tests: 'RAE: "solo" takes no accent' },
  { input: 'Este es el informe final.', expect: 'Este es el informe final.', tests: 'RAE: demonstrative pronoun takes no accent' },
  { input: 'Esta semana no puedo.', expect: 'Esta semana no puedo.', tests: '"esta" is not "está" here' },
  { input: 'Tu informe ya está listo.', expect: 'Tu informe ya está listo.', tests: '"tu" possessive' },
  { input: 'Lo hice como me dijiste.', expect: 'Lo hice como me dijiste.', tests: '"como" not interrogative' },
  { input: 'Mándame el link del meeting, porfa.', expect: 'Mándame el link del meeting, porfa.', tests: 'mixed, informal' },
  { input: 'Te mando el documento cuando lo termine.', expect: 'Te mando el documento cuando lo termine.', tests: 'subjunctive, no accent' },
];

/** The live-check fixtures too, minus any sentence already above. */
const CASES: Fixture[] = [
  ...AUTO_FIXTURES,
  ...FIXTURES.filter((f) => !AUTO_FIXTURES.some((a) => a.input === f.input)),
];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

interface Write {
  fixture: number;
  original: string;
  replacement: string;
  right: boolean;
}

/** The changes `live.ts` would write unasked, in the order it would find them. */
function autoWrites(input: string, output: string): Change[] {
  const source = input.trim();
  const changes = diffWords(source, output.trim()) ?? [];
  return changes.filter((change) =>
    autoFixable(source.slice(change.start, change.end), change.replacement, classifyChange(change, source).category),
  );
}

const same = (a: Change, b: Change): boolean =>
  a.start === b.start && a.end === b.end && a.replacement === b.replacement;

async function check(
  base: string,
  key: string,
  model: string,
  temperature: number | undefined,
  inputs: string[],
): Promise<string[] | null> {
  const body = {
    model,
    messages: [
      { role: 'system', content: composeCheckPrompt(EMPTY_PROFILE, inputs.length) },
      { role: 'user', content: formatCheckPayload(inputs) },
    ],
    max_tokens: 2048,
    stream: false,
    ...(temperature === undefined ? {} : { temperature }),
  };
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} — ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json();
  const reply = payload?.choices?.[0]?.message?.content ?? '';
  const lines = parseCheckReply(reply, inputs.length);
  return lines && dropAddedFullStops(inputs, lines);
}

async function main(): Promise<void> {
  const base = arg('base') ?? 'http://127.0.0.1:8080/v1';
  const key = process.env['PROOFKEY_EVAL_KEY'] ?? 'local';
  const models = (arg('models') ?? 'local').split(',').map((m) => m.trim());
  const runs = Number(arg('runs') ?? 3);
  const t = arg('temperature');
  const temperature = t === undefined ? undefined : Number(t);

  const expected = CASES.map((f) => autoWrites(f.input, f.expect));
  const shouldWrite = expected.reduce((n, list) => n + list.length, 0);
  const traps = CASES.filter((f) => f.input === f.expect).length;
  console.log(
    `${CASES.length} sentences (${traps} clean), ${shouldWrite} expected automatic fixes, ` +
      `batches of ${BATCH}, temperature ${temperature ?? 'unset'}\n`,
  );

  for (const model of models) {
    const writes: Write[] = [];
    let missed = 0;
    let broken = 0;
    let batches = 0;
    const started = Date.now();

    for (let run = 0; run < runs; run++) {
      for (let from = 0; from < CASES.length; from += BATCH) {
        const slice = CASES.slice(from, from + BATCH);
        batches++;
        let outputs: string[] | null;
        try {
          outputs = await check(base, key, model, temperature, slice.map((f) => f.input));
        } catch (error) {
          console.error(`  ${model}: ${(error as Error).message}`);
          outputs = null;
        }
        if (!outputs) {
          broken++;
          continue;
        }
        slice.forEach((fixture, offset) => {
          const index = from + offset;
          const source = fixture.input.trim();
          const got = autoWrites(fixture.input, outputs![offset]!);
          for (const change of got) {
            writes.push({
              fixture: index,
              original: source.slice(change.start, change.end),
              replacement: change.replacement,
              right: expected[index]!.some((e) => same(e, change)),
            });
          }
          missed += expected[index]!.filter((e) => !got.some((g) => same(g, e))).length;
        });
      }
    }

    const right = writes.filter((w) => w.right).length;
    const wrong = writes.filter((w) => !w.right);
    const held = batches - broken;
    const perRun = (n: number): string => (n / Math.max(runs, 1)).toFixed(1);
    console.log(`${model} — ${runs} runs, ${held}/${batches} batches held the format, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    console.log(`  written: ${writes.length} (${perRun(writes.length)}/run)`);
    console.log(`  right:   ${right} (${perRun(right)}/run of ${shouldWrite} expected)`);
    console.log(`  wrong:   ${wrong.length} (${perRun(wrong.length)}/run)`);
    console.log(`  missed:  ${missed} (left underlined)`);
    if (writes.length > 0) console.log(`  precision: ${((right / writes.length) * 100).toFixed(1)}%`);

    const distinct = new Map<string, number>();
    for (const w of wrong) {
      const label = `#${w.fixture + 1} "${w.original}" → "${w.replacement}"  (${CASES[w.fixture]!.tests})`;
      distinct.set(label, (distinct.get(label) ?? 0) + 1);
    }
    for (const [label, count] of distinct) console.log(`    ×${count} ${label}`);
    console.log('');
  }
}

await main();
