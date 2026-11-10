import { describe, expect, it } from 'vitest'
import { outageDurationLabel, serverOutageNotice, withLiveOutagePauses } from './serverOutage'
import { resolveMonitorTimer } from './monitorTimer'

const clock = (ms) => new Date(ms).toISOString().slice(11, 19)

describe('[UC-TENTATIVA-001] servidor fora do ar no Monitor (H3b, CONF-03)', () => {
  it('descreve a última queda: devolvida ou não, com o período, a duração e o motivo', () => {
    const base = Date.parse('2026-10-18T10:00:00Z')
    expect(serverOutageNotice(null)).toBeNull()
    expect(serverOutageNotice({ outages: [] })).toBeNull()

    const short = serverOutageNotice({ outages: [{ from: base, to: base + 36000, durationMs: 36000, reason: 'suspended', compensated: true }] }, { formatClock: clock })
    expect(short).toEqual({
      compensated: true,
      count: 1,
      title: 'Servidor fora do ar durante a prova.',
      text: 'Ficou fora do ar das 10:00:00 às 10:00:36 (36 s, computador suspenso ou travado). O tempo parado foi devolvido a todos.',
    })

    const long = serverOutageNotice({
      outages: [
        { from: base, to: base + 36000, durationMs: 36000, reason: 'crash', compensated: true },
        { from: base + 60000, to: base + 60000 + 22 * 60000, durationMs: 22 * 60000, reason: 'restart', compensated: false },
      ],
    }, { formatClock: clock })
    expect(long.compensated).toBe(false)
    expect(long.count).toBe(2)
    expect(long.text).toBe('Ficou fora do ar das 10:01:00 às 10:23:00 (22 min, reinício). O tempo não foi devolvido automaticamente (mais de 15 min); se precisar, dê mais tempo à turma. Esta aplicação teve 2 quedas.')
  })

  it('duração no mesmo formato do registro da aplicação', () => {
    expect([36000, 185000, 22 * 60000, 65 * 60000, 3600000].map(outageDurationLabel)).toEqual(['36 s', '3 min 5 s', '22 min', '1 h 5 min', '1 h'])
  })

  it('só as pausas de queda da lista viva entram no cronômetro coletivo, sem repetir', () => {
    const start = Date.parse('2026-10-18T10:00:00Z')
    const teacherPause = { pausedAt: start + 60000, resumedAt: start + 120000 }
    const outagePause = { pausedAt: start + 300000, resumedAt: start + 336000, reason: 'server_outage' }
    // Pausa aberta na lista viva (de uma consulta adiantada) não muda o estado na tela.
    const liveOpenPause = { pausedAt: start + 400000, resumedAt: null }
    expect(withLiveOutagePauses([teacherPause], [teacherPause, outagePause, liveOpenPause])).toEqual([teacherPause, outagePause])
    expect(withLiveOutagePauses([teacherPause, outagePause], [teacherPause, outagePause])).toEqual([teacherPause, outagePause])
    const unchanged = [teacherPause]
    expect(withLiveOutagePauses(unchanged, null)).toBe(unchanged)

    const now = start + 600000
    const config = { onlineActive: true, startTime: start, durationMinutes: 60, timerEnabled: true }
    const before = resolveMonitorTimer({ config: { ...config, pauses: [teacherPause] }, now })
    const after = resolveMonitorTimer({ config: { ...config, pauses: withLiveOutagePauses([teacherPause], [outagePause]) }, now })
    expect(after.remaining - before.remaining).toBe(36)
  })
})
