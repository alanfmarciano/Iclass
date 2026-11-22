// Textos das telas de tarefa do painel (fase 3, C7 / P1-e; FUN-01). Funções puras, sem
// React: a lista (TarefasPage), o formulário (TarefaForm) e as telas de entrega e
// correção (C8) usam as mesmas frases.
//
// - Prazo sempre no relógio da escola: o servidor manda, em cada tarefa, `local` com a
//   data e a hora já no fuso settings.timezone (dueDate/dueTime...). A tela nunca
//   converte o instante pelo fuso do navegador.
// - "Faltam 2 dias" é contado pelo relógio do servidor (serverNow da resposta), não pelo
//   do computador do professor (D8 do P1).
// - Aluno sem e-mail: o endereço interno ('*@sem-email.invalid') nunca aparece. O nome e o
//   e-mail de uma linha da lista da tarefa (GET /api/admin/assignments/:id, roster) e da
//   entrega (GET .../submissions/:id) passam por studentLabel, que usa displayEmail de
//   lib/studentProfile.js ('sem e-mail'); o endereço interno continua sendo o que a tela
//   manda nas rotas (studentEmail é a chave). Pendência herdada da J1. Texto livre que
//   vem do servidor (recusa mostrada no formulário ou no diálogo) passa por
//   hidePlaceholderEmails antes de aparecer.
import { NO_EMAIL_LABEL, displayEmail, isPlaceholderEmail } from '../../../lib/studentProfile'

export const ASSIGNMENT_STATUS = Object.freeze({
  rascunho: { label: 'Rascunho', tone: 'neutral' },
  publicada: { label: 'Publicada', tone: 'success' },
  arquivada: { label: 'Arquivada', tone: 'warning' },
})

export function assignmentStatusInfo(status) {
  return ASSIGNMENT_STATUS[status] || { label: 'Rascunho', tone: 'neutral' }
}

const WEEKDAYS = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.']
const DAY_MS = 24 * 60 * 60 * 1000

function parseLocalDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
  if (!match) return null
  const [, year, month, day] = match
  return { year: Number(year), month: Number(month), day: Number(day) }
}

// 'sex., 04/12/2026 às 23:00' a partir da data e da hora locais da escola ('' sem data).
export function localDateTimeText(date, time) {
  const parts = parseLocalDate(date)
  if (!parts) return ''
  const weekday = WEEKDAYS[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()]
  const dd = String(parts.day).padStart(2, '0')
  const mm = String(parts.month).padStart(2, '0')
  return `${weekday}, ${dd}/${mm}/${parts.year}${time ? ` às ${time}` : ''}`
}

// Quanto falta (ou passou) até o instante, pelo relógio do servidor.
// 'faltam 3 horas', 'falta 1 dia', 'faltam 2 dias', 'terminou há 5 dias'...
export function relativeDeadlineText(ms, now) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || typeof now !== 'number' || !Number.isFinite(now)) return ''
  const diff = ms - now
  const abs = Math.abs(diff)
  // O arredondamento nunca mostra '60 minutos' nem '24 horas': de 59 min 30 s em diante
  // já é '1 hora', e de 23 h 30 min em diante já é '1 dia'.
  const minutes = Math.max(1, Math.round(abs / 60000))
  const hours = Math.round(abs / (60 * 60 * 1000))
  let amount
  let unit
  if (minutes < 60) {
    amount = minutes
    unit = amount === 1 ? 'minuto' : 'minutos'
  } else if (hours < 24) {
    amount = Math.max(1, hours)
    unit = amount === 1 ? 'hora' : 'horas'
  } else {
    amount = Math.max(1, Math.floor(abs / DAY_MS))
    unit = amount === 1 ? 'dia' : 'dias'
  }
  if (diff >= 0) return `${amount === 1 ? 'falta' : 'faltam'} ${amount} ${unit}`
  return `terminou há ${amount} ${unit}`
}

// Linha do prazo no cartão da tarefa: 'Prazo: sex., 04/12/2026 às 23:00 (faltam 2 dias)'.
export function deadlineLine(assignment, now) {
  const local = assignment?.local || {}
  if (assignment?.dueAt === null || assignment?.dueAt === undefined || !local.dueDate) return 'Sem prazo definido'
  const absolute = localDateTimeText(local.dueDate, local.dueTime)
  const relative = assignment.status === 'publicada' ? relativeDeadlineText(assignment.dueAt, now) : ''
  return `Prazo: ${absolute}${relative ? ` (${relative})` : ''}`
}

export function closeLine(assignment) {
  const local = assignment?.local || {}
  if (assignment?.closeAt === null || assignment?.closeAt === undefined || !local.closeDate) return ''
  return `Envios encerram ${localDateTimeText(local.closeDate, local.closeTime)}`
}

export function opensLine(assignment, now) {
  const local = assignment?.local || {}
  if (assignment?.opensAt === null || assignment?.opensAt === undefined || !local.opensDate) return ''
  if (typeof now === 'number' && assignment.opensAt <= now) return ''
  return `Aparece para os alunos em ${localDateTimeText(local.opensDate, local.opensTime)}`
}

// Contadores do cartão: 'Para corrigir 3 · Atrasadas 1 · Sem envio 12'.
export function countsLine(counts) {
  const value = (key) => (counts && Number.isFinite(counts[key]) ? counts[key] : 0)
  return `Para corrigir ${value('paraCorrigir')} · Atrasadas ${value('atrasadas')} · Sem envio ${value('naoEntregues')}`
}

// Regra de atraso por extenso (o aluno lê a mesma frase na tela dele).
export function latePolicyText(policy) {
  const mode = policy?.mode || 'aceitar'
  if (mode === 'bloquear') return 'Depois do prazo, a entrega não é aceita.'
  if (mode === 'desconto') {
    const perDay = Number(policy?.penaltyPerDayPct) || 0
    const max = Number(policy?.penaltyMaxPct) || 0
    return `Depois do prazo, a entrega é aceita com desconto de ${perDay}% por dia, até ${max}%.`
  }
  return 'Depois do prazo, a entrega é aceita e marcada como atrasada.'
}

// Nome e e-mail para mostrar de um aluno da lista da tarefa ou da entrega. Nunca devolve
// o endereço interno do aluno sem e-mail: email é o do cadastro ou 'sem e-mail'.
// { name, email, matricula, semEmail, title } — title é a linha única ("Ana Lima
// (ana@x.com)", "Bia Reis (sem e-mail)" ou só "sem e-mail" sem nome).
export function studentLabel(row) {
  const raw = String(row?.studentEmail || row?.email || '')
  const semEmail = row?.semEmail === true || isPlaceholderEmail(raw)
  const email = semEmail ? NO_EMAIL_LABEL : displayEmail(raw)
  const name = String(row?.name || '').trim()
  const matricula = String(row?.matricula || '').trim()
  const title = name ? `${name} (${email})` : email
  return { name: name || email, email, matricula, semEmail, title }
}

// Troca, num texto livre (recusa do servidor, aviso), todo endereço interno de aluno sem
// e-mail por 'sem e-mail'. Texto sem o endereço volta igual.
const PLACEHOLDER_IN_TEXT = /[^\s<>()"',;:]+@sem-email\.invalid\b/gi

export function hidePlaceholderEmails(text) {
  if (typeof text !== 'string' || !text) return text
  return text.replace(PLACEHOLDER_IN_TEXT, NO_EMAIL_LABEL)
}
