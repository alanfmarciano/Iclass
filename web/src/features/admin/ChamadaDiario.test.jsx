import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChamadaDiario } from './ChamadaDiario'

// Conteúdo das aulas na Chamada (fase 3, B11 / P4-S7, FUN-09): um cartão por aula,
// autosave com a versão lida, conflito de versão (409 diary_changed), só consulta e turma
// encerrada, e o texto que ficou por salvar quando a data muda.
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))

function diario(extra = {}) {
  return {
    courseId: 'curso1', studentClass: '1DES', date: '2026-11-10', versao: null,
    registradoPor: null, registradoEm: null, atualizadoPor: null, atualizadoEm: null,
    encerrada: false, naoLetivo: null, foraDoPeriodo: false,
    aulas: [
      { ordem: 1, inicio: '07:30', disciplinaId: 'RED', disciplinaNome: 'Redes', naGrade: true, conteudo: '', atividade: '', observacao: '' },
      { ordem: 2, inicio: '08:20', disciplinaId: 'PROG', disciplinaNome: 'Programação', naGrade: true, conteudo: '', atividade: '', observacao: '' },
    ],
    ...extra,
  }
}
const limites = { conteudoMax: 2000, atividadeMax: 1000 }
const conflict409 = (atual) => Object.assign(new Error('O diário deste dia foi alterado em outra aba ou por outra pessoa.'), { status: 409, data: { code: 'diary_changed', atual } })

beforeEach(() => {
  mocks.get.mockImplementation(async () => ({ success: true, diario: diario(), limites }))
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

const conteudos = () => screen.getAllByLabelText('Conteúdo ministrado')

describe('Conteúdo das aulas na Chamada', () => {
  it('[UC-DIARIO-001] um cartão por aula da grade; o texto salva sozinho, só a aula que mudou, com a versão lida', async () => {
    mocks.post.mockResolvedValueOnce({ success: true, changed: true, diario: diario({ versao: 1 }) })
      .mockResolvedValueOnce({ success: true, changed: true, diario: diario({ versao: 2 }) })
    render(<ChamadaDiario courseId="curso1" className="1DES" date="2026-11-10" accountEmail="prof@x.local" />)
    expect(await screen.findByText('Aula 1 · 07:30 · Redes')).toBeInTheDocument()
    expect(screen.getByText('Aula 2 · 08:20 · Programação')).toBeInTheDocument()
    expect(screen.getByText(/Não escreva dados de alunos aqui/)).toBeInTheDocument()
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/attendance/diary?courseId=curso1&studentClass=1DES&date=2026-11-10')

    vi.useFakeTimers()
    fireEvent.change(conteudos()[0], { target: { value: 'Endereçamento IPv4' } })
    expect(screen.getByText('Alterações não salvas')).toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(2100) })
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/attendance/diary', {
      courseId: 'curso1', studentClass: '1DES', date: '2026-11-10', versao: null,
      aulas: [{ ordem: 1, conteudo: 'Endereçamento IPv4', atividade: '' }],
    })
    vi.useRealTimers()
    expect(await screen.findByText(/Salvo às/)).toBeInTheDocument()

    // A próxima gravação manda a versão que o servidor devolveu.
    vi.useFakeTimers()
    fireEvent.change(screen.getAllByLabelText('Atividade (opcional)')[1], { target: { value: 'Lista 1' } })
    await act(async () => { vi.advanceTimersByTime(2100) })
    expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/attendance/diary', expect.objectContaining({
      versao: 1, aulas: [{ ordem: 2, conteudo: '', atividade: 'Lista 1' }],
    }))
  })

  it('[UC-DIARIO-001] outra aba gravou antes (409): a tela pergunta; "Gravar o meu texto por cima" usa a versão de agora', async () => {
    const atual = diario({ versao: 3, atualizadoPor: 'admin@x.local', atualizadoEm: Date.UTC(2026, 10, 10, 13, 5), aulas: diario().aulas.map((a) => (a.ordem === 1 ? { ...a, conteudo: 'Texto da outra aba' } : a)) })
    mocks.post.mockRejectedValueOnce(conflict409(atual)).mockResolvedValueOnce({ success: true, changed: true, diario: { ...atual, versao: 4 } })
    render(<ChamadaDiario courseId="curso1" className="1DES" date="2026-11-10" />)
    await screen.findByText('Aula 1 · 07:30 · Redes')
    vi.useFakeTimers()
    fireEvent.change(conteudos()[0], { target: { value: 'Meu texto' } })
    await act(async () => { vi.advanceTimersByTime(2100) })
    vi.useRealTimers()
    expect(await screen.findByText(/foi alterado em outra aba ou por outra pessoa \(admin@x\.local/)).toBeInTheDocument()
    expect(conteudos()[0]).toHaveValue('Meu texto')
    fireEvent.click(screen.getByRole('button', { name: 'Gravar o meu texto por cima' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2))
    expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/attendance/diary', expect.objectContaining({ versao: 3, aulas: [{ ordem: 1, conteudo: 'Meu texto', atividade: '' }] }))
    expect(await screen.findByText(/Salvo às/)).toBeInTheDocument()
  })

  it('[UC-DIARIO-001] "Ver a versão salva" troca o texto daqui pelo de agora, sem gravar', async () => {
    const atual = diario({ versao: 3, aulas: diario().aulas.map((a) => (a.ordem === 1 ? { ...a, conteudo: 'Texto da outra aba' } : a)) })
    mocks.post.mockRejectedValueOnce(conflict409(atual))
    render(<ChamadaDiario courseId="curso1" className="1DES" date="2026-11-10" />)
    await screen.findByText('Aula 1 · 07:30 · Redes')
    vi.useFakeTimers()
    fireEvent.change(conteudos()[0], { target: { value: 'Meu texto' } })
    await act(async () => { vi.advanceTimersByTime(2100) })
    vi.useRealTimers()
    fireEvent.click(await screen.findByRole('button', { name: 'Ver a versão salva' }))
    expect(conteudos()[0]).toHaveValue('Texto da outra aba')
    expect(screen.queryByText(/foi alterado em outra aba/)).not.toBeInTheDocument()
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })

  it('[UC-DIARIO-001] trocar a data com texto por salvar grava antes de sair', async () => {
    mocks.post.mockResolvedValue({ success: true, changed: true, diario: diario({ versao: 1 }) })
    const { rerender } = render(<ChamadaDiario courseId="curso1" className="1DES" date="2026-11-10" />)
    await screen.findByText('Aula 1 · 07:30 · Redes')
    fireEvent.change(conteudos()[0], { target: { value: 'Escrito às pressas' } })
    rerender(<ChamadaDiario courseId="curso1" className="1DES" date="2026-11-11" />)
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1))
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/attendance/diary', expect.objectContaining({ date: '2026-11-10', aulas: [{ ordem: 1, conteudo: 'Escrito às pressas', atividade: '' }] }))
    await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith(expect.stringContaining('date=2026-11-11')))
  })

  it('[UC-DIARIO-001] trocar de data rápido: a resposta atrasada da data anterior não cobre o texto da data de agora', async () => {
    let releaseOld
    const salvo = diario({ versao: 1, aulas: diario().aulas.map((a) => (a.ordem === 1 ? { ...a, conteudo: 'Hardware' } : a)) })
    mocks.get.mockImplementation(async (url) => {
      if (url.includes('date=2026-11-11')) return new Promise((resolve) => { releaseOld = () => resolve({ success: true, diario: diario({ date: '2026-11-11' }), limites }) })
      return { success: true, diario: salvo, limites }
    })
    const { rerender } = render(<ChamadaDiario courseId="curso1" className="1DES" date="2026-11-11" />)
    await waitFor(() => expect(releaseOld).toBeTypeOf('function'))
    rerender(<ChamadaDiario courseId="curso1" className="1DES" date="2026-11-10" />)
    await waitFor(() => expect(conteudos()[0]).toHaveValue('Hardware'))
    await act(async () => { releaseOld() })
    expect(conteudos()[0]).toHaveValue('Hardware')
  })

  it('[UC-PAPEIS-004] só consulta: os campos ficam travados e nada é gravado', async () => {
    mocks.get.mockResolvedValue({ success: true, diario: diario({ versao: 2, aulas: diario().aulas.map((a) => ({ ...a, conteudo: a.ordem === 1 ? 'Redes: IPv4' : '' })) }), limites })
    render(<ChamadaDiario courseId="curso1" className="1DES" date="2026-11-10" readOnly />)
    await screen.findByText('Aula 1 · 07:30 · Redes')
    expect(screen.getByText(/Sua conta é só de consulta: o conteúdo aparece como foi salvo/)).toBeInTheDocument()
    expect(conteudos()[0]).toHaveValue('Redes: IPv4')
    expect(conteudos()[0]).toBeDisabled()
    fireEvent.change(conteudos()[0], { target: { value: 'mudar' } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('[UC-DIARIO-001] turma encerrada: o conteúdo fica só para consulta; aula escrita fora da grade aparece marcada', async () => {
    mocks.get.mockResolvedValue({ success: true, diario: diario({ encerrada: true, versao: 1, aulas: [...diario().aulas, { ordem: 3, inicio: '', disciplinaId: 'RED', disciplinaNome: 'Redes', naGrade: false, conteudo: 'Reposição', atividade: '', observacao: '' }] }), limites })
    render(<ChamadaDiario courseId="curso1" className="1DES" date="2026-11-10" />)
    expect(await screen.findByText('Turma encerrada: o conteúdo das aulas fica só para consulta.')).toBeInTheDocument()
    expect(screen.getByText('fora da grade deste dia')).toBeInTheDocument()
    conteudos().forEach((field) => expect(field).toBeDisabled())
  })

  it('[UC-DIARIO-001] falha ao abrir o diário avisa e oferece "Tentar de novo"; resposta sem diário não mostra nada', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Sem conexão com o servidor.'))
    const { unmount } = render(<ChamadaDiario courseId="curso1" className="1DES" date="2026-11-10" />)
    expect(await screen.findByText(/Não foi possível abrir o conteúdo das aulas deste dia/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    expect(await screen.findByText('Aula 1 · 07:30 · Redes')).toBeInTheDocument()
    unmount()
    mocks.get.mockResolvedValueOnce({})
    const { container } = render(<ChamadaDiario courseId="curso1" className="1DES" date="2026-11-10" />)
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3))
    expect(container).toBeEmptyDOMElement()
  })
})
