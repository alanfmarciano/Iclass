import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CalendarioPage from './CalendarioPage'

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  downloadFile: vi.fn(),
  refetch: vi.fn(),
  refetchDays: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  events: [],
  days: null,
  auth: undefined,
}))

vi.mock('../../lib/api', () => ({ api: { post: mocks.post, get: mocks.get }, downloadFile: mocks.downloadFile }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => ({ courseId: 'TI', courseName: 'Informática', className: '1DES' }),
}))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => {
    if (path && path.startsWith('/api/admin/announcements/calendar')) return { data: mocks.events, loading: false, error: null, refetch: mocks.refetch }
    if (path && path.startsWith('/api/admin/calendar/non-school-days')) return { data: mocks.days, loading: false, error: null, refetch: mocks.refetchDays }
    return { data: null, loading: false, error: null, refetch: vi.fn() }
  },
}))

// Dias do mês corrente (o calendário abre no mês de hoje).
const now = new Date()
const ymd = (day) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

const TIPOS = [
  { value: 'feriado', label: 'Feriado' }, { value: 'recesso', label: 'Recesso' }, { value: 'ponto_facultativo', label: 'Ponto facultativo' },
  { value: 'evento_escolar', label: 'Evento escolar' }, { value: 'outro', label: 'Outro' },
]
const ESCOPOS_ADMIN = [
  { value: 'instituicao', label: 'Toda a instituição' }, { value: 'escola', label: 'Toda a escola' },
  { value: 'curso', label: 'Todo o curso' }, { value: 'turma', label: 'Só a turma' },
]

const recesso = { id: 'nl_1', inicio: ymd(12), fim: ymd(14), nome: 'Recesso escolar', tipo: 'recesso', tipoRotulo: 'Recesso', escopo: 'instituicao', escopoRotulo: 'Toda a instituição', podeAlterar: true }

function renderPage() {
  return render(<MemoryRouter><CalendarioPage /></MemoryRouter>)
}

beforeEach(() => {
  window.scrollTo = vi.fn()
  mocks.post.mockResolvedValue({ success: true })
  mocks.events = [
    { id: 'cal_1', title: 'Prova de Redes', message: 'Trazer calculadora', eventDate: ymd(10), startTime: '08:00', endTime: '', eventType: 'prova', target: 'turma', targetValue: '1DES', courseId: 'TI' },
    { kind: 'nonSchoolDay', id: 'nl_1', title: 'Recesso escolar', message: 'Recesso: não há aula de 12/xx a 14/xx.', eventDate: ymd(12), endDate: ymd(14), startTime: '', endTime: '', eventType: 'nao_letivo', escopo: 'instituicao', readOnly: true },
  ]
  mocks.days = {
    dias: [recesso], tipos: TIPOS, escopos: ESCOPOS_ADMIN, podeAdicionarFeriadosNacionais: true,
    contexto: { courseId: 'TI', studentClass: '1DES', schoolId: 'esc_1', escolaNome: 'Escola Centro' },
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.auth = undefined
})

describe('Calendário do painel', () => {
  it('[UC-PRESENCA-005] o recesso pinta todos os dias do intervalo e aparece em "Feriados e recessos deste mês"', () => {
    const { container } = renderPage()
    // Antes, o recesso só aparecia no primeiro dia (eventDate) e não havia a lista.
    ;[12, 13, 14].forEach((day) => expect(container.querySelector(`[data-date="${ymd(day)}"]`)).toHaveAttribute('data-sem-aula', 'true'))
    expect(container.querySelector(`[data-date="${ymd(15)}"]`)).not.toHaveAttribute('data-sem-aula')
    expect(screen.getAllByRole('button', { name: 'Sem aula: Recesso escolar' })).toHaveLength(3)
    const lista = screen.getByRole('list', { name: 'Feriados e recessos deste mês' })
    expect(within(lista).getByText('Recesso escolar')).toBeInTheDocument()
    expect(within(lista).getByText('Toda a instituição')).toBeInTheDocument()
    // Sábado com acento no cabeçalho da grade.
    expect(screen.getByText('Sáb')).toBeInTheDocument()
    expect(screen.queryByText('Sab')).toBeNull()
  })

  it('[UC-PRESENCA-005] dia não letivo que a conta não altera abre só para leitura, sem Excluir nem Salvar', async () => {
    mocks.days = { ...mocks.days, dias: [{ ...recesso, podeAlterar: false }], escopos: [{ value: 'turma', label: 'Só a turma' }], podeAdicionarFeriadosNacionais: false }
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getAllByRole('button', { name: 'Sem aula: Recesso escolar' })[0])
    const dialog = await screen.findByRole('dialog', { name: 'Recesso escolar' })
    expect(within(dialog).getByText(/não há aula/)).toBeInTheDocument()
    expect(within(dialog).getByText(/vale para toda a instituição/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Excluir' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Salvar' })).toBeNull()
    // O professor (sem feriados nacionais) não vê o botão dos feriados.
    expect(screen.queryByRole('button', { name: /Feriados nacionais/ })).toBeNull()
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('[UC-PRESENCA-005] "Dia não letivo" cadastra para a turma com a data de fim e mostra o erro do campo que o servidor recusou', async () => {
    mocks.post
      .mockRejectedValueOnce(Object.assign(new Error('Este dia não letivo já está cadastrado.'), { status: 409, data: { code: 'duplicate' } }))
      .mockRejectedValueOnce(Object.assign(new Error('A data de fim não pode ser antes da data de início.'), { status: 400, data: { field: 'fim' } }))
      .mockResolvedValueOnce({ success: true, presencasIgnoradas: 2 })
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Dia não letivo' }))
    const dialog = await screen.findByRole('dialog', { name: 'Novo dia não letivo' })
    const escopo = within(dialog).getByLabelText('Para quem vale')
    expect(within(escopo).getAllByRole('option').map((option) => option.textContent)).toEqual(['Toda a instituição', 'Toda a escola Escola Centro', 'Todo o curso Informática', 'Só a turma 1DES'])
    expect(escopo).toHaveValue('turma')
    await user.type(within(dialog).getByLabelText('Nome'), 'Semana da Consciência')
    await user.type(within(dialog).getByLabelText('Data (ou início)'), ymd(20))
    await user.type(within(dialog).getByLabelText('Até (para vários dias)'), ymd(21))
    await user.selectOptions(within(dialog).getByLabelText('Tipo'), 'evento_escolar')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    expect(await within(dialog).findByText('Este dia não letivo já está cadastrado.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    const fim = within(dialog).getByLabelText('Até (para vários dias)')
    await waitFor(() => expect(fim).toHaveAttribute('aria-invalid', 'true'))
    expect(within(dialog).getByText('A data de fim não pode ser antes da data de início.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Novo dia não letivo' })).toBeNull())
    expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/calendar/non-school-days/create', {
      inicio: ymd(20), fim: ymd(21), tipo: 'evento_escolar', nome: 'Semana da Consciência', escopo: 'turma', courseId: 'TI', studentClass: '1DES',
    })
    expect(mocks.toast.success).toHaveBeenCalledWith(expect.stringMatching(/cadastrado\. 2 presenças automáticas do acesso deixam de contar/))
    expect(mocks.refetch).toHaveBeenCalled()
    expect(mocks.refetchDays).toHaveBeenCalled()
  })

  it('[UC-PRESENCA-005] dia de escola manda a escola do curso; alterar e excluir pelo dia da lista', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(within(screen.getByRole('list', { name: 'Feriados e recessos deste mês' })).getByRole('button', { name: /Recesso escolar/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Alterar dia não letivo' })
    expect(within(dialog).getByLabelText('Nome')).toHaveValue('Recesso escolar')
    expect(within(dialog).getByLabelText('Até (para vários dias)')).toHaveValue(ymd(14))
    await user.selectOptions(within(dialog).getByLabelText('Para quem vale'), 'escola')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/calendar/non-school-days/update', {
      id: 'nl_1', inicio: ymd(12), fim: ymd(14), tipo: 'recesso', nome: 'Recesso escolar', escopo: 'escola', schoolId: 'esc_1',
    }))

    mocks.post.mockResolvedValue({ success: true, presencasDevolvidas: 1 })
    await user.click(within(screen.getByRole('list', { name: 'Feriados e recessos deste mês' })).getByRole('button', { name: /Recesso escolar/ }))
    const again = await screen.findByRole('dialog', { name: 'Alterar dia não letivo' })
    await user.click(within(again).getByRole('button', { name: 'Excluir' }))
    const confirm = await screen.findByRole('dialog', { name: 'Excluir este dia não letivo?' })
    await user.click(within(confirm).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/calendar/non-school-days/delete', { id: 'nl_1' }))
    expect(mocks.toast.success).toHaveBeenLastCalledWith(expect.stringMatching(/excluído\. 1 presença automática do acesso volta a contar na frequência/))
  })

  it('[UC-PRESENCA-005] feriados nacionais: ponto facultativo desmarcável e o já cadastrado travado', async () => {
    const ano = now.getFullYear()
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/admin/calendar/non-school-days/national-holidays')) {
        return {
          ano,
          feriados: [
            { chave: 'confraternizacao', inicio: `${ano}-01-01`, fim: `${ano}-01-01`, nome: 'Confraternização Universal', tipo: 'feriado', tipoRotulo: 'Feriado', jaCadastrado: true },
            { chave: 'carnaval', inicio: `${ano}-02-16`, fim: `${ano}-02-17`, nome: 'Carnaval', tipo: 'ponto_facultativo', tipoRotulo: 'Ponto facultativo', jaCadastrado: false },
            { chave: 'tiradentes', inicio: `${ano}-04-21`, fim: `${ano}-04-21`, nome: 'Tiradentes', tipo: 'feriado', tipoRotulo: 'Feriado', jaCadastrado: false },
          ],
        }
      }
      return {}
    })
    mocks.post.mockResolvedValue({ success: true, ano, criados: [{ id: 'nl_9' }], jaExistiam: [], presencasIgnoradas: 0 })
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: `Feriados nacionais de ${ano}` }))
    const dialog = await screen.findByRole('dialog', { name: `Adicionar feriados nacionais de ${ano}` })
    const ja = await within(dialog).findByRole('checkbox', { name: /Confraternização Universal/ })
    expect(ja).toBeChecked()
    expect(ja).toBeDisabled()
    const carnaval = within(dialog).getByRole('checkbox', { name: /Carnaval/ })
    expect(carnaval).toBeChecked()
    await user.click(carnaval)
    await user.click(within(dialog).getByRole('button', { name: 'Adicionar 1 feriado' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/calendar/non-school-days/national-holidays', { ano, incluir: ['tiradentes'] }))
    expect(mocks.toast.success).toHaveBeenCalledWith(`1 feriado adicionado ao calendário de ${ano}.`)
  })

  it('[UC-PRESENCA-005] feriados nacionais de um ano longe do atual: o seletor mostra o ano que o diálogo busca e grava', async () => {
    const ano = now.getFullYear() + 3
    mocks.get.mockImplementation(async (url) => {
      const pedido = Number(new URL(url, 'http://x').searchParams.get('ano'))
      if (url.startsWith('/api/admin/calendar/non-school-days/national-holidays')) {
        return { ano: pedido, feriados: [{ chave: 'tiradentes', inicio: `${pedido}-04-21`, fim: `${pedido}-04-21`, nome: 'Tiradentes', tipo: 'feriado', tipoRotulo: 'Feriado', jaCadastrado: false }] }
      }
      return {}
    })
    mocks.post.mockResolvedValue({ success: true, ano, criados: [{ id: 'nl_9' }], jaExistiam: [], presencasIgnoradas: 0 })
    const user = userEvent.setup()
    renderPage()
    // Avança o calendário até janeiro de daqui a três anos.
    const meses = (ano - now.getFullYear()) * 12 - now.getMonth()
    for (let i = 0; i < meses; i += 1) await user.click(screen.getByRole('button', { name: 'Próximo mês' }))
    await user.click(screen.getByRole('button', { name: `Feriados nacionais de ${ano}` }))
    const dialog = await screen.findByRole('dialog', { name: `Adicionar feriados nacionais de ${ano}` })
    // Antes o seletor só tinha do ano passado a daqui a dois anos e mostrava o primeiro.
    expect(within(dialog).getByLabelText('Ano')).toHaveValue(String(ano))
    await within(dialog).findByRole('checkbox', { name: /Tiradentes/ })
    expect(mocks.get).toHaveBeenLastCalledWith(`/api/admin/calendar/non-school-days/national-holidays?ano=${ano}`)
    await user.click(within(dialog).getByRole('button', { name: 'Adicionar 1 feriado' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/calendar/non-school-days/national-holidays', { ano, incluir: ['tiradentes'] }))
    // O ano de agora continua no seletor e, escolhido, busca os feriados dele.
    await user.click(screen.getByRole('button', { name: `Feriados nacionais de ${ano}` }))
    const reaberto = await screen.findByRole('dialog', { name: `Adicionar feriados nacionais de ${ano}` })
    await user.selectOptions(within(reaberto).getByLabelText('Ano'), String(now.getFullYear()))
    await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith(`/api/admin/calendar/non-school-days/national-holidays?ano=${now.getFullYear()}`))
    expect(within(reaberto).getByLabelText('Ano')).toHaveValue(String(now.getFullYear()))
  })

  it('[UC-PRESENCA-005] "Baixar agenda (.ics)" baixa a agenda da turma com a sessão', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Baixar agenda (.ics)' }))
    expect(mocks.downloadFile).toHaveBeenCalledWith('/api/admin/calendar/ics?courseId=TI&studentClass=1DES', 'agenda_1DES.ics')
  })

  it('[UC-PRESENCA-005] no celular o mês vira lista por dia, com "Sem aula"', () => {
    const original = window.matchMedia
    window.matchMedia = vi.fn((query) => ({ matches: query === '(max-width: 767px)', media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    try {
      const { container } = renderPage()
      expect(container.querySelector('[data-date]')).toBeNull()
      const lista = screen.getByRole('list', { name: /^Dias de / })
      const itens = within(lista).getAllByRole('listitem')
      // Dia 10 (prova) e 12 a 14 (recesso).
      expect(itens).toHaveLength(4)
      expect(within(itens[1]).getByText('Sem aula')).toBeInTheDocument()
      expect(within(itens[0]).queryByText('Sem aula')).toBeNull()
    } finally { window.matchMedia = original }
  })

  it('[UC-PRESENCA-005] excluir evento pede confirmação no diálogo da tela', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm')
    renderPage()
    await user.click(screen.getByRole('button', { name: /Prova de Redes/ }))
    const form = await screen.findByRole('dialog', { name: 'Editar evento' })
    await user.click(within(form).getByRole('button', { name: 'Excluir' }))
    expect(mocks.post).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('dialog', { name: 'Excluir este evento?' })
    await user.click(within(confirm).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/announcements/calendar/delete', { id: 'cal_1' }))
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})

describe('Calendário da Coordenação (só consulta)', () => {
  it('[UC-PAPEIS-004] sem "Novo evento" nem "Dia não letivo"; o evento e o dia abrem só para ler; a agenda .ics continua', async () => {
    mocks.auth = {
      role: 'admin', accountRole: 'coordenacao', readOnly: true,
      effectivePermissions: ['page.dashboard', 'page.results', 'page.classes', 'page.students', 'page.forum', 'page.assignments', 'reports.view'],
    }
    // Mesmo que um servidor antigo mande podeAlterar, a tela só de consulta não oferece.
    const user = userEvent.setup()
    renderPage()
    expect(screen.queryByRole('button', { name: 'Novo evento' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dia não letivo' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Feriados nacionais/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Baixar agenda (.ics)' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Prova de Redes/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Prova de Redes' })
    expect(screen.queryByRole('dialog', { name: 'Editar evento' })).toBeNull()
    expect(within(dialog).getByText('Trazer calculadora')).toBeInTheDocument()
    expect(within(dialog).getByText(/08:00/)).toBeInTheDocument()
    expect(within(dialog).getByText('Prova')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Excluir' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Salvar' })).toBeNull()
    expect(within(dialog).queryByRole('textbox')).toBeNull()
    await user.click(within(dialog).getAllByRole('button', { name: 'Fechar' }).at(-1))
    await user.click(within(screen.getByRole('list', { name: 'Feriados e recessos deste mês' })).getByRole('button', { name: /Recesso escolar/ }))
    expect(await screen.findByRole('dialog', { name: 'Recesso escolar' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Alterar dia não letivo' })).toBeNull()
    expect(mocks.post).not.toHaveBeenCalled()
  })
})
