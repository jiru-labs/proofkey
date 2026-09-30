/**
 * Builds `tools/webllm-probe.html`: one self-contained file that can be opened
 * by double-click. A module script loaded from `file://` is refused by CORS, so
 * the bundle is inlined as a classic script rather than referenced.
 *
 *     node tools/build-webllm-probe.mjs
 */

import { build } from 'vite';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const outDir = at('./.webllm-probe-build');

await build({
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    target: 'chrome124',
    minify: false,
    lib: {
      entry: at('./webllm-probe.ts'),
      formats: ['iife'],
      name: 'ProofKeyWebLLMProbe',
      fileName: () => 'probe.js',
    },
  },
});

const script = (await readFile(`${outDir}/probe.js`, 'utf8')).replaceAll('</script', '<\\/script');
await rm(outDir, { recursive: true, force: true });

const html = `<!doctype html>
<html lang="es">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ProofKey · modelo en el navegador</title>
<style>
  body { font: 15px/1.45 system-ui, sans-serif; max-width: 900px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 1.3em; }
  .note { background: #fff6d6; border: 1px solid #e6cf73; padding: 10px 12px; border-radius: 6px; }
  #models label { display: block; font-family: ui-monospace, monospace; }
  button { font-size: 1em; padding: 6px 14px; margin-right: 8px; }
  pre, textarea { width: 100%; box-sizing: border-box; font: 12px/1.4 ui-monospace, monospace; }
  pre { background: #111; color: #ddd; padding: 10px; height: 320px; overflow: auto; white-space: pre-wrap; }
  textarea { height: 180px; }
</style>
<h1>ProofKey · ¿funciona un modelo dentro del navegador?</h1>
<p class="note">Esto es una <b>herramienta de medición</b>, no la extensión. Al pulsar «Empezar» descarga
WebLLM desde <code>cdn.jsdelivr.net</code>, la librería WebGPU de cada modelo desde
<code>raw.githubusercontent.com</code> y sus pesos desde <code>huggingface.co</code> (unos 1,3–2,5 GB por
modelo, se guardan en la caché del navegador). No envía ningún texto a ningún sitio: los casos de prueba se
procesan en tu GPU. Si ya mediste antes, los modelos siguen en la caché y no se vuelven a descargar.</p>
<p>Modelos a medir:</p>
<div id="models"></div>
<p>Qué medir:</p>
<label><input type="checkbox" id="do-custom" checked> Un texto tuyo — Fix grammar y revisión en vivo, 3 veces cada una, con la respuesta tal cual la devuelve el modelo:</label>
<textarea id="custom-text" style="height:3.5em">tis is a test, a i am cheking if it work</textarea>
<label><input type="checkbox" id="do-variants" checked> Cuatro variantes del prompt de Fix grammar sobre 10 textos muy mal escritos (unos 4 min con el modelo ya cargado)</label><br>
<label><input type="checkbox" id="do-live"> Revisión en vivo (14 casos) — repeticiones: <input id="runs" type="number" value="10" min="1" max="50" style="width:4em"></label><br>
<label><input type="checkbox" id="do-actions"> Acciones rápidas (9 acciones: casos con idiomas mezclados, de un idioma y de traducción) — repeticiones por caso: <input id="action-runs" type="number" value="1" min="1" max="10" style="width:4em"></label>
<p><button id="gpu">Solo comprobar WebGPU</button><button id="start">Empezar</button><button id="copy">Copiar resultado</button></p>
<pre id="log"></pre>
<p>Resultado (JSON):</p>
<textarea id="result" readonly></textarea>
<script>
${script}
</script>
</html>
`;
await writeFile(at('./webllm-probe.html'), html);
console.log(`tools/webllm-probe.html: ${Math.round(html.length / 1024)} KB`);
