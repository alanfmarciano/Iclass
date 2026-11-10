// Orçamento do pacote da interface (fase 2, H2-A: DES-06). `npm run check:bundle`, na
// suíte rápida e no `npm run check`; NÃO roda no `npm run build`, para nunca impedir o
// Alan de compilar e ligar o sistema pela opção [4] do launcher.
//
// Falha (saída 1) quando:
// - o JavaScript da primeira abertura (script de entrada do index.html mais os
//   <link rel="modulepreload">) passa de 130 KB em gzip;
// - algum .js de web/dist/assets passa de 350 KB sem compressão;
// - algum arquivo de web/src faz `import * as` de 'lucide-react' (traz os ~1.500 ícones
//   para o pacote; StatCard usava assim e o pacote único chegava a 1,5 MB).
// Sem web/dist, confere só o código-fonte e avisa que o orçamento do build não foi
// conferido. O tamanho em gzip vem do .gz do build (compress-assets.mjs) ou, sem ele, de
// zlib nível 9.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

export const INITIAL_JS_GZIP_LIMIT = 130 * 1024
export const JS_RAW_LIMIT = 350 * 1024
export const NO_BUILD_MESSAGE = 'Sem build da interface: orçamento não conferido.'

const WILDCARD_LUCIDE = /(?:import|export)\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s*['"]lucide-react['"]/
const SOURCE_EXTENSIONS = /\.(?:js|jsx|mjs|ts|tsx)$/

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`
}

function walk(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full)
    return SOURCE_EXTENSIONS.test(entry.name) ? [full] : []
  })
}

// Arquivos de web/src com `import * as` (ou `export *`) de 'lucide-react'.
export function findWildcardIconImports(srcDir) {
  return walk(srcDir)
    .filter((file) => WILDCARD_LUCIDE.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(srcDir, file).replace(/\\/g, '/'))
}

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3]) : null
}

// Caminhos (relativos a web/dist) do JS que o navegador baixa na primeira abertura.
export function initialScripts(indexHtml) {
  const scripts = []
  for (const [tag] of indexHtml.matchAll(/<script\b[^>]*>/gi)) {
    const src = attribute(tag, 'src')
    if (src && /module/i.test(attribute(tag, 'type') || '')) scripts.push(src)
  }
  for (const [tag] of indexHtml.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attribute(tag, 'rel') || '').toLowerCase()
    const href = attribute(tag, 'href')
    if (href && rel.split(/\s+/).includes('modulepreload')) scripts.push(href)
  }
  return [...new Set(scripts.map((item) => item.replace(/^\.?\//, '').split(/[?#]/)[0]))]
}

function gzipSize(file) {
  const precompressed = `${file}.gz`
  if (fs.existsSync(precompressed)) return fs.statSync(precompressed).size
  return zlib.gzipSync(fs.readFileSync(file), { level: 9 }).length
}

// checkBundle({ distDir, srcDir }) → { ok, built, errors, lines }
export function checkBundle({ distDir, srcDir, initialLimit = INITIAL_JS_GZIP_LIMIT, rawLimit = JS_RAW_LIMIT }) {
  const errors = []
  const lines = []
  const wildcard = findWildcardIconImports(srcDir)
  for (const file of wildcard) {
    errors.push(`${file} importa todos os ícones (import * as de 'lucide-react'). Importe só os ícones usados pelo nome.`)
  }
  const indexPath = path.join(distDir, 'index.html')
  if (!fs.existsSync(indexPath)) {
    lines.push(NO_BUILD_MESSAGE)
    return { ok: errors.length === 0, built: false, errors, lines }
  }

  const initial = initialScripts(fs.readFileSync(indexPath, 'utf8'))
  let initialGzip = 0
  for (const relative of initial) {
    const file = path.join(distDir, relative)
    if (!fs.existsSync(file)) {
      errors.push(`O index.html aponta para ${relative}, que não está no build. Rode npm run build de novo.`)
      continue
    }
    initialGzip += gzipSize(file)
  }
  lines.push(`JavaScript da primeira abertura: ${formatKb(initialGzip)} em gzip (limite ${formatKb(initialLimit)}), ${initial.length} arquivo(s).`)
  if (initialGzip > initialLimit) {
    errors.push(`O JavaScript da primeira abertura tem ${formatKb(initialGzip)} em gzip, acima do limite de ${formatKb(initialLimit)}. Carregue a tela nova com lazyPage (web/src/lib/lazyPage.js) em vez de importá-la direto no App.jsx.`)
  }

  const assetsDir = path.join(distDir, 'assets')
  const jsFiles = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((name) => /\.m?js$/.test(name))
    : []
  let largest = null
  for (const name of jsFiles) {
    const size = fs.statSync(path.join(assetsDir, name)).size
    if (!largest || size > largest.size) largest = { name, size }
    if (size > rawLimit) {
      errors.push(`assets/${name} tem ${formatKb(size)} sem compressão, acima do limite de ${formatKb(rawLimit)} por arquivo.`)
    }
  }
  lines.push(`Arquivos .js no build: ${jsFiles.length}${largest ? `; o maior é assets/${largest.name}, com ${formatKb(largest.size)} (limite ${formatKb(rawLimit)})` : ''}.`)
  return { ok: errors.length === 0, built: true, errors, lines }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = checkBundle({ distDir: path.join(webRoot, 'dist'), srcDir: path.join(webRoot, 'src') })
  result.lines.forEach((line) => console.log(line))
  if (!result.ok) {
    console.error('\nOrçamento do pacote da interface estourado:')
    result.errors.forEach((error) => console.error(` - ${error}`))
    process.exit(1)
  }
  console.log('Orçamento do pacote da interface: dentro do limite.')
}
