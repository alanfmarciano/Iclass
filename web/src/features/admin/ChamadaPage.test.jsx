import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChamadaPage from './ChamadaPage'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), auth: undefined }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
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
    render(<ChamadaPage />)
    expect(await screen.findByText('Só presença automática: confira e conclua')).toBeInTheDocument()
    expect(screen.queryByText('Rascunho salvo')).not.toBeInTheDocument()
    expect(screen.getByText(/Automática · acesso às 08:40 · IP 10\.0\.0\.5/)).toBeInTheDocument()
  })

  it('[UC-PRESENCA-003] com lançamento do professor a tela continua dizendo "Rascunho salvo"', async () => {
    const chamada = aluno('ana@x.local', { origin: 'chamada', salvo: true })
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster') ? rosterWith([chamada]) : {}))
    render(<ChamadaPage />)
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
    render(<ChamadaPage />)
    expect(await screen.findByText('Entrou no sistema às 07:58')).toBeInTheDocument()
    expect(screen.queryByText(/^Automática/)).not.toBeInTheDocument()
  })

  it('[UC-PRESENCA-004] aluno com cadastro encerrado que aparece na data mostra a situação', async () => {
    const encerrado = aluno('carla@x.local', { origin: 'chamada', salvo: true, encerrado: true, situacao: 'Transferido' })
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster') ? rosterWith([encerrado, aluno('ana@x.local')]) : {}))
    render(<ChamadaPage />)
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
    render(<ChamadaPage />)
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
    render(<ChamadaPage />)
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
    render(<ChamadaPage />)
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
    render(<ChamadaPage />)
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
    render(<ChamadaPage />)
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
    render(<ChamadaPage />)
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
    render(<ChamadaPage />)
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
    render(<ChamadaPage />)
    expect(await screen.findByText('Não há aula neste dia: Proclamação da República')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Fazer a chamada mesmo assim' })).not.toBeInTheDocument()
  })

  it('[UC-PAPEIS-004] dia sem chamada salva: avisa que as marcações são o padrão da tela, não um registro', async () => {
    mocks.auth = coordenacao
    mocks.get.mockImplementation(async (url) => (url.startsWith('/api/admin/attendance/roster') ? rosterWith([aluno('ana@x.local')]) : {}))
    render(<ChamadaPage />)
    expect(await screen.findByText('Sua conta é só de consulta. A chamada deste dia ainda não foi salva: as marcações abaixo são o padrão da tela, não um registro.')).toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalled()
  })
})

describe('Exportar a presença e o conteúdo das aulas (B11, FUN-09)', () => {
  const diario = {
    courseId: 'curso1', studentClass: '1DES', date: '2026-11-10', versao: null, encerrada: false,
    aulas: aulas.map((a) => ({ ...a, disciplinaNome: 'Fundamentos', naGrade: true, conteudo: '', atividade: '', observacao: '' })),
  }
  function routes(url) {
    if (url.startsWith('/api/settings/public')) return { today: '2026-11-10' }
    if (url.startsWith('/api/admin/attendance/roster')) return rosterWith([aluno('ana@x.local')])
    if (url.startsWith('/api/admin/attendance/diary')) return { success: true, diario, limites: { conteudoMax: 2000, atividadeMax: 1000 } }
    if (url.startsWith('/api/admin/attendance/export')) return 'Data;Aluno\n'
    return {}
  }

  it('[UC-DIARIO-003] Exportar CSV pede o período (padrão: o mês da data) e manda from, to e courseId', async () => {
    const user = userEvent.setup()
    const created = vi.fn(() => 'blob:presenca')
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = created
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      mocks.get.mockImplementation(async (url) => routes(url))
      render(<ChamadaPage />)
      await screen.findByText('ana')
      await waitFor(() => expect(screen.getByLabelText('Data')).toHaveValue('2026-11-10'))
      await user.click(screen.getByRole('button', { name: 'Exportar CSV' }))
      expect(await screen.findByRole('dialog')).toHaveTextContent('Exportar a presença')
      expect(screen.getByLabelText('De')).toHaveValue('2026-11-01')
      expect(screen.getByLabelText('Até')).toHaveValue('2026-11-30')
      fireEvent.change(screen.getByLabelText('De'), { target: { value: '2026-11-03' } })
      await user.click(screen.getByRole('button', { name: 'Baixar CSV' }))
      await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining('/api/admin/attendance/export?'), { raw: true }))
      const url = mocks.get.mock.calls.map(([u]) => u).find((u) => u.startsWith('/api/admin/attendance/export'))
      const params = new URL(url, 'http://x').searchParams
      // Antes: só studentClass (todas as datas, e a turma de mesmo nome de outro curso junto).
      expect(Object.fromEntries(params)).toEqual({ studentClass: '1DES', courseId: 'curso1', from: '2026-11-03', to: '2026-11-30' })
      expect(created).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
      click.mockRestore()
    }
  })

  it('[UC-DIARIO-003] período ao contrário: o diálogo avisa e não baixa', async () => {
    const user = userEvent.setup()
    mocks.get.mockImplementation(async (url) => routes(url))
    render(<ChamadaPage />)
    await screen.findByText('ana')
    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }))
    fireEvent.change(await screen.findByLabelText('De'), { target: { value: '2026-12-01' } })
    await user.click(screen.getByRole('button', { name: 'Baixar CSV' }))
    expect(await screen.findByText('O início do período é depois do fim.')).toBeInTheDocument()
    expect(mocks.get).not.toHaveBeenCalledWith(expect.stringContaining('/api/admin/attendance/export'), expect.anything())
  })

  it('[UC-DIARIO-001] o bloco "Conteúdo das aulas" aparece abaixo da lista, com um cartão por aula', async () => {
    mocks.get.mockImplementation(async (url) => routes(url))
    render(<ChamadaPage />)
    expect(await screen.findByRole('heading', { name: 'Conteúdo das aulas' })).toBeInTheDocument()
    expect(screen.getAllByLabelText('Conteúdo ministrado')).toHaveLength(2)
    expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/admin\/attendance\/diary\?courseId=curso1&studentClass=1DES&date=/))
  })
})
