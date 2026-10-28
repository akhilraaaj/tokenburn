import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// `npm run dev:api` serves the built app with the Worker on :8787.
// For hot reload, run `npm run dev -w @tokenburn/web` too: Vite proxies API and sign-in routes to the Worker.
const worker = 'http://localhost:8787';
export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: { proxy: { '/api': worker, '/login': worker, '/auth': worker } },
  build: isSsrBuild ? {} : {
    rollupOptions: {
      output: {
        // React and the router change far less often than the app; their own chunk stays cached across deploys.
        manualChunks: (id) => (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(id) ? 'react' : undefined),
      },
    },
  },
}));
