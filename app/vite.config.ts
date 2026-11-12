import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// The server only answers callers that present this per-install token (the built app gets it as a cookie).
function token(): string { try { return readFileSync(new URL('../workspace/.config/session-token', import.meta.url), 'utf-8').trim(); } catch { return ''; } }
const auth = { configure: (proxy: any) => { proxy.on('proxyReq', (req: any) => { const t = token(); if (t) req.setHeader('X-Fibb-Token', t); }); } };

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3847', changeOrigin: true, ...auth },
      '/socket.io': { target: 'http://localhost:3847', ws: true, ...auth },
    },
  },
});
