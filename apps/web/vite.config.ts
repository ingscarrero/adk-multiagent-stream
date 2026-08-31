/**
 * Vite config.
 *
 * The dev server proxies `/api` to the Node server so the browser sees a single
 * origin. That matters more than usual here: `EventSource` cannot send custom
 * headers and cross-origin SSE brings CORS preflight and cookie rules into a
 * long-lived connection. A same-origin proxy sidesteps all of it in dev, and
 * production is expected to serve both behind one origin for the same reason.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env['API_TARGET'] ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // Buffering would defeat the entire point of a token stream.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              delete proxyRes.headers['content-length'];
            }
          });
        },
      },
    },
  },
  preview: { port: 4173 },
  build: { sourcemap: true },
});
