// Onde o termo aparece num texto, para marcar o trecho (busca do aluno, fase 3, C16 /
// P5-S2; CRIT-07). A regra de "achar" é a de lib/textSearch.js (sem acento, sem
// maiúscula, todas as palavras): aqui só se descobre EM QUE PONTO do texto original cada
// palavra está, para marcar "Redes" quando o aluno digitou "redes" e "Ação" quando digitou
// "acao". O texto nunca vira HTML: a tela monta <mark> com nós de texto (highlightParts).
import { searchTerms } from './textSearch'

const DIACRITICS = /[̀-ͯ]/g
const SPACE = /\s/

// Texto dobrado (sem acento, minúsculo, espaços juntados) com o mapa de volta: a letra i
// do texto dobrado veio de original.slice(start[i], end[i]). Letra a letra, para "ç" virar
// "c" sem mudar o lugar das outras.
export function foldWithMap(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  let folded = ''
  const start = []
  const end = []
  let index = 0
  for (const ch of text) {
    const from = index
    index += ch.length
    if (SPACE.test(ch)) {
      if (folded.endsWith(' ')) { end[end.length - 1] = index; continue }
      folded += ' '
      start.push(from); end.push(index)
      continue
    }
    const out = ch.normalize('NFD').replace(DIACRITICS, '').toLowerCase()
    for (const piece of out) {
      folded += piece
      for (let k = 0; k < piece.length; k += 1) { start.push(from); end.push(index) }
    }
  }
  return { folded, start, end }
}

// Trechos [início, fim) do texto original onde aparece alguma palavra do termo, em ordem
// e sem sobrepor. limit: no máximo quantos trechos (texto grande, termo de uma letra).
export function findTermRanges(value, term, { limit = 500 } = {}) {
  const words = Array.isArray(term) ? term : searchTerms(term)
  if (!words.length) return []
  const { folded, start, end } = foldWithMap(value)
  const ranges = []
  words.forEach((word) => {
    if (!word) return
    let at = folded.indexOf(word)
    while (at !== -1 && ranges.length < limit * 2) {
      ranges.push([start[at], end[at + word.length - 1]])
      at = folded.indexOf(word, at + word.length)
    }
  })
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const merged = []
  ranges.forEach((range) => {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  })
  return merged.slice(0, limit)
}

// Partes do texto para a tela: [{ text, mark }]. Junto com <mark>{text}</mark> do React
// (nó de texto), "<img onerror>" digitado na apostila aparece como texto.
export function highlightParts(value, ranges) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const parts = []
  let cursor = 0
  ;(ranges || []).forEach(([from, to]) => {
    if (from > cursor) parts.push({ text: text.slice(cursor, from), mark: false })
    if (to > from) parts.push({ text: text.slice(from, to), mark: true })
    cursor = Math.max(cursor, to)
  })
  if (cursor < text.length) parts.push({ text: text.slice(cursor), mark: false })
  return parts.filter((part) => part.text)
}

// Trecho curto em volta da primeira palavra achada (com "…" nas pontas cortadas) e as
// partes já marcadas. Sem palavra no texto (achada só no título), o começo do texto.
export function makeSnippet(value, term, { before = 60, size = 180 } = {}) {
  const text = (typeof value === 'string' ? value : String(value ?? '')).replace(/\s+/g, ' ').trim()
  if (!text) return { parts: [], found: false }
  const ranges = findTermRanges(text, term)
  const first = ranges[0]
  let from = first ? Math.max(0, first[0] - before) : 0
  // Começa numa palavra inteira.
  if (from > 0) {
    const space = text.indexOf(' ', from)
    if (space !== -1 && space < (first ? first[0] : from + 20)) from = space + 1
  }
  let to = Math.min(text.length, from + size)
  if (first && to < first[1]) to = Math.min(text.length, first[1] + 40)
  if (to < text.length) {
    const space = text.lastIndexOf(' ', to)
    if (space > (first ? first[1] : from)) to = space
  }
  const slice = text.slice(from, to)
  const local = ranges
    .filter(([a, b]) => b > from && a < to)
    .map(([a, b]) => [Math.max(a, from) - from, Math.min(b, to) - from])
  const parts = highlightParts(slice, local)
  if (from > 0) parts.unshift({ text: '… ', mark: false })
  if (to < text.length) parts.push({ text: ' …', mark: false })
  return { parts, found: !!first }
}
