// Tempo pausado que conta para um relógio iniciado em startTime: só pausas que
// começaram enquanto ainda havia tempo (mesma regra do servidor).
export function pausedMsWithinTimer(pauses, startTime, baseDeadline, now = Date.now()) {
  let deadline = Number(baseDeadline)
  const start = Number(startTime)
  if (!Number.isFinite(deadline) || !Number.isFinite(start)) return 0
  const ordered = (Array.isArray(pauses) ? pauses : [])
    .filter((pause) => pause && Number(pause.pausedAt) > 0)
    .map((pause) => ({ pausedAt: Number(pause.pausedAt), resumedAt: Number(pause.resumedAt) > 0 ? Number(pause.resumedAt) : null }))
    .sort((a, b) => a.pausedAt - b.pausedAt)
  for (const pause of ordered) {
    const from = Math.max(pause.pausedAt, start)
    const until = pause.resumedAt || now
    if (!(until > from)) continue
    if (from >= deadline) break
    deadline += until - from
  }
  return deadline - Number(baseDeadline)
}

export function resolveMonitorTimer({ config = {}, rows = [], now = Date.now(), rowsSyncedAt = now } = {}) {
  const enabled = config.timerEnabled !== false
  const configuredSeconds = Math.max(0, (Number(config.durationMinutes) + Number(config.globalTimeAdjustment || 0)) * 60)
  const collective = config.timerMode !== 'per_attempt'

  if (!enabled) {
    return { enabled: false, collective, started: false, remaining: null, activeCount: 0 }
  }

  if (collective) {
    const startTime = Number(config.startTime || 0)
    const started = config.onlineActive === true && startTime > 0 && now >= startTime
    // Pausar congela o relógio coletivo: o tempo pausado não é descontado.
    const pausedMs = started ? pausedMsWithinTimer(config.pauses, startTime, startTime + configuredSeconds * 1000, now) : 0
    return {
      enabled: true,
      collective: true,
      started,
      remaining: started
        ? Math.max(0, configuredSeconds - Math.floor((now - startTime - pausedMs) / 1000))
        : configuredSeconds,
      activeCount: 0,
    }
  }

  const secondsSinceSync = Math.max(0, Math.floor((now - Number(rowsSyncedAt || now)) / 1000))
  const individualTimes = rows
    .filter(row => row?.status !== 'finished' && row?.timerRemaining !== null && row?.timerRemaining !== undefined)
    .map(row => Number(row.timerRemaining))
    .filter(value => Number.isFinite(value) && value >= 0)
    .map(value => Math.max(0, value - secondsSinceSync))

  return {
    enabled: true,
    collective: false,
    started: individualTimes.length > 0,
    remaining: individualTimes.length > 0 ? Math.min(...individualTimes) : configuredSeconds,
    activeCount: individualTimes.length,
  }
}

// Retorno do "+N min" para a turma. Logo depois do fim do tempo (até 2 min), quem foi
// entregue automaticamente no fim do tempo volta para a prova com o tempo extra; o
// professor fica sabendo quantos voltaram e quantos já tinham entregue e ficaram sem o
// extra (envio pelo próprio aluno, nota publicada ou fim do tempo há mais de 2 min),
// não só "sucesso".
export function classTimeExtraFeedback(response, minutes = 5) {
  const count = (value) => Math.max(0, Math.floor(Number(value) || 0))
  const reopened = count(response?.reopenedAtDeadline)
  const keptAtDeadline = count(response?.deliveredAtDeadline)
  const keptByStudent = count(response?.deliveredByStudent)
  const parts = [`+${minutes} min para a turma`]
  if (reopened) {
    parts.push(reopened === 1
      ? '1 aluno entregue automaticamente no fim do tempo voltou para a prova com o tempo extra'
      : `${reopened} alunos entregues automaticamente no fim do tempo voltaram para a prova com o tempo extra`)
  }
  const kept = keptAtDeadline + keptByStudent
  if (kept) {
    const reasons = []
    if (keptByStudent) reasons.push(keptByStudent === 1 ? '1 enviou a prova por conta própria' : `${keptByStudent} enviaram a prova por conta própria`)
    if (keptAtDeadline) {
      reasons.push(keptAtDeadline === 1
        ? '1 foi entregue automaticamente no fim do tempo e não pôde ser reaberto (nota publicada ou fim do tempo há mais de 2 min)'
        : `${keptAtDeadline} foram entregues automaticamente no fim do tempo e não puderam ser reabertos (nota publicada ou fim do tempo há mais de 2 min)`)
    }
    const who = kept === 1 ? '1 aluno que já tinha entregue ficou sem o tempo extra' : `${kept} alunos que já tinham entregue ficaram sem o tempo extra`
    parts.push(`${who}: ${reasons.join('; ')}`)
  }
  return { tone: kept ? 'warning' : 'success', message: parts.length > 1 ? `${parts.join('. ')}.` : parts[0] }
}
