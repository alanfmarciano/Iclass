import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { usePreview } from '../../hooks/usePreview'
import { useStudent } from './useStudent'

// Conteúdo do curso no portal do aluno (fase 3, C16 / P5-S2; D24 do P5): o data.js da
// turma (estrutura e apostilas JÁ LIBERADAS, filtradas pelo servidor) é baixado uma vez por
// turma e fica na memória da aba. Módulos e Busca leem daqui: abrir a busca depois do
// leitor (ou voltar para ele) não baixa as apostilas de novo.
//
// O conteúdo vale enquanto a liberação não muda: quem passa releasedItems (o /api/status
// que a tela já consulta) faz o hook comparar a assinatura da liberação (as chaves
// liberadas) com a da última vez; mudou (o professor liberou ou bloqueou uma unidade),
// baixa o data.js de novo. Na primeira vez em que a liberação chega, confere se o
// data.js guardado bate com ela (unidade liberada depois do download, ou bloqueada) e
// baixa de novo uma vez se não bater.
//
// O conteúdo guardado também envelhece: a tela que abre depois de CONTENT_MAX_AGE_MS do
// último download pede o data.js de novo, sem esconder o que já está na tela enquanto ele
// chega. Assim a correção que o professor faz no texto da apostila chega ao aluno quando
// ele volta para Módulos ou para a Busca, sem recarregar a página; se o texto veio igual,
// nada muda na tela (nem o índice da Busca é montado de novo).
//
// A memória é por aluno, prévia, curso e turma, e guarda só as do aluno que está na aba
// (no máximo MAX_ENTRIES turmas): outro aluno no mesmo aparelho não reaproveita nada.

const MAX_ENTRIES = 3
export const CONTENT_MAX_AGE_MS = 60 * 1000
const META_KEYS = new Set(['courses', 'courseStructure', 'branding'])
const cache = new Map()

export function parseDataJs(source) {
  const text = String(source || '').trim().replace(/^const\s+courseData\s*=\s*/, '').replace(/;?\s*$/, '')
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

// Estrutura do curso no data.js (curso novo em courses[0].structure; legado em courseStructure).
export function courseModules(courseData) {
  const raw = (courseData && courseData.courses && courseData.courses[0]?.structure) || courseData?.courseStructure || []
  return Array.isArray(raw) ? raw : []
}

// Unidade da estrutura no formato do leitor: chave da apostila, título e módulo.
export function unitKey(unit) {
  return unit ? (unit.apostilaKey || unit.key) : undefined
}

export function normalizeUnit(mod, unit, index) {
  return {
    key: unitKey(unit),
    examKey: unit.avaliacaoKey,
    title: unit.name || unit.title || `Unidade ${index + 1}`,
    moduleKey: mod.id || mod.key || mod.title || mod.name || 'module',
    moduleTitle: mod.title || mod.name || mod.id || 'Módulo',
  }
}

// Módulos que o leitor mostra: os da estrutura; curso sem estrutura (legado), as apostilas
// liberadas num módulo só.
export function readerModules(courseData, released) {
  const modules = courseModules(courseData)
  if (modules.length > 0) return modules
  const keys = Object.keys(released || {}).filter((key) => released[key] && key.startsWith('Apostila_'))
  if (!keys.length) return []
  return [{ id: 'released', name: 'Materiais liberados', units: keys.map((key, index) => ({ id: String(index + 1), name: key.replace(/_/g, ' '), apostilaKey: key })) }]
}

// Unidades em ordem (módulo por módulo), só as que têm apostila.
export function courseUnits(courseData, released) {
  return readerModules(courseData, released)
    .flatMap((mod) => (mod.units || mod.items || []).map((unit, index) => normalizeUnit(mod, unit, index)))
    .filter((unit) => unit.key)
}

function structureKeys(courseData) {
  const apostilas = new Set()
  const exams = new Set()
  courseModules(courseData).forEach((mod) => (mod?.units || mod?.items || []).forEach((unit) => {
    const key = unit && (unit.apostilaKey || unit.key)
    if (key) apostilas.add(key)
    if (unit && unit.avaliacaoKey) exams.add(unit.avaliacaoKey)
  }))
  return { apostilas, exams }
}

// Assinatura da liberação: as chaves liberadas, sem gabaritos e provas (que não mudam o
// data.js). null quando a liberação ainda não chegou.
export function releaseSignature(releasedItems, courseData) {
  if (!releasedItems || typeof releasedItems !== 'object') return null
  const { exams } = structureKeys(courseData)
  return Object.keys(releasedItems)
    .filter((key) => releasedItems[key] === true && !key.startsWith('Gabarito_') && !exams.has(key))
    .sort()
    .join('|')
}

// O data.js guardado bate com a liberação? Toda apostila liberada da estrutura está nele
// e nenhuma apostila dele está bloqueada.
function matchesRelease(courseData, releasedItems) {
  const { apostilas } = structureKeys(courseData)
  for (const key of apostilas) {
    const has = typeof courseData[key] === 'string'
    if (releasedItems[key] === true && !has) return false
    if (releasedItems[key] !== true && has) return false
  }
  return true
}

export function courseContentCacheKey({ email, previewToken, courseId, studentClass }) {
  return [String(email || '').toLowerCase(), previewToken || '', courseId || '', studentClass || ''].join('\u0001')
}

// Só para os testes.
export function clearCourseContentCache() {
  cache.clear()
}

function ownerOf(key) {
  return key.split('\u0001').slice(0, 2).join('\u0001')
}

function getEntry(key) {
  let entry = cache.get(key)
  if (!entry) {
    // Outro aluno (ou outra prévia) na mesma aba: o que era dele sai da memória.
    const owner = ownerOf(key)
    for (const other of [...cache.keys()]) if (ownerOf(other) !== owner) cache.delete(other)
    entry = { data: null, raw: null, loadedAt: 0, error: null, promise: null, signature: null, listeners: new Set() }
    cache.set(key, entry)
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value)
  }
  return entry
}

function notify(entry) {
  entry.listeners.forEach((listener) => listener())
}

function load(entry, url) {
  if (entry.promise) return entry.promise
  entry.error = null
  entry.promise = api.get(url, { raw: true })
    .then((text) => {
      // Igual ao guardado: mantém o mesmo objeto (a tela e o índice da Busca não refazem nada).
      if (!entry.data || text !== entry.raw) entry.data = parseDataJs(text)
      entry.raw = text
      entry.loadedAt = Date.now()
    })
    .catch((error) => { entry.error = error })
    .finally(() => { entry.promise = null; notify(entry) })
  notify(entry)
  return entry.promise
}

export function useCourseContent({ releasedItems } = {}) {
  const { email, courseId, studentClass } = useStudent()
  const preview = usePreview()
  const previewToken = preview && preview.token ? preview.token : ''
  const key = courseId ? courseContentCacheKey({ email, previewToken, courseId, studentClass }) : ''
  const url = courseId ? `/api/data.js?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}` : ''
  const [, setVersion] = useState(0)

  useEffect(() => {
    if (!key) return undefined
    const entry = getEntry(key)
    const listener = () => setVersion((value) => value + 1)
    entry.listeners.add(listener)
    // Sem conteúdo (primeira vez, ou a última tentativa falhou): baixa ao abrir a tela.
    // Conteúdo velho: baixa de novo, mostrando o guardado enquanto isso.
    if (!entry.promise && (!entry.data || Date.now() - entry.loadedAt >= CONTENT_MAX_AGE_MS)) load(entry, url)
    return () => { entry.listeners.delete(listener) }
  }, [key, url])

  const entry = key ? cache.get(key) : null
  const data = entry ? entry.data : null
  const signature = releaseSignature(releasedItems, data)

  // Liberação mudou: baixa de novo (uma vez por assinatura nova).
  useEffect(() => {
    if (!key || signature === null) return
    const current = cache.get(key)
    if (!current || !current.data || current.promise) return
    if (current.signature === null) {
      current.signature = signature
      if (!matchesRelease(current.data, releasedItems)) load(current, url)
      return
    }
    if (current.signature !== signature) {
      current.signature = signature
      load(current, url)
    }
  }, [key, url, signature, data, releasedItems])

  const reload = useCallback(() => {
    if (!key) return Promise.resolve()
    const current = getEntry(key)
    current.error = null
    return load(current, url)
  }, [key, url])

  // Apostila liberada depois do download, buscada sozinha pelo leitor (/:chave.md).
  const putUnitText = useCallback((unitKey, text) => {
    if (!key || !unitKey || typeof text !== 'string' || META_KEYS.has(unitKey)) return
    const current = getEntry(key)
    current.data = { ...(current.data || {}), [unitKey]: text }
    // O guardado já não é o texto baixado: o próximo download vale, mesmo se vier igual.
    current.raw = null
    notify(current)
  }, [key])

  return {
    data: data || {},
    loaded: !!data,
    loading: !!key && !data && !(entry && entry.error),
    refreshing: !!(entry && entry.promise),
    error: entry && !data ? entry.error : null,
    reload,
    putUnitText,
  }
}
