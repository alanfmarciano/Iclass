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
  // Só conta quem começou a tentativa: quem ainda não começou recebe o tempo inteiro ao
  // começar e fica fora de "Menor tempo restante" e da contagem de cronômetros.
  const individualTimes = rows
    .filter(row => row?.status !== 'finished' && row?.attemptStarted !== false && row?.timerRemaining !== null && row?.timerRemaining !== undefined)
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
// professor fica sabendo quantos voltaram (e quem voltou ainda bloqueado por perda de
// foco, que só continua depois do desbloqueio) e quantos já tinham entregue e ficaram
// sem o extra (envio pelo próprio aluno com o tempo dele já acabado, nota publicada ou
// fim do tempo há mais de 2 min), não só "sucesso". No meio da prova, quem já enviou
// não entra no aviso: o servidor só conta quem estava com o tempo acabado.
export function classTimeExtraFeedback(response, minutes = 5) {
  const count = (value) => Math.max(0, Math.floor(Number(value) || 0))
  const reopened = count(response?.reopenedAtDeadline)
  const reopenedLocked = Math.min(reopened, count(response?.reopenedLocked))
  const keptAtDeadline = count(response?.deliveredAtDeadline)
  // Das entregas do fim do tempo que ficaram: quantas porque o tempo extra não cobre o
  // tempo que já passou desde o fim (as outras: nota publicada ou fim há mais de 2 min).
  const keptTooShort = Math.min(keptAtDeadline, count(response?.deliveredAtDeadlineTooShort))
  const keptNotReopenable = keptAtDeadline - keptTooShort
  const keptByStudent = count(response?.deliveredByStudent)
  // Já estavam na tentativa seguinte (2+ tentativas): o tempo extra vale para ela.
  const nextStarted = count(response?.nextAttemptStarted)
  const parts = [`+${minutes} min para a turma`]
  if (reopened) {
    const back = reopened === 1
      ? '1 aluno entregue automaticamente no fim do tempo voltou para a prova com o tempo extra'
      : `${reopened} alunos entregues automaticamente no fim do tempo voltaram para a prova com o tempo extra`
    if (!reopenedLocked) parts.push(back)
    else if (reopenedLocked === reopened) {
      parts.push(reopened === 1
        ? `${back}, mas continua bloqueado por perda de foco: desbloqueie no Monitor para ele continuar`
        : `${back}, mas continuam bloqueados por perda de foco: desbloqueie no Monitor para eles continuarem`)
    } else {
      parts.push(`${back} (${reopenedLocked === 1 ? '1 continua bloqueado' : `${reopenedLocked} continuam bloqueados`} por perda de foco: desbloqueie no Monitor para continuar)`)
    }
  }
  const kept = keptAtDeadline + keptByStudent
  if (kept) {
    const reasons = []
    if (keptByStudent) reasons.push(keptByStudent === 1 ? '1 enviou a prova por conta própria' : `${keptByStudent} enviaram a prova por conta própria`)
    if (keptTooShort) {
      reasons.push(keptTooShort === 1
        ? `1 foi entregue automaticamente no fim do tempo e os ${minutes} min não cobrem o tempo que já passou desde o fim`
        : `${keptTooShort} foram entregues automaticamente no fim do tempo e os ${minutes} min não cobrem o tempo que já passou desde o fim`)
    }
    if (keptNotReopenable) {
      reasons.push(keptNotReopenable === 1
        ? '1 foi entregue automaticamente no fim do tempo e não pôde ser reaberto (nota publicada ou fim do tempo há mais de 2 min)'
        : `${keptNotReopenable} foram entregues automaticamente no fim do tempo e não puderam ser reabertos (nota publicada ou fim do tempo há mais de 2 min)`)
    }
    const who = kept === 1 ? '1 aluno que já tinha entregue ficou sem o tempo extra' : `${kept} alunos que já tinham entregue ficaram sem o tempo extra`
    parts.push(`${who}: ${reasons.join('; ')}`)
  }
  if (nextStarted) {
    parts.push(nextStarted === 1
      ? '1 aluno entregue automaticamente no fim do tempo já tinha começado a tentativa seguinte: a entrega anterior ficou como estava e o tempo extra vale para a tentativa em andamento'
      : `${nextStarted} alunos entregues automaticamente no fim do tempo já tinham começado a tentativa seguinte: as entregas anteriores ficaram como estavam e o tempo extra vale para a tentativa em andamento`)
  }
  return { tone: kept || reopenedLocked || nextStarted ? 'warning' : 'success', message: parts.length > 1 ? `${parts.join('. ')}.` : parts[0] }
}

// Começou uma tentativa nesta aplicação (em andamento ou já entregue). Quem só está com o
// portal aberto, ou parado nas instruções, não conta em "Iniciaram".
export function rowStartedAttempt(row) {
  if (!row) return false
  if (row.attemptStarted === true) return true
  return ['finished', 'time_over', 'discarded'].includes(row.status)
}

// Texto da coluna "Tempo": no cronômetro por aluno, quem ainda não começou não tem tempo correndo.
export function rowTimerLabel(row, { collective = true, enabled = true } = {}, format = (value) => String(value)) {
  if (enabled && !collective && row?.status !== 'finished' && !rowStartedAttempt(row)) return 'Não iniciou'
  return format(row?.timerRemaining)
}
