// Banco de questões na tela Provas (fase 3, P3-S9a: AVA-15; desenho P3, telas.professor
// "Provas > Banco de questões"). Funções puras, sem React, para o painel do banco
// (QuestionBankPanel.jsx), a tela Provas e os testes:
// - bankItemPayload(questão do editor, { category }): o corpo do create/update do banco
//   (/api/admin/question-bank/*), com os campos do modelo único. Dificuldade, habilidades
//   e etiquetas vão sempre, vazias quando o professor apagou: no update, campo ausente
//   fica como estava, e o professor não conseguiria tirar a dificuldade.
// - bankQuery(filtros): '?categoria=...&tipo=...' (vazio sem filtro).
// - bankQuestionForExam(item): a questão do banco no editor da prova, com bankKey (é por
//   ela que o banco conta usos e acertos).
// - bankUsageText(stats) e bankAccuracyText(stats): "Usada em 3 aplicações", "63% de
//   acerto em 4 respostas".
// - mergeFacet(lista, valor): a lista de categorias ou etiquetas dos filtros com o valor
//   que o professor acabou de salvar, sem repetir por acento ou maiúscula e na ordem do
//   português (como bankFacets no servidor, pelo textSearch).
import { compareText, normalizeSearch } from '../../lib/textSearch'
import { editorQuestion, editorQuestionPayload, splitList } from './questionEditorModel'

export const BANK_DIFFICULTY_LABELS = Object.freeze({ facil: 'Fácil', media: 'Média', dificil: 'Difícil' })
export const BANK_DIFFICULTY_TONES = Object.freeze({ facil: 'success', media: 'warning', dificil: 'danger' })
export const BANK_FILTER_DIFFICULTIES = Object.freeze([
  Object.freeze({ value: '', label: 'Todas' }),
  Object.freeze({ value: 'facil', label: 'Fácil' }),
  Object.freeze({ value: 'media', label: 'Média' }),
  Object.freeze({ value: 'dificil', label: 'Difícil' }),
  Object.freeze({ value: 'sem', label: 'Sem dificuldade' }),
])
export const EMPTY_BANK_FILTERS = Object.freeze({ q: '', categoria: '', tipo: '', dificuldade: '', tag: '', arquivadas: false })
export const BANK_CATEGORY_MAX = 500

export function bankItemPayload(question, { category } = {}) {
  const payload = editorQuestionPayload(question)
  delete payload.bankKey
  payload.difficulty = question?.difficulty || ''
  payload.skills = splitList(question?.skills)
  payload.tags = splitList(question?.tags)
  payload.category = String(category || '').trim().slice(0, BANK_CATEGORY_MAX) || 'Geral'
  return payload
}

export function bankQuery(filters = {}) {
  const params = new URLSearchParams()
  ;['categoria', 'tipo', 'dificuldade', 'tag'].forEach((field) => {
    const value = String(filters[field] || '').trim()
    if (value) params.set(field, value)
  })
  const q = String(filters.q || '').trim().slice(0, 80)
  if (q) params.set('q', q)
  if (filters.arquivadas) params.set('arquivadas', '1')
  const text = params.toString()
  return text ? `?${text}` : ''
}

export function hasBankFilters(filters = {}) {
  return ['q', 'categoria', 'tipo', 'dificuldade', 'tag'].some((field) => String(filters[field] || '').trim())
}

export function mergeFacet(list, value) {
  const current = Array.isArray(list) ? list : []
  const text = String(value || '').trim()
  const key = normalizeSearch(text)
  if (!key || current.some((item) => normalizeSearch(item) === key)) return current
  return [...current, text].sort(compareText)
}

export function bankQuestionForExam(item = {}) {
  return editorQuestion({ ...item, bankKey: item.key })
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`
}

export function bankUsageText(stats) {
  const uses = Number(stats?.usos) || 0
  return uses ? `Usada em ${plural(uses, 'aplicação', 'aplicações')}` : 'Ainda não usada'
}

export function bankAccuracyText(stats) {
  const answers = Number(stats?.respostas) || 0
  const pending = Number(stats?.pendentes) || 0
  const parts = []
  if (answers && Number.isFinite(Number(stats?.acertoPct))) parts.push(`${Number(stats.acertoPct)}% de acerto em ${plural(answers, 'resposta', 'respostas')}`)
  else parts.push('Sem respostas corrigidas')
  if (pending) parts.push(`${plural(pending, 'aguardando', 'aguardando')} correção`)
  return parts.join(' · ')
}

// Texto curto do enunciado para a lista (o Markdown aparece como foi escrito).
// Começo do enunciado em texto corrido, sem as marcas do Markdown (o cartão do banco e a
// prévia da importação mostram "Qual porta o HTTP usa?", não "Qual porta o **HTTP**
// usa?"); a imagem vira "[imagem]".
export function markdownPlain(text) {
  return String(text || '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (match, alt) => (alt.trim() ? `[imagem: ${alt.trim()}]` : '[imagem]'))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?=\S))/gm, '')
}

export function bankExcerpt(text, max = 180) {
  const clean = markdownPlain(text).replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean
}

// ---------------------------------------------------------------- importar e exportar
// (fase 3, P3-S9b: AVA-15; D22). GIFT (Moodle e outro IClass) e planilha (CSV ou XLSX),
// sempre com prévia no servidor antes de gravar.
export const BANK_IMPORT_MAX_BYTES = 2 * 1024 * 1024
export const BANK_IMPORT_FORMATS = Object.freeze([
  Object.freeze({ value: 'gift', label: 'GIFT (Moodle ou outro IClass)', accept: '.txt,.gift', exportLabel: 'Baixar em GIFT' }),
  Object.freeze({ value: 'csv', label: 'Planilha (CSV ou XLSX)', accept: '.csv,.txt,.xlsx', exportLabel: 'Baixar planilha (CSV)' }),
])
export const BANK_IMPORT_PREVIEW_MAX = 50

// '/api/admin/question-bank/export?formato=gift&categoria=...': os mesmos filtros da lista.
export function bankExportPath(filters = {}, formato = 'gift') {
  const query = bankQuery(filters)
  return `/api/admin/question-bank/export?formato=${encodeURIComponent(formato)}${query ? `&${query.slice(1)}` : ''}`
}

// Quantas questões a confirmação grava: as sem erro, menos as repetidas (a não ser que o
// professor peça para importar também as repetidas).
export function importCount(preview, includeDuplicates = false) {
  if (!preview) return 0
  const valid = Number(preview.validas) || 0
  return includeDuplicates ? valid + (Number(preview.duplicadas) || 0) : valid
}

export function importConfirmLabel(count) {
  if (!count) return 'Nada para importar'
  return count === 1 ? 'Importar 1 questão' : `Importar ${count} questões`
}

// "47 questões prontas para importar, 2 já estão no banco e 3 com erro."
export function importSummaryText(preview) {
  if (!preview) return ''
  const valid = Number(preview.validas) || 0
  const duplicates = Number(preview.duplicadas) || 0
  const errors = Number(preview.comErro) || 0
  const parts = [valid === 1 ? '1 questão pronta para importar' : `${valid} questões prontas para importar`]
  if (duplicates) parts.push(duplicates === 1 ? '1 repetida (já está no banco ou mais acima no arquivo)' : `${duplicates} repetidas (já estão no banco ou mais acima no arquivo)`)
  if (errors) parts.push(errors === 1 ? '1 com erro' : `${errors} com erro`)
  const last = parts.pop()
  return `${parts.length ? `${parts.join(', ')} e ${last}` : last}.`
}

// Marca de repetida de uma questão da prévia.
export function importDuplicateText(item) {
  if (!item?.duplicada) return ''
  if (item.noArquivo) return `Repetida da linha ${item.noArquivo}`
  return item.arquivada ? 'Já está no banco (arquivada)' : 'Já está no banco'
}

// Questões da lista com imagem enviada: a imagem não vai no arquivo exportado (só o
// endereço dela no Markdown). Quem diz é o servidor: cada item do GET traz `imagens`, os
// arquivos citados no enunciado, nas alternativas, na explicação e na resposta esperada
// (referencedExamUploads, contrato C8 do desenho P3).
export function questionsWithImages(questions = []) {
  return (Array.isArray(questions) ? questions : []).filter((question) => Array.isArray(question?.imagens) && question.imagens.length > 0).length
}
