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
export function bankExcerpt(text, max = 180) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean
}
