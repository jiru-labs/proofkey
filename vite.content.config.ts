import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Content scripts run in the page's world and are not ES modules, so they must
 * ship as one self-contained IIFE with no import statements and no separate
 * CSS file (styles are imported with `?inline` and injected into a shadow root).
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: at('./dist'),
    emptyOutDir: false,
    target: 'chrome116',
    cssCodeSplit: false,
    lib: {
      entry: at('./src/content/index.ts'),
      formats: ['iife'],
      name: 'ProofKey',
      fileName: () => 'content.js',
    },
  },
});
