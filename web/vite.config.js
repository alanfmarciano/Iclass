import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const require = createRequire(import.meta.url)
const { appVersion, computeSourceHash } = require('../backend/utils/buildIntegrity.js')
// Novidades (fase 3, A1 / P6-S2): o CHANGELOG.md da raiz entra no bundle como texto, pelo
// módulo virtual:iclass-changelog (src/lib/changelog.js), e no hash do build
// (ROOT_BUILD_FILES de backend/utils/buildIntegrity.js). Um módulo virtual em vez de
// importar '../CHANGELOG.md?raw' de fora de web/: o Vite recusa ler arquivo fora da pasta
// do projeto (server.fs) no servidor de desenvolvimento e nos testes.
const CHANGELOG_FILE = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url))
const CHANGELOG_MODULE = 'virtual:iclass-changelog'

function changelogModule() {
  const resolvedId = `\0${CHANGELOG_MODULE}`
  return {
    name: 'iclass-changelog',
    resolveId(source) {
      return source === CHANGELOG_MODULE ? resolvedId : null
    },
    load(id) {
      if (id !== resolvedId) return null
      this.addWatchFile(CHANGELOG_FILE)
      return `export default ${JSON.stringify(fs.readFileSync(CHANGELOG_FILE, 'utf8'))}\n`
    },
  }
}
const { toServableAssetName } = require('../backend/utils/staticAssets.js')

// base '/' porque o Express serve o build na raiz (web/dist). Em dev, proxy /api, /uploads, /imagens e apostilas .md.
// No build, o bundle leva a própria versão (o mesmo hash que vai para build-meta.json):
// o navegador compara com o cabeçalho X-IClass-Build do servidor e recarrega sozinho
// depois de uma atualização (src/lib/buildVersion.js).
export default defineConfig(({ command }) => ({
  base: '/',
  plugins: [react(), changelogModule()],
  define: {
    __ICLASS_BUILD__: JSON.stringify(command === 'build' ? computeSourceHash() : ''),
    // Versão do IClass (package.json da raiz, fonte única; D7 do P6): a barra lateral e o
    // cartão Sobre o IClass mostram a mesma que o servidor (/api/health, src/lib/appVersion.js).
    __ICLASS_VERSION__: JSON.stringify(appVersion()),
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
