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
