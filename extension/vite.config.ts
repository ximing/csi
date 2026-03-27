import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { copyFileSync, cpSync } from 'node:fs';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const r = (p: string) => resolve(rootDir, p);

/**
 * MV3 needs a fixed directory layout in dist/. Vite only bundles JS/HTML/CSS,
 * so copy the static parts (manifest, icons, locales) after the build.
 */
function copyStaticAssets(): Plugin {
  return {
    name: 'csi-copy-static',
    closeBundle() {
      copyFileSync(r('manifest.json'), r('dist/manifest.json'));
      // icons/src/ 是设计源文件（per-size SVG），不进产物/上架 zip
      cpSync(r('icons'), r('dist/icons'), {
        recursive: true,
        filter: (src) => !src.includes(`${sep}src`),
      });
      cpSync(r('_locales'), r('dist/_locales'), { recursive: true });
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
        popup: r('popup.html'),
        options: r('options.html'),
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
