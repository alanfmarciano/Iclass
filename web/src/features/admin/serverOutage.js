// Servidor fora do ar durante a prova (H3b, CONF-03). O servidor grava em
// application.outages cada período em que ficou fora do ar com a prova correndo e
// alguém ainda com tempo ({ from, to, durationMs, reason, compensated }) e devolve o
// tempo parado como uma pausa fechada { pausedAt, resumedAt, reason: 'server_outage' }
// (até 15 min). Acima disso só fica o registro, e o professor decide se dá mais tempo.
export const SERVER_OUTAGE_REASON = 'server_outage'
export const SERVER_OUTAGE_MAX_MINUTES = 15

const OUTAGE_REASON_LABELS = {
  restart: 'reinício',
  crash: 'queda do servidor',
  suspended: 'computador suspenso ou travado',
}

const isOutagePause = (pause) => !!pause && pause.reason === SERVER_OUTAGE_REASON && Number(pause.pausedAt) > 0

// A aplicação escolhida no Monitor é lida uma vez; a lista da turma é consultada a cada
// 5 s. A compensação acontece no servidor (no boot ou na volta do computador suspenso),
// então a pausa nova da queda só aparece na lista: entram no cronômetro coletivo apenas
// as pausas de queda dela. O resto (status, pausa do professor) continua o da aplicação
// escolhida, para uma consulta atrasada não trocar o estado na tela.
export function withLiveOutagePauses(pauses, livePauses) {
  const base = Array.isArray(pauses) ? pauses : []
  const live = (Array.isArray(livePauses) ? livePauses : []).filter(isOutagePause)
  if (!live.length) return base
  const known = new Set(base.filter(isOutagePause).map((pause) => Number(pause.pausedAt)))
  const extra = live.filter((pause) => !known.has(Number(pause.pausedAt)))
  return extra.length ? [...base, ...extra] : base
}

// Mesmo texto de duração do registro da aplicação (backend/utils/gradebook.js).
export function outageDurationLabel(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000) || 0)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest && minutes < 10 ? `${minutes} min ${rest} s` : `${minutes} min`
  }
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes ? `${hours} h ${restMinutes} min` : `${hours} h`
}

function clockLabel(ms) {
  const date = new Date(Number(ms))
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Quantas quedas aparecem abertas no aviso do Monitor (as mais recentes). As sem
// devolução aparecem sempre; as outras ficam em "Ver as outras".
export const SERVER_OUTAGE_VISIBLE_COUNT = 3

function outageText(outage, formatClock) {
  const compensated = outage.compensated !== false
  const reason = OUTAGE_REASON_LABELS[outage.reason]
  const from = Number(outage.from) > 0 ? formatClock(Number(outage.from)) : ''
  const to = formatClock(Number(outage.to))
  const period = from && to ? `das ${from} às ${to}` : ''
  const duration = outageDurationLabel(outage.durationMs)
  if (compensated) {
    const details = [duration, reason].filter(Boolean).join(', ')
    return `O servidor ficou fora do ar ${period ? `${period} ` : ''}(${details}). O tempo parado foi devolvido a todos.`
  }
  const details = [period, reason].filter(Boolean).join(', ')
  return `O servidor ficou fora do ar por ${duration}${details ? ` (${details})` : ''}. O tempo não foi devolvido automaticamente (mais de ${SERVER_OUTAGE_MAX_MINUTES} min); se precisar, dê mais tempo à turma.`
}

// Aviso do Monitor com uma linha para cada queda registrada na aplicação (até as 20
// que o servidor guarda), da mais recente para a mais antiga, ou null quando não houve
// nenhuma. { title, compensated, count, items, visible, hidden }, cada item
// { key, compensated, text }. compensated: todas tiveram o tempo devolvido. visible: as
// SERVER_OUTAGE_VISIBLE_COUNT mais recentes e toda queda sem devolução (uma antiga de
// mais de 15 min não some atrás de uma curta depois dela); hidden: o resto.
export function serverOutageNotices(application, { formatClock = clockLabel, visibleCount = SERVER_OUTAGE_VISIBLE_COUNT } = {}) {
  const outages = (Array.isArray(application?.outages) ? application.outages : [])
    .filter((outage) => outage && Number(outage.to) > 0 && Number(outage.durationMs) > 0)
    .sort((a, b) => Number(b.to) - Number(a.to))
  if (!outages.length) return null
  const items = outages.map((outage, index) => ({
    key: `${Number(outage.from) || 0}-${Number(outage.to)}-${index}`,
    compensated: outage.compensated !== false,
    text: outageText(outage, formatClock),
  }))
  const visible = items.filter((item, index) => index < visibleCount || !item.compensated)
  const hidden = items.filter((item) => !visible.includes(item))
  return {
    title: 'Servidor fora do ar durante a prova.',
    compensated: items.every((item) => item.compensated),
    count: items.length,
    items,
    visible,
    hidden,
  }
}
