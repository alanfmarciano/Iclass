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
    if (path.startsWith('/api/admin/exam-applications')) return { data: { applications: [] }, loading: false, error: null, refetch: vi.fn() }
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
