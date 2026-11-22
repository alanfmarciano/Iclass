import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AlunosGlobalPage from './AlunosGlobalPage'

const mocks = vi.hoisted(() => ({ auth: {} }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))

// Diretório de alunos (/diretorio): o filtro de situação acha os anonimizados (H7c) e
// compara sem acento ("Concluido" de banco antigo entra em Concluído).
const STUDENTS = [
  { name: 'Ana Ativa', email: 'ana@x.local', status: 'Ativo', classes: [] },
  { name: 'Aluno anonimizado AAAAAA', email: 'anonimizado-aaa@anonimizado.invalid', status: 'Anonimizado', classes: [] },
  { name: 'Carla Antiga', email: 'carla@x.local', status: 'Concluido', classes: [] },
]
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => ({ data: String(path).startsWith('/api/admin/students?') ? STUDENTS : [], loading: false, error: null, refetch: vi.fn() }),
}))
afterEach(cleanup)

function renderPage(url = '/diretorio') {
  return render(<MemoryRouter initialEntries={[url]}><AlunosGlobalPage /></MemoryRouter>)
}

describe('[UC-ENCERRADOS-003] Diretório: situação Anonimizado e situação sem acento', () => {
  it('o filtro tem Anonimizado e acha o cadastro anonimizado', async () => {
    renderPage()
    const filter = screen.getByLabelText('Situação')
    expect(within(filter).getByRole('option', { name: 'Anonimizado' })).toBeTruthy()
    await userEvent.selectOptions(filter, 'Anonimizado')
    expect(screen.getByText('Aluno anonimizado AAAAAA')).toBeTruthy()
    expect(screen.queryByText('Ana Ativa')).toBeNull()
  })

  it('Concluído acha a situação antiga "Concluido"', () => {
    renderPage('/diretorio?situacao=Conclu%C3%ADdo')
    expect(screen.getByText('Carla Antiga')).toBeTruthy()
    expect(screen.queryByText('Ana Ativa')).toBeNull()
  })
})

describe('[UC-PAPEIS-001] Diretório: Novo aluno e ações em lote só com students.edit', () => {
  afterEach(() => { mocks.auth = {} })

  it('o administrador vê Novo aluno e a seleção em lote', () => {
    renderPage()
    expect(screen.getByRole('button', { name: 'Novo aluno' })).toBeTruthy()
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0)
  })

  it('a Coordenação (só consulta) lista os alunos sem Novo aluno nem seleção para matricular ou mudar a situação', () => {
    mocks.auth = { accountRole: 'coordenacao', readOnly: true, effectivePermissions: ['page.dashboard', 'page.classes', 'page.students', 'page.results', 'page.forum', 'page.assignments', 'reports.view'] }
    renderPage()
    expect(screen.getByText('Ana Ativa')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Novo aluno' })).toBeNull()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Matricular em turma' })).toBeNull()
  })
})
