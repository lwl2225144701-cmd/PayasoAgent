import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // dev 模式的 API 前缀统一走这里——**新增 Host 路由域必须同步加进这个数组**，
    // 否则 Vite 会用 index.html 兜底（200 + HTML），前端表现为"接口返回解析失败"。
    proxy: Object.fromEntries(
      ['/runs', '/sessions', '/workspace', '/settings', '/runtime', '/preview', '/open-in-app'].map(
        (prefix) => [prefix, { target: 'http://localhost:4500', changeOrigin: true }],
      ),
    ),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
