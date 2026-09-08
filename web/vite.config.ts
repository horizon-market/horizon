import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.HORIZON_API_ORIGIN ?? 'http://127.0.0.1:3001';

// The dev server proxies to the real Horizon API; the frontend has no mock data path.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': { target: api, changeOrigin: false } } },
  build: { outDir: 'dist', sourcemap: false },
});
