import { cleanup, render, screen } from '@testing-library/react'
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
