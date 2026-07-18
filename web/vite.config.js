import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// base '/' porque o Express serve o build na raiz (web/dist). Em dev, proxy /api, /uploads, /imagens e apostilas .md.
export default defineConfig({
  base: '/',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
      '/imagens': 'http://localhost:3000',
      '^/[^/]+\\.md$': 'http://localhost:3000',
    },
  },
})
