import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChamadaPage from './ChamadaPage'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
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
