// Índice e busca do portal do aluno (fase 3, C16 / P5-S2; CRIT-07, D24 do P5). Tudo no
// aparelho: o índice sai do que o aluno já recebe (data.js com as apostilas liberadas,
// Biblioteca e avisos da turma); nenhuma rota nova, nada de apostila não liberada.
import { markdownToHtml } from '../../../lib/contentMarkdown'
import { matchesSearch, searchTerms } from '../../../lib/textSearch'
import { makeSnippet } from '../../../lib/searchHighlight'
import { courseUnits } from '../useCourseContent'
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

// Entradas das apostilas: uma por seção, na ordem do curso. released (opcional): só as
// unidades liberadas (o data.js já vem filtrado; isto cobre o bloqueio feito depois do
// download, até o data.js novo chegar).
export function apostilaEntries(courseData, released = null) {
  const entries = []
  courseUnits(courseData, released).forEach((unit) => {
    const text = courseData[unit.key]
    if (typeof text !== 'string') return
    if (released && released[unit.key] !== true) return
    apostilaSections(text, unit.title).forEach((section) => {
      entries.push({
        kind: 'apostila',
        id: `${unit.key}#${section.secao}`,
        unitKey: unit.key,
        unitTitle: unit.title,
        moduleTitle: unit.moduleTitle,
        secao: section.secao,
        sectionTitle: section.secao > 0 ? section.title : '',
        text: section.text,
      })
    })
  })
  return entries
}

export function libraryEntries(list) {
  return (Array.isArray(list) ? list : []).filter((item) => item && item.id).map((item) => ({
    kind: 'biblioteca',
    id: String(item.id),
    title: String(item.name || 'Material'),
    materia: String(item.materia || ''),
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    text: String(item.description || ''),
  }))
}

export function announcementEntries(list) {
  return (Array.isArray(list) ? list : []).filter((item) => item && item.id).map((item) => ({
    kind: 'aviso',
    id: String(item.id),
    title: String(item.title || 'Aviso'),
    text: String(item.message || ''),
    authorName: String(item.authorName || ''),
    createdAt: item.createdAt,
  }))
}

function entryValues(entry) {
  if (entry.kind === 'apostila') return [entry.unitTitle, entry.moduleTitle, entry.sectionTitle, entry.text]
  if (entry.kind === 'biblioteca') return [entry.title, entry.materia, entry.tags, entry.text]
  return [entry.title, entry.text]
}

function snippetSource(entry, term) {
  // Trecho do texto; achado só nas etiquetas, mostra as etiquetas.
  if (entry.kind === 'biblioteca' && !matchesAny(entry.text, term) && entry.tags.length) return entry.tags.join(', ')
  return entry.text
}

function matchesAny(text, term) {
  return searchTerms(term).some((word) => matchesSearch([text], word))
}

function toResult(entry, term) {
  const snippet = makeSnippet(snippetSource(entry, term), term)
  if (entry.kind === 'apostila') {
    return {
      ...entry,
      href: unitHref(entry.unitKey, { busca: term, secao: entry.secao }),
      title: entry.unitTitle,
      context: [entry.moduleTitle, entry.sectionTitle].filter(Boolean).join(' · '),
      snippet: snippet.parts,
    }
  }
  if (entry.kind === 'biblioteca') {
    return { ...entry, href: `/aluno/biblioteca?material=${encodeURIComponent(entry.id)}`, context: entry.materia, snippet: snippet.parts }
  }
  return { ...entry, href: `/aluno/avisos?aviso=${encodeURIComponent(entry.id)}`, context: entry.authorName, snippet: snippet.parts }
}

// Busca no índice: { apostilas, biblioteca, avisos, total, shown }. Todas as palavras do
// termo precisam aparecer (cada uma em qualquer campo da entrada), sem acento.
export function runSearch(index, term, { limit = SEARCH_RESULT_LIMIT } = {}) {
  const empty = { apostilas: [], biblioteca: [], avisos: [], total: 0, shown: 0 }
  const words = searchTerms(term)
  if (!words.length || words.join('').length < SEARCH_MIN_CHARS) return empty
  const pick = (list) => (list || []).filter((entry) => matchesSearch(entryValues(entry), term))
  const apostilas = pick(index.apostilas)
  const biblioteca = pick(index.biblioteca)
  const avisos = pick(index.avisos)
  const total = apostilas.length + biblioteca.length + avisos.length
  const sideLimit = Math.min(SIDE_GROUP_SHARE, Math.floor(limit / 3))
  const bibliotecaShown = biblioteca.slice(0, Math.max(sideLimit, limit - apostilas.length - Math.min(avisos.length, sideLimit)))
  const avisosShown = avisos.slice(0, Math.max(sideLimit, limit - apostilas.length - bibliotecaShown.length))
  const apostilasShown = apostilas.slice(0, Math.max(0, limit - bibliotecaShown.length - avisosShown.length))
  return {
    apostilas: apostilasShown.map((entry) => toResult(entry, term)),
    biblioteca: bibliotecaShown.map((entry) => toResult(entry, term)),
    avisos: avisosShown.map((entry) => toResult(entry, term)),
    total,
    shown: apostilasShown.length + bibliotecaShown.length + avisosShown.length,
  }
}
