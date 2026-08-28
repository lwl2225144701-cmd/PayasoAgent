import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/runs': {
        target: 'http://localhost:4500',
        changeOrigin: true,
      },
      '/sessions': {
        target: 'http://localhost:4500',
        changeOrigin: true,
      },
      '/workspace': {
        target: 'http://localhost:4500',
        changeOrigin: true,
      },
      '/settings': {
        target: 'http://localhost:4500',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
