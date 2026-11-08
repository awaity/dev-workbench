import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  base: './',
  worker: { format: 'es' },
  build: {
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      input: { workbench: 'index.html', popup: 'popup.html', background: 'src/background.ts' },
      output: {
        entryFileNames: (chunk) => {
          return chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
