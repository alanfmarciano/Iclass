import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AuditoriaPage, { auditSummary } from './AuditoriaPage'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  downloadFile: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get }, downloadFile: mocks.downloadFile }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

const FACETS = {
  categories: [{ value: 'grade', label: 'Notas' }, { value: 'system', label: 'Sistema' }],
  actors: [{ value: 'prof@x.local', label: 'Júlia (prof@x.local)' }],
  courses: [{ value: 'DES', label: 'Desenvolvimento' }],
  classes: [{ value: '1DES', courseId: 'DES', label: '1DES' }],
  exams: [{ value: 'Avaliacao_P1', label: 'Prova 1' }],
  applications: [{ value: 'app_1', examKey: 'Avaliacao_P1', label: 'Prova 1 · 1DES · 10/03/2026' }],
}

function item(id, extra = {}) {
  return {
    id, action: 'grade_update', label: 'Nota alterada', category: 'grade', categoryLabel: 'Notas',
    actor: 'prof@x.local', actorName: 'Júlia', timestamp: Date.parse('2026-03-10T15:00:00Z'), ip: '10.0.0.5',
    device: 'Mozilla/5.0 (Windows NT 10.0)', studentEmail: 'ana@x.local', studentName: 'Ana', courseId: 'DES', courseName: 'Desenvolvimento',
    studentClass: '1DES', examKey: 'Avaliacao_P1', examTitle: 'Prova 1', applicationId: 'app_1', submissionId: 's1',
    field: 'Nota', oldValue: '5,0', newValue: '7,0', reason: 'Revisão pedida pela aluna', before: null, after: null, details: null,
    ...extra,
  }
}

function renderPage(entry = '/auditoria') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes><Route path="/auditoria" element={<AuditoriaPage />} /></Routes>
    </MemoryRouter>,
  )
}

const auditCalls = () => mocks.get.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith('/api/admin/audit?'))
const lastQuery = () => new URLSearchParams(auditCalls().pop().split('?')[1])

beforeEach(() => {
  mocks.get.mockImplementation(async (path) => {
    const query = new URLSearchParams(String(path).split('?')[1])
    if (query.get('offset') === '100') return { success: true, items: [item('b101', { label: 'Configurações alteradas' })], total: 101, offset: 100, limit: 100 }
    const items = Array.from({ length: 100 }, (_, index) => item(`a${index}`))
    return { success: true, items, total: 101, offset: 0, limit: 100, ...(query.get('facets') === '1' ? { facets: FACETS } : {}) }
  })
  mocks.downloadFile.mockResolvedValue('auditoria_2026-03-10.csv')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Tela Auditoria', () => {
  it('[UC-AUDITORIA-003] lista os eventos com quem fez, aluno, prova e motivo, e carrega mais pelo offset', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByText('100 de 101 evento(s)')).toBeInTheDocument()
    expect(lastQuery().get('facets')).toBe('1')
    expect(lastQuery().get('limit')).toBe('100')
    const first = screen.getAllByRole('listitem')[0]
    expect(within(first).getByText('Nota alterada')).toBeInTheDocument()
    expect(within(first).getByText(/por Júlia \(prof@x\.local\)/)).toBeInTheDocument()
    expect(within(first).getByText(/aluno Ana \(ana@x\.local\)/)).toBeInTheDocument()
    expect(within(first).getByText('Desenvolvimento · 1DES · Prova 1')).toBeInTheDocument()
    expect(within(first).getByText('Revisão pedida pela aluna')).toBeInTheDocument()
    // Detalhes: IP, aparelho e aplicação.
    await user.click(within(first).getByRole('button', { name: 'Detalhes' }))
    expect(within(first).getByText('10.0.0.5')).toBeInTheDocument()
    expect(within(first).getByText('Mozilla/5.0 (Windows NT 10.0)')).toBeInTheDocument()
    expect(within(first).getAllByText('app_1').length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: 'Carregar mais' }))
    expect(await screen.findByText('101 de 101 evento(s)')).toBeInTheDocument()
    expect(lastQuery().get('offset')).toBe('100')
    expect(screen.getByText('Configurações alteradas')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).not.toBeInTheDocument()
  })

  it('[UC-AUDITORIA-003] filtros de prova (examKey) e aplicação (applicationId) vão para o servidor e para o CSV', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('100 de 101 evento(s)')
    await user.selectOptions(screen.getByLabelText('Prova'), 'Avaliacao_P1')
    await waitFor(() => expect(lastQuery().get('examKey')).toBe('Avaliacao_P1'))
    await user.selectOptions(screen.getByLabelText('Aplicação'), 'app_1')
    await waitFor(() => expect(lastQuery().get('applicationId')).toBe('app_1'))
    expect(lastQuery().get('examKey')).toBe('Avaliacao_P1')
    // As opções vieram uma vez só (facets na primeira leitura).
    expect(lastQuery().get('facets')).toBe(null)
    await user.selectOptions(screen.getByLabelText('Categoria'), 'grade')
    await waitFor(() => expect(lastQuery().get('category')).toBe('grade'))

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }))
    await waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledOnce())
    const [path, fallbackName] = mocks.downloadFile.mock.calls[0]
    expect(path).toBe('/api/admin/audit/export?category=grade&examKey=Avaliacao_P1&applicationId=app_1')
    expect(fallbackName).toBe('auditoria.csv')
    expect(mocks.toast.success).toHaveBeenCalledWith('CSV da auditoria baixado.')

    // Trocar a prova limpa a aplicação escolhida.
    await user.selectOptions(screen.getByLabelText('Prova'), '')
    await waitFor(() => expect(lastQuery().get('examKey')).toBe(null))
    expect(lastQuery().get('applicationId')).toBe(null)
  })

  it('[UC-AUDITORIA-003] abre já filtrada pelo endereço e busca o texto depois da pausa', async () => {
    const user = userEvent.setup()
    renderPage('/auditoria?applicationId=app_1&from=2026-03-01')
    await screen.findByText('100 de 101 evento(s)')
    expect(lastQuery().get('applicationId')).toBe('app_1')
    expect(lastQuery().get('from')).toBe('2026-03-01')
    expect(screen.getByLabelText('Aplicação')).toHaveValue('app_1')
    await user.type(screen.getByLabelText('Buscar'), 'revisão')
    await waitFor(() => expect(lastQuery().get('q')).toBe('revisão'), { timeout: 2000 })
    expect(lastQuery().get('applicationId')).toBe('app_1')
    await user.click(screen.getByRole('button', { name: 'Limpar filtros' }))
    await waitFor(() => expect(lastQuery().get('applicationId')).toBe(null))
    expect(screen.getByLabelText('Buscar')).toHaveValue('')
  })

  it('[UC-AUDITORIA-003] data inválida: a mensagem do servidor aparece no campo e a exportação fica desligada', async () => {
    mocks.get.mockImplementation(async () => {
      const error = new Error('Data inicial inválida: use o formato AAAA-MM-DD.')
      error.status = 400
      error.data = { success: false, error: error.message, field: 'from' }
      throw error
    })
    renderPage('/auditoria?from=2026-02-30')
    expect(await screen.findByText('Corrija o filtro marcado acima.')).toBeInTheDocument()
    expect(screen.getByText('Data inicial inválida: use o formato AAAA-MM-DD.')).toBeInTheDocument()
    expect(screen.getByLabelText('De')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeDisabled()
  })

  it('[UC-AUDITORIA-003] resumo: valor antigo → novo, ou as configurações que mudaram', () => {
    expect(auditSummary(item('x'))).toEqual({ field: 'Nota', oldValue: '5,0', newValue: '7,0' })
    expect(auditSummary(item('y', { field: '', oldValue: null, newValue: null, details: { changes: [{ key: 'timezone', before: 'America/Sao_Paulo', after: 'America/Recife' }] } })))
      .toEqual({ field: 'Mudanças', oldValue: 'timezone: America/Sao_Paulo', newValue: 'timezone: America/Recife' })
    expect(auditSummary(item('z', { oldValue: null, newValue: null }))).toBe(null)
  })
})
