import { lazy } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, NavLink, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from './AppShell'

vi.mock('../../context/BrandingProvider', () => ({ useBranding: () => ({ interfacePreset: 'classic' }) }))
vi.mock('../../features/admin/AdminCourseGate', () => ({ AdminCourseGate: ({ children }) => children }))
vi.mock('./Topbar', () => ({ Topbar: ({ onMenu }) => <button type="button" onClick={onMenu}>Abrir menu</button> }))
vi.mock('./Sidebar', () => ({
  Sidebar: ({ open, onNavigate }) => (
    <aside data-testid="sidebar" data-open={open ? 'true' : 'false'}>
      <NavLink to="/sistema" onClick={onNavigate}>Sistema</NavLink>
      <NavLink to="/" onClick={onNavigate}>Dashboard</NavLink>
    </aside>
  ),
}))

function setViewport(desktop) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({ matches: desktop, media: query, addEventListener() {}, removeEventListener() {} }))
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<p>Página inicial</p>} />
          <Route path="/sistema" element={<button type="button">Limpar estado de prova</button>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('AppShell · menu lateral no celular', () => {
  afterEach(cleanup)

  it('[UC-MANUT-001] a 390 px o menu fecha ao tocar em Sistema e a página fica acessível', async () => {
    setViewport(false)
    const user = userEvent.setup()
    renderShell()
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'false')
    await user.click(screen.getByRole('button', { name: 'Abrir menu' }))
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'true')
    await user.click(screen.getByRole('link', { name: 'Sistema' }))
    expect(screen.getByRole('button', { name: 'Limpar estado de prova' })).toBeVisible()
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'false')
    expect(screen.queryByRole('button', { name: 'Fechar menu' })).not.toBeInTheDocument()
  })

  it('no computador o menu lateral continua aberto ao navegar', async () => {
    setViewport(true)
    const user = userEvent.setup()
    renderShell()
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'true')
    await user.click(screen.getByRole('link', { name: 'Sistema' }))
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'true')
  })
})

describe('[UC-DESEMPENHO-001] AppShell · tela sob demanda', () => {
  afterEach(cleanup)

  it('enquanto o arquivo da tela chega, mostra "Carregando..." dentro do painel, com o menu à vista', async () => {
    setViewport(true)
    let resolveModule
    const pending = new Promise((resolve) => { resolveModule = resolve })
    const TelaSobDemanda = lazy(() => pending)
    render(
      <MemoryRouter initialEntries={['/monitor']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/monitor" element={<TelaSobDemanda />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Carregando...')
    expect(screen.getByTestId('sidebar')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Abrir menu' })).toBeInTheDocument()
    await act(async () => { resolveModule({ default: () => <p>Monitor da turma</p> }) })
    expect(await screen.findByText('Monitor da turma')).toBeInTheDocument()
    expect(screen.queryByText('Carregando...')).not.toBeInTheDocument()
  })
})
