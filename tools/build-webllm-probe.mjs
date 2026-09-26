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
modelo, se guardan en la caché del navegador). No envía ningún texto a ningún sitio: los 14 casos de prueba
se corrigen en tu GPU.</p>
<p>Modelos a medir:</p>
<div id="models"></div>
<p>Repeticiones por modelo: <input id="runs" type="number" value="10" min="1" max="50" style="width:4em"></p>
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
