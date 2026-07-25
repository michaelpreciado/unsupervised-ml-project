import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    // The tile atlas is already compressed; leave it as a file, don't inline.
    assetsInlineLimit: 4096,
  },
  worker: {
    format: 'es',
  },
});
