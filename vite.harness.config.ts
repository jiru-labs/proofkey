import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Bundles the real Lexical editor used by the test harness. Test-only — it is
 * never part of the extension, and lives beside the harness page it serves.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: at('./tools'),
    emptyOutDir: false,
    target: 'chrome116',
    lib: {
      entry: at('./tools/lexical-editor.ts'),
      formats: ['iife'],
      name: 'ProofKeyHarnessEditor',
      fileName: () => 'lexical-editor.js',
    },
  },
});
