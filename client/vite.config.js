import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: clientRoot,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Lightning CSS prefixes from this target. Left at the default it emitted
    // only -webkit-backdrop-filter, which would drop the modal blur in Firefox.
    cssTarget: ['chrome100', 'edge100', 'firefox103', 'safari15.4']
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/quiz-template.json': 'http://localhost:3000'
    }
  }
});
