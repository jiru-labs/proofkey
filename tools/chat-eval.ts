/**
 * The live check on chat-style text, batched the way `live.ts` sends it
 * (8 sentences a request, shuffled per run so neighbours change).
 *
 *     node --experimental-strip-types tools/chat-eval.ts --base http://127.0.0.1:8080/v1 --model qwen3.5-4b --runs 6 \
 *         [--temperature 0] [--varieties en=en-US,es=es-419] [--native "Spanish, English"]
 *
 * `eval.ts` has 14 tidy sentences in one request. This set is what a chat box
 * gets: informal Spanish and English, missing accents, voseo, Spain and Latin
 * American words, half of it already correct. Regional items (British spelling,
 * ordenador, vosotros, vídeo) are right or wrong depending on the pinned
 * variety, so they are listed but kept out of both percentages.
 */
import {
  composeCheckPrompt,
  dropAddedFullStops,
  formatCheckPayload,
  parseCheckReply,
} from '../src/core/prompts.ts';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const base = arg('base')!;
const model = arg('model')!;
const runs = Number(arg('runs') ?? 5);
const temperature = arg('temperature') === undefined ? undefined : Number(arg('temperature'));
const varieties = Object.fromEntries((arg('varieties') ?? '').split(',').filter(Boolean).map((p) => p.split('=')));
const profile = {
  styleGuide: '', neverFlag: [], nativeLanguage: arg('native') ?? '', explainLanguage: '', translateLanguage: '', varieties,
} as any;

type F = { input: string; expect: string; tag: string };
const F: F[] = [
  // ---- Spanish chat with errors
  { input: 'Hola, ya llege a casa', expect: 'Hola, ya llegué a casa', tag: 'es err' },
  { input: 'No se si voy a poder ir mañana', expect: 'No sé si voy a poder ir mañana', tag: 'es err' },
  { input: 'Haber si nos vemos el finde', expect: 'A ver si nos vemos el finde', tag: 'es err' },
  { input: 'Te mando el archivo despues de comer', expect: 'Te mando el archivo después de comer', tag: 'es err' },
  { input: 'Ayer fuimos al cine y la pelicula estuvo genial', expect: 'Ayer fuimos al cine y la película estuvo genial', tag: 'es err' },
  { input: 'Cuando puedas me avisas porfa', expect: 'Cuando puedas me avisas porfa', tag: 'es clean' },
  { input: 'Hechale un vistazo cuando tengas tiempo', expect: 'Échale un vistazo cuando tengas tiempo', tag: 'es err' },
  { input: 'Mi hermano tubo un accidente pero esta bien', expect: 'Mi hermano tuvo un accidente pero está bien', tag: 'es err' },
  { input: 'Que hora es la reunion?', expect: '¿Qué hora es la reunión?', tag: 'es err' },
  { input: 'Vamos a ver que pasa', expect: 'Vamos a ver qué pasa', tag: 'es err' },
  { input: 'Me dijo que no habia problema', expect: 'Me dijo que no había problema', tag: 'es err' },
  { input: 'Si quieres te lo explico mejor por telefono', expect: 'Si quieres te lo explico mejor por teléfono', tag: 'es err' },
  // ---- Spanish chat, already correct (regional and informal on purpose)
  { input: 'Vale, nos vemos a las ocho.', expect: 'Vale, nos vemos a las ocho.', tag: 'es clean' },
  { input: 'Dejé el ordenador en la oficina.', expect: 'Dejé el ordenador en la oficina.', tag: 'es clean spain' },
  { input: '¿Vosotros venís a la cena?', expect: '¿Vosotros venís a la cena?', tag: 'es clean spain' },
  { input: 'Se me quedó el móvil sin batería.', expect: 'Se me quedó el móvil sin batería.', tag: 'es clean spain' },
  { input: '¿Vos sabés a qué hora abre?', expect: '¿Vos sabés a qué hora abre?', tag: 'es clean voseo' },
  { input: 'Ahorita te marco al celular.', expect: 'Ahorita te marco al celular.', tag: 'es clean latam' },
  { input: 'jaja sí, qué risa', expect: 'jaja sí, qué risa', tag: 'es clean' },
  { input: 'Gracias por todo, de verdad.', expect: 'Gracias por todo, de verdad.', tag: 'es clean' },
  { input: 'Mañana te paso el link del meeting.', expect: 'Mañana te paso el link del meeting.', tag: 'es clean mixed' },
  { input: 'Te mandé un vídeo muy gracioso.', expect: 'Te mandé un vídeo muy gracioso.', tag: 'es clean spain' },
  { input: 'Llegamos tarde por el tráfico.', expect: 'Llegamos tarde por el tráfico.', tag: 'es clean' },
  { input: 'Ustedes tienen que ver esto.', expect: 'Ustedes tienen que ver esto.', tag: 'es clean' },
  // ---- English chat with errors
  { input: 'Im running late, be their in 10', expect: "I'm running late, be there in 10", tag: 'en err' },
  { input: 'Did you recieve my message?', expect: 'Did you receive my message?', tag: 'en err' },
  { input: 'Its going to rain tomorow', expect: "It's going to rain tomorrow", tag: 'en err' },
  { input: 'We was talking about it yesterday.', expect: 'We were talking about it yesterday.', tag: 'en err' },
  { input: 'Let me know if your coming', expect: "Let me know if you're coming", tag: 'en err' },
  { input: 'Thanks alot for the help!', expect: 'Thanks a lot for the help!', tag: 'en err' },
  // ---- English chat, correct (incl. British spellings)
  { input: 'Sounds good, see you then.', expect: 'Sounds good, see you then.', tag: 'en clean' },
  { input: 'lol that is so true', expect: 'lol that is so true', tag: 'en clean' },
  { input: 'I love the colour of your new car.', expect: 'I love the colour of your new car.', tag: 'en clean gb' },
  { input: 'Can you call me when you get a chance?', expect: 'Can you call me when you get a chance?', tag: 'en clean' },
  { input: 'The package should arrive on Monday.', expect: 'The package should arrive on Monday.', tag: 'en clean' },
  { input: 'We travelled to the centre of town.', expect: 'We travelled to the centre of town.', tag: 'en clean gb' },
];

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const BATCH = 8;

async function batch(inputs: string[]): Promise<string[] | null> {
  const body = {
    model,
    messages: [
      { role: 'system', content: composeCheckPrompt(profile, inputs.length) },
      { role: 'user', content: formatCheckPayload(inputs) },
    ],
    max_tokens: 1024,
    stream: false,
    reasoning_effort: 'none',
    ...(temperature === undefined ? {} : { temperature }),
  };
  const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await r.json();
  const lines = parseCheckReply(j?.choices?.[0]?.message?.content ?? '', inputs.length);
  return lines && dropAddedFullStops(inputs, lines);
}

const stats = { exact: 0, errFixed: 0, errTotal: 0, cleanFlag: 0, cleanTotal: 0, broken: 0 };
const wrong = new Map<string, Map<string, number>>();
for (let r = 0; r < runs; r++) {
  // Shuffle order per run so a batch is not always the same neighbours.
  const order = F.map((_, i) => i).sort(() => Math.random() - 0.5);
  for (let i = 0; i < order.length; i += BATCH) {
    const idx = order.slice(i, i + BATCH);
    const out = await batch(idx.map((k) => F[k]!.input));
    if (!out) { stats.broken++; continue; }
    idx.forEach((k, n) => {
      const f = F[k]!; const got = norm(out[n]!);
      const clean = f.input === f.expect;
      if (/gb|spain/.test(f.tag)) {
        // Regional items: changing them is right or wrong depending on the pin. Counted apart.
        if (got !== norm(f.input)) { const m = wrong.get(f.input) ?? new Map(); m.set(got, (m.get(got) ?? 0) + 1); wrong.set(f.input, m); }
        return;
      }
      if (clean) stats.cleanTotal++; else stats.errTotal++;
      if (got === norm(f.expect)) { stats.exact++; if (!clean) stats.errFixed++; return; }
      if (clean) stats.cleanFlag++;
      const m = wrong.get(f.input) ?? new Map(); m.set(got, (m.get(got) ?? 0) + 1); wrong.set(f.input, m);
    });
  }
}
console.log(JSON.stringify({ runs, temperature, varieties, native: profile.nativeLanguage, ...stats,
  errFixedPct: +(100 * stats.errFixed / stats.errTotal).toFixed(1), falseAlarmPct: +(100 * stats.cleanFlag / stats.cleanTotal).toFixed(1) }));
for (const [input, m] of wrong) for (const [got, c] of m) console.log(`  ${c}x  ${input}  →  ${got}`);
