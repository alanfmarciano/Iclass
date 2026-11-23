import { cleanup, render, screen, within } from '@testing-library/react'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { afterEach, describe, expect, it, vi } from 'vitest'
import tailwindConfig from '../../../tailwind.config.js'
import { MonthCalendar, firstOfMonth } from './MonthCalendar'

// O dia não letivo é "pintado" no mês (B7 / P2-S6, FUN-15). O jsdom não aplica o CSS do
// Tailwind, então o teste compila com o próprio Tailwind do projeto as classes de fundo da
// célula e confere que cada uma gera CSS: as cores do tailwind.config são var(--...), e com
// elas "bg-warning-soft/40" não gerava nada (a célula ficava sem fundo).
async function generatedCss(classNames) {
  const html = `<div class="${classNames.join(' ')}"></div>`
  const result = await postcss([tailwindcss({ ...tailwindConfig, content: [{ raw: html, extension: 'html' }], corePlugins: { preflight: false } })])
    .process('@tailwind utilities;', { from: undefined })
  return result.css
}

const escapeClass = (name) => name.replace(/[/:.[\]]/g, (ch) => `\\${ch}`)

async function expectBackgroundGenerated(element) {
  const backgrounds = [...element.classList].filter((name) => /^bg-/.test(name))
  expect(backgrounds.length, 'a célula do dia sem aula tem classe de fundo').toBeGreaterThan(0)
  const css = await generatedCss(backgrounds)
  backgrounds.forEach((name) => {
    const rule = new RegExp(`\\.${escapeClass(name).replace(/\\/g, '\\\\')}\\s*\\{[^}]*background-color`)
    expect(css, `${name} gera background-color`).toMatch(rule)
  })
}

const month = firstOfMonth(new Date(2026, 10, 1))
const events = [
  { id: 'nl_1', title: 'Recesso escolar', eventDate: '2026-11-23', endDate: '2026-11-25', eventType: 'nao_letivo' },
  { id: 'cal_1', title: 'Prova de Redes', eventDate: '2026-11-10', startTime: '08:00', eventType: 'prova' },
]

afterEach(() => cleanup())

describe('[UC-PRESENCA-005] mês do calendário com dia não letivo', () => {
  it('a célula do dia sem aula fica pintada (a classe de fundo gera CSS) e a do dia comum não', async () => {
    const { container } = render(<MonthCalendar month={month} onMonthChange={vi.fn()} events={events} />)
    const cell = container.querySelector('[data-date="2026-11-24"]')
    expect(cell).toHaveAttribute('data-sem-aula', 'true')
    expect(cell.classList.contains('bg-warning-soft')).toBe(true)
    await expectBackgroundGenerated(cell)
    const comum = container.querySelector('[data-date="2026-11-26"]')
    expect([...comum.classList].some((name) => name.startsWith('bg-warning'))).toBe(false)
  }, 20000)

  it('no celular o dia sem aula da lista também fica pintado', async () => {
    const original = window.matchMedia
    window.matchMedia = vi.fn((query) => ({ matches: query === '(max-width: 767px)', media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    try {
      render(<MonthCalendar month={month} onMonthChange={vi.fn()} events={events} />)
      const itens = within(screen.getByRole('list', { name: /^Dias de / })).getAllByRole('listitem')
      const semAula = itens.find((item) => within(item).queryByText('Sem aula'))
      expect(semAula).toBeTruthy()
      await expectBackgroundGenerated(semAula)
      expect([...itens[0].classList].some((name) => name.startsWith('bg-'))).toBe(false)
    } finally { window.matchMedia = original }
  }, 20000)

  it('a guarda pega o modificador de opacidade que não gera CSS', async () => {
    // Confere a própria conferência: com a classe antiga o teste acima teria falhado.
    const css = await generatedCss(['bg-warning-soft/40', 'bg-warning-soft'])
    expect(css).not.toMatch(/bg-warning-soft\\\/40/)
    expect(css).toMatch(/\.bg-warning-soft\s*\{[^}]*background-color/)
  }, 20000)
})
