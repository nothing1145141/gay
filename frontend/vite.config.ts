import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// 开发模式：后端用 python server.py --no-auth --port 8642 单独起，
// 这里把 /api 与 /ws 代理过去；生产模式由 server.py 直接托管 dist/。
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5188,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8642', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8642', ws: true },
    },
  },
})
