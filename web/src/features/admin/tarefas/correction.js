// Entregas e correção de uma tarefa no painel (fase 3, C8 / P1-f; FUN-01, D7, D9 e D10 do
// P1). Funções puras, sem React: a lista da turma (TarefaDetalhePage), o painel de
// correção (CorrecaoPanel) e a prévia dos arquivos (FilePreview) usam as mesmas regras e
// frases. As contas e os corpos das rotas ficam em correctionRules.js (os testes do
// servidor carregam esse arquivo e mandam os corpos às rotas) e são reexportados aqui.
//
// - A situação de cada aluno vem pronta do servidor (status de GET
//   /api/admin/assignments/:id, assignments.instructorStatus): a tela só filtra e escreve.
// - Horários sempre no relógio da escola: o servidor manda o fuso (timezone) junto com os
//   instantes, e a conta usa Intl com esse fuso, nunca o do navegador.
// - Nota: o professor digita de 0 a 10 com vírgula; o servidor converte e calcula o
//   desconto (gradeWithPenalty). A "nota final" mostrada antes de salvar é só a prévia,
//   pela mesma conta de assignments.finalScoreFor (o teste do servidor compara as duas);
//   depois de salvar vale a que voltou do servidor.
import { fmtGrade, parseGradeInput, scoreFromGrade } from '../../../lib/grades'
import { studentLabel } from './assignmentText'
import { CORRECTION_LIMITS, extensionBody, finalScorePreview, gradeBody, lateDaysStarted, manualEntryBody, redoBody } from './correctionRules'

// As contas e os corpos das rotas ficam em correctionRules.js (sem import: os testes do
// servidor carregam no Node); as telas importam tudo daqui.
export { CORRECTION_LIMITS, extensionBody, finalScorePreview, gradeBody, lateDaysStarted, manualEntryBody, redoBody }

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

// ------------------------------------------------------------ aluno
// Como o aluno aparece na lista e no painel: { title, name, detail } com o nome, a
// matrícula e o e-mail ('sem e-mail' no aluno sem e-mail: nunca o endereço interno).
export function rowDisplay(row) {
  const label = studentLabel(row)
  const detail = [label.matricula ? `matrícula ${label.matricula}` : '', label.name === label.email ? '' : label.email].filter(Boolean).join(' · ')
  return { title: label.title, name: label.name, detail }
}

// Posição do aluno na fila do painel (a lista filtrada quando o painel abriu):
// { index, total, previous, next } com as chaves (studentEmail) vizinhas ou null.
export function queuePosition(queue, key) {
  const list = Array.isArray(queue) ? queue : []
  const index = list.indexOf(key)
  if (index < 0) return { index: -1, total: list.length, previous: null, next: null }
  return { index, total: list.length, previous: index > 0 ? list[index - 1] : null, next: index < list.length - 1 ? list[index + 1] : null }
}

// ------------------------------------------------------------ situação e filtros
export const INSTRUCTOR_STATUS = Object.freeze({
  nao_entregue: { label: 'Sem envio', tone: 'neutral' },
  para_corrigir: { label: 'Para corrigir', tone: 'warning' },
  corrigida: { label: 'Corrigida, sem devolver', tone: 'info' },
  refazer: { label: 'Refazer (esperando o aluno)', tone: 'warning' },
  devolvida: { label: 'Devolvida', tone: 'success' },
})

export function rowStatusInfo(row) {
  const status = row?.status
  if (status === 'para_corrigir' && !row?.versions && row?.manualEntry) return { label: 'Entregue em mãos, sem nota', tone: 'warning' }
  return INSTRUCTOR_STATUS[status] || INSTRUCTOR_STATUS.nao_entregue
}

export const ROSTER_FILTERS = Object.freeze([
  { id: 'todos', label: 'Todos' },
  { id: 'para-corrigir', label: 'Para corrigir' },
  { id: 'corrigidas', label: 'Corrigidas, sem devolver' },
  { id: 'atrasadas', label: 'Atrasadas' },
  { id: 'sem-envio', label: 'Sem envio' },
  { id: 'devolvidas', label: 'Devolvidas' },
])
export const ROSTER_FILTER_IDS = ROSTER_FILTERS.map((item) => item.id)

// Mesmas definições das contagens do servidor (assignmentStatusSummary): atrasada é a
// entrega cuja última versão chegou depois do prazo; sem envio, nem versão nem entrega em
// mãos.
export function rowMatches(row, filter) {
  if (filter === 'para-corrigir') return row?.status === 'para_corrigir'
  if (filter === 'corrigidas') return row?.status === 'corrigida'
  if (filter === 'atrasadas') return !!row?.lastVersion?.late
  if (filter === 'sem-envio') return !row?.lastVersion && !row?.manualEntry
  if (filter === 'devolvidas') return row?.status === 'devolvida'
  return true
}

export function filterCounts(rows) {
  const list = Array.isArray(rows) ? rows : []
  return Object.fromEntries(ROSTER_FILTER_IDS.map((id) => [id, list.filter((row) => rowMatches(row, id)).length]))
}

// Entra no "Devolver todas as corrigidas" (a mesma regra de assignments.isReturnable):
// correção salva com nota e sem versão nova esperando.
export function isReturnableRow(row) {
  return row?.status === 'corrigida' && !!row?.grade && row.grade.finalScore !== null && row.grade.finalScore !== undefined
}

// ------------------------------------------------------------ horários
function parts(ms, timezone) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  let format
  try {
    format = new Intl.DateTimeFormat('en-CA', timezone ? { ...options, timeZone: timezone } : options)
  } catch {
    format = new Intl.DateTimeFormat('en-CA', options)
  }
  const out = {}
  format.formatToParts(new Date(ms)).forEach((part) => { out[part.type] = part.value })
  const hour = out.hour === '24' ? '00' : out.hour
  return { date: `${out.year}-${out.month}-${out.day}`, time: `${hour}:${out.minute}`, year: out.year, month: out.month, day: out.day }
}

// { date: 'AAAA-MM-DD', time: 'HH:MM' } do instante no fuso da escola (campos do
// formulário de prorrogação e de "refazer"); null sem instante.
export function localPartsInZone(ms, timezone) {
  const p = parts(ms, timezone)
  return p ? { date: p.date, time: p.time } : null
}

// '20/11/2026 às 14:32' no fuso da escola ('' sem instante).
export function schoolDateTime(ms, timezone) {
  const p = parts(ms, timezone)
  return p ? `${p.day}/${p.month}/${p.year} às ${p.time}` : ''
}

function plural(amount, one, many) {
  return `${amount} ${amount === 1 ? one : many}`
}

// Quanto tempo de atraso, por extenso: '5 minutos', '3 horas', '2 dias' ('' sem atraso).
// Com um dia ou mais, conta o dia iniciado (como o desconto).
export function lateAmountText(lateMs) {
  const late = Math.max(0, Number(lateMs) || 0)
  if (late <= 0) return ''
  if (late < HOUR_MS) return plural(Math.max(1, Math.ceil(late / MINUTE_MS)), 'minuto', 'minutos')
  if (late < DAY_MS) return plural(Math.ceil(late / HOUR_MS), 'hora', 'horas')
  return plural(lateDaysStarted(late), 'dia', 'dias')
}

// 'Atrasada 2 dias' ('' sem atraso).
export function lateText(lateMs) {
  const amount = lateAmountText(lateMs)
  return amount ? `Atrasada ${amount}` : ''
}

// ------------------------------------------------------------ nota e desconto
// Texto da nota gravada para o campo ('8,5'; '' sem nota).
export function gradeInputText(grade) {
  if (!grade || grade.score === null || grade.score === undefined) return ''
  return fmtGrade(grade.score, '')
}

// Nota digitada -> { score (0 a 100) | null, empty, error }.
export function readGradeText(text) {
  const parsed = parseGradeInput(text)
  if (parsed === null) return { score: null, empty: true, error: '' }
  if (Number.isNaN(parsed)) return { score: null, empty: false, error: 'Digite a nota de 0 a 10 (até duas casas, com vírgula ou ponto).' }
  return { score: scoreFromGrade(parsed), empty: false, error: '' }
}

// Linha do desconto debaixo da nota, para a versão escolhida:
// 'Atraso de 2 dias: -20%, nota final 6,4'. Sem atraso ou sem desconto, uma frase curta
// (ou '' quando não há nada a dizer).
export function penaltyLine({ version, latePolicy, waived = false, score = null }) {
  if (!version || !version.late) return ''
  const amount = lateAmountText(version.lateMs)
  const pct = Number(version.penaltyPct) || 0
  if (latePolicy?.mode !== 'desconto' || pct <= 0) return `Enviada com atraso de ${amount}. A regra desta tarefa não desconta da nota.`
  if (waived) return `Atraso de ${amount}: desconto de ${pct}% dispensado.`
  const final = finalScorePreview(score, pct)
  return `Atraso de ${amount}: -${pct}%${final === null ? '' : `, nota final ${fmtGrade(final)}`}.`
}

// ------------------------------------------------------------ arquivos e links
export function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0).replace('.', ',')} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1).replace('.', ',')} GB`
}

// Link do aluno: só http(s) vira botão "Abrir" (o resto aparece só como texto).
export function safeExternalLink(link) {
  const value = String(link || '').trim()
  if (!/^https?:\/\//i.test(value)) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}
