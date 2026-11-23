import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TurmasPage from './TurmasPage'

// Criar, alterar, excluir e restaurar curso vão pelas rotas novas do painel
// (/api/admin/courses, SEG-12): as antigas (/api/courses) respondem 410.
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  get: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  apiData: {},
  auth: { role: 'admin', accountRole: 'admin' },
}))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post, put: mocks.put, delete: mocks.del } }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => ({ data: (path && mocks.apiData[path]) || null, loading: false, error: null, refetch: vi.fn() }),
}))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))

function renderPage() {
  return render(<MemoryRouter><TurmasPage /></MemoryRouter>)
}

describe('TurmasPage · cursos', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth = { role: 'admin', accountRole: 'admin' }
    mocks.apiData = {
      '/api/admin/course-summaries?includeDeleted=1': [
        { id: 'DES', name: 'Técnico em TI', description: 'Desenvolvimento', schoolId: 'escola-a', status: 'active', stats: { classCount: 1, studentCount: 3 } },
      ],
      '/api/admin/classes': [{ name: '1DES', courseId: 'DES', period: 'Manhã' }],
      '/api/admin/schools': [{ id: 'escola-a', name: 'Escola A' }, { id: 'escola-b', name: 'Escola B' }],
      '/api/admin/accounts': [],
      '/api/admin/archived-courses': [],
    }
    mocks.post.mockResolvedValue({ success: true, course: { id: 'NOVO' } })
    mocks.put.mockResolvedValue({ success: true })
    mocks.del.mockResolvedValue({ success: true })
  })
  afterEach(cleanup)

  it('[UC-CURSO-001] "Novo curso" cria pelo painel (/api/admin/courses), sem mandar a estrutura', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Novo curso' }))
    const dialog = screen.getByRole('dialog', { name: 'Novo curso' })
    await user.type(within(dialog).getByLabelText('Código do curso'), 'novo')
    await user.type(within(dialog).getByLabelText('Nome'), 'Curso novo')
    await user.selectOptions(within(dialog).getByLabelText('Escola'), 'escola-b')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/courses', { id: 'NOVO', name: 'Curso novo', description: '', schoolId: 'escola-b' }))
    expect(mocks.post.mock.calls.some(([path]) => path === '/api/courses')).toBe(false)
  })

  it('[UC-CURSO-001] "Editar" e "Excluir" usam PUT e DELETE em /api/admin/courses/:id', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Editar' }))
    const dialog = screen.getByRole('dialog', { name: 'Editar curso' })
    const name = within(dialog).getByLabelText('Nome')
    await user.clear(name)
    await user.type(name, 'Técnico em Informática')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/admin/courses/DES', { name: 'Técnico em Informática', description: 'Desenvolvimento', schoolId: 'escola-a' }))

    await user.click(screen.getByRole('button', { name: 'Excluir' }))
    const confirm = screen.getByRole('dialog', { name: 'Excluir curso?' })
    // O curso excluído pode ser restaurado: o diálogo não diz mais que não tem volta (C0a).
    expect(confirm).toHaveTextContent('O curso ficará desativado e poderá ser restaurado.')
    expect(confirm).not.toHaveTextContent('não pode ser desfeita')
    await user.click(within(confirm).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('/api/admin/courses/DES', { timeoutMs: 0 }))
  })

  it('[UC-CURSO-001] "Restaurar" um curso excluído usa PUT em /api/admin/courses/:id', async () => {
    mocks.apiData['/api/admin/course-summaries?includeDeleted=1'] = [
      { id: 'OLD', name: 'Curso antigo', schoolId: 'escola-a', status: 'deleted', deleted: true, deletedAt: '2026-01-01T00:00:00Z' },
    ]
    const user = userEvent.setup()
    renderPage()
    await user.selectOptions(screen.getByLabelText('Filtrar por status'), 'deleted')
    await user.click(await screen.findByRole('button', { name: 'Restaurar' }))
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/admin/courses/OLD', { status: 'active', deleted: false, deletedAt: null }))
  })

  it('conta que não é administrador vê o total de professores da turma que o servidor manda (não "0 professor(es)")', async () => {
    const user = userEvent.setup()
    mocks.auth = { role: 'admin', accountRole: 'secretaria', effectivePermissions: ['page.classes'] }
    mocks.apiData['/api/admin/classes'] = [
      { name: '1DES', courseId: 'DES', period: 'Manhã', professorCount: 2 },
      { name: '2DES', courseId: 'DES', period: 'Tarde', professorCount: 0 },
    ]
    delete mocks.apiData['/api/admin/accounts']
    renderPage()
    await user.click(screen.getByRole('button', { name: /Técnico em TI/ }))
    expect(screen.getByText('2 professor(es)')).toBeInTheDocument()
    expect(screen.getByText('0 professor(es)')).toBeInTheDocument()
    expect(screen.getAllByText('Sem professor')).toHaveLength(1)
  })
})

// Período letivo da turma e disciplinas pela tela (B8 / P2-S8, FUN-05). Antes, o
// formulário da turma não tinha o seletor (o servidor já aceitava periodoLetivoId desde o
// B5), a turma não mostrava o período e "Período" era o rótulo do turno.
describe('TurmasPage · período letivo da turma', () => {
  const TERMS = {
    periodos: [
      { id: 'per_1', nome: '2027 · 1º semestre', inicio: '2027-02-01', fim: '2027-07-09', schoolId: null, situacao: 'aberto', etapas: [], turmas: [], totalTurmas: 0, podeAlterar: true },
      { id: 'per_b', nome: 'Período da Escola B', inicio: '2027-02-01', fim: '2027-07-09', schoolId: 'escola-b', situacao: 'aberto', etapas: [], turmas: [], totalTurmas: 0, podeAlterar: true },
      { id: 'per_0', nome: '2026 · 2º semestre', inicio: '2026-08-03', fim: '2026-12-18', schoolId: null, situacao: 'encerrado', etapas: [], turmas: [], totalTurmas: 1, podeAlterar: true },
    ],
    escolas: [],
    podeCriar: true,
  }
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth = { role: 'admin', accountRole: 'admin' }
    mocks.apiData = {
      '/api/admin/course-summaries?includeDeleted=1': [
        { id: 'DES', name: 'Técnico em TI', schoolId: 'escola-a', status: 'active', stats: { classCount: 2, studentCount: 3 }, structure: [{ id: 'M1', name: 'Redes' }],
          disciplinas: [{ id: 'REDES', nome: 'Redes', cor: '', cargaHoraria: 80, professor: 'Prof. Carlos', modulos: ['M1'] }] },
      ],
      '/api/admin/classes': [
        { name: '1DES', courseId: 'DES', period: 'Manhã', periodoLetivoId: 'per_0' },
        { name: '2DES', courseId: 'DES', period: 'Noite' },
      ],
      '/api/admin/schools': [{ id: 'escola-a', name: 'Escola A' }, { id: 'escola-b', name: 'Escola B' }],
      '/api/admin/accounts': [],
      '/api/admin/archived-courses': [],
      '/api/admin/academic/terms': TERMS,
    }
    mocks.post.mockResolvedValue({ success: true })
  })
  afterEach(cleanup)

  it('[UC-CURSO-002] cada turma mostra o período letivo dela ou "Sem período letivo"; a seção lista os períodos', () => {
    renderPage()
    expect(screen.getByText('2026 · 2º semestre · encerrado')).toBeVisible()
    // Há período aberto que serve ao curso: o selo é um aviso.
    expect(screen.getByText('Sem período letivo')).toHaveClass('text-warning')
    expect(screen.getByRole('list', { name: 'Períodos letivos' })).toHaveTextContent('2027 · 1º semestre')
    expect(screen.getByRole('button', { name: 'Novo período letivo' })).toBeVisible()
  })

  it('[UC-CURSO-002] o formulário da turma liga ao período (Turno é o Manhã/Tarde/Noite) e só manda o período quando ele muda', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Editar turma 2DES' }))
    let dialog = screen.getByRole('dialog', { name: 'Editar turma' })
    expect(within(dialog).getByLabelText('Turno')).toHaveValue('Noite')
    const select = within(dialog).getByLabelText('Período letivo')
    // Só o aberto da instituição: o da Escola B não vale para este curso e o encerrado não recebe turma.
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['Sem período letivo', '2027 · 1º semestre (01/02/2027 a 09/07/2027)'])
    await user.selectOptions(select, 'per_1')
    expect(within(dialog).getByText(/Aulas de 01\/02\/2027 a 09\/07\/2027/)).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/class/update', expect.objectContaining({ name: '2DES', courseId: 'DES', period: 'Noite', periodoLetivoId: 'per_1' })))

    // Sem mexer no período: o pedido não leva o campo (o servidor deixa como está).
    mocks.post.mockClear()
    await user.click(screen.getByRole('button', { name: 'Editar turma 1DES' }))
    dialog = screen.getByRole('dialog', { name: 'Editar turma' })
    expect(within(dialog).getByLabelText('Período letivo')).toHaveValue('per_0')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/class/update', expect.anything()))
    expect(mocks.post.mock.calls[0][1]).not.toHaveProperty('periodoLetivoId')

    // Tirar do período: null.
    mocks.post.mockClear()
    await user.click(screen.getByRole('button', { name: 'Editar turma 1DES' }))
    dialog = screen.getByRole('dialog', { name: 'Editar turma' })
    await user.selectOptions(within(dialog).getByLabelText('Período letivo'), '')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/class/update', expect.objectContaining({ name: '1DES', periodoLetivoId: null })))
  })

  it('[UC-CURSO-002] sem a lista de períodos (falhou), o seletor fica travado e o pedido não tira a turma do período', async () => {
    const user = userEvent.setup()
    delete mocks.apiData['/api/admin/academic/terms']
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Editar turma 1DES' }))
    const dialog = screen.getByRole('dialog', { name: 'Editar turma' })
    expect(within(dialog).getByLabelText('Período letivo')).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/class/update', expect.anything()))
    expect(mocks.post.mock.calls[0][1]).not.toHaveProperty('periodoLetivoId')
  })

  it('[UC-CURSO-002] "Nova turma" já pode nascer no período', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Nova turma' }))
    const dialog = screen.getByRole('dialog', { name: 'Nova turma' })
    await user.type(within(dialog).getByLabelText('Nome da turma'), '3DES')
    await user.selectOptions(within(dialog).getByLabelText('Período letivo'), 'per_1')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/class/create', expect.objectContaining({ name: '3DES', period: 'Manhã', courseId: 'DES', periodoLetivoId: 'per_1' })))
  })

  it('[UC-CURSO-002] Disciplinas manda carga horária, professor e módulos de volta', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Disciplinas' }))
    const dialog = screen.getByRole('dialog', { name: 'Disciplinas do curso' })
    const carga = within(dialog).getByLabelText('Carga horária de Redes (horas)')
    expect(carga).toHaveValue('80')
    await user.clear(carga)
    await user.type(carga, '100')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar disciplinas' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/course/disciplinas', {
      courseId: 'DES',
      disciplinas: [{ id: 'REDES', nome: 'Redes', cor: '', cargaHoraria: 100, professor: 'Prof. Carlos', modulos: ['M1'] }],
    }))
  })
})

