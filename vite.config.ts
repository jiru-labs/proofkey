import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Builds everything that is allowed to be an ES module: the MV3 service worker
 * (declared with `"type": "module"`) and the options page.
 *
 * Content scripts cannot be ES modules, so they are built separately by
 * `vite.content.config.ts` into a single IIFE bundle.
 */
export default defineConfig({
  root: at('./src'),
  publicDir: at('./public'),
  build: {
    outDir: at('./dist'),
    emptyOutDir: true,
    target: 'chrome116',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        background: at('./src/background/index.ts'),
        options: at('./src/options/index.html'),
      },
      output: {
        // The service worker path is referenced verbatim by manifest.json, so
        // it must not be hashed.
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
