import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { copyFileSync, cpSync } from 'node:fs';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const r = (p: string) => resolve(rootDir, p);

/**
 * MV3 needs a fixed directory layout in dist/. Vite only bundles JS,
 * so copy the static parts (manifest, icons) after the build.
 */
function copyStaticAssets(): Plugin {
  return {
    name: 'cdp-bridge-copy-static',
    closeBundle() {
      copyFileSync(r('manifest.json'), r('dist/manifest.json'));
      cpSync(r('icons'), r('dist/icons'), { recursive: true });
    },
  };
}

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: r('src/background/index.ts'),
      },
      output: {
        // manifest.json references background.js by fixed name — no hashes.
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [copyStaticAssets()],
});
