import { createRequire } from 'node:module'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const require = createRequire(import.meta.url)
const { computeSourceHash } = require('../backend/utils/buildIntegrity.js')
const { toServableAssetName } = require('../backend/utils/staticAssets.js')

// base '/' porque o Express serve o build na raiz (web/dist). Em dev, proxy /api, /uploads, /imagens e apostilas .md.
// No build, o bundle leva a própria versão (o mesmo hash que vai para build-meta.json):
// o navegador compara com o cabeçalho X-IClass-Build do servidor e recarrega sozinho
// depois de uma atualização (src/lib/buildVersion.js).
export default defineConfig(({ command }) => ({
  base: '/',
  plugins: [react()],
  define: {
    __ICLASS_BUILD__: JSON.stringify(command === 'build' ? computeSourceHash() : ''),
  },
  build: {
    rollupOptions: {
      output: {
        // Nomes dos arquivos do build só com o que o servidor entrega em /assets (letras
        // sem acento, números, '.', '_' e '-'; backend/utils/staticAssets.js). O padrão do
        // Rollup deixa passar acento, espaço e outros sinais, e o arquivo daria 404.
        sanitizeFileName: toServableAssetName,
        // Ícones num arquivo só (lucide-react), em vez de um pedaço em cada tela: menos
        // arquivos para o celular buscar e cache que não muda quando uma tela muda.
        manualChunks(id) {
          if (id.replace(/\\/g, '/').includes('/node_modules/lucide-react/')) return 'icons'
          return undefined
        },
      },
    },
  },
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
}))
