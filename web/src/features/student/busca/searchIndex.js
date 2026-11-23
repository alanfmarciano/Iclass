// Índice e busca do portal do aluno (fase 3, C16 / P5-S2; CRIT-07, D24 do P5). Tudo no
// aparelho: o índice sai do que o aluno já recebe (data.js com as apostilas liberadas,
// Biblioteca e avisos da turma); nenhuma rota nova, nada de apostila não liberada. O
// caderno (fase 3, C17 / P5-S3) entra pela rota do caderno para levar
// (GET /api/student/notebook): só o que o próprio aluno escreveu.
import { markdownToHtml } from '../../../lib/contentMarkdown'
import { matchesSearch, normalizeSearch, searchTerms } from '../../../lib/textSearch'
import { findTermRanges, highlightParts, makeSnippet } from '../../../lib/searchHighlight'
import { courseModules, courseUnits } from '../useCourseContent'
import { htmlRoot, splitSections } from './contentText'
import { unitHref } from '../unitLinks'

// No máximo quantos resultados a tela mostra (celular antigo, termo de uma letra).
export const SEARCH_RESULT_LIMIT = 50
// Biblioteca e avisos ficam com uma parte garantida dos 50, para não sumirem atrás das apostilas.
const SIDE_GROUP_SHARE = 10
export const SEARCH_MIN_CHARS = 2

// Seções de uma apostila (Markdown) como o leitor mostra.
export function apostilaSections(markdown, unitTitle = '') {
  return splitSections(htmlRoot(markdownToHtml(markdown || '')), { firstTitle: unitTitle })
}

// Unidades que o índice cobre: as da estrutura; curso sem estrutura (legado), as apostilas
// que vieram no data.js (o servidor já filtrou pela liberação). Não depende da liberação
// de agora: ela é aplicada na hora de buscar (runSearch, opção released), para que o índice
// valha enquanto o data.js for o mesmo.
function indexUnits(courseData) {
  if (courseModules(courseData).length > 0) return courseUnits(courseData, null)
  const present = {}
  Object.keys(courseData || {}).forEach((key) => {
    if (key.startsWith('Apostila_') && typeof courseData[key] === 'string') present[key] = true
  })
  return courseUnits(courseData, present)
}

// Entradas de uma unidade: uma por seção, com o texto já normalizado (hay: título e texto
// da seção; titleHay: títulos da unidade e do módulo) para a busca não normalizar de novo
// centenas de KB a cada termo.
function unitEntries(courseData, unit, unitIndex) {
  const text = courseData[unit.key]
  if (typeof text !== 'string') return []
  const titleHay = normalizeSearch([unit.title, unit.moduleTitle])
  return apostilaSections(text, unit.title).map((section) => {
    const sectionTitle = section.secao > 0 ? section.title : ''
    return {
      kind: 'apostila',
      id: `${unit.key}#${section.secao}`,
      unitKey: unit.key,
      unitIndex,
      unitTitle: unit.title,
      moduleTitle: unit.moduleTitle,
      secao: section.secao,
      sectionTitle,
      text: section.text,
      hay: normalizeSearch([sectionTitle, section.text]),
      titleHay,
    }
  })
}

// Entradas das apostilas: uma por seção, na ordem do curso (de uma vez só; a tela usa
// buildApostilaIndex, que monta aos poucos e guarda). released (opcional): só as unidades
// liberadas.
export function apostilaEntries(courseData, released = null) {
  const entries = []
  indexUnits(courseData).forEach((unit, unitIndex) => {
    if (released && released[unit.key] !== true) return
    entries.push(...unitEntries(courseData, unit, unitIndex))
  })
  return entries
}

// Índice guardado por data.js (o objeto que useCourseContent guarda para a turma): abrir a
// Busca de novo, apagar o termo e digitar outro não monta nada outra vez. O data.js novo
// (liberação mudou, apostila corrigida) é outro objeto e ganha índice novo.
const builtIndexes = new WeakMap()
// Tempo máximo de cada pedaço da montagem: entre um pedaço e outro a página responde
// (celular antigo com centenas de KB de apostila não trava enquanto o aluno digita).
export const INDEX_SLICE_MS = 12

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
}

export function peekApostilaIndex(courseData) {
  const built = courseData && typeof courseData === 'object' ? builtIndexes.get(courseData) : null
  return built && built.entries ? built.entries : null
}

// Monta o índice das apostilas aos poucos (uma unidade depois da outra, pedaços de até
// INDEX_SLICE_MS) e guarda. Devolve uma promessa com as entradas; chamadas repetidas para
// o mesmo data.js recebem a mesma promessa.
export function buildApostilaIndex(courseData, { sliceMs = INDEX_SLICE_MS } = {}) {
  if (!courseData || typeof courseData !== 'object') return Promise.resolve([])
  const existing = builtIndexes.get(courseData)
  if (existing) return existing.promise
  const record = { entries: null, promise: null }
  record.promise = new Promise((resolve) => {
    const units = indexUnits(courseData)
    const entries = []
    let next = 0
    const step = () => {
      const started = now()
      while (next < units.length) {
        const unitIndex = next
        next += 1
        try {
          entries.push(...unitEntries(courseData, units[unitIndex], unitIndex))
        } catch {
          // Apostila que não se deixa ler fica fora da busca; o resto continua.
        }
        if (now() - started >= sliceMs) break
      }
      if (next < units.length) { setTimeout(step, 0); return }
      record.entries = entries
      resolve(entries)
    }
    setTimeout(step, 0)
  })
  builtIndexes.set(courseData, record)
  return record.promise
}

export function libraryEntries(list) {
  return (Array.isArray(list) ? list : []).filter((item) => item && item.id).map((item) => {
    const entry = {
      kind: 'biblioteca',
      id: String(item.id),
      title: String(item.name || 'Material'),
      materia: String(item.materia || ''),
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      text: String(item.description || ''),
    }
    entry.hay = normalizeSearch([entry.title, entry.materia, entry.tags, entry.text])
    return entry
  })
}

export function announcementEntries(list) {
  return (Array.isArray(list) ? list : []).filter((item) => item && item.id).map((item) => {
    const entry = {
      kind: 'aviso',
      id: String(item.id),
      title: String(item.title || 'Aviso'),
      text: String(item.message || ''),
      authorName: String(item.authorName || ''),
      createdAt: item.createdAt,
    }
    entry.hay = normalizeSearch([entry.title, entry.text])
    return entry
  })
}

// Entradas do caderno: a nota geral e, por unidade, a nota e as anotações de parágrafo do
// aluno. Só o texto que ele escreveu entra na busca (o trecho destacado é texto da
// apostila, que já sai nos resultados das apostilas).
export function notebookEntries(notebook) {
  const data = notebook && typeof notebook === 'object' ? notebook : {}
  const entries = []
  const push = (entry, parts) => {
    const text = parts.map((part) => String(part ?? '').trim()).filter(Boolean).join('\n')
    if (!text) return
    entries.push({ ...entry, kind: 'caderno', text, hay: normalizeSearch([text]) })
  }
  push({ id: 'geral', title: 'Anotações gerais', context: '', unitKey: '' }, [data.geral])
  ;(Array.isArray(data.unidades) ? data.unidades : []).forEach((unit) => {
    if (!unit || !unit.chave) return
    push({ id: String(unit.chave), title: String(unit.titulo || unit.chave), context: String(unit.modulo || ''), unitKey: String(unit.chave) },
      [unit.nota, ...(Array.isArray(unit.destaques) ? unit.destaques.map((item) => item && item.nota) : [])])
  })
  if (data.anteriores) {
    push({ id: 'anteriores', title: 'Anotações anteriores', context: '', unitKey: '' },
      [data.anteriores.nota, ...(Array.isArray(data.anteriores.destaques) ? data.anteriores.destaques.map((item) => item && item.nota) : [])])
  }
  return entries
}

function snippetSource(entry, term) {
  // Trecho do texto; achado só nas etiquetas, mostra as etiquetas.
  if (entry.kind === 'biblioteca' && !matchesAny(entry.text, term) && entry.tags.length) return entry.tags.join(', ')
  return entry.text
}

function matchesAny(text, term) {
  return searchTerms(term).some((word) => matchesSearch([text], word))
}

// Título e linha de contexto com a palavra marcada também (achada no nome da unidade, do
// módulo ou da parte da apostila, o trecho do texto pode não ter a palavra).
function marked(text, term) {
  return highlightParts(text, findTermRanges(text, term))
}

function withMarks(result, term) {
  return { ...result, titleParts: marked(result.title, term), contextParts: marked(result.context || '', term) }
}

function toResult(entry, term) {
  const snippet = makeSnippet(snippetSource(entry, term), term)
  if (entry.kind === 'apostila') {
    return withMarks({
      ...entry,
      // Achada só pelo título da unidade ou do módulo: abre a unidade do começo.
      href: unitHref(entry.unitKey, { busca: term, secao: entry.titleOnly ? 0 : entry.secao }),
      title: entry.unitTitle,
      context: [entry.moduleTitle, entry.titleOnly ? '' : entry.sectionTitle].filter(Boolean).join(' · '),
      snippet: snippet.parts,
    }, term)
  }
  if (entry.kind === 'biblioteca') {
    return withMarks({ ...entry, href: `/aluno/biblioteca?material=${encodeURIComponent(entry.id)}`, context: entry.materia, snippet: snippet.parts }, term)
  }
  if (entry.kind === 'caderno') {
    // Só o texto do aluno entra na busca: o título e o módulo não são marcados. A nota de
    // unidade liberada abre a unidade (o caderno dela fica ao lado da apostila); a geral,
    // a de unidade bloqueada e a anterior abrem o Caderno.
    const href = entry.unitKey && entry.released ? unitHref(entry.unitKey) : '/aluno/caderno'
    return { ...entry, href, snippet: snippet.parts, titleParts: null, contextParts: null }
  }
  // O autor do aviso não entra na busca: não marca o nome dele.
  return { ...withMarks({ ...entry, href: `/aluno/avisos?aviso=${encodeURIComponent(entry.id)}`, context: entry.authorName, snippet: snippet.parts }, term), contextParts: null }
}

function hayOf(entry) {
  if (typeof entry.hay === 'string') return entry.hay
  // Entrada montada fora daqui (testes): normaliza na hora.
  return normalizeSearch(entry.kind === 'biblioteca' ? [entry.title, entry.materia, entry.tags, entry.text] : [entry.title, entry.text])
}

// Apostilas que casam, da mais certeira para a menos:
// 1. seções com todas as palavras no título ou no texto da própria seção;
// 2. seções com parte das palavras no texto e o resto no título da unidade ou do módulo;
// 3. unidades achadas só pelo título (dela ou do módulo): UM resultado por unidade, e só
//    quando nenhuma seção dela entrou acima. Antes, cada seção de uma unidade com a palavra
//    no título virava um resultado sem a palavra no trecho e empurrava para fora dos 50 as
//    seções que falam do assunto.
// Dentro de cada grupo, na ordem do curso. released (opcional): só as unidades liberadas.
function pickApostilas(entries, words, released) {
  const full = []
  const partial = []
  const byTitle = new Map()
  const represented = new Set()
  ;(entries || []).forEach((entry) => {
    if (released && released[entry.unitKey] !== true) return
    const hay = typeof entry.hay === 'string' ? entry.hay : normalizeSearch([entry.sectionTitle, entry.text])
    const titleHay = typeof entry.titleHay === 'string' ? entry.titleHay : normalizeSearch([entry.unitTitle, entry.moduleTitle])
    let inSection = 0
    for (const word of words) {
      if (hay.includes(word)) inSection += 1
      else if (!titleHay.includes(word)) return
    }
    if (inSection === words.length) { full.push(entry); represented.add(entry.unitKey) }
    else if (inSection > 0) { partial.push(entry); represented.add(entry.unitKey) }
    else if (!byTitle.has(entry.unitKey)) byTitle.set(entry.unitKey, { ...entry, titleOnly: true })
  })
  const titleOnly = [...byTitle.values()].filter((entry) => !represented.has(entry.unitKey))
  return [...full, ...partial, ...titleOnly]
}

// Busca no índice: { apostilas, biblioteca, avisos, caderno, total, shown }. Todas as palavras do
// termo precisam aparecer (cada uma em qualquer campo da entrada), sem acento. released
// (opcional): liberação de agora; unidade bloqueada depois do download do data.js some na
// hora, sem esperar o data.js novo.
export function runSearch(index, term, { limit = SEARCH_RESULT_LIMIT, released = null } = {}) {
  const empty = { apostilas: [], biblioteca: [], avisos: [], caderno: [], total: 0, shown: 0 }
  const words = searchTerms(term)
  if (!words.length || words.join('').length < SEARCH_MIN_CHARS) return empty
  const pick = (list) => (list || []).filter((entry) => {
    const hay = hayOf(entry)
    return words.every((word) => hay.includes(word))
  })
  const apostilas = pickApostilas(index.apostilas, words, released)
  const biblioteca = pick(index.biblioteca)
  const avisos = pick(index.avisos)
  const caderno = pick(index.caderno)
  const total = apostilas.length + biblioteca.length + avisos.length + caderno.length
  const sideLimit = Math.min(SIDE_GROUP_SHARE, Math.floor(limit / 3))
  const cadernoReserve = Math.min(caderno.length, sideLimit)
  const bibliotecaShown = biblioteca.slice(0, Math.max(sideLimit, limit - apostilas.length - Math.min(avisos.length, sideLimit) - cadernoReserve))
  const avisosShown = avisos.slice(0, Math.max(sideLimit, limit - apostilas.length - bibliotecaShown.length - cadernoReserve))
  const cadernoShown = caderno.slice(0, Math.max(sideLimit, limit - apostilas.length - bibliotecaShown.length - avisosShown.length))
  const apostilasShown = apostilas.slice(0, Math.max(0, limit - bibliotecaShown.length - avisosShown.length - cadernoShown.length))
  return {
    apostilas: apostilasShown.map((entry) => toResult(entry, term)),
    biblioteca: bibliotecaShown.map((entry) => toResult(entry, term)),
    avisos: avisosShown.map((entry) => toResult(entry, term)),
    caderno: cadernoShown.map((entry) => toResult({ ...entry, released: !released || released[entry.unitKey] === true }, term)),
    total,
    shown: apostilasShown.length + bibliotecaShown.length + avisosShown.length + cadernoShown.length,
  }
}
