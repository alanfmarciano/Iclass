import { describe, expect, it } from 'vitest'
import { outageDurationLabel, serverOutageNotices, withLiveOutagePauses } from './serverOutage'
import { resolveMonitorTimer } from './monitorTimer'

const clock = (ms) => new Date(ms).toISOString().slice(11, 19)

describe('[UC-TENTATIVA-001] servidor fora do ar no Monitor (H3b, CONF-03)', () => {
  it('uma linha para cada queda: devolvida ou não, com o período, a duração e o motivo', () => {
    const base = Date.parse('2026-10-18T10:00:00Z')
    expect(serverOutageNotices(null)).toBeNull()
    expect(serverOutageNotices({ outages: [] })).toBeNull()

    const short = serverOutageNotices({ outages: [{ from: base, to: base + 36000, durationMs: 36000, reason: 'suspended', compensated: true }] }, { formatClock: clock })
    expect(short.title).toBe('Servidor fora do ar durante a prova.')
    expect(short.compensated).toBe(true)
    expect(short.count).toBe(1)
    expect(short.visible.map((item) => item.text)).toEqual([
      'O servidor ficou fora do ar das 10:00:00 às 10:00:36 (36 s, computador suspenso ou travado). O tempo parado foi devolvido a todos.',
    ])
    expect(short.hidden).toEqual([])

    const two = serverOutageNotices({
      outages: [
        { from: base, to: base + 36000, durationMs: 36000, reason: 'crash', compensated: true },
        { from: base + 60000, to: base + 60000 + 22 * 60000, durationMs: 22 * 60000, reason: 'restart', compensated: false },
      ],
    }, { formatClock: clock })
    expect(two.compensated).toBe(false)
    expect(two.count).toBe(2)
    // Da mais recente para a mais antiga, cada uma com o seu estado.
    expect(two.visible.map((item) => [item.compensated, item.text])).toEqual([
      [false, 'O servidor ficou fora do ar por 22 min (das 10:01:00 às 10:23:00, reinício). O tempo não foi devolvido automaticamente (mais de 15 min); se precisar, dê mais tempo à turma.'],
      [true, 'O servidor ficou fora do ar das 10:00:00 às 10:00:36 (36 s, queda do servidor). O tempo parado foi devolvido a todos.'],
    ])
  })

  it('queda antiga sem devolução continua à vista depois de quedas curtas; as outras ficam em "Ver as outras"', () => {
    const base = Date.parse('2026-10-18T10:00:00Z')
    const outages = [
      { from: base, to: base + 20 * 60000, durationMs: 20 * 60000, reason: 'crash', compensated: false },
      ...[1, 2, 3, 4, 5].map((index) => ({ from: base + index * 30 * 60000, to: base + index * 30 * 60000 + 5000, durationMs: 5000, reason: 'restart', compensated: true })),
    ]
    const notice = serverOutageNotices({ outages }, { formatClock: clock })
    expect(notice.count).toBe(6)
    expect(notice.compensated).toBe(false)
    expect(notice.visible).toHaveLength(4)
    expect(notice.visible.slice(0, 3).every((item) => item.compensated)).toBe(true)
    expect(notice.visible[0].text).toContain('das 12:30:00 às 12:30:05')
    expect(notice.visible[3].compensated).toBe(false)
    expect(notice.visible[3].text).toContain('por 20 min (das 10:00:00 às 10:20:00, queda do servidor)')
    expect(notice.hidden.map((item) => item.text)).toEqual([
      'O servidor ficou fora do ar das 11:00:00 às 11:00:05 (5 s, reinício). O tempo parado foi devolvido a todos.',
      'O servidor ficou fora do ar das 10:30:00 às 10:30:05 (5 s, reinício). O tempo parado foi devolvido a todos.',
    ])
    expect(new Set(notice.items.map((item) => item.key)).size).toBe(6)
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
