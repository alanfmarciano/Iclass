import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AlunosPage from './AlunosPage'

// Alunos da turma (/alunos) por papel (B1, contrato C2 do P4): criar, alterar e redefinir a
// senha pedem students.edit; o histórico de provas vem de Resultados (page.results).
const mocks = vi.hoisted(() => ({ auth: {}, paths: [] }))
const STUDENTS = [{ name: 'Ana Souza', email: 'ana@x.local', status: 'Ativo', classes: [{ name: '1DES', courseId: 'C1' }] }]
const CLASSES = [{ name: '1DES', courseId: 'C1' }]

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(async () => ({})), post: vi.fn() } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({ useAdminWorkspace: () => ({ courseId: 'C1', courseName: 'Curso', className: '1DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => {
    mocks.paths.push(path)
    const ok = (data) => ({ data, loading: false, error: null, refetch: vi.fn() })
    if (String(path).startsWith('/api/admin/students?')) return ok(STUDENTS)
    if (String(path).startsWith('/api/admin/classes?')) return ok(CLASSES)
    return ok(path ? [] : null)
  },
}))
afterEach(() => { mocks.auth = {}; mocks.paths = []; cleanup() })

const COORDENACAO = { accountRole: 'coordenacao', readOnly: true, effectivePermissions: ['page.dashboard', 'page.classes', 'page.students', 'page.results', 'page.forum', 'page.assignments', 'reports.view'] }
const MONITOR = { accountRole: 'monitor', effectivePermissions: ['page.dashboard', 'page.classes', 'page.students', 'page.monitor'] }

async function openMenu() {
  render(<MemoryRouter><AlunosPage /></MemoryRouter>)
  await userEvent.click(screen.getByRole('button', { name: 'Ações' }))
  return within(screen.getByRole('dialog'))
}

describe('[UC-PAPEIS-001] Alunos da turma: ações de cadastro só com students.edit', () => {
  it('o professor cria, edita e redefine a senha', async () => {
    mocks.auth = { accountRole: 'professor' }
    const menu = await openMenu()
    expect(screen.getByRole('button', { name: 'Novo aluno' })).toBeInTheDocument()
    expect(menu.getByRole('button', { name: 'Editar' })).toBeInTheDocument()
    expect(menu.getByRole('button', { name: 'Redefinir senha' })).toBeInTheDocument()
    expect(menu.getByRole('button', { name: 'Histórico' })).toBeInTheDocument()
  })

  it('a Coordenação (só consulta) não vê Novo aluno, Editar nem Redefinir senha', async () => {
    mocks.auth = COORDENACAO
    const menu = await openMenu()
    expect(screen.queryByRole('button', { name: 'Novo aluno' })).toBeNull()
    expect(menu.queryByRole('button', { name: 'Editar' })).toBeNull()
    expect(menu.queryByRole('button', { name: 'Redefinir senha' })).toBeNull()
    expect(menu.getByRole('button', { name: 'Histórico' })).toBeInTheDocument()
  })

  it('o Professor auxiliar também não, e sem o Histórico de provas (nem a consulta a Resultados)', async () => {
    mocks.auth = MONITOR
    const menu = await openMenu()
    expect(screen.queryByRole('button', { name: 'Novo aluno' })).toBeNull()
    expect(menu.queryByRole('button', { name: 'Editar' })).toBeNull()
    expect(menu.queryByRole('button', { name: 'Redefinir senha' })).toBeNull()
    expect(menu.queryByRole('button', { name: 'Histórico' })).toBeNull()
    expect(mocks.paths.some((path) => String(path).startsWith('/api/admin/submissions'))).toBe(false)
  })
})
