import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AvisosPage from './AvisosPage'

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  refetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  announcements: [],
  auth: { accountRole: 'professor' },
}))

vi.mock('../../lib/api', () => ({ api: { post: mocks.post, get: mocks.get } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => ({ courseId: 'DES', courseName: 'Desenvolvimento', className: '1DES' }),
}))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => {
    if (path.startsWith('/api/admin/classes')) return { data: [{ name: '1DES', courseId: 'DES' }], loading: false, error: null, refetch: vi.fn() }
    if (path.startsWith('/api/admin/announcements')) return { data: mocks.announcements, loading: false, error: null, refetch: mocks.refetch }
    return { data: null, loading: false, error: null, refetch: vi.fn() }
  },
}))

beforeEach(() => {
  window.scrollTo = vi.fn()
  mocks.post.mockResolvedValue({ success: true })
  mocks.get.mockResolvedValue({ grupos: [] })
  mocks.announcements = [
    { id: 'ann_dir', title: 'Recado da direção', message: 'Reunião geral', target: 'todos', targetValue: '', canEdit: false, createdAt: 2 },
    { id: 'ann_turma', title: 'Prova remarcada', message: 'Sexta', target: 'turma', targetValue: '1DES', courseId: 'DES', canEdit: true, createdAt: 1 },
  ]
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.auth = { accountRole: 'professor' }
})

const cardOf = (title) => screen.getByText(title).closest('.p-4')

describe('Avisos', () => {
  it('[UC-ADMIN-001] "Excluir" pede confirmação com o diálogo padrão antes de apagar', async () => {
    const user = userEvent.setup()
    render(<AvisosPage />)
    await user.click(within(cardOf('Prova remarcada')).getByRole('button', { name: 'Excluir' }))
    // Antes apagava no clique, sem confirmação.
    expect(mocks.post).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', { name: 'Excluir aviso?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(mocks.post).not.toHaveBeenCalled()

    await user.click(within(cardOf('Prova remarcada')).getByRole('button', { name: 'Excluir' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Excluir aviso?' })).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/announcements/delete', { id: 'ann_turma' }))
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('[UC-ADMIN-001] aviso para toda a instituição aparece ao professor sem editar nem excluir', async () => {
    const user = userEvent.setup()
    render(<AvisosPage />)
    const card = cardOf('Recado da direção')
    expect(within(card).queryByRole('button', { name: 'Excluir' })).not.toBeInTheDocument()
    expect(within(card).getByText('Só o administrador edita')).toBeInTheDocument()
    await user.click(card)
    expect(screen.queryByText('Editar aviso')).not.toBeInTheDocument()
    await user.click(cardOf('Prova remarcada'))
    expect(screen.getByText('Editar aviso')).toBeInTheDocument()
  })
})

describe('Avisos da Coordenação (só consulta)', () => {
  it('[UC-PAPEIS-004] lê os avisos sem o formulário de publicar, editar nem excluir (403)', async () => {
    mocks.auth = {
      role: 'admin', accountRole: 'coordenacao', readOnly: true,
      effectivePermissions: ['page.dashboard', 'page.results', 'page.classes', 'page.students', 'page.forum', 'page.assignments', 'reports.view'],
    }
    const user = userEvent.setup()
    render(<AvisosPage />)
    expect(screen.getByText('Prova remarcada')).toBeInTheDocument()
    expect(screen.getByText('Recado da direção')).toBeInTheDocument()
    // Antes: o formulário "Novo aviso" e o "Excluir" apareciam e o POST dava 403.
    expect(screen.queryByText('Novo aviso')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publicar aviso' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Excluir' })).not.toBeInTheDocument()
    expect(screen.queryByText('Só o administrador edita')).not.toBeInTheDocument()
    await user.click(cardOf('Prova remarcada'))
    expect(screen.queryByText('Editar aviso')).not.toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalled()
  })
})

// Fase 3, C19 (P5-S5, CRIT-11): aviso para um grupo da turma.
describe('Avisos para um grupo', () => {
  const PROFESSOR = { role: 'admin', accountRole: 'professor', effectivePermissions: ['page.forum', 'page.students'] }
  const GRUPOS = [
    { id: 'grp_b', nome: 'Laboratório B', conjunto: 'Laboratório', quantidade: 3, membros: [] },
    { id: 'grp_a', nome: 'Laboratório A', conjunto: 'Laboratório', quantidade: 1, membros: [] },
    { id: 'grp_x', nome: 'Antigo', conjunto: '', arquivado: true, quantidade: 0, membros: [] },
  ]

  it('[UC-GRUPO-003] "Um grupo da turma" lista os grupos ativos e publica com o id do grupo', async () => {
    mocks.auth = PROFESSOR
    mocks.get.mockResolvedValue({ grupos: GRUPOS })
    const user = userEvent.setup()
    render(<AvisosPage />)
    const destino = screen.getByLabelText('Destino')
    await waitFor(() => expect(within(destino).getByRole('option', { name: 'Um grupo da turma' })).toBeInTheDocument())
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/class-groups?courseId=DES&studentClass=1DES')
    await user.selectOptions(destino, 'grupo')
    const grupo = screen.getByLabelText('Grupo')
    expect(within(grupo).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Escolha o grupo…', 'Laboratório · Laboratório A (1 aluno)', 'Laboratório · Laboratório B (3 alunos)',
    ])
    await user.type(screen.getByLabelText('Título'), 'Bancada 2')
    await user.type(screen.getByLabelText('Mensagem'), 'Tragam o multímetro')
    await user.click(screen.getByRole('button', { name: 'Publicar aviso' }))
    expect(mocks.toast.error).toHaveBeenCalledWith('Escolha o grupo')
    expect(mocks.post).not.toHaveBeenCalled()
    await user.selectOptions(grupo, 'grp_a')
    await user.click(screen.getByRole('button', { name: 'Publicar aviso' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/announcements', expect.objectContaining({
      target: 'grupo', targetValue: 'grp_a', courseId: 'DES', studentClass: '1DES', title: 'Bancada 2',
    })))
  })

  it('[UC-GRUPO-003] o aviso de um grupo aparece na lista com o nome do grupo; arquivado continua editável', async () => {
    mocks.auth = PROFESSOR
    mocks.get.mockResolvedValue({ grupos: [] })
    mocks.announcements = [
      { id: 'ann_g', title: 'Só o laboratório', message: 'Oi', target: 'grupo', targetValue: 'grp_x', courseId: 'DES', studentClass: '1DES', canEdit: true, createdAt: 3, grupo: { id: 'grp_x', nome: 'Antigo', conjunto: '', arquivado: true } },
      { id: 'ann_outra', title: 'De outra turma', message: 'Oi', target: 'grupo', targetValue: 'grp_y', courseId: 'DES', studentClass: '2DES', canEdit: true, createdAt: 2, grupo: { id: 'grp_y', nome: 'Y', conjunto: '' } },
    ]
    const user = userEvent.setup()
    render(<AvisosPage />)
    expect(within(cardOf('Só o laboratório')).getByText('Grupo: Antigo (arquivado)')).toBeInTheDocument()
    expect(screen.queryByText('De outra turma')).not.toBeInTheDocument()
    await user.click(cardOf('Só o laboratório'))
    expect(screen.getByLabelText('Destino')).toHaveValue('grupo')
    expect(screen.getByLabelText('Grupo')).toHaveValue('grp_x')
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/announcements/update', expect.objectContaining({ id: 'ann_g', target: 'grupo', targetValue: 'grp_x' })))
  })

  it('[UC-GRUPO-003] sem grupos na turma (ou sem acesso a Alunos) a opção não aparece', async () => {
    mocks.auth = { role: 'admin', accountRole: 'professor', effectivePermissions: ['page.forum'] }
    render(<AvisosPage />)
    expect(within(screen.getByLabelText('Destino')).queryByRole('option', { name: 'Um grupo da turma' })).not.toBeInTheDocument()
    expect(mocks.get).not.toHaveBeenCalledWith(expect.stringContaining('/api/admin/class-groups'))
  })
})
