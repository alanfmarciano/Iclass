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
    return {
      enabled: true,
      collective: true,
      started,
      remaining: started
        ? Math.max(0, configuredSeconds - Math.floor((now - startTime) / 1000))
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
