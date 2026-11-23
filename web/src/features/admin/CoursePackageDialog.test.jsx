import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TurmasPage from './TurmasPage'

// Pacote de curso (P4-S14, D25 a D27) em Cursos e turmas: "Exportar curso" avisa que o
// arquivo leva provas e gabaritos e baixa o ZIP; "Importar curso" mostra a prévia do
// servidor (o que entra, o que muda de nome), deixa trocar código, nome e escola e manda
// o mesmo arquivo com o sha256 da prévia.
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  get: vi.fn(),
  downloadFile: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  apiData: {},
  auth: { role: 'admin', accountRole: 'admin' },
}))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post, put: mocks.put, delete: mocks.del }, downloadFile: mocks.downloadFile }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => ({ data: (path && mocks.apiData[path]) || null, loading: false, error: null, refetch: vi.fn() }),
}))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))

const SHA = 'c'.repeat(64)
const PREVIEW = {
  success: true,
  arquivo: 'curso_DES.iclass-curso.zip',
  sha256: SHA,
  versaoFormato: 1,
  resumo: { codigo: 'DES', nome: 'Técnico em TI', descricao: '', exportadoEm: Date.UTC(2026, 10, 20, 12), versaoApp: '3.0.0' },
  contagens: { modulos: 2, unidades: 5, apostilas: 4, avaliacoes: 1, questoesNasAvaliacoes: 10, conteudos: 5, arquivos: 3, imagens: 0, biblioteca: 1, questoesBanco: 10, turmasModelo: 1 },
  conflitos: { cursoExiste: true, chavesRenomeadas: 5, arquivosRenomeados: 1, arquivosReaproveitados: 2, exemplos: [{ de: 'Apostila_DES_1', para: 'Apostila_DES_1_DES2' }] },
  sugestao: { newId: 'DES2', newName: 'Técnico em TI' },
  turmasModelo: ['1DES'],
  avisos: [],
}

function renderPage() {
  return render(<MemoryRouter><TurmasPage /></MemoryRouter>)
}

function formEntries(form) {
  return Object.fromEntries([...form.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : value.name]))
}

describe('TurmasPage · pacote de curso', () => {
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
    mocks.downloadFile.mockResolvedValue('curso_DES_2026-11-20.iclass-curso.zip')
  })
  afterEach(cleanup)

  it('[UC-PACOTE-001] "Exportar curso" avisa das provas e gabaritos e baixa o pacote do curso', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Exportar curso' }))
    const dialog = screen.getByRole('dialog', { name: 'Exportar curso?' })
    expect(dialog).toHaveTextContent('O arquivo tem as provas e os gabaritos: guarde como guardaria a prova impressa.')
    expect(dialog).toHaveTextContent('O pacote não leva alunos, notas nem presença.')
    expect(mocks.downloadFile).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Baixar pacote' }))
    await waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledWith('/api/admin/courses/DES/package', 'curso_DES.iclass-curso.zip'))
    expect(mocks.toast.success).toHaveBeenCalledWith('Pacote do curso baixado.')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Exportar curso?' })).not.toBeInTheDocument())
  })

  it('[UC-PACOTE-001] erro do download fica no diálogo, em português', async () => {
    mocks.downloadFile.mockRejectedValue(new Error('Sem permissão para esta escola.'))
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Exportar curso' }))
    const dialog = screen.getByRole('dialog', { name: 'Exportar curso?' })
    await user.click(within(dialog).getByRole('button', { name: 'Baixar pacote' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Sem permissão para esta escola.')
  })

  it('[UC-PACOTE-002] "Importar curso": prévia sem gravar, código e escola editáveis, importação com o sha256 da prévia', async () => {
    mocks.post.mockImplementation(async (path) => {
      if (path === '/api/admin/course-packages/preview') return PREVIEW
      return { success: true, course: { id: 'DES_NOITE', name: 'TI Noite' }, classes: [], renomeadas: 5, arquivosRenomeados: 1, arquivosReaproveitados: 2, avisos: [] }
    })
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Importar curso' }))
    const dialog = screen.getByRole('dialog', { name: 'Importar curso' })
    expect(within(dialog).getByRole('button', { name: 'Importar curso' })).toBeDisabled()
    const file = new File(['PK'], 'curso_DES.iclass-curso.zip', { type: 'application/zip' })
    await user.upload(within(dialog).getByLabelText('Pacote do curso'), file)

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/course-packages/preview', expect.any(FormData), { timeoutMs: 0 }))
    expect(formEntries(mocks.post.mock.calls[0][1])).toEqual({ arquivo: 'curso_DES.iclass-curso.zip' })
    expect(await within(dialog).findByText('Já existe um curso DES: será importado como DES2.')).toBeInTheDocument()
    const counts = within(dialog).getByRole('list', { name: 'Conteúdo do pacote' })
    expect(counts).toHaveTextContent('2 módulos')
    expect(counts).toHaveTextContent('1 avaliação')
    expect(counts).toHaveTextContent('10 questões do banco')
    expect(counts).not.toHaveTextContent('imagens')
    expect(dialog).toHaveTextContent('O pacote não leva alunos, notas nem presença.')
    expect(dialog).toHaveTextContent('5 apostilas ou avaliações têm o nome de um conteúdo que já existe aqui')
    expect(dialog).toHaveTextContent('1 arquivo tem o nome de outro arquivo daqui')
    expect(within(dialog).getByLabelText('Código do curso')).toHaveValue('DES2')

    const code = within(dialog).getByLabelText('Código do curso')
    await user.clear(code)
    await user.type(code, 'des_noite')
    expect(dialog).toHaveTextContent('será importado como DES_NOITE.')
    const name = within(dialog).getByLabelText('Nome do curso')
    await user.clear(name)
    await user.type(name, 'TI Noite')
    await user.selectOptions(within(dialog).getByLabelText('Escola'), 'escola-b')
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Importar curso' }))

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/course-packages/import', expect.any(FormData), { timeoutMs: 0 }))
    expect(formEntries(mocks.post.mock.calls[1][1])).toEqual({
      arquivo: 'curso_DES.iclass-curso.zip', sha256: SHA, newId: 'DES_NOITE', newName: 'TI Noite', schoolId: 'escola-b', incluirTurmasModelo: 'nao',
    })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Importar curso' })).not.toBeInTheDocument())
    expect(mocks.toast.success).toHaveBeenCalledWith(expect.stringContaining('Curso importado como DES_NOITE.'))
  })

  it('[UC-PACOTE-002] recusa do servidor: campo do código marcado; pacote inválido mostra o motivo', async () => {
    mocks.post.mockImplementation(async (path) => {
      if (path === '/api/admin/course-packages/preview') return PREVIEW
      const error = new Error('Já existe um curso com esse código.')
      error.status = 400
      error.data = { success: false, error: error.message, code: 'course_exists', field: 'newId' }
      throw error
    })
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Importar curso' }))
    const dialog = screen.getByRole('dialog', { name: 'Importar curso' })
    await user.upload(within(dialog).getByLabelText('Pacote do curso'), new File(['PK'], 'curso.zip', { type: 'application/zip' }))
    await within(dialog).findByText('Já existe um curso DES: será importado como DES2.')
    await user.click(within(dialog).getByRole('button', { name: 'Importar curso' }))
    expect(await within(dialog).findByText('Já existe um curso com esse código.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Código do curso')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('dialog', { name: 'Importar curso' })).toBeInTheDocument()

    mocks.post.mockRejectedValue(Object.assign(new Error('Pacote de curso inválido: link simbólico no ZIP (conteudo/x.md).'), { status: 400, data: { code: 'invalid_package' } }))
    await user.upload(within(dialog).getByLabelText('Pacote do curso'), new File(['PK'], 'outro.zip', { type: 'application/zip' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('link simbólico')
    expect(within(dialog).getByRole('button', { name: 'Importar curso' })).toBeDisabled()
  })

  it('[UC-PACOTE-002] professor sem course.manage não vê exportar nem importar; com a permissão vê os dois e só eles', () => {
    mocks.auth = { role: 'professor', accountRole: 'professor', effectivePermissions: ['page.courses'] }
    renderPage()
    expect(screen.queryByRole('button', { name: 'Exportar curso' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Importar curso' })).not.toBeInTheDocument()
    cleanup()

    mocks.auth = { role: 'professor', accountRole: 'professor', effectivePermissions: ['page.courses', 'course.manage'] }
    renderPage()
    expect(screen.getByRole('button', { name: 'Exportar curso' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Importar curso' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Duplicar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Novo curso' })).not.toBeInTheDocument()
  })
})
