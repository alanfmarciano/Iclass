import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AlunoDetailPage from './AlunoDetailPage'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  printBoletim: vi.fn(() => true),
  auth: { accountRole: 'admin' },
}))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: vi.fn() } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => ({ courseId: 'OUTRO', courseName: 'Outro curso', className: 'X' }),
}))
vi.mock('./boletimPrint', () => ({ printBoletim: mocks.printBoletim }))
vi.mock('../../components/ui/MonthCalendar', () => ({ MonthCalendar: () => null }))
vi.mock('../../hooks/useApi', () => ({
  useApi: () => ({
    data: [{ name: 'Bia', email: 'bia@x.local', status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }, { name: '2RED', courseId: 'RED' }] }],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

beforeEach(() => {
  mocks.auth = { accountRole: 'admin' }
  mocks.get.mockImplementation(async (path) => {
    if (path.startsWith('/api/admin/course-summaries')) return [{ id: 'DES', name: 'Técnico em Desenvolvimento' }, { id: 'RED', name: 'Técnico em Redes' }]
    if (path.startsWith('/api/admin/student/report')) return { student: { name: 'Bia' }, modules: [] }
    if (path.startsWith('/api/admin/student/audit')) return []
    if (path.startsWith('/api/admin/student/academic')) return { submissions: [], progress: { completedCount: 0 }, moduleAccess: [], attendance: { count: 0, recent: [] }, certificates: [] }
    return null
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Ficha do aluno · boletim', () => {
  it('[UC-NOTAS-003] aluno em dois cursos fora do curso ativo: o seletor mostra o nome do curso e envia o curso escolhido', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: 'Boletim (PDF)' }))
    const dialog = await screen.findByRole('dialog', { name: 'Boletim de qual curso?' })
    const redes = within(dialog).getByRole('button', { name: 'Turma 2RED · Técnico em Redes' })
    expect(within(dialog).getByRole('button', { name: 'Turma 1DES · Técnico em Desenvolvimento' })).toBeInTheDocument()
    expect(within(dialog).queryByText(/· RED$/)).not.toBeInTheDocument()
    await user.click(redes)
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/student/report?email=bia%40x.local&courseId=RED&studentClass=2RED'))
    expect(mocks.printBoletim).toHaveBeenCalled()
  })

  it('[UC-NOTAS-003] professor: matrícula em curso fora do seu escopo aparece desativada, sem o id técnico', async () => {
    const user = userEvent.setup()
    mocks.auth = { accountRole: 'professor' }
    const fallback = mocks.get.getMockImplementation()
    mocks.get.mockImplementation(async (path) => (path.startsWith('/api/admin/course-summaries')
      ? [{ id: 'DES', name: 'Técnico em Desenvolvimento', classes: [{ name: '1DES' }] }]
      : fallback(path)))
    render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: 'Boletim (PDF)' }))
    const dialog = await screen.findByRole('dialog', { name: 'Boletim de qual curso?' })
    expect(within(dialog).getByRole('button', { name: 'Turma 2RED · curso fora do seu acesso' })).toBeDisabled()
    expect(within(dialog).queryByText(/RED$/)).not.toBeInTheDocument()
    const des = within(dialog).getByRole('button', { name: 'Turma 1DES · Técnico em Desenvolvimento' })
    expect(des).toBeEnabled()
    await user.click(des)
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/student/report?email=bia%40x.local&courseId=DES&studentClass=1DES'))
  })
})

describe('Ficha do aluno · notas com vírgula', () => {
  it('[UC-NOTAS-003] desempenho por módulo, comparativo e média do mês aparecem com vírgula (antes "7.8", "7.5 vs 6.3")', async () => {
    const fallback = mocks.get.getMockImplementation()
    mocks.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/admin/student/academic')) {
        return {
          submissions: [
            { id: 's1', examKey: 'Avaliacao_FUTEC_1', score: 75, timestamp: '2026-03-01T12:00:00.000Z' },
            { id: 's2', examKey: 'Avaliacao_FUTEC_2', score: 80, timestamp: '2026-03-10T12:00:00.000Z' },
          ],
          progress: { completedCount: 0 }, moduleAccess: [], attendance: { count: 0, recent: [] }, certificates: [],
        }
      }
      if (path.startsWith('/api/admin/student/dashboard')) {
        return {
          kpis: { media: 7.75, provasFeitas: 2, provasTotais: 4, frequencia: 90, progresso: 10 },
          comparativo: { studentMedia: 7.75, turmaMedia: 6.84, studentFreq: 90, turmaFreq: 85, turmaSize: 12 },
          risco: { level: 'baixo', reasons: [] },
          engajamento: { weeks: [], diasAtivos: 3 },
          streak: { atual: 1, recorde: 2 },
          temporal: { mediaAtual: 7.5, mediaAnterior: 6.25, presencaAtual: 3, presencaAnterior: 2 },
          modulos: [{ id: 'm1', modulo: 'FUTEC', media: 7.75 }],
        }
      }
      return fallback(path)
    })
    render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('7,5 vs 6,3')).toBeInTheDocument()
    expect(screen.getByText('aluno 7,8 · turma 6,8')).toBeInTheDocument()
    const modulo = screen.getByText('Desempenho por módulo').closest('div').parentElement
    expect(within(modulo).getByText('7,8')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/\b\d\.\d\b/)
    // A média da ficha é a da matrícula no curso/turma ativos (consolidada no servidor).
    expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/admin\/student\/dashboard\?email=bia%40x\.local&courseId=OUTRO&studentClass=X$/))
  })
})

describe('Ficha do aluno · desempenho por módulo', () => {
  it('[UC-NOTAS-003] mostra a média por módulo do servidor, igual à "Média geral", e não a média simples das tentativas', async () => {
    const fallback = mocks.get.getMockImplementation()
    mocks.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/admin/student/academic')) {
        // Média simples destas tentativas: (6,0 + 6,8 + 2,0 + 10,0) / 4 = 6,2.
        return {
          submissions: [
            { id: 's1', examKey: 'Avaliacao_IRCOM_1', score: 60, timestamp: '2026-03-01T12:00:00.000Z' },
            { id: 's2', examKey: 'Avaliacao_IRCOM_1', score: 68, timestamp: '2026-03-01T12:30:00.000Z' },
            { id: 's3', examKey: 'Avaliacao_IRCOM_1', score: 20, timestamp: '2026-03-02T12:00:00.000Z' },
            { id: 's4', examKey: 'Avaliacao_IRCOM_1', score: 100, timestamp: '2026-03-03T12:00:00.000Z' },
          ],
          progress: { completedCount: 0 }, moduleAccess: [], attendance: { count: 0, recent: [] }, certificates: [],
        }
      }
      if (path.startsWith('/api/admin/student/dashboard')) {
        return {
          kpis: { media: 8.4, provasFeitas: 1, provasTotais: 2, frequencia: 90, progresso: 10 },
          comparativo: { studentMedia: 8.4, turmaMedia: 7, studentFreq: 90, turmaFreq: 85, turmaSize: 12 },
          risco: { level: 'baixo', reasons: [] },
          engajamento: { weeks: [], diasAtivos: 3 },
          streak: { atual: 1, recorde: 2 },
          temporal: { mediaAtual: null, mediaAnterior: null, presencaAtual: 3, presencaAnterior: 2 },
          modulos: [{ id: 'm1', modulo: 'IRCOM — Redes', media: 8.4 }],
        }
      }
      return fallback(path)
    })
    render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    const label = await screen.findByText('IRCOM — Redes')
    const card = screen.getByText('Desempenho por módulo').closest('div').parentElement
    expect(within(card).getByText('8,4')).toBeInTheDocument()
    expect(within(card).queryByText('6,2')).not.toBeInTheDocument()
    expect(label).toBeInTheDocument()
  })

  it('[UC-NOTAS-003] sem a resposta do servidor não inventa média no navegador', async () => {
    const fallback = mocks.get.getMockImplementation()
    mocks.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/admin/student/academic')) {
        return {
          submissions: [{ id: 's1', examKey: 'Avaliacao_IRCOM_1', score: 60, timestamp: '2026-03-01T12:00:00.000Z' }],
          progress: { completedCount: 0 }, moduleAccess: [], attendance: { count: 0, recent: [] }, certificates: [],
        }
      }
      if (path.startsWith('/api/admin/student/dashboard')) throw new Error('falhou')
      return fallback(path)
    })
    render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    const card = (await screen.findByText('Desempenho por módulo')).closest('div').parentElement
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/admin\/student\/dashboard/)))
    expect(within(card).getByText('Sem notas ainda.')).toBeInTheDocument()
    const kpi = screen.getByText('Média geral').parentElement
    expect(within(kpi).getByText('—')).toBeInTheDocument()
    expect(within(kpi).queryByText('6,0')).not.toBeInTheDocument()
  })
})
