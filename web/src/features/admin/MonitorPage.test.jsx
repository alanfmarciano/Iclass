import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MonitorPage, { classifyKeystroke } from './MonitorPage'
import { keystrokeLiveEmptyText, keystrokeLiveTitle } from '../../lib/keystrokeModes'

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
  // A aplicação do teste não traz keystrokeMode: vale 'eventos' (H8b), e o botão se chama
  // "Ver atalhos ao vivo". O cursor da digitação ao vivo é o mesmo em qualquer modo.
  const LIVE_TITLE = /^Ver (digitação|atalhos) ao vivo$/
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
    fireEvent.click(screen.getByTitle(LIVE_TITLE))
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
    fireEvent.click(screen.getAllByTitle(LIVE_TITLE)[0])
    await tick(50)
    await tick(2050)
    const calls = urls('/api/admin/exam-keystrokes/')
    expect(calls.slice(0, 3).map((url) => (url.match(/after=(\d+)/) || [])[1] || null)).toEqual([null, '10', '11'])
    // Fecha e abre a digitação de outro aluno: começa de novo, sem cursor.
    fireEvent.click(screen.getByLabelText('Fechar'))
    await tick(10)
    fireEvent.click(screen.getAllByTitle(LIVE_TITLE)[1])
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
    const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => { throw new Error('caixa do navegador') })
    try {
      renderMonitor()
      await tick(50)
      fireEvent.click(screen.getByText('Liberar nota para o aluno'))
      // Fase 3, C0a: o diálogo da tela pergunta antes (o confirm do navegador parava o polling).
      // P3-S8 (D20): o diálogo já abre contando as notas, então as entregas desta
      // aplicação são pedidas ao abrir (antes, só ao confirmar) e nada é publicado antes do clique.
      const dialog = screen.getByRole('dialog', { name: 'Liberar as notas desta aplicação?' })
      await tick(50)
      expect(urls('/api/admin/submissions?')).toHaveLength(1)
      expect(urls('/api/admin/submissions?')[0]).toContain('applicationId=app-antiga')
      expect(dialog).toHaveTextContent('1 nota será liberada e o aluno passará a vê-la no portal.')
      expect(mocks.post).not.toHaveBeenCalled()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Liberar notas' }))
      await tick(50)
      expect(urls('/api/admin/submissions?')).toHaveLength(1)
      expect(mocks.post).toHaveBeenCalledWith('/api/admin/submissions/publish', { ids: ['s1'], published: true })
      expect(screen.queryByRole('dialog', { name: 'Liberar as notas desta aplicação?' })).toBeNull()
      expect(confirm).not.toHaveBeenCalled()
    } finally {
      confirm.mockRestore()
      mocks.liveApplications = null
    }
  })
})

// Fase 3, C0a (contrato C12 do P3): mensagem, tempo, versão e liberar notas no
// ConfirmDialog, sem prompt nem confirm do navegador. Cancelar não envia nada (com o
// prompt, Cancelar no tempo virava um ajuste de 0 minutos).
describe('[UC-CONFIRMACAO-001] MonitorPage · diálogos das ações por aluno', () => {
  const row = { email: 'elisa@x.local', name: 'Elisa', status: 'online', attemptNumber: 1, maxAttempts: 1, deliveredAttempts: 0, attemptInProgress: true, progress: '1/4', keystrokeCount: 0, logs: [], logCount: 0, assignedVersion: 'B' }
  const renderMonitor = () => render(
    <MemoryRouter initialEntries={['/monitor?courseId=C1&className=1DES&examKey=Avaliacao_Antiga&applicationId=app-antiga']}>
      <Routes><Route path="/monitor" element={<MonitorPage />} /></Routes>
    </MemoryRouter>,
  )
  const posts = (path) => mocks.post.mock.calls.filter(([url]) => url === path)
  let nativeSpies = []

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/admin/exam-applications?')) return { applications }
      if (url.startsWith('/api/admin/monitor-status/')) return [row]
      if (url.startsWith('/api/admin/question-reports/')) return { groups: [], totalOpen: 0 }
      if (url.startsWith('/api/admin/message-history?')) return { messages: [] }
      return {}
    })
    mocks.post.mockResolvedValue({ success: true })
    nativeSpies = ['prompt', 'confirm', 'alert'].map((name) => vi.spyOn(window, name).mockImplementation(() => { throw new Error(`window.${name}`) }))
  })
  afterEach(() => {
    for (const spy of nativeSpies) {
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }
    cleanup()
  })

  it('Tempo: Cancelar não ajusta; zero e fora do limite não confirmam; -5 vai como -5', async () => {
    renderMonitor()
    fireEvent.click(await screen.findByRole('button', { name: 'Tempo' }))
    let dialog = screen.getByRole('dialog', { name: 'Ajustar o tempo do aluno' })
    expect(dialog).toHaveTextContent('Elisa')
    const field = within(dialog).getByLabelText('Minutos')
    expect(field).toHaveValue(5)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog', { name: 'Ajustar o tempo do aluno' })).toBeNull()
    expect(posts('/api/admin/adjust-student-time')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Tempo' }))
    dialog = screen.getByRole('dialog', { name: 'Ajustar o tempo do aluno' })
    const confirm = within(dialog).getByRole('button', { name: 'Ajustar tempo' })
    for (const value of ['0', '', '121', '-31', '2.5']) {
      fireEvent.change(within(dialog).getByLabelText('Minutos'), { target: { value } })
      expect(confirm).toBeDisabled()
    }
    fireEvent.change(within(dialog).getByLabelText('Minutos'), { target: { value: '-5' } })
    expect(confirm).not.toBeDisabled()
    await act(async () => { fireEvent.click(confirm) })
    await waitFor(() => expect(posts('/api/admin/adjust-student-time')).toHaveLength(1))
    expect(posts('/api/admin/adjust-student-time')[0][1]).toMatchObject({ targetEmail: 'elisa@x.local', adjustmentMinutes: -5, applicationId: 'app-antiga' })
    expect(screen.queryByRole('dialog', { name: 'Ajustar o tempo do aluno' })).toBeNull()
  })

  it('Msg: só envia com texto, aparado; erro do servidor fica no diálogo com o texto', async () => {
    mocks.post.mockRejectedValueOnce(new Error('Sem conexão com o servidor.'))
    renderMonitor()
    fireEvent.click(await screen.findByRole('button', { name: 'Msg' }))
    const dialog = screen.getByRole('dialog', { name: 'Mensagem para o aluno' })
    const field = within(dialog).getByLabelText('Mensagem')
    expect(field).toHaveAttribute('maxLength', '500')
    const send = within(dialog).getByRole('button', { name: 'Enviar' })
    expect(send).toBeDisabled()
    fireEvent.change(field, { target: { value: '  Faltam 10 minutos  ' } })
    await act(async () => { fireEvent.click(send) })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Sem conexão com o servidor.')
    expect(field).toHaveValue('  Faltam 10 minutos  ')
    await act(async () => { fireEvent.click(send) })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Mensagem para o aluno' })).toBeNull())
    const sent = posts('/api/admin/send-broadcast-message')
    expect(sent).toHaveLength(2)
    expect(sent[1][1]).toMatchObject({ targetEmail: 'elisa@x.local', messageText: 'Faltam 10 minutos', applicationId: 'app-antiga' })
    expect(mocks.toast.success).toHaveBeenCalledWith('Aviso enviado')
  })

  it('Aviso turma: o diálogo diz que vai para todos e envia sem aluno', async () => {
    renderMonitor()
    fireEvent.click(await screen.findByRole('button', { name: 'Aviso turma' }))
    const dialog = screen.getByRole('dialog', { name: 'Aviso para a turma' })
    fireEvent.change(within(dialog).getByLabelText('Mensagem'), { target: { value: 'Confira se respondeu todas' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar' })) })
    await waitFor(() => expect(posts('/api/admin/send-broadcast-message')).toHaveLength(1))
    expect(posts('/api/admin/send-broadcast-message')[0][1]).toMatchObject({ targetEmail: null, messageText: 'Confira se respondeu todas' })
  })

  it('Versão: começa na versão atual, vai em maiúscula e Cancelar não envia', async () => {
    renderMonitor()
    fireEvent.click(await screen.findByRole('button', { name: 'B' }))
    let dialog = screen.getByRole('dialog', { name: 'Versão da prova do aluno' })
    expect(within(dialog).getByLabelText('Versão')).toHaveValue('B')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(posts('/api/admin/assign-student-version')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    dialog = screen.getByRole('dialog', { name: 'Versão da prova do aluno' })
    fireEvent.change(within(dialog).getByLabelText('Versão'), { target: { value: '   ' } })
    expect(within(dialog).getByRole('button', { name: 'Atribuir versão' })).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Versão'), { target: { value: ' c ' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Atribuir versão' })) })
    await waitFor(() => expect(posts('/api/admin/assign-student-version')).toHaveLength(1))
    expect(posts('/api/admin/assign-student-version')[0][1]).toMatchObject({ studentEmail: 'elisa@x.local', version: 'C', applicationId: 'app-antiga' })
  })
})

// Fase 3, P3-S8 (AVA-14, UXI-05; D18 e D20 do P3): ações por aluno no menu "Mais ações"
// (recolher, reabrir e tentativa extra) e os diálogos próprios do Monitor.
describe('[UC-TENTATIVA-004] MonitorPage · ações por aluno e diálogos próprios', () => {
  const base = { email: 'elisa@x.local', name: 'Elisa', status: 'online', attemptNumber: 1, maxAttempts: 1, deliveredAttempts: 0, attemptInProgress: true, progress: '1/4', keystrokeCount: 0, logs: [], logCount: 0, assignedVersion: 'B' }
  let row = base
  let list = applications
  const renderMonitor = () => render(
    <MemoryRouter initialEntries={['/monitor?courseId=C1&className=1DES&examKey=Avaliacao_Antiga&applicationId=app-antiga']}>
      <Routes><Route path="/monitor" element={<MonitorPage />} /></Routes>
    </MemoryRouter>,
  )
  const posts = (path) => mocks.post.mock.calls.filter(([url]) => url === path)
  const actionUrl = '/api/admin/exam-applications/app-antiga/attempt-action'
  let nativeSpies = []

  beforeEach(() => {
    vi.clearAllMocks()
    row = base
    list = applications
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/admin/exam-applications?')) return { applications: list }
      if (url.startsWith('/api/admin/monitor-status/')) return [row]
      if (url.startsWith('/api/admin/question-reports/')) return { groups: [], totalOpen: 0 }
      if (url.startsWith('/api/admin/message-history?')) return { messages: [] }
      return {}
    })
    mocks.post.mockResolvedValue({ success: true })
    nativeSpies = ['prompt', 'confirm', 'alert'].map((name) => vi.spyOn(window, name).mockImplementation(() => { throw new Error(`window.${name}`) }))
  })
  afterEach(() => {
    for (const spy of nativeSpies) {
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }
    mocks.liveApplications = null
    cleanup()
  })

  async function openMenuItem(name) {
    fireEvent.click(await screen.findByRole('button', { name: 'Mais ações de Elisa' }))
    fireEvent.click(screen.getByRole('menuitem', { name }))
  }

  it('Recolher prova: Cancelar não envia; confirmar manda recolher com o motivo opcional', async () => {
    mocks.post.mockResolvedValue({ success: true, submission: { answeredCount: 3 } })
    renderMonitor()
    await openMenuItem('Recolher prova')
    let dialog = screen.getByRole('dialog', { name: 'Recolher a prova de Elisa?' })
    expect(dialog).toHaveTextContent('respostas que o servidor já salvou (1/4 respondidas)')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(posts(actionUrl)).toHaveLength(0)

    await openMenuItem('Recolher prova')
    dialog = screen.getByRole('dialog', { name: 'Recolher a prova de Elisa?' })
    fireEvent.change(within(dialog).getByLabelText('Motivo (opcional)'), { target: { value: 'Saiu da sala' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Recolher prova' })) })
    await waitFor(() => expect(posts(actionUrl)).toHaveLength(1))
    expect(posts(actionUrl)[0][1]).toEqual({ action: 'recolher', studentEmail: 'elisa@x.local', motivo: 'Saiu da sala' })
    expect(mocks.toast.success).toHaveBeenCalledWith('Prova de Elisa recolhida com 3 respostas salvas.')
    expect(screen.queryByRole('dialog', { name: 'Recolher a prova de Elisa?' })).toBeNull()
  })

  it('Recolher tentativa já vencida: o aviso do servidor fecha o diálogo', async () => {
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('O tempo deste aluno já tinha terminado.'), { status: 409, data: { attemptFinalized: true } }))
    renderMonitor()
    await openMenuItem('Recolher prova')
    const dialog = screen.getByRole('dialog', { name: 'Recolher a prova de Elisa?' })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Recolher prova' })) })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recolher a prova de Elisa?' })).toBeNull())
    expect(mocks.toast.info).toHaveBeenCalledWith('O tempo deste aluno já tinha terminado.')
  })

  it('Reabrir prova: só aparece quando a entrega pode voltar, pede o motivo e o erro fica no diálogo', async () => {
    row = { ...base, status: 'finished', attemptInProgress: false, canReopen: true }
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('A nota desta entrega já foi publicada.'), { status: 409, data: { code: 'grade_published' } }))
    renderMonitor()
    fireEvent.click(await screen.findByRole('button', { name: 'Mais ações de Elisa' }))
    expect(screen.queryByRole('menuitem', { name: 'Recolher prova' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reabrir prova' }))
    const dialog = screen.getByRole('dialog', { name: 'Reabrir a prova de Elisa?' })
    expect(dialog).toHaveTextContent('o tempo que faltava')
    const confirm = within(dialog).getByRole('button', { name: 'Reabrir prova' })
    expect(confirm).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Motivo'), { target: { value: 'Queda de energia' } })
    await act(async () => { fireEvent.click(confirm) })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('A nota desta entrega já foi publicada.')
    mocks.post.mockResolvedValueOnce({ success: true, state: { remainingMinutes: 12 } })
    await act(async () => { fireEvent.click(confirm) })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Reabrir a prova de Elisa?' })).toBeNull())
    expect(posts(actionUrl).at(-1)[1]).toEqual({ action: 'reabrir', studentEmail: 'elisa@x.local', motivo: 'Queda de energia' })
    expect(mocks.toast.success).toHaveBeenCalledWith('Prova de Elisa reaberta com 12 min para terminar.')
  })

  it('Tentativa extra: número de 1 a 5 e motivo opcional; sem limite de tentativas o item não aparece', async () => {
    row = { ...base, status: 'finished', attemptInProgress: false }
    mocks.post.mockResolvedValue({ success: true, extraAttempts: 2, maxAttempts: 3 })
    renderMonitor()
    await openMenuItem('Dar tentativa extra')
    const dialog = screen.getByRole('dialog', { name: 'Dar tentativa extra a Elisa?' })
    const field = within(dialog).getByLabelText('Tentativas a mais')
    expect(field).toHaveValue(1)
    const confirm = within(dialog).getByRole('button', { name: 'Dar tentativa extra' })
    for (const value of ['0', '6', '', '1.5']) {
      fireEvent.change(field, { target: { value } })
      expect(confirm).toBeDisabled()
    }
    fireEvent.change(field, { target: { value: '2' } })
    await act(async () => { fireEvent.click(confirm) })
    await waitFor(() => expect(posts(actionUrl)).toHaveLength(1))
    expect(posts(actionUrl)[0][1]).toEqual({ action: 'tentativa_extra', studentEmail: 'elisa@x.local', extraAttempts: 2 })
    expect(mocks.toast.success).toHaveBeenCalledWith('Elisa pode fazer 3 tentativas nesta aplicação.')
    cleanup()

    row = { ...base, status: 'finished', attemptInProgress: false, maxAttempts: null }
    renderMonitor()
    await screen.findByRole('button', { name: 'Msg' })
    expect(screen.queryByRole('button', { name: 'Mais ações de Elisa' })).toBeNull()
    cleanup()

    // A4, ajuste 1: aluno desligado (Transferido) não recebe a oferta de tentativa extra.
    row = { ...base, status: 'finished', attemptInProgress: false, activeStudent: false }
    renderMonitor()
    await screen.findByRole('button', { name: 'Msg' })
    expect(screen.queryByRole('button', { name: 'Mais ações de Elisa' })).toBeNull()
  })

  it('aplicação encerrada não mostra o menu; a linha reaberta pelo professor diz isso', async () => {
    row = { ...base, reopenedAt: '2026-11-20T10:00:00.000Z', reopenedByInstructor: true }
    renderMonitor()
    expect(await screen.findByText('Reaberta pelo professor')).toBeVisible()
    cleanup()
    list = applications.map((item) => (item.id === 'app-antiga' ? { ...item, status: 'finished' } : item))
    mocks.liveApplications = list
    renderMonitor()
    await screen.findByRole('button', { name: 'Ver respostas' })
    expect(screen.queryByRole('button', { name: 'Mais ações de Elisa' })).toBeNull()
  })

  it('Mensagem: modelos prontos, várias linhas e o destinatário', async () => {
    renderMonitor()
    fireEvent.click(await screen.findByRole('button', { name: 'Msg' }))
    const dialog = screen.getByRole('dialog', { name: 'Mensagem para o aluno' })
    expect(dialog).toHaveTextContent('Para: Elisa (elisa@x.local)')
    for (const template of ['Faltam 10 minutos', 'Confira se respondeu todas', 'Levante a mão se precisar de ajuda']) {
      expect(within(dialog).getByRole('button', { name: template })).toBeVisible()
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Levante a mão se precisar de ajuda' }))
    const field = within(dialog).getByLabelText('Mensagem')
    expect(field).toHaveValue('Levante a mão se precisar de ajuda')
    fireEvent.change(field, { target: { value: 'Linha 1\nLinha 2' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar' })) })
    await waitFor(() => expect(posts('/api/admin/send-broadcast-message')).toHaveLength(1))
    expect(posts('/api/admin/send-broadcast-message')[0][1]).toMatchObject({ targetEmail: 'elisa@x.local', messageText: 'Linha 1\nLinha 2' })
    cleanup()
    renderMonitor()
    fireEvent.click(await screen.findByRole('button', { name: 'Aviso turma' }))
    expect(screen.getByRole('dialog', { name: 'Aviso para a turma' })).toHaveTextContent('Para: todos os alunos desta aplicação (1)')
  })

  it('Aviso para a turma conta só os alunos ativos (desligado e anonimizado ficam fora da contagem)', async () => {
    const fallback = mocks.get.getMockImplementation()
    const finished = { ...base, status: 'finished', attemptInProgress: false, deliveredAttempts: 1 }
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/monitor-status/')
      ? [
          row,
          { ...finished, email: 'lucas@x.local', name: 'Lucas Transferido', activeStudent: false },
          { ...finished, email: 'anon_1@anonimizado.invalid', name: 'Aluno anonimizado', activeStudent: false },
          { ...base, email: 'bia@x.local', name: 'Bia', activeStudent: true },
        ]
      : fallback(url)))
    renderMonitor()
    await screen.findAllByText('Lucas Transferido')
    fireEvent.click(await screen.findByRole('button', { name: 'Aviso turma' }))
    expect(screen.getByRole('dialog', { name: 'Aviso para a turma' })).toHaveTextContent('Para: todos os alunos desta aplicação (2)')
  })

  it('Tempo: atalhos −5, +5 e +10 trocam o valor e o motivo opcional vai junto', async () => {
    renderMonitor()
    fireEvent.click(await screen.findByRole('button', { name: 'Tempo' }))
    const dialog = screen.getByRole('dialog', { name: 'Ajustar o tempo do aluno' })
    fireEvent.click(within(dialog).getByRole('button', { name: '+10 min' }))
    expect(within(dialog).getByLabelText('Minutos')).toHaveValue(10)
    expect(within(dialog).getByRole('button', { name: '+10 min' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(dialog).getByRole('button', { name: '\u22125 min' }))
    expect(within(dialog).getByLabelText('Minutos')).toHaveValue(-5)
    fireEvent.click(within(dialog).getByRole('button', { name: '+5 min' }))
    fireEvent.change(within(dialog).getByLabelText('Motivo (opcional)'), { target: { value: 'Laudo' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Ajustar tempo' })) })
    await waitFor(() => expect(posts('/api/admin/adjust-student-time')).toHaveLength(1))
    expect(posts('/api/admin/adjust-student-time')[0][1]).toMatchObject({ targetEmail: 'elisa@x.local', adjustmentMinutes: 5, reason: 'Laudo' })
  })

  it('Versão: só as versões que a aplicação tem', async () => {
    list = applications.map((item) => (item.id === 'app-antiga' ? { ...item, versionLabels: ['A', 'B', 'C'] } : item))
    mocks.liveApplications = list
    renderMonitor()
    fireEvent.click(await screen.findByRole('button', { name: 'B' }))
    const dialog = screen.getByRole('dialog', { name: 'Versão da prova do aluno' })
    const select = within(dialog).getByLabelText('Versão')
    expect(select.tagName).toBe('SELECT')
    expect([...select.options].map((option) => option.value)).toEqual(['A', 'B', 'C'])
    expect(select).toHaveValue('B')
    fireEvent.change(select, { target: { value: 'C' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Atribuir versão' })) })
    await waitFor(() => expect(posts('/api/admin/assign-student-version')).toHaveLength(1))
    expect(posts('/api/admin/assign-student-version')[0][1]).toMatchObject({ version: 'C' })
  })

  it('Liberar notas: conta as notas e deixa de fora as que aguardam correção', async () => {
    list = applications.map((item) => (item.id === 'app-antiga' ? { ...item, status: 'finished' } : item))
    mocks.liveApplications = list
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/admin/exam-applications?')) return { applications: list }
      if (url.startsWith('/api/admin/monitor-status/')) return [row]
      if (url.startsWith('/api/admin/question-reports/')) return { groups: [], totalOpen: 0 }
      if (url.startsWith('/api/admin/submissions?')) {
        return [
          { id: 's1', applicationId: 'app-antiga', gradePublished: false },
          { id: 's2', applicationId: 'app-antiga', gradePublished: false, correcao: { situacao: 'pendente' } },
          { id: 's3', applicationId: 'app-antiga', gradePublished: false, correcao: { situacao: 'concluida' } },
          { id: 's4', applicationId: 'app-antiga', gradePublished: true },
        ]
      }
      return {}
    })
    mocks.post.mockResolvedValue({ updated: 2 })
    renderMonitor()
    fireEvent.click(await screen.findByRole('button', { name: 'Liberar nota para o aluno' }))
    const dialog = screen.getByRole('dialog', { name: 'Liberar as notas desta aplicação?' })
    await waitFor(() => expect(dialog).toHaveTextContent('2 notas serão liberadas'))
    expect(dialog).toHaveTextContent('1 entrega aguardando correção fica de fora.')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Liberar notas' })) })
    await waitFor(() => expect(posts('/api/admin/submissions/publish')).toHaveLength(1))
    expect(posts('/api/admin/submissions/publish')[0][1]).toEqual({ ids: ['s1', 's3'], published: true })
    expect(mocks.toast.success).toHaveBeenCalledWith('2 notas liberadas para os alunos.')
  })
})

describe('[UC-LGPD-009] MonitorPage · coluna do teclado conforme a aplicação', () => {
  const row = { email: 'elisa@x.local', name: 'Elisa', status: 'online', attemptNumber: 1, maxAttempts: 1, deliveredAttempts: 0, attemptInProgress: true, progress: '1/4', logs: [], keystrokeCount: 3, suspiciousCount: 3 }
  function renderWith(keystrokeMode, extra = {}) {
    const list = applications.map((item) => (item.id === 'app-antiga' ? { ...item, ...(keystrokeMode ? { keystrokeMode } : {}), ...extra } : item))
    mocks.liveApplications = list
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/admin/exam-applications?')) return { applications: list }
      if (url.startsWith('/api/admin/monitor-status/')) return [row]
      if (url.startsWith('/api/admin/question-reports/')) return { groups: [], totalOpen: 0 }
      return {}
    })
    render(
      <MemoryRouter initialEntries={['/monitor?courseId=C1&className=1DES&examKey=Avaliacao_Antiga&applicationId=app-antiga']}>
        <Routes><Route path="/monitor" element={<MonitorPage />} /></Routes>
      </MemoryRouter>,
    )
  }
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup(); mocks.liveApplications = null })

  it('aplicação sem o campo (padrão) mostra "Atalhos"', async () => {
    renderWith(undefined)
    await waitFor(() => expect(screen.getByText('Elisa')).toBeTruthy())
    expect(screen.getByRole('columnheader', { name: 'Atalhos' })).toBeTruthy()
    expect(screen.getByTitle('Ver atalhos ao vivo')).toBeTruthy()
  })

  it('aplicação de antes desta versão (keystrokeModeLegacy): "Teclado", porque guardou toda a digitação', async () => {
    renderWith('eventos', { keystrokeModeLegacy: true })
    await waitFor(() => expect(screen.getByText('Elisa')).toBeTruthy())
    expect(screen.getByRole('columnheader', { name: 'Teclado' })).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: 'Atalhos' })).toBeNull()
    expect(screen.queryByTitle('Ver atalhos ao vivo')).toBeNull()
    expect(screen.getByTitle(/^Ver teclado ao vivo \(aplicação de antes desta versão/)).toBeTruthy()
    expect(screen.queryByText('Desligado')).toBeNull()
  })

  it('"tudo" mostra "Digitação"; "nada" mostra "Teclado" com "Desligado", sem a janela ao vivo', async () => {
    renderWith('tudo')
    await waitFor(() => expect(screen.getByText('Elisa')).toBeTruthy())
    expect(screen.getByRole('columnheader', { name: 'Digitação' })).toBeTruthy()
    expect(screen.getByTitle('Ver digitação ao vivo')).toBeTruthy()
    cleanup()
    renderWith('nada')
    await waitFor(() => expect(screen.getByText('Elisa')).toBeTruthy())
    expect(screen.getByRole('columnheader', { name: 'Teclado' })).toBeTruthy()
    expect(screen.getByText('Desligado')).toBeTruthy()
    expect(screen.queryByTitle(/ao vivo/)).toBeNull()
  })

  it('janela ao vivo: título e texto sem eventos seguem o modo (decisões §12, sobra do H8b)', async () => {
    renderWith(undefined)
    await waitFor(() => expect(screen.getByText('Elisa')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Ver atalhos ao vivo'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Atalhos ao vivo — Elisa' })).toBeTruthy())
    fireEvent.click(screen.getByText('Fluxo completo'))
    await waitFor(() => expect(screen.getByText('Nenhum atalho registrado ainda.')).toBeTruthy())
    cleanup()
    renderWith('tudo')
    await waitFor(() => expect(screen.getByText('Elisa')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Ver digitação ao vivo'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Digitação ao vivo — Elisa' })).toBeTruthy())
    fireEvent.click(screen.getByText('Fluxo completo'))
    await waitFor(() => expect(screen.getByText('Nenhuma digitação registrada ainda.')).toBeTruthy())
    // 'nada' não abre a janela pelo Monitor; o texto, se aberta, é o do modo.
    expect(keystrokeLiveTitle('nada', false, 'Elisa')).toBe('Teclado — Elisa')
    expect(keystrokeLiveEmptyText('nada')).toBe('Registro de teclado desligado nesta prova.')
    expect(keystrokeLiveTitle('eventos', true, 'Elisa')).toBe('Digitação ao vivo — Elisa')
  })
})

// Rodada de ajuste do A5: colar pelo menu da resposta escrita chega como evento 'paste'
// (kind 'clipboard'); no Monitor ele é "Colou conteúdo", e não "Cópia bloqueada".
describe('[UC-LGPD-009] Monitor: colar pelo menu da resposta escrita', () => {
  it('evento paste vira "Colou conteúdo" e conta como colagem; copiar e recortar continuam bloqueados', () => {
    expect(classifyKeystroke({ kind: 'clipboard', key: 'paste' })).toMatchObject({ reason: 'colar', label: 'Colou conteúdo' })
    expect(classifyKeystroke({ kind: 'clipboard', key: 'copy' })).toMatchObject({ reason: 'clipboard', label: 'Cópia bloqueada' })
    expect(classifyKeystroke({ kind: 'clipboard', key: 'cut' })).toMatchObject({ reason: 'clipboard', label: 'Recorte bloqueado' })
  })
})
