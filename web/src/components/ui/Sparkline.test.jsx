import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Sparkline } from './Sparkline'
import { TrendPill } from './TrendPill'
import { ReasonChips } from '../../features/admin/dashboard/ReasonChips'

afterEach(cleanup)

describe('Sparkline', () => {
  it('expõe rótulo e valor por ponto (sem rótulo o gráfico é decorativo)', () => {
    render(<Sparkline points={[{ label: '01/07', valor: 80 }, { label: '06/07', valor: null }]} unit="%" />)
    const serie = screen.getByRole('img')
    expect(serie.getAttribute('aria-label')).toContain('01/07: 80%')
    expect(serie.getAttribute('aria-label')).toContain('06/07: sem dado')
    expect(document.querySelector('[title="01/07 · 80%"]')).toBeTruthy()
  })

  it('ponto null vira barra vazia, não barra de altura zero enganosa', () => {
    const { container } = render(<Sparkline points={[{ label: 'a', valor: 50 }, { label: 'b', valor: null }]} />)
    const barras = container.querySelectorAll('.absolute')
    expect(barras.length).toBe(1) // só o ponto com valor pinta preenchimento
  })
})

describe('TrendPill', () => {
  it('não codifica só por cor: glifo + texto acessível', () => {
    render(<TrendPill delta={3} unit=" p.p." />)
    expect(screen.getByText('subiu')).toBeTruthy() // sr-only
    expect(screen.getByText('3 p.p.')).toBeTruthy()
  })
  it('delta negativo em métrica invertida é bom (verde)', () => {
    const { container } = render(<TrendPill delta={-2} invert />)
    expect(container.firstChild.className).toContain('success')
  })
  it('sem base de comparação mostra "sem base", nunca 0 espúrio', () => {
    render(<TrendPill delta={null} />)
    expect(screen.getByText('sem base')).toBeTruthy()
  })
})

describe('ReasonChips', () => {
  it('corta em 2 motivos + "mais N" com o restante no title', () => {
    render(<ReasonChips reasons={['a', 'b', 'c', 'd']} />)
    expect(screen.getByText('a')).toBeTruthy()
    expect(screen.getByText('b')).toBeTruthy()
    expect(screen.queryByText('c')).toBeNull()
    const mais = screen.getByText('mais 2')
    expect(mais.getAttribute('title')).toBe('c · d')
  })
  it('não renderiza nada sem motivos', () => {
    const { container } = render(<ReasonChips reasons={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
