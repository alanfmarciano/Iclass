// Pré-compressão do build (fase 2, H2-A: DES-05). Roda no `npm run build`, logo depois do
// `vite build`: para cada arquivo de texto de web/dist/assets com pelo menos 1 KB, grava
// <arquivo>.gz (gzip nível 9) e <arquivo>.br (brotli qualidade 11). O servidor manda a
// versão comprimida que o navegador aceita (backend/utils/staticAssets.js), sem
// comprimir nada a cada pedido. Na rede da sala, em http, o navegador só aceita gzip; o
// .br passa a valer sozinho com o HTTPS.
//
// Só fs, path e zlib do Node: nenhum pacote novo. Pula a variante que não ficar abaixo de
// 95% do original (não vale o trabalho do navegador). Apaga .gz/.br que sobraram sem o
// arquivo original (o Vite esvazia a pasta, mas um build interrompido pode deixar sobras).
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

export const COMPRESSIBLE_EXTENSIONS = ['.js', '.mjs', '.css', '.svg', '.json', '.html', '.txt']
export const MIN_BYTES = 1024
export const MAX_RATIO = 0.95

function compressGzip(buffer) {
  return zlib.gzipSync(buffer, { level: 9 })
}

function compressBrotli(buffer) {
  return zlib.brotliCompressSync(buffer, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    },
  })
}

// compressAssets(assetsDir) → { files, written, skipped, removed, originalBytes, gzipBytes }
export function compressAssets(assetsDir) {
  const summary = { files: 0, written: 0, skipped: 0, removed: 0, originalBytes: 0, gzipBytes: 0 }
  if (!fs.existsSync(assetsDir)) return summary
  const names = fs.readdirSync(assetsDir)
  const present = new Set(names)
  for (const name of names) {
    const full = path.join(assetsDir, name)
    if (/\.(gz|br)$/i.test(name)) {
      // Sobra de um build anterior sem o original ao lado.
      if (!present.has(name.replace(/\.(gz|br)$/i, ''))) {
        fs.rmSync(full, { force: true })
        summary.removed += 1
      }
      continue
    }
    const stat = fs.statSync(full)
    if (!stat.isFile()) continue
    if (!COMPRESSIBLE_EXTENSIONS.includes(path.extname(name).toLowerCase())) continue
    if (stat.size < MIN_BYTES) continue
    const original = fs.readFileSync(full)
    summary.files += 1
    summary.originalBytes += original.length
    for (const [suffix, compress] of [['.gz', compressGzip], ['.br', compressBrotli]]) {
      const target = full + suffix
      const compressed = compress(original)
      if (compressed.length >= original.length * MAX_RATIO) {
        fs.rmSync(target, { force: true })
        summary.skipped += 1
        continue
      }
      fs.writeFileSync(target, compressed)
      // Mesma data do original: o ETag e o Last-Modified acompanham o arquivo do build.
      fs.utimesSync(target, stat.atime, stat.mtime)
      summary.written += 1
      if (suffix === '.gz') summary.gzipBytes += compressed.length
    }
  }
  return summary
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const assetsDir = path.join(webRoot, 'dist', 'assets')
  const started = Date.now()
  const summary = compressAssets(assetsDir)
  console.log(`Pré-compressão: ${summary.files} arquivo(s), ${summary.written} versão(ões) .gz/.br gravada(s), ${formatKb(summary.originalBytes)} → ${formatKb(summary.gzipBytes)} em gzip (${((Date.now() - started) / 1000).toFixed(1).replace('.', ',')} s).`)
}
