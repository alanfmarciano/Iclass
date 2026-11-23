// Mensagens entre aluno e professor (fase 3, C14 / P5-S7b, FUN-14): textos e contas que
// as duas telas (portal do aluno e painel) usam. As regras ficam no servidor
// (backend/utils/conversations.js); aqui só se mostra o que ele mandou.
import { compareOrdinal } from '../../lib/textSearch'

// Limites do servidor (LIMITS de conversations.js); a resposta da lista traz os mesmos em
// `limites`, e a tela usa os dela quando vêm.
export const TEXT_MAX = 2000
export const SUBJECT_MAX = 120
export const REASON_MAX = 200
// O contador de caracteres aparece a partir daqui (P5: "contador a partir de 1800").
export const TEXT_COUNTER_FROM = 1800
// Com a conversa aberta, a tela pergunta por mensagens novas a cada 10 s (D13 do P5).
export const THREAD_POLL_MS = 10000

// Avisos fixos (os mesmos textos do servidor, READ_NOTICE e KEEP_NOTICE).
export const READ_NOTICE = 'O administrador da escola pode ler estas mensagens.'
export const KEEP_NOTICE = 'As mensagens ficam guardadas e não podem ser apagadas.'
export const EXAM_NOTICE = 'Durante a prova, fale com o professor pelo botão da prova.'
export const STUDENT_CLOSED_NOTICE = 'O professor encerrou esta conversa. Você pode começar outra.'
export const ADMIN_READING_NOTICE = 'Você está lendo uma conversa de outro professor; isso fica registrado.'
export const STUDENT_INACTIVE_NOTICE = 'O cadastro deste aluno está encerrado. A conversa fica só para consulta.'

function toMs(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

const pad = (value) => String(value).padStart(2, '0')

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

// "agora", "há 5 min", "há 2 h", "ontem", "há 3 dias" ou "20/11" (na lista de conversas).
export function timeAgo(at, now = Date.now()) {
  const ms = toMs(at)
  if (!ms) return ''
  const diff = now - ms
  if (diff < 60000) return 'agora'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `há ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const date = new Date(ms)
  const today = new Date(now)
  if (hours < 24 && sameDay(date, today)) return `há ${hours} h`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(date, yesterday)) return 'ontem'
  const days = Math.floor(diff / 86400000)
  if (days < 7) return `há ${Math.max(2, days)} dias`
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}${date.getFullYear() === today.getFullYear() ? '' : `/${date.getFullYear()}`}`
}

// Hora do balão: "14:32" hoje, "ontem 14:32" ou "20/11 14:32".
export function messageTime(at, now = Date.now()) {
  const ms = toMs(at)
  if (!ms) return ''
  const date = new Date(ms)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const today = new Date(now)
  if (sameDay(date, today)) return clock
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(date, yesterday)) return `ontem ${clock}`
  const year = date.getFullYear() === today.getFullYear() ? '' : `/${date.getFullYear()}`
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}${year} ${clock}`
}

// Data e hora completas (título do balão e "encerrada em").
export function fullDateTime(at) {
  const ms = toMs(at)
  if (!ms) return ''
  const date = new Date(ms)
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} às ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// Junta mensagens novas às que a tela já tem: sem repetir (pelo id), na ordem de envio.
// A mesma mensagem pode chegar duas vezes (a resposta do envio e a consulta seguinte).
export function mergeMessages(current, incoming) {
  const byId = new Map()
  ;[...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])].forEach((message) => {
    if (!message || !message.id) return
    byId.set(String(message.id), message)
  })
  return [...byId.values()].sort((a, b) => toMs(a.criadaEm) - toMs(b.criadaEm) || compareOrdinal(String(a.id), String(b.id)))
}

export function lastTimestamp(messages) {
  return (Array.isArray(messages) ? messages : []).reduce((max, message) => Math.max(max, toMs(message?.criadaEm)), 0)
}

export function firstTimestamp(messages) {
  const list = (Array.isArray(messages) ? messages : []).map((message) => toMs(message?.criadaEm)).filter(Boolean)
  return list.length ? Math.min(...list) : 0
}

// A mensagem é de quem está vendo a tela? Portal: autor 'voce'. Painel: voce true.
export function isOwnMessage(message, side) {
  if (!message) return false
  return side === 'aluno' ? message.autor === 'voce' : message.voce === true
}

// A última mensagem do outro lado (o que a marca de leitura precisa alcançar).
export function lastFromOtherSide(messages, side) {
  return (Array.isArray(messages) ? messages : []).reduce((max, message) => (
    isOwnMessage(message, side) ? max : Math.max(max, toMs(message?.criadaEm))
  ), 0)
}

// "1 mensagem nova" / "3 mensagens novas" (rótulo acessível do selo da lista).
export function unreadLabel(count) {
  const value = Math.max(0, Math.trunc(Number(count) || 0))
  if (!value) return ''
  return value === 1 ? '1 mensagem nova' : `${value} mensagens novas`
}

// Erro de uma ação para mostrar na tela: a mensagem do servidor (já em português), com o
// tempo de espera do 429 quando ele não diz.
export function actionErrorText(error, fallback = 'Não foi possível enviar agora. Tente de novo.') {
  if (!error) return ''
  return error.message || fallback
}
