import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ResultadosPage from './ResultadosPage'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  downloadFile: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  refetch: vi.fn(),
  applications: [],
  deletedItems: [],
}))

vi.mock('../../lib/api', () => ({
  api: { get: mocks.get, post: mocks.post },
  downloadFile: mocks.downloadFile,
}))

vi.mock('../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => ({ courseId: 'DES', courseName: 'Desenvolvimento', className: '1DES' }),
}))

vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => {
    if (!path) return { data: null, loading: false, error: null, refetch: vi.fn() }
    if (path.startsWith('/api/admin/students')) return { data: [{ name: 'Ana', email: 'ana@x.local', classes: [{ name: '1DES', courseId: 'DES' }] }], loading: false, error: null, refetch: vi.fn() }
    if (path.startsWith('/api/admin/classes')) return { data: [{ name: '1DES', courseId: 'DES' }], loading: false, error: null, refetch: vi.fn() }
    if (path.startsWith('/api/admin/exam-applications/') && path.endsWith('/audit')) {
      return {
        data: {
          application: { id: 'app_1', examTitle: 'Prova 2', studentClass: '1DES', createdAt: '2026-03-01T10:00:00Z' },
          entries: [
            { id: 'a1', at: Date.parse('2026-03-01T10:00:00Z'), kind: 'application', title: 'Aplicação criada', detail: '', actor: 'prof@x.local' },
            { id: 'a2', at: Date.parse('2026-03-01T11:00:00Z'), kind: 'exam', title: 'Questão 3 anulada (ponto para todos)', detail: 'motivo: enunciado ambíguo · 1 entrega recorrigida', actor: 'prof@x.local' },
            { id: 'a3', at: Date.parse('2026-03-01T11:00:01Z'), kind: 'grade', title: 'Nota · Ana', detail: 'Prova 2: 5,0 → Prova 2: 7,5', actor: 'prof@x.local' },
          ],
        },
        loading: false, error: null, refetch: vi.fn(),
      }
    }
    if (path.startsWith('/api/admin/exam-applications')) return { data: { applications: mocks.applications }, loading: false, error: null, refetch: vi.fn() }
    if (path.startsWith('/api/admin/submissions/deleted')) return { data: { items: mocks.deletedItems }, loading: false, error: null, refetch: mocks.refetch }
    if (path.startsWith('/api/admin/submissions')) {
      return {
        data: [{ id: 'old', student: { name: 'Ana', email: 'ana@x.local', courseId: 'DES', studentClass: '1DES' }, courseId: 'DES', examKey: 'Avaliacao_P2', score: 150, scoreInvalid: true, consolidatedScore: null, gradePublished: true, timestamp: '2026-03-01T10:00:00Z' }],
        loading: false, error: null, refetch: vi.fn(),
      }
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() }
  },
}))

const questions = Array.from({ length: 10 }, (_, index) => ({ originalNumber: index + 1, text: `Q${index + 1}`, alternatives: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }] }))

beforeEach(() => {
  mocks.get.mockImplementation(async (path) => {
    if (path.includes('/structure')) return { structure: [{ id: 'm1', name: 'Módulo 1', units: [{ name: 'Prova 2', avaliacaoKey: 'Avaliacao_P2' }] }] }
    if (path.startsWith('/api/admin/evaluation/')) return { evaluation: { questions } }
    if (path.startsWith('/api/admin/exam-history')) return { history: [] }
    return {}
  })
  mocks.post.mockResolvedValue({ success: true, message: 'Nota 7,0 lançada para Ana.' })
  mocks.downloadFile.mockResolvedValue('planilha.csv')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.applications = []
  mocks.deletedItems = []
})

function renderPage() {
  return render(<MemoryRouter initialEntries={['/resultados']}><ResultadosPage /></MemoryRouter>)
}

async function openManual(user) {
  await user.click(screen.getByRole('button', { name: 'Lançar nota' }))
  const dialog = await screen.findByRole('dialog')
  await user.selectOptions(within(dialog).getByLabelText('Aluno'), 'ana@x.local')
  await waitFor(() => expect(within(dialog).getByRole('option', { name: /Prova 2/ })).toBeInTheDocument())
  await user.selectOptions(within(dialog).getByLabelText('Prova'), 'Avaliacao_P2')
  await waitFor(() => expect(within(dialog).getByLabelText('Total de questões')).toHaveAttribute('placeholder', '10'))
  return dialog
}

describe('Resultados · lançamento manual de nota', () => {
  it('[UC-NOTAS-001] rotula a nota de 0 a 10 e, só com acertos, envia os acertos para o servidor calcular', async () => {
    const user = userEvent.setup()
    renderPage()
    const dialog = await openManual(user)
    expect(within(dialog).getByLabelText('Nota (0 a 10)')).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Nota (%)')).not.toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Acertos'), '7')
    expect(within(dialog).getByText(/Nota que será gravada: 7,0 \(calculada pelos acertos\)/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Salvar nota' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce())
    const [path, body] = mocks.post.mock.calls[0]
    expect(path).toBe('/api/admin/submissions/create')
    expect(body).toEqual({ studentEmail: 'ana@x.local', examKey: 'Avaliacao_P2', courseId: 'DES', studentClass: '1DES', type: 'impressa', correctCount: 7 })
    expect(body).not.toHaveProperty('score')
  })

  it('[UC-NOTAS-001] bloqueia nota fora de 0 a 10 e acertos acima do total, e aceita vírgula', async () => {
    const user = userEvent.setup()
    renderPage()
    const dialog = await openManual(user)
    const grade = within(dialog).getByLabelText('Nota (0 a 10)')
    await user.type(grade, '150')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar nota' }))
    expect(await within(dialog).findByText(/Use um número de 0 a 10/)).toBeInTheDocument()
    await user.clear(grade)
    await user.type(within(dialog).getByLabelText('Acertos'), '12')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar nota' }))
    expect(await within(dialog).findByText(/A prova tem 10 questões/)).toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalled()

    await user.clear(within(dialog).getByLabelText('Acertos'))
    await user.type(grade, '8,5')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar nota' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce())
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ grade: 8.5 })
  })
})

describe('Resultados · exportação', () => {
  it('[UC-NOTAS-002] exporta a planilha da turma com download autenticado (não window.open)', async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Exportar planilha (CSV)' }))
    await waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledOnce())
    expect(mocks.downloadFile.mock.calls[0][0]).toBe('/api/admin/gradebook?courseId=DES&studentClass=1DES&format=csv')
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('[UC-NOTAS-001] nota inválida antiga nunca aparece como 15,0', async () => {
    renderPage()
    expect(screen.queryByText('15,0')).not.toBeInTheDocument()
    expect(screen.queryByText('15.0')).not.toBeInTheDocument()
  })
})

describe('Resultados · total da turma no lançamento rápido', () => {
  it('[UC-NOTAS-001] usa o total configurado na turma (não o tamanho do banco) na prévia, no placeholder e na validação', async () => {
    mocks.get.mockImplementation(async (path) => {
      if (path.includes('/structure')) return { structure: [{ id: 'm1', name: 'Módulo 1', units: [{ name: 'Prova 2', avaliacaoKey: 'Avaliacao_P2' }] }] }
      if (path.startsWith('/api/admin/evaluation/')) return { evaluation: { questions } }
      if (path.startsWith('/api/admin/exam-history')) return { history: [] }
      if (path.startsWith('/api/admin/submissions/manual-context')) return { questionCount: 10, defaultTotal: 4, configuredCount: 4, excludedCount: 0 }
      return {}
    })
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Lançar nota' }))
    const dialog = await screen.findByRole('dialog')
    await user.selectOptions(within(dialog).getByLabelText('Aluno'), 'ana@x.local')
    await waitFor(() => expect(within(dialog).getByRole('option', { name: /Prova 2/ })).toBeInTheDocument())
    await user.selectOptions(within(dialog).getByLabelText('Prova'), 'Avaliacao_P2')
    await waitFor(() => expect(within(dialog).getByLabelText('Total de questões')).toHaveAttribute('placeholder', '4'))
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/submissions/manual-context?studentClass=1DES&courseId=DES&examKey=Avaliacao_P2')
    expect(within(dialog).getByText(/Nesta turma a prova usa 4 de 10 questões/)).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Acertos'), '2')
    expect(within(dialog).getByText(/Nota que será gravada: 5,0 \(calculada pelos acertos\)/)).toBeInTheDocument()
    await user.clear(within(dialog).getByLabelText('Acertos'))
    await user.type(within(dialog).getByLabelText('Acertos'), '6')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar nota' }))
    expect(await within(dialog).findByText(/Nesta turma a prova tem 4 questões/)).toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalled()
  })
})

describe('Resultados · lixeira e registro da aplicação', () => {
  it('[UC-NOTAS-004] lista as notas excluídas da turma e restaura pelo id da exclusão', async () => {
    mocks.deletedItems = [{ auditId: 'audit_1', submissionId: 'sub_1', studentName: 'Ana', studentEmail: 'ana@x.local', examTitle: 'Prova 2', attemptNumber: 1, grade: '7,0', gradePublished: true, deletedAt: Date.parse('2026-03-02T10:00:00Z'), deletedBy: 'prof@x.local', canRestore: true }]
    mocks.post.mockResolvedValue({ success: true, message: 'Nota de Ana restaurada (publicada).' })
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Notas excluídas' }))
    const dialog = await screen.findByRole('dialog', { name: 'Notas excluídas' })
    expect(within(dialog).getByText(/Prova 2 · tentativa 1 · nota 7,0 · publicada/)).toBeInTheDocument()
    expect(within(dialog).getByText(/por prof@x.local/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Restaurar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/submissions/restore', { auditId: 'audit_1' }))
    expect(mocks.toast.success).toHaveBeenCalledWith('Nota de Ana restaurada (publicada).')
  })

  it('[UC-NOTAS-004] mostra o registro da aplicação escolhida no filtro', async () => {
    mocks.applications = [{ id: 'app_1', examKey: 'Avaliacao_P2', studentClass: '1DES', courseId: 'DES', createdAt: '2026-03-01T10:00:00Z' }]
    const user = userEvent.setup()
    renderPage()
    const button = screen.getByRole('button', { name: 'Registro da aplicação' })
    expect(button).toBeDisabled()
    await user.selectOptions(screen.getByDisplayValue('Todas as aplicações'), 'app_1')
    await user.click(screen.getByRole('button', { name: 'Registro da aplicação' }))
    const dialog = await screen.findByRole('dialog', { name: 'Registro da aplicação' })
    expect(within(dialog).getByText('Questão 3 anulada (ponto para todos)')).toBeInTheDocument()
    expect(within(dialog).getByText(/motivo: enunciado ambíguo/)).toBeInTheDocument()
    expect(within(dialog).getByText('Nota · Ana')).toBeInTheDocument()
  })
})
