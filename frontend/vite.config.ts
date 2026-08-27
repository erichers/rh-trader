import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' so the built assets load whether served from / (backend) or
// /rh.tradingbot/ (MAMP Apache proxy) or inside the Tauri app.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8011',
      '/ws': { target: 'ws://127.0.0.1:8011', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
