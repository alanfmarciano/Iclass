import { act, cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportFailure, reportResponse, reportSuccess, resetConnectionForTests, setConnectionProbe } from '../../lib/connection'
import { BANNER_DELAY_MS, EXAM_HINT_TEXT, OFFLINE_TEXT, RECOVERED_MS, RECOVERED_TEXT, STARTING_TEXT, ServerConnectionBanner } from './ServerConnectionBanner'

// Frente do H3 (CONF-03, UXA-06): a faixa diz que é o servidor (não a prova) e, na rota
// da prova, pede para não recarregar. Antes a tela não dizia nada até cair no login.
function renderAt(path) {
  const router = createMemoryRouter([{ path: '*', element: <ServerConnectionBanner /> }], { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}
const network = () => Object.assign(new Error('Sem conexão'), { status: 0, network: true })
const goOffline = () => act(() => { reportFailure(network()); reportFailure(network()) })

beforeEach(() => {
  vi.useFakeTimers()
  resetConnectionForTests()
  setConnectionProbe(null)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetConnectionForTests()
})

describe('[UC-AUTH-001] faixa de conexão com o servidor', () => {
  it('sem conexão: nada antes de 1,5 s; depois a faixa com role=status e aria-live', () => {
    renderAt('/aluno')
    goOffline()
    act(() => { vi.advanceTimersByTime(BANNER_DELAY_MS - 100) })
    expect(screen.queryByText(OFFLINE_TEXT)).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.getByText(OFFLINE_TEXT)).toBeVisible()
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(screen.queryByText(EXAM_HINT_TEXT)).not.toBeInTheDocument()
  })

  it('servidor reiniciando: texto próprio; na rota da prova, a linha para continuar respondendo', () => {
    renderAt('/aluno/prova/Avaliacao?applicationId=app-1')
    act(() => { reportResponse(503, { starting: true }) })
    act(() => { vi.advanceTimersByTime(BANNER_DELAY_MS) })
    expect(screen.getByText(STARTING_TEXT)).toBeVisible()
    expect(screen.getByText(EXAM_HINT_TEXT)).toBeVisible()
    // Fica sobre o cabeçalho da prova: o tom "soft" é translúcido, então a faixa leva o
    // fundo opaco da superfície (na conferência a 375 px o título da prova aparecia por trás).
    expect(screen.getByTestId('server-connection-banner-box')).toHaveClass('bg-surface')
  })

  it('falha que volta antes de 1,5 s não pisca a faixa nem mostra "Conexão restabelecida."', () => {
    renderAt('/aluno')
    goOffline()
    act(() => { vi.advanceTimersByTime(800) })
    act(() => { reportSuccess() })
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.queryByText(OFFLINE_TEXT)).not.toBeInTheDocument()
    expect(screen.queryByText(RECOVERED_TEXT)).not.toBeInTheDocument()
  })

  it('na volta mostra "Conexão restabelecida." por 4 s e some', () => {
    renderAt('/admin')
    goOffline()
    act(() => { vi.advanceTimersByTime(BANNER_DELAY_MS) })
    expect(screen.getByText(OFFLINE_TEXT)).toBeVisible()
    act(() => { reportSuccess() })
    expect(screen.getByText(RECOVERED_TEXT)).toBeVisible()
    expect(screen.queryByText(OFFLINE_TEXT)).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(RECOVERED_MS - 100) })
    expect(screen.getByText(RECOVERED_TEXT)).toBeVisible()
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.queryByText(RECOVERED_TEXT)).not.toBeInTheDocument()
  })

  it('de sem conexão para reiniciando troca o texto na hora', () => {
    renderAt('/aluno')
    goOffline()
    act(() => { vi.advanceTimersByTime(BANNER_DELAY_MS) })
    act(() => { reportResponse(503, { starting: true }) })
    expect(screen.getByText(STARTING_TEXT)).toBeVisible()
  })
})
