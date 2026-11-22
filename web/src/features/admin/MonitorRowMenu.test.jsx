import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MonitorRowMenu } from './MonitorRowMenu'

// Fase 3, A4 (P3-S8, AVA-14), ajuste 1: o menu "Mais ações" abria fora da tela quando a
// página estava rolada, porque o painel tem um ancestral com transform (.app-enter) e o
// position:fixed ficava relativo a ele. O menu passa a ser desenhado em document.body.
describe('MonitorRowMenu', () => {
  const originalHeight = window.innerHeight
  const originalWidth = window.innerWidth

  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1366 })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
  })

  function renderInTransformedShell(onSelect, rect) {
    render(
      // Igual ao LumenAdminShell: a animação de entrada deixa um transform no ancestral.
      <div className="app-enter" style={{ transform: 'matrix(1, 0, 0, 1, 0, 0)' }} data-testid="shell">
        <MonitorRowMenu label="Mais ações de Elisa" items={[{ id: 'recolher', label: 'Recolher prova', onSelect }, { id: 'extra', label: 'Dar tentativa extra', onSelect: vi.fn() }]} />
      </div>,
    )
    const button = screen.getByRole('button', { name: 'Mais ações de Elisa' })
    button.getBoundingClientRect = () => ({ top: rect.top, bottom: rect.top + 32, left: 1300, right: 1332, width: 32, height: 32, x: 1300, y: rect.top })
    return button
  }

  it('abre o menu em document.body, fixo e dentro da janela, mesmo com ancestral transformado', () => {
    const onSelect = vi.fn()
    const button = renderInTransformedShell(onSelect, { top: 170 })
    fireEvent.click(button)
    const menu = screen.getByRole('menu', { name: 'Mais ações de Elisa' })
    expect(menu.parentElement).toBe(document.body)
    expect(screen.getByTestId('shell').contains(menu)).toBe(false)
    expect(menu.style.position).toBe('fixed')
    const top = parseFloat(menu.style.top)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(top).toBeLessThan(window.innerHeight)
    expect(top).toBe(206)
    expect(menu.style.right).toBe('34px')
    // Escolher um item ainda funciona pelo portal e fecha o menu.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Recolher prova' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('perto do fim da tela abre para cima, sem passar do topo da janela', () => {
    const button = renderInTransformedShell(vi.fn(), { top: 700 })
    fireEvent.click(button)
    const menu = screen.getByRole('menu', { name: 'Mais ações de Elisa' })
    expect(menu.parentElement).toBe(document.body)
    expect(menu.style.top).toBe('')
    const bottom = parseFloat(menu.style.bottom)
    expect(bottom).toBe(72)
    expect(bottom).toBeLessThan(window.innerHeight)
    expect(parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(window.innerHeight)
  })

  it('fecha com Esc e com clique fora do menu', () => {
    const button = renderInTransformedShell(vi.fn(), { top: 300 })
    fireEvent.click(button)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
