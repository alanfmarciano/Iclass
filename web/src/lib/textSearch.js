// Busca e ordem de texto do painel e do portal (fase 3, CRIT-07): uma função só, a mesma
// do servidor (backend/utils/textSearch.js). "joao" acha "João", "acao" acha "AÇÃO",
// "Ângela" fica ao lado de "ana" e "Turma 2" vem antes de "Turma 10".
//
// - normalizeSearch(valor): texto sem acento, em minúsculas e com os espaços juntados.
//   null e undefined viram '' (nunca 'null' nem 'undefined', que casavam com "und").
// - matchesSearch(valores, termo): todas as palavras do termo aparecem, cada uma em
//   qualquer um dos valores. Termo vazio casa com tudo.
// - compareText(a, b): ordem alfabética do português (Intl.Collator 'pt-BR', sem
//   diferenciar acento nem maiúscula e com os números em ordem natural).
// - compareOrdinal(a, b): ordem pelo código dos caracteres, para chaves e datas ISO
//   ('AAAA-MM-DD', '2026-11-18T10:00:00.000Z'), que não são texto para pessoa ler.
//
// Lista e tabela nova usam estas funções (contrato C1 do P5); a guarda em
// test/backend/contrato-telas.test.js recusa '.toLowerCase().includes(' e localeCompare
// sem 'pt-BR' em web/src/features.

const DIACRITICS = /[̀-ͯ]/g
const SPACES = /\s+/g

// Texto de um valor da lista: string e número como estão; lista, item por item; o resto
// (objeto, booleano, função, ausente) não tem texto para buscar.
function plainText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join(' ')
  return ''
}

export function normalizeSearch(value) {
  return plainText(value).normalize('NFD').replace(DIACRITICS, '').toLowerCase().replace(SPACES, ' ').trim()
}

// Palavras do termo já normalizadas (sem repetidas).
export function searchTerms(term) {
  const text = normalizeSearch(term)
  return text ? [...new Set(text.split(' '))] : []
}

export function matchesSearch(values, term) {
  const words = searchTerms(term)
  if (!words.length) return true
  const list = Array.isArray(values) ? values : [values]
  const haystack = list.map(normalizeSearch).filter(Boolean)
  if (!haystack.length) return false
  return words.every((word) => haystack.some((text) => text.includes(word)))
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })

export function compareText(a, b) {
  return collator.compare(plainText(a), plainText(b))
}

export function compareOrdinal(a, b) {
  const left = plainText(a)
  const right = plainText(b)
  if (left === right) return 0
  return left < right ? -1 : 1
}
