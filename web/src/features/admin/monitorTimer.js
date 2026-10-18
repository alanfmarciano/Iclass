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

// Retorno do "+N min" para a turma: quem já estava com o tempo esgotado foi entregue
// automaticamente com as respostas salvas e não recebe o tempo extra (o professor
// precisa saber disso, não só ver "sucesso").
export function classTimeExtraFeedback(response, minutes = 5) {
  const base = `+${minutes} min para a turma`
  const delivered = Math.max(0, Math.floor(Number(response?.deliveredAtDeadline) || 0))
  if (!delivered) return { tone: 'success', message: base }
  const who = delivered === 1
    ? '1 aluno já estava sem tempo e foi entregue'
    : `${delivered} alunos já estavam sem tempo e foram entregues`
  return { tone: 'warning', message: `${base}. ${who} automaticamente com as respostas salvas, sem o tempo extra.` }
}
