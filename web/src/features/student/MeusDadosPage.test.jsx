import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// H8c reduzido (SEG-14): "Meus dados" do aluno. O mesmo botão apertado de novo usa a
// cópia já recebida (o servidor aceita 5 por hora); baixar e imprimir pedem cada um a sua,
// para a auditoria registrar a finalidade (decisões §12); a janela de impressão abre no
// clique.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  download: vi.fn(() => 'meus-dados-2026-11-10.json'),
  openWindow: vi.fn(),
  print: vi.fn(() => true),
}))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: vi.fn() } }))
vi.mock('../../lib/dataExportPrint', () => ({ downloadDataExport: mocks.download, openPrintWindow: mocks.openWindow, printDataExport: mocks.print }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: { role: 'student', email: 'ana@escola.local' } }) }))

import MeusDadosPage from './MeusDadosPage'

const DATA = { type: 'iclass-dados-pessoais', audience: 'aluno', generatedAt: '2026-11-10T13:00:00Z', profile: { email: 'ana@escola.local' } }

beforeEach(() => {
  mocks.get.mockResolvedValue(DATA)
  mocks.openWindow.mockReturnValue({ closed: false, close: vi.fn() })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

function renderPage() {
  return render(<MemoryRouter><MeusDadosPage /></MemoryRouter>)
}

describe('[UC-LGPD-010] Meus dados', () => {
  // Contrato mudado (decisões §12, sobra do H8c): antes, imprimir logo depois de baixar
  // reaproveitava a cópia e a impressão ficava sem lgpd_export 'imprimir' na auditoria.
  it('baixa a cópia; imprimir depois pede a cópia com finalidade imprimir; repetir o mesmo botão reaproveita', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: /Baixar meus dados/ }))
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith(DATA))
    expect(mocks.get).toHaveBeenCalledWith('/api/student/my-data?finalidade=baixar')
    expect(await screen.findByRole('status')).toHaveTextContent('meus-dados-2026-11-10.json')

    await user.click(screen.getByRole('button', { name: /Ver para imprimir/ }))
    await waitFor(() => expect(mocks.print).toHaveBeenCalled())
    expect(mocks.print.mock.calls[0][0]).toBe(DATA)
    expect(mocks.print.mock.calls[0][1]).toBe(mocks.openWindow.mock.results[0].value)
    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(mocks.get).toHaveBeenLastCalledWith('/api/student/my-data?finalidade=imprimir')

    await user.click(screen.getByRole('button', { name: /Baixar meus dados/ }))
    await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(2))
    await user.click(screen.getByRole('button', { name: /Ver para imprimir/ }))
    await waitFor(() => expect(mocks.print).toHaveBeenCalledTimes(2))
    expect(mocks.get).toHaveBeenCalledTimes(2)
  })

  it('[UC-LGPD-010] explica que a cópia traz os trabalhos enviados nas atividades, com a nota só depois de devolvidos (C10)', () => {
    renderPage()
    expect(screen.getByText(/os trabalhos\s+que você enviou nas atividades \(cada versão, com o nome e o tamanho dos arquivos e o comprovante; a nota e o\s+comentário do professor depois de devolvidos\)/)).toBeTruthy()
  })

  it('imprimir primeiro pede com finalidade imprimir e abre a janela antes da resposta', async () => {
    const user = userEvent.setup()
    let resolve
    mocks.get.mockReturnValue(new Promise((r) => { resolve = r }))
    renderPage()
    await user.click(screen.getByRole('button', { name: /Ver para imprimir/ }))
    expect(mocks.openWindow).toHaveBeenCalledTimes(1)
    expect(mocks.print).not.toHaveBeenCalled()
    resolve(DATA)
    await waitFor(() => expect(mocks.print).toHaveBeenCalled())
    expect(mocks.get).toHaveBeenCalledWith('/api/student/my-data?finalidade=imprimir')
  })

  it('janela bloqueada: avisa e nem pede a cópia (não gasta uma das 5 da hora)', async () => {
    const user = userEvent.setup()
    mocks.openWindow.mockReturnValue(null)
    renderPage()
    await user.click(screen.getByRole('button', { name: /Ver para imprimir/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('bloqueou a janela de impressão')
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('limite da hora (429): mostra o texto do servidor e fecha a janela aberta', async () => {
    const user = userEvent.setup()
    const win = { closed: false, close: vi.fn() }
    mocks.openWindow.mockReturnValue(win)
    mocks.get.mockRejectedValue(Object.assign(new Error('Você já baixou seus dados 5 vezes na última hora. Tente de novo em 12 minutos.'), { status: 429 }))
    renderPage()
    await user.click(screen.getByRole('button', { name: /Ver para imprimir/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('5 vezes na última hora')
    expect(win.close).toHaveBeenCalled()
    expect(mocks.print).not.toHaveBeenCalled()
  })
})
