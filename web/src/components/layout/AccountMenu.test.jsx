import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountMenu, accountInitials } from './AccountMenu'

// Avatar do topo do painel (fase 3, B1; UXI-07): iniciais do nome (antes, do e-mail:
// "professor@escola" virava "PE") e um menu com Minha conta e Sair.
afterEach(() => { cleanup() })

function renderMenu(props = {}) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<><AccountMenu name="Maria da Silva Souza" email="maria@escola.local" detail="Professor" {...props} /><button type="button">fora</button></>} />
        <Route path="/minha-conta" element={<h1>Página Minha conta</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('[UC-CONTA-001] avatar e menu da conta', () => {
  it('iniciais: primeira e última palavra do nome, sem "da/de/do"; sem nome, o e-mail', () => {
    expect(accountInitials('Maria da Silva Souza', 'x@y')).toBe('MS')
    expect(accountInitials('  joão  ', '')).toBe('J')
    expect(accountInitials('Ana de Oliveira')).toBe('AO')
    expect(accountInitials('', 'professor@teste.local')).toBe('PT')
    expect(accountInitials('', '')).toBe('IC')
  })

  it('abre com Minha conta e Sair, leva para Minha conta e fecha', async () => {
    const user = userEvent.setup()
    renderMenu()
    const button = screen.getByRole('button', { name: 'Menu da conta: Maria da Silva Souza' })
    expect(button).toHaveTextContent('MS')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu', { name: 'Sua conta' })
    expect(menu).toHaveTextContent('maria@escola.local')
    expect(menu).toHaveTextContent('Professor')
    await user.click(screen.getByRole('menuitem', { name: 'Minha conta' }))
    expect(screen.getByRole('heading', { name: 'Página Minha conta' })).toBeInTheDocument()
  })

  it('Sair chama o logout; Esc e um toque fora fecham sem sair', async () => {
    const user = userEvent.setup()
    const onLogout = vi.fn()
    renderMenu({ onLogout })
    const button = screen.getByRole('button', { name: /Menu da conta/ })
    await user.click(button)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(button).toHaveFocus()
    await user.click(button)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'fora' }))
    expect(screen.queryByRole('menu')).toBeNull()
    await user.click(button)
    await user.click(screen.getByRole('menuitem', { name: 'Sair' }))
    expect(onLogout).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
