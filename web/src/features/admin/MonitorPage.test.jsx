import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MonitorPage from './MonitorPage'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
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
    if (String(path).startsWith('/api/admin/exam-applications')) return { data: { applications }, refetch: vi.fn(), loading: false }
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
