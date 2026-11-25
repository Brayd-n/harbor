import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // assetsInlineLimit 0: no data: URIs for fonts, so the CSP can stay at font-src 'self'.
  build: { outDir: '../dist', emptyOutDir: true, assetsInlineLimit: 0 },
  // `npm run dev` (API on :3300) + `npm run dev:web` (this, on :5173)
  server: { proxy: { '/api': 'http://localhost:3300', '/auth': 'http://localhost:3300' } },
});
