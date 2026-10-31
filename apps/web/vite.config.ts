import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: the API (npm run app:api, port 8787) is proxied under /api. Production: the API serves the built dist/ itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // changeOrigin: false keeps the browser's Host header, so the API's same-origin (CSRF) check sees localhost:5173 on both sides
  server: { port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } } },
});
