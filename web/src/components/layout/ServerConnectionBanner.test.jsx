import { act, cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportFailure, reportResponse, reportSuccess, resetConnectionForTests, setConnectionProbe } from '../../lib/connection'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BANNER_DELAY_MS, BANNER_HEIGHT_VAR, COMPACT_MEDIA, EXAM_HINT_SHORT_TEXT, EXAM_HINT_TEXT, OFFLINE_SHORT_TEXT, OFFLINE_TEXT, RECOVERED_MS, RECOVERED_TEXT, STARTING_SHORT_TEXT, STARTING_TEXT, ServerConnectionBanner } from './ServerConnectionBanner'

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
  document.documentElement.style.removeProperty(BANNER_HEIGHT_VAR)
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
    // O tom "soft" é translúcido: a faixa leva o fundo opaco da superfície (na conferência a
    // 375 px o título da prova aparecia por trás quando ela ficava por cima).
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

// Frente do H3, ajuste 1: a faixa fixa ficava por cima do cabeçalho da prova durante toda a
// queda (cronômetro, x/y respondidas, "Sem conexão: as respostas serão enviadas…" e o botão
// Enviar), a 375 px e a 1280 px, e um toque nela acionava o Enviar escondido (a faixa não
// recebia o toque). Agora a altura dela é reservada em cima do #root e ela recebe o toque.
describe('[UC-AUTH-001] faixa de conexão não cobre a tela', () => {
  function fakeHeight(px) {
    const original = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function rect() {
      if (this.dataset?.testid === 'server-connection-banner-box') return { top: 0, left: 0, width: 375, height: px, right: 375, bottom: px, x: 0, y: 0 }
      return original.call(this)
    }
    return () => { HTMLElement.prototype.getBoundingClientRect = original }
  }

  it('enquanto está à vista, reserva a altura dela em cima da tela; ao sumir, devolve', () => {
    const restore = fakeHeight(121.4)
    try {
      renderAt('/aluno/prova/Avaliacao?applicationId=app-1')
      const root = document.documentElement
      goOffline()
      act(() => { vi.advanceTimersByTime(BANNER_DELAY_MS - 100) })
      expect(root.style.getPropertyValue(BANNER_HEIGHT_VAR)).toBe('')
      act(() => { vi.advanceTimersByTime(200) })
      expect(screen.getByText(OFFLINE_TEXT)).toBeVisible()
      expect(root.style.getPropertyValue(BANNER_HEIGHT_VAR)).toBe('122px')
      act(() => { reportSuccess() })
      expect(screen.getByText(RECOVERED_TEXT)).toBeVisible()
      expect(root.style.getPropertyValue(BANNER_HEIGHT_VAR)).toBe('122px')
      act(() => { vi.advanceTimersByTime(RECOVERED_MS + 100) })
      expect(screen.queryByText(RECOVERED_TEXT)).not.toBeInTheDocument()
      expect(root.style.getPropertyValue(BANNER_HEIGHT_VAR)).toBe('')
    } finally { restore() }
  })

  it('o #root desce a altura da faixa (index.css) e a faixa recebe o toque', () => {
    // O vitest não entrega CSS por ?raw: lê o arquivo.
    const indexCss = readFileSync(join(__dirname, '../../index.css'), 'utf8')
    expect(indexCss).toMatch(/#root\s*\{[^}]*padding-top:\s*var\(--connection-banner-h,\s*0px\)/)
    renderAt('/aluno/prova/Avaliacao?applicationId=app-1')
    goOffline()
    act(() => { vi.advanceTimersByTime(BANNER_DELAY_MS) })
    expect(screen.getByTestId('server-connection-banner-box')).toHaveClass('pointer-events-auto')
  })

  it('sem faixa, nada reservado (servidor no ar o tempo todo)', () => {
    renderAt('/aluno')
    act(() => { vi.advanceTimersByTime(5000) })
    expect(document.documentElement.style.getPropertyValue(BANNER_HEIGHT_VAR)).toBe('')
  })
})

// Frente do H3, ajuste 2: com zoom de 200% num celular de 390 px (195 x 422 px CSS, o caso
// do UC-PROVA-003) a faixa completa ocupava 241 px e, com o cabeçalho fixo da prova,
// sobravam 39 px para as questões. Em tela estreita ou baixa a faixa fica compacta.
describe('[UC-AUTH-001] faixa compacta em tela estreita (zoom de 200%)', () => {
  const originalMatchMedia = window.matchMedia
  let listeners
  let compact
  beforeEach(() => {
    listeners = new Set()
    compact = true
    window.matchMedia = vi.fn((query) => ({
      get matches() { return query === COMPACT_MEDIA ? compact : false },
      media: query,
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
    }))
  })
  afterEach(() => { window.matchMedia = originalMatchMedia })

  it('na prova: textos curtos na mesma linha, sem a coluna do ícone', () => {
    renderAt('/aluno/prova/Avaliacao?applicationId=app-1')
    goOffline()
    act(() => { vi.advanceTimersByTime(BANNER_DELAY_MS) })
    const box = screen.getByTestId('server-connection-banner-box')
    expect(box).toHaveAttribute('data-compact', 'true')
    expect(box).toHaveTextContent(`${OFFLINE_SHORT_TEXT} ${EXAM_HINT_SHORT_TEXT}`)
    expect(screen.queryByText(OFFLINE_TEXT)).not.toBeInTheDocument()
    expect(screen.queryByText(EXAM_HINT_TEXT)).not.toBeInTheDocument()
    expect(box.querySelector('svg')).toBeNull()
    expect(box.querySelector('.block')).toBeNull()
    // O pedido de não recarregar continua lá, só mais curto.
    expect(EXAM_HINT_SHORT_TEXT).toMatch(/não recarregue/)
    act(() => { reportResponse(503, { starting: true }) })
    expect(screen.getByText(STARTING_SHORT_TEXT)).toBeVisible()
    expect(box.textContent.length).toBeLessThan((STARTING_TEXT + EXAM_HINT_TEXT).length / 2)
  })

  it('fora da prova, só o título curto; ao alargar a tela (giro, zoom) volta a faixa completa', () => {
    renderAt('/aluno')
    goOffline()
    act(() => { vi.advanceTimersByTime(BANNER_DELAY_MS) })
    expect(screen.getByTestId('server-connection-banner-box')).toHaveTextContent(OFFLINE_SHORT_TEXT)
    expect(screen.queryByText(EXAM_HINT_SHORT_TEXT)).not.toBeInTheDocument()
    act(() => { compact = false; listeners.forEach((fn) => fn()) })
    const box = screen.getByTestId('server-connection-banner-box')
    expect(box).not.toHaveAttribute('data-compact')
    expect(screen.getByText(OFFLINE_TEXT)).toBeVisible()
    expect(box.querySelector('svg')).not.toBeNull()
  })

  it('tela larga: a faixa completa de antes', () => {
    compact = false
    renderAt('/aluno/prova/Avaliacao?applicationId=app-1')
    goOffline()
    act(() => { vi.advanceTimersByTime(BANNER_DELAY_MS) })
    expect(screen.getByText(OFFLINE_TEXT)).toBeVisible()
    expect(screen.getByText(EXAM_HINT_TEXT)).toBeVisible()
    expect(window.matchMedia).toHaveBeenCalledWith(COMPACT_MEDIA)
  })
})
