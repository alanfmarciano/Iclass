// Ajuda dentro do app (fase 3, A1 / P6-S2 e S9: OPS-13, UXI-04; D20 do P6).
//
// O conteúdo é Markdown em web/src/features/help/conteudo/, só estes cinco arquivos
// (shared_contracts.regras_gerais da fase 3; ninguém cria outro), mais as Novidades, que
// vêm do CHANGELOG.md da raiz. Cada um é um pedaço próprio do build, carregado sob demanda
// (import ?raw): funciona sem internet e sem rota no servidor, e só quem abre a Ajuda
// baixa o texto.
//
// Formato de cada arquivo: "# Título" uma vez, um texto de abertura e os temas como
// "## Título do tema {#ancora}". A âncora é estável (o HelpLink das telas aponta para ela e
// o npm run test:docs confere que existe); "###" e o resto ficam dentro do tema. Tema sem
// texto (só o título, ou só comentários <!-- -->) não aparece na tela: é o lugar guardado
// para o grupo que ainda vai escrever.
import { loadChangelog } from '../../lib/changelog'
import { normalizeSearch } from '../../lib/textSearch'

export const HELP_DOCS = Object.freeze([
  { id: 'instrutor', titulo: 'Para o professor', load: () => import('./conteudo/instrutor.md?raw') },
  { id: 'aluno', titulo: 'Para o aluno', load: () => import('./conteudo/aluno.md?raw') },
  { id: 'instalacao-e-rede', titulo: 'Instalação e rede', load: () => import('./conteudo/instalacao-e-rede.md?raw') },
  { id: 'perguntas-frequentes', titulo: 'Perguntas frequentes', load: () => import('./conteudo/perguntas-frequentes.md?raw') },
  { id: 'problemas', titulo: 'Quando algo dá errado', load: () => import('./conteudo/problemas.md?raw') },
  { id: 'novidades', titulo: 'Novidades', load: () => loadChangelog().then((text) => ({ default: text })) },
])

export const DEFAULT_HELP_DOC = 'instrutor'

export function findHelpDoc(id) {
  return HELP_DOCS.find((doc) => doc.id === id) || null
}

const HEADING_ANCHOR = /\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/i
const FENCE = /^\s*(```|~~~)/

// Âncora a partir do título, para tema sem {#ancora} (as versões do CHANGELOG): sem acento,
// minúsculas, letras e números separados por hífen ("Não publicado" -> "nao-publicado").
export function slugify(text) {
  return normalizeSearch(text).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'secao'
}

// Tira os comentários HTML (<!-- -->), que são recados para quem escreve.
export function stripComments(markdown) {
  return String(markdown || '').replace(/<!--[\s\S]*?-->/g, '')
}

function finishBody(lines) {
  return stripComments(lines.join('\n')).replace(/\n{3,}/g, '\n\n').trim()
}

// { titulo, intro, secoes: [{ id, titulo, corpo }] }, na ordem do arquivo. Título "##" dentro
// de bloco de código não abre tema. Âncora repetida ganha sufixo (-2, -3), para nenhum id
// repetir na página.
export function parseHelpDocument(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n')
  let titulo = ''
  const intro = []
  const secoes = []
  const used = new Map()
  let current = null
  let inFence = false
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence
    if (!inFence && !titulo && !current && /^#\s+\S/.test(line)) {
      titulo = line.replace(/^#\s+/, '').trim()
      continue
    }
    if (!inFence && /^##\s+\S/.test(line)) {
      if (current) secoes.push({ ...current, corpo: finishBody(current.lines) })
      const raw = line.replace(/^##\s+/, '')
      const match = HEADING_ANCHOR.exec(raw)
      const text = (match ? raw.slice(0, match.index) : raw).trim()
      let id = match ? match[1].toLowerCase() : slugify(text)
      const count = used.get(id) || 0
      used.set(id, count + 1)
      if (count) id = `${id}-${count + 1}`
      current = { id, titulo: text, lines: [] }
      continue
    }
    if (current) current.lines.push(line)
    else intro.push(line)
  }
  if (current) secoes.push({ ...current, corpo: finishBody(current.lines) })
  return {
    titulo,
    intro: finishBody(intro),
    secoes: secoes.map(({ id, titulo: sectionTitle, corpo }) => ({ id, titulo: sectionTitle, corpo })),
  }
}

// Âncora pedida na URL (#tema). Hash malformado (%E0%A4%A, digitado ou cortado numa
// mensagem) não derruba a tela: vira "sem âncora".
export function anchorFromHash(hash) {
  const raw = String(hash || '').replace(/^#/, '')
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return ''
  }
}

// Só os temas com texto (os outros esperam o grupo dono).
export function visibleSections(doc) {
  return (doc?.secoes || []).filter((section) => section.corpo)
}

// Cache dos textos já baixados (o mesmo arquivo não é buscado duas vezes na mesma visita).
const cache = new Map()

export function loadHelpDoc(id) {
  const entry = findHelpDoc(id)
  if (!entry) return Promise.reject(new Error('Este assunto da ajuda não existe.'))
  if (!cache.has(id)) {
    const promise = entry.load()
      .then((module) => parseHelpDocument(typeof module === 'string' ? module : module?.default))
      .catch((error) => { cache.delete(id); throw error })
    cache.set(id, promise)
  }
  return cache.get(id)
}

export function clearHelpCacheForTests() {
  cache.clear()
}
