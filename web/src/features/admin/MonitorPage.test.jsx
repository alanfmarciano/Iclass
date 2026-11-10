import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MonitorPage from './MonitorPage'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  // Lista da turma consultada a cada 5 s (useApi); sem valor, a mesma da carga inicial.
  liveApplications: null,
}))

const classes = [{ name: '1DES', courseId: 'C1', onlineExamConfigs: {} }]
const applications = [
  // A lista do servidor vem da mais nova para a mais antiga.
  { id: 'app-nova', examKey: 'Avaliacao_Nova', studentClass: '1DES', courseId: 'C1', status: 'prepared', createdAt: '2026-10-18T11:00:00Z' },
  { id: 'app-antiga', examKey: 'Avaliacao_Antiga', studentClass: '1DES', courseId: 'C1', status: 'running', createdAt: '2026-10-18T10:00:00Z' },
]

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../hooks/useAdminWorkspace', () => ({ useAdminWorkspace: () => ({ courseId: 'C1', courseName: 'Curso', className: '1DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => {
    if (String(path).startsWith('/api/admin/classes')) return { data: classes, refetch: vi.fn(), loading: false }
    if (String(path).startsWith('/api/admin/exam-applications')) return { data: { applications: mocks.liveApplications || applications }, refetch: vi.fn(), loading: false }
    return { data: null, refetch: vi.fn(), loading: false }
  },
}))

describe('MonitorPage · link para uma aplicação', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/admin/exam-applications?')) {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { applications }
      }
      if (url.startsWith('/api/admin/monitor-status/')) return { monitorList: [] }
      if (url.startsWith('/api/admin/question-reports/')) return { groups: [], totalOpen: 0 }
      return {}
    })
  })
  afterEach(cleanup)

  it('[UC-APLICACAO-001] "Abrir Monitor" de uma prova mais antiga abre essa aplicação, não a preparada mais nova', async () => {
    render(
      <MemoryRouter initialEntries={['/monitor?courseId=C1&className=1DES&examKey=Avaliacao_Antiga&applicationId=app-antiga']}>
        <Routes><Route path="/monitor" element={<MonitorPage />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/admin\/exam-applications\?/)))
    await waitFor(() => expect(screen.getAllByText('Avaliacao_Antiga').length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const monitorCalls = mocks.get.mock.calls.map(([url]) => url).filter((url) => url.startsWith('/api/admin/monitor-status/'))
    expect(monitorCalls.at(-1)).toMatch(/Avaliacao_Antiga.*applicationId=app-antiga/)
    expect(monitorCalls.some((url) => url.includes('app-nova'))).toBe(false)
  })
})

describe('MonitorPage · tentativa atual com mais de uma tentativa', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/admin/exam-applications?')) return { applications }
      if (url.startsWith('/api/admin/monitor-status/')) {
        return [
          // Entregou a tentativa 1 e está fazendo a 2: linha da tentativa 2, não "Finalizou".
          { email: 'elisa@x.local', name: 'Elisa', status: 'online', attemptNumber: 2, maxAttempts: 2, deliveredAttempts: 1, attemptInProgress: true, progress: '2/4', logs: [] },
          { email: 'bruno@x.local', name: 'Bruno', status: 'finished', attemptNumber: 1, maxAttempts: 2, deliveredAttempts: 1, attemptInProgress: false, progress: '4/4', logs: [] },
        ]
      }
      if (url.startsWith('/api/admin/question-reports/')) return { groups: [], totalOpen: 0 }
      return {}
    })
  })
  afterEach(cleanup)

  it('[UC-APLICACAO-001] mostra "Tentativa N de M" e conta como entregue só quem não está em outra tentativa', async () => {
    render(
      <MemoryRouter initialEntries={['/monitor?courseId=C1&className=1DES&examKey=Avaliacao_Antiga&applicationId=app-antiga']}>
        <Routes><Route path="/monitor" element={<MonitorPage />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Tentativa 2 de 2')).toBeTruthy())
    expect(screen.getByText('Tentativa 1 de 2')).toBeTruthy()
    const delivered = screen.getByText('Entregaram').closest('div').parentElement
    expect(delivered.textContent).toContain('1')
    expect(delivered.textContent).not.toContain('2')
  })
})

describe('MonitorPage · servidor fora do ar durante a prova (H3b, CONF-03)', () => {
  const startsAt = Date.parse('2026-10-18T10:00:00Z')
  const withOutage = (outage) => applications.map((item) => (item.id !== 'app-antiga' ? item : {
    ...item,
    startsAt,
    durationMinutes: 60,
    timerEnabled: true,
    pauses: outage.compensated ? [{ pausedAt: outage.from, resumedAt: outage.to, reason: 'server_outage' }] : [],
    outages: [outage],
  }))

  beforeEach(() => {
    vi.clearAllMocks()
    // A carga inicial ainda não tem a queda: ela só aparece na lista consultada a cada 5 s.
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/admin/exam-applications?')) return { applications }
      if (url.startsWith('/api/admin/monitor-status/')) return { monitorList: [] }
      if (url.startsWith('/api/admin/question-reports/')) return { groups: [], totalOpen: 0 }
      return {}
    })
  })
  afterEach(() => {
    mocks.liveApplications = null
    cleanup()
  })

  const renderMonitor = () => render(
    <MemoryRouter initialEntries={['/monitor?courseId=C1&className=1DES&examKey=Avaliacao_Antiga&applicationId=app-antiga']}>
      <Routes><Route path="/monitor" element={<MonitorPage />} /></Routes>
    </MemoryRouter>,
  )

  it('[UC-TENTATIVA-001] queda curta: avisa que o tempo parado foi devolvido a todos', async () => {
    mocks.liveApplications = withOutage({ from: startsAt + 600000, to: startsAt + 636000, durationMs: 36000, reason: 'crash', compensated: true })
    renderMonitor()
    const notice = await screen.findByText('Servidor fora do ar durante a prova.')
    const text = notice.closest('[role="status"]').textContent
    expect(text).toMatch(/O servidor ficou fora do ar das .+ às .+ \(36 s, queda do servidor\)\. O tempo parado foi devolvido a todos\./)
    expect(text).not.toContain('não foi devolvido')
  })

  it('[UC-TENTATIVA-001] queda acima de 15 min: avisa que o tempo não foi devolvido e o professor decide', async () => {
    mocks.liveApplications = withOutage({ from: startsAt + 600000, to: startsAt + 600000 + 22 * 60000, durationMs: 22 * 60000, reason: 'restart', compensated: false })
    renderMonitor()
    const notice = await screen.findByText('Servidor fora do ar durante a prova.')
    const text = notice.closest('[role="status"]').textContent
    expect(text).toMatch(/O servidor ficou fora do ar por 22 min \(das .+ às .+, reinício\)\./)
    expect(text).toContain('O tempo não foi devolvido automaticamente (mais de 15 min); se precisar, dê mais tempo à turma.')
  })

  it('[UC-TENTATIVA-001] várias quedas: um aviso para cada uma, e a antiga sem devolução não some atrás das curtas', async () => {
    const longOutage = { from: startsAt + 60000, to: startsAt + 60000 + 20 * 60000, durationMs: 20 * 60000, reason: 'crash', compensated: false }
    const short = [1, 2, 3, 4].map((index) => ({ from: startsAt + (20 + index * 5) * 60000, to: startsAt + (20 + index * 5) * 60000 + 4000, durationMs: 4000, reason: 'restart', compensated: true }))
    mocks.liveApplications = withOutage(longOutage).map((item) => (item.id !== 'app-antiga' ? item : {
      ...item,
      pauses: short.map((outage) => ({ pausedAt: outage.from, resumedAt: outage.to, reason: 'server_outage' })),
      outages: [longOutage, ...short],
    }))
    renderMonitor()
    const notice = (await screen.findByText('Servidor fora do ar durante a prova.')).closest('[role="status"]')
    const visible = [...notice.querySelectorAll(':scope > div > ul > li')].map((item) => item.textContent)
    expect(visible).toHaveLength(4)
    expect(visible.slice(0, 3).every((text) => text.includes('(4 s, reinício). O tempo parado foi devolvido a todos.'))).toBe(true)
    expect(visible[3]).toMatch(/^O servidor ficou fora do ar por 20 min \(das .+, queda do servidor\)\. O tempo não foi devolvido automaticamente/)
    expect(within(notice).getByText('Ver a outra queda')).toBeInTheDocument()
    expect(notice.querySelectorAll('details li')).toHaveLength(1)
  })

  it('[UC-TENTATIVA-001] sem queda registrada, nenhum aviso', async () => {
    renderMonitor()
    await waitFor(() => expect(screen.getAllByText('Avaliacao_Antiga').length).toBeGreaterThan(0))
    expect(screen.queryByText('Servidor fora do ar durante a prova.')).not.toBeInTheDocument()
  })
})

describe('MonitorPage · consultas leves (H2-D, DES-04)', () => {
  const row = { email: 'elisa@x.local', name: 'Elisa', status: 'online', attemptNumber: 1, maxAttempts: 1, deliveredAttempts: 0, attemptInProgress: true, progress: '1/4', keystrokeCount: 3, logs: [], logCount: 0 }
  const renderMonitor = () => render(
    <MemoryRouter initialEntries={['/monitor?courseId=C1&className=1DES&examKey=Avaliacao_Antiga&applicationId=app-antiga']}>
      <Routes><Route path="/monitor" element={<MonitorPage />} /></Routes>
    </MemoryRouter>,
  )
  const urls = (prefix) => mocks.get.mock.calls.map(([url]) => url).filter((url) => url.startsWith(prefix))
  const tick = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: false })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('[UC-DESEMPENHO-002] com monitor-status pendente, o relógio de 3 s não dispara outra consulta; a próxima sai depois da resposta', async () => {
    let release
    mocks.get.mockImplementation((url) => {
      if (url.startsWith('/api/admin/exam-applications?')) return Promise.resolve({ applications })
      if (url.startsWith('/api/admin/monitor-status/')) return new Promise((resolve) => { release = () => resolve([row]) })
      if (url.startsWith('/api/admin/question-reports/')) return Promise.resolve({ groups: [], totalOpen: 0 })
      return Promise.resolve({})
    })
    renderMonitor()
    await tick(50)
    expect(urls('/api/admin/monitor-status/')).toHaveLength(1)
    await tick(10000)
    expect(urls('/api/admin/monitor-status/'), 'nenhuma consulta nova enquanto a anterior não respondeu').toHaveLength(1)
    await act(async () => { release() })
    await tick(10)
    expect(screen.getByText('Elisa')).toBeTruthy()
    await tick(3100)
    expect(urls('/api/admin/monitor-status/')).toHaveLength(2)
    // A consulta periódica sai em segundo plano (não conta como uso da sessão) e com prazo.
    const options = mocks.get.mock.calls.find(([url]) => url.startsWith('/api/admin/monitor-status/'))[1]
    expect(options).toMatchObject({ background: true, timeoutMs: 10000 })
    // A lista de aplicações do Monitor é pedida na versão resumida.
    expect(urls('/api/admin/exam-applications?').every((url) => url.includes('view=summary'))).toBe(true)
  })

  it('[UC-DESEMPENHO-002] digitação ao vivo: a segunda busca manda after=<cursor> e acrescenta os eventos; logs vêm da resposta', async () => {
    const pages = [
      { events: [{ seq: 1, kind: 'char', key: 'a', serverTs: Date.now() }, { seq: 2, kind: 'char', key: 'b', serverTs: Date.now() }], total: 2, cursor: 41, hasMore: false, logs: [{ eventType: 'tab_blur', timestamp: Date.now() }] },
      // O aluno recarregou a página: o seq do navegador recomeçou em 1, o cursor do servidor não.
      { events: [{ seq: 1, kind: 'char', key: 'c', serverTs: Date.now() }], total: 3, cursor: 57, hasMore: false, logs: [{ eventType: 'tab_blur', timestamp: Date.now() }, { eventType: 'exam_left', timestamp: Date.now() }] },
    ]
    // Sem tecla nova, o cursor fica onde estava; os logs vêm sempre (os do aluno na aplicação).
    pages.push({ ...pages[1], events: [] })
    let page = 0
    mocks.get.mockImplementation((url) => {
      if (url.startsWith('/api/admin/exam-applications?')) return Promise.resolve({ applications })
      if (url.startsWith('/api/admin/monitor-status/')) return Promise.resolve([row])
      if (url.startsWith('/api/admin/question-reports/')) return Promise.resolve({ groups: [], totalOpen: 0 })
      if (url.startsWith('/api/admin/exam-keystrokes/')) return Promise.resolve(pages[Math.min(page++, pages.length - 1)])
      return Promise.resolve({})
    })
    renderMonitor()
    await tick(50)
    fireEvent.click(screen.getByTitle('Ver digitação ao vivo'))
    await tick(50)
    const first = urls('/api/admin/exam-keystrokes/')
    expect(first).toHaveLength(1)
    expect(first[0]).not.toContain('after=')
    expect(first[0]).toContain('applicationId=app-antiga')
    await tick(2100)
    const second = urls('/api/admin/exam-keystrokes/')
    expect(second).toHaveLength(2)
    expect(second[1]).toContain('after=41')
    await tick(2100)
    expect(urls('/api/admin/exam-keystrokes/')[2]).toContain('after=57')
    // Os três eventos ficam na tela, na ordem de chegada (o "c" depois da recarga).
    fireEvent.click(screen.getByText('Fluxo completo'))
    expect(screen.getByText('abc')).toBeTruthy()
    // Saídas de foco contadas pelos logs da resposta da digitação (2), não da linha (0).
    const focusStat = screen.getAllByText('Saídas de foco')[0].parentElement
    expect(focusStat.textContent).toContain('2')
  })

  it('[UC-DESEMPENHO-002] hasMore busca de novo na hora; trocar de aluno recomeça sem cursor', async () => {
    const other = { ...row, email: 'bruno@x.local', name: 'Bruno' }
    mocks.get.mockImplementation((url) => {
      if (url.startsWith('/api/admin/exam-applications?')) return Promise.resolve({ applications })
      if (url.startsWith('/api/admin/monitor-status/')) return Promise.resolve([row, other])
      if (url.startsWith('/api/admin/question-reports/')) return Promise.resolve({ groups: [], totalOpen: 0 })
      if (url.startsWith('/api/admin/exam-keystrokes/')) {
        if (url.includes('after=10')) return Promise.resolve({ events: [{ seq: 3, kind: 'char', key: 'z' }], cursor: 11, hasMore: true, logs: [] })
        if (url.includes('after=11')) return Promise.resolve({ events: [{ seq: 4, kind: 'char', key: 'y' }], cursor: 12, hasMore: false, logs: [] })
        if (url.includes('after=')) return Promise.resolve({ events: [], cursor: 12, hasMore: false, logs: [] })
        return Promise.resolve({ events: [{ seq: 1, kind: 'char', key: 'x' }], cursor: 10, hasMore: false, logs: [] })
      }
      return Promise.resolve({})
    })
    renderMonitor()
    await tick(50)
    fireEvent.click(screen.getAllByTitle('Ver digitação ao vivo')[0])
    await tick(50)
    await tick(2050)
    const calls = urls('/api/admin/exam-keystrokes/')
    expect(calls.slice(0, 3).map((url) => (url.match(/after=(\d+)/) || [])[1] || null)).toEqual([null, '10', '11'])
    // Fecha e abre a digitação de outro aluno: começa de novo, sem cursor.
    fireEvent.click(screen.getByLabelText('Fechar'))
    await tick(10)
    fireEvent.click(screen.getAllByTitle('Ver digitação ao vivo')[1])
    await tick(50)
    const bruno = urls('/api/admin/exam-keystrokes/').filter((url) => url.includes('bruno'))
    expect(bruno).toHaveLength(1)
    expect(bruno[0]).not.toContain('after=')
  })

  it('[UC-DESEMPENHO-004] "Liberar nota para o aluno" pede só as entregas da aplicação', async () => {
    const finished = applications.map((item) => (item.id === 'app-antiga' ? { ...item, status: 'finished' } : item))
    mocks.liveApplications = finished
    mocks.get.mockImplementation((url) => {
      if (url.startsWith('/api/admin/exam-applications?')) return Promise.resolve({ applications: finished })
      if (url.startsWith('/api/admin/monitor-status/')) return Promise.resolve([row])
      if (url.startsWith('/api/admin/question-reports/')) return Promise.resolve({ groups: [], totalOpen: 0 })
      if (url.startsWith('/api/admin/submissions?')) return Promise.resolve([{ id: 's1', applicationId: 'app-antiga', gradePublished: false }])
      return Promise.resolve({})
    })
    mocks.post.mockResolvedValue({ updated: 1 })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      renderMonitor()
      await tick(50)
      fireEvent.click(screen.getByText('Liberar nota para o aluno'))
      await tick(50)
      expect(urls('/api/admin/submissions?')).toHaveLength(1)
      expect(urls('/api/admin/submissions?')[0]).toContain('applicationId=app-antiga')
      expect(mocks.post).toHaveBeenCalledWith('/api/admin/submissions/publish', { ids: ['s1'], published: true })
    } finally {
      confirm.mockRestore()
      mocks.liveApplications = null
    }
  })
})
