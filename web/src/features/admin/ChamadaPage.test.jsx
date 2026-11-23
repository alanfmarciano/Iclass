import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import ChamadaPage from './ChamadaPage'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), info: vi.fn(), auth: undefined }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: mocks.info }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => ({ courseId: 'curso1', courseName: 'Curso', className: '1DES' }),
}))

const aulas = [
  { ordem: 1, disciplinaId: 'FECOP', inicio: '08:00' },
  { ordem: 2, disciplinaId: 'FECOP', inicio: '08:50' },
]

function aluno(email, extra = {}) {
  return {
    email, name: email.split('@')[0], nomeSocial: '', matricula: '', origin: '', acessoAutomatico: null,
    salvo: false, concluida: false, justificativa: null, observacao: '', frequencia: 100, faltasAcumuladas: 0, emRisco: false,
    aulas: aulas.map((a) => ({ ...a, status: 'presente', hora: '' })),
    ...extra,
  }
}

// A Chamada guarda o grupo escolhido no endereço (?grupo=, P5-S5): renderiza num roteador.
function renderPage(entry = '/chamada') {
  return render(<MemoryRouter initialEntries={[entry]}><ChamadaPage /></MemoryRouter>)
}

function rosterWith(rows) {
  return { studentClass: '1DES', courseId: 'curso1', date: '2026-10-19', weekday: 1, toleranciaMin: 10, limiarRiscoPct: 75, disciplinas: [], aulas, roster: rows }
}

beforeEach(() => {
  mocks.post.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.auth = undefined
})

describe('Chamada com presença automática', () => {
  it('[UC-PRESENCA-003] só registros automáticos não aparecem como "Rascunho salvo": a tela pede para conferir e concluir', async () => {
    const automatico = aluno('diego@x.local', {
      origin: 'login', salvo: true,
      acessoAutomatico: { hora: '08:40', ip: '10.0.0.5', via: 'login' },
      aulas: [{ ...aulas[0], status: 'falta', hora: '08:40' }, { ...aulas[1], status: 'presente', hora: '' }],
    })
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster') ? rosterWith([automatico, aluno('ana@x.local')]) : {}))
    renderPage()
    expect(await screen.findByText('Só presença automática: confira e conclua')).toBeInTheDocument()
    expect(screen.queryByText('Rascunho salvo')).not.toBeInTheDocument()
    expect(screen.getByText(/Automática · acesso às 08:40 · IP 10\.0\.0\.5/)).toBeInTheDocument()
  })

  it('[UC-PRESENCA-003] com lançamento do professor a tela continua dizendo "Rascunho salvo"', async () => {
    const chamada = aluno('ana@x.local', { origin: 'chamada', salvo: true })
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster') ? rosterWith([chamada]) : {}))
    renderPage()
    expect(await screen.findByText('Rascunho salvo')).toBeInTheDocument()
  })
})

describe('Chamada com presença em versões (H7b)', () => {
  it('[UC-PRESENCA-004] depois que a chamada substitui a presença automática, a tela ainda mostra a hora do acesso', async () => {
    const chamada = aluno('diego@x.local', {
      origin: 'chamada', salvo: true,
      acessoAutomatico: { hora: '07:58', ip: '10.0.0.7', via: 'sessão aberta' },
    })
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster') ? rosterWith([chamada]) : {}))
    renderPage()
    expect(await screen.findByText('Entrou no sistema às 07:58')).toBeInTheDocument()
    expect(screen.queryByText(/^Automática/)).not.toBeInTheDocument()
  })

  it('[UC-PRESENCA-004] aluno com cadastro encerrado que aparece na data mostra a situação', async () => {
    const encerrado = aluno('carla@x.local', { origin: 'chamada', salvo: true, encerrado: true, situacao: 'Transferido' })
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster') ? rosterWith([encerrado, aluno('ana@x.local')]) : {}))
    renderPage()
    expect(await screen.findByText('Transferido')).toBeInTheDocument()
    expect(screen.getAllByText('Transferido')).toHaveLength(1)
  })
})

describe('Chamada em dia não letivo', () => {
  const feriado = { id: 'nl_1', nome: 'Proclamação da República', tipo: 'feriado', tipoRotulo: 'Feriado', inicio: '2026-11-15', fim: '2026-11-15', escopo: 'instituicao' }

  it('[UC-PRESENCA-005] feriado: a tela diz que não há aula (não "sem grade") e "mesmo assim" pede a grade de novo', async () => {
    const user = userEvent.setup()
    mocks.get.mockImplementation(async (url) => {
      if (!url.startsWith('/api/admin/attendance/roster')) return {}
      const forcado = url.includes('mesmoAssim=1')
      return { ...rosterWith([aluno('ana@x.local')]), aulas: forcado ? aulas : [], aulasGrade: aulas, naoLetivo: feriado, foraDoPeriodo: false, mesmoAssim: forcado }
    })
    renderPage()
    expect(await screen.findByText('Não há aula neste dia: Proclamação da República')).toBeInTheDocument()
    // Antes a tela dizia que a turma não tinha grade para o dia da semana.
    expect(screen.queryByText('Sem aulas neste dia')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Concluir chamada' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Fazer a chamada mesmo assim' }))
    expect(await screen.findByText(/chamada lançada mesmo assim, que conta na frequência/)).toBeInTheDocument()
    expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining('mesmoAssim=1'))
    expect(screen.getByRole('button', { name: 'Concluir chamada' })).toBeInTheDocument()
  })

  it('[UC-PRESENCA-005] voltar ao feriado com a chamada de reposição salva mostra a chamada, não a tela de dia sem aula', async () => {
    // O servidor entra sozinho no "mesmo assim" quando já há chamada naquela data.
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster')
      ? { ...rosterWith([aluno('ana@x.local', { salvo: true, concluida: true, origin: 'chamada' })]), aulas, aulasGrade: aulas, naoLetivo: feriado, foraDoPeriodo: false, mesmoAssim: true, chamadaNoDia: true }
      : {}))
    renderPage()
    expect(await screen.findByText(/chamada lançada mesmo assim, que conta na frequência/)).toBeInTheDocument()
    expect(screen.queryByText('Não há aula neste dia: Proclamação da República')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Concluir chamada' })).toBeInTheDocument()
    expect(mocks.get).not.toHaveBeenCalledWith(expect.stringContaining('mesmoAssim=1'))
  })

  it('[UC-PRESENCA-005] "Tentar novamente" depois de um erro não pede a grade "mesmo assim" sem o professor escolher', async () => {
    const user = userEvent.setup()
    let falhar = true
    mocks.get.mockImplementation(async (url) => {
      if (!url.startsWith('/api/admin/attendance/roster')) return {}
      if (falhar) { falhar = false; throw new Error('Servidor fora do ar') }
      return { ...rosterWith([aluno('ana@x.local')]), aulas: url.includes('mesmoAssim=1') ? aulas : [], aulasGrade: aulas, naoLetivo: feriado, foraDoPeriodo: false, mesmoAssim: url.includes('mesmoAssim=1') }
    })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Não há aula neste dia: Proclamação da República')).toBeInTheDocument()
    const rosterCalls = mocks.get.mock.calls.map(([url]) => url).filter((url) => url.startsWith('/api/admin/attendance/roster'))
    expect(rosterCalls.length).toBeGreaterThanOrEqual(2)
    rosterCalls.forEach((url) => expect(url).not.toContain('mesmoAssim=1'))
  })

  it('[UC-PRESENCA-005] dia não letivo sem grade no dia da semana não oferece "mesmo assim"', async () => {
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster')
      ? { ...rosterWith([aluno('ana@x.local')]), aulas: [], aulasGrade: [], naoLetivo: feriado, foraDoPeriodo: false }
      : {}))
    renderPage()
    expect(await screen.findByText('Não há aula neste dia: Proclamação da República')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Fazer a chamada mesmo assim' })).not.toBeInTheDocument()
  })
})

describe('Chamada em dia sem aula: faixa (B7)', () => {
  it('[UC-PRESENCA-005] recesso: a faixa diz o tipo e o intervalo, e o botão ocupa a largura toda no celular', async () => {
    const recesso = { id: 'nl_2', nome: 'Recesso de julho', tipo: 'recesso', tipoRotulo: 'Recesso', inicio: '2027-07-12', fim: '2027-07-23', escopo: 'instituicao' }
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster')
      ? { ...rosterWith([aluno('ana@x.local')]), aulas: [], aulasGrade: aulas, naoLetivo: recesso, foraDoPeriodo: false }
      : {}))
    renderPage()
    const faixa = (await screen.findByText('Não há aula neste dia: Recesso de julho')).closest('[role="status"]')
    expect(faixa).toHaveTextContent('Recesso, de 12/07/2027 a 23/07/2027.')
    expect(screen.getByRole('button', { name: 'Fazer a chamada mesmo assim' }).className).toMatch(/\bw-full\b/)
  })

  it('[UC-PRESENCA-005] fora do período letivo: a faixa diz o nome e as datas do período', async () => {
    // Antes dizia só "Fora do período letivo da turma", sem dizer qual.
    const periodo = { id: 'per_1', nome: '2027 · 1º semestre', inicio: '2027-02-01', fim: '2027-06-30' }
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster')
      ? { ...rosterWith([aluno('ana@x.local')]), aulas: [], aulasGrade: aulas, naoLetivo: null, foraDoPeriodo: true, periodoLetivo: periodo }
      : {}))
    renderPage()
    const faixa = (await screen.findByText('Fora do período letivo da turma')).closest('[role="status"]')
    expect(faixa).toHaveTextContent('Fora do período letivo 2027 · 1º semestre (de 01/02/2027 a 30/06/2027).')
  })
})

describe('Chamada da Coordenação (só consulta)', () => {
  const coordenacao = {
    role: 'admin', accountRole: 'coordenacao', readOnly: true,
    effectivePermissions: ['page.dashboard', 'page.results', 'page.classes', 'page.students', 'page.forum', 'page.assignments', 'reports.view'],
  }

  it('[UC-PAPEIS-004] mostra a chamada como foi salva, sem concluir, marcar todos nem salvar sozinha (403)', async () => {
    mocks.auth = coordenacao
    const user = userEvent.setup()
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster') ? rosterWith([aluno('ana@x.local', { origin: 'chamada', salvo: true })]) : {}))
    renderPage()
    expect(await screen.findByText('Sua conta é só de consulta: a chamada aparece como foi salva, sem alterar.')).toBeInTheDocument()
    // Antes: "Concluir chamada" e "Todos presente" apareciam e o POST de /attendance/bulk dava 403.
    expect(screen.queryByRole('button', { name: 'Concluir chamada' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Todos presente' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeInTheDocument()
    const lista = screen.getByRole('group', { name: 'Chamada (só consulta)' })
    expect(lista).toBeDisabled()
    // Tecla de atalho (F = falta) não muda nada.
    fireEvent.keyDown(document.body, { key: 'f' })
    await user.click(lista)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('[UC-PAPEIS-004] em dia sem aula não oferece "Fazer a chamada mesmo assim"', async () => {
    mocks.auth = coordenacao
    const feriado = { id: 'nl_1', nome: 'Proclamação da República', tipo: 'feriado', tipoRotulo: 'Feriado', inicio: '2026-11-15', fim: '2026-11-15', escopo: 'instituicao' }
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster')
      ? { ...rosterWith([aluno('ana@x.local')]), aulas: [], aulasGrade: aulas, naoLetivo: feriado, foraDoPeriodo: false, mesmoAssim: false }
      : {}))
    renderPage()
    expect(await screen.findByText('Não há aula neste dia: Proclamação da República')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Fazer a chamada mesmo assim' })).not.toBeInTheDocument()
  })

  it('[UC-PAPEIS-004] dia sem chamada salva: avisa que as marcações são o padrão da tela, não um registro', async () => {
    mocks.auth = coordenacao
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster') ? rosterWith([aluno('ana@x.local')]) : {}))
    renderPage()
    expect(await screen.findByText('Sua conta é só de consulta. A chamada deste dia ainda não foi salva: as marcações abaixo são o padrão da tela, não um registro.')).toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalled()
  })
})

describe('Chamada por grupo (P5-S5)', () => {
  const grupos = [
    { id: 'grp_a', nome: 'Laboratório A', conjunto: 'Laboratório', quantidade: 1 },
    { id: 'grp_b', nome: 'Laboratório B', conjunto: 'Laboratório', quantidade: 1 },
  ]

  it('[UC-GRUPO-003] o grupo do endereço (?grupo=) filtra a lista, conclui e exporta só ele', async () => {
    const user = userEvent.setup()
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/admin/attendance/roster')) return { ...rosterWith([aluno('ana@x.local')]), grupo: { id: 'grp_a', nome: 'Laboratório A', conjunto: 'Laboratório' }, grupos }
      if (url.startsWith('/api/admin/attendance/export')) return 'email;data\n'
      return {}
    })
    mocks.post.mockResolvedValue({ success: true, saved: 1, skipped: 0, groupId: 'grp_a', foraDoGrupo: 0 })
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    renderPage('/chamada?grupo=grp_a')
    const seletor = await screen.findByLabelText('Chamada de')
    expect(seletor).toHaveValue('grp_a')
    expect(mocks.get.mock.calls.find(([url]) => url.startsWith('/api/admin/attendance/roster'))[0]).toContain('&groupId=grp_a')
    expect(await screen.findByText(/Presença por aula · Curso · 1DES · Laboratório · Laboratório A/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Concluir chamada' }))
    const confirmar = screen.getAllByRole('button', { name: 'Concluir chamada' }).at(-1)
    await user.click(confirmar)
    const bulk = mocks.post.mock.calls.find(([url]) => url === '/api/admin/attendance/bulk')
    expect(bulk[1]).toMatchObject({ studentClass: '1DES', courseId: 'curso1', groupId: 'grp_a', concluida: true })

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }))
    const exportUrl = mocks.get.mock.calls.find(([url]) => url.startsWith('/api/admin/attendance/export'))[0]
    expect(exportUrl).toContain('groupId=grp_a')
    expect(exportUrl).toContain('courseId=curso1')
  })

  it('[UC-GRUPO-003] trocar para um grupo pede a lista dele; "Toda a turma" volta à turma inteira', async () => {
    const user = userEvent.setup()
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster')
      ? { ...rosterWith([aluno('ana@x.local'), aluno('bia@x.local')]), grupo: url.includes('groupId=grp_b') ? grupos[1] : null, grupos }
      : {}))
    renderPage()
    const seletor = await screen.findByLabelText('Chamada de')
    expect(seletor).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Laboratório · Laboratório B' })).toBeInTheDocument()
    await user.selectOptions(seletor, 'grp_b')
    await vi.waitFor(() => expect(mocks.get.mock.calls.some(([url]) => url.includes('/attendance/roster') && url.includes('groupId=grp_b'))).toBe(true))
    await user.selectOptions(screen.getByLabelText('Chamada de'), '')
    await vi.waitFor(() => {
      const rosterCalls = mocks.get.mock.calls.filter(([url]) => url.includes('/attendance/roster'))
      expect(rosterCalls.at(-1)[0]).not.toContain('groupId')
    })
  })

  it('[UC-GRUPO-003] link de um grupo arquivado volta para a turma inteira com aviso', async () => {
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/admin/attendance/roster') && url.includes('groupId=')) {
        const error = new Error('Grupo não encontrado nesta turma (ele pode ter sido arquivado).')
        error.status = 404; error.data = { code: 'group_not_found' }
        throw error
      }
      return url.startsWith('/api/admin/attendance/roster') ? { ...rosterWith([aluno('ana@x.local')]), grupo: null, grupos } : {}
    })
    renderPage('/chamada?grupo=grp_velho')
    await vi.waitFor(() => expect(screen.getByLabelText('Chamada de')).toHaveValue(''))
    expect(await screen.findByText('ana')).toBeInTheDocument()
    expect(mocks.info).toHaveBeenCalledWith('Esse grupo não está mais ativo nesta turma: mostrando a turma inteira.')
    expect(screen.queryByText(/não encontrado/)).not.toBeInTheDocument()
  })

  it('[UC-GRUPO-003] turma sem grupos não mostra o seletor', async () => {
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster') ? { ...rosterWith([aluno('ana@x.local')]), grupos: [] } : {}))
    renderPage()
    expect(await screen.findByText('ana')).toBeInTheDocument()
    expect(screen.queryByLabelText('Chamada de')).not.toBeInTheDocument()
  })
})
