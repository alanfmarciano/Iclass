import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { STAT_CARD_ICONS, StatCard } from './StatCard'

// Fase 2, H2-A (DES-06): o StatCard importava a biblioteca inteira de ícones
// (`import * as`), o que levava os ~1.500 ícones para o pacote do app, baixado até pelo
// celular do aluno. Agora usa só os ícones nomeados do mapa STAT_CARD_ICONS.
const SOURCES = import.meta.glob('../../**/*.{js,jsx}', { query: '?raw', import: 'default', eager: true })

function statCardIconProps() {
  const found = []
  for (const [file, source] of Object.entries(SOURCES)) {
    for (const match of source.matchAll(/<StatCard\b[^>]*?\sicon=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g)) {
      found.push({ file, literal: match[1] ?? match[2] ?? null, expression: match[3] ?? null })
    }
  }
  return found
}

afterEach(cleanup)

describe('[UC-DESEMPENHO-001] StatCard com ícones nomeados', () => {
  it('todo icon="..." usado com StatCard em web/src existe no mapa de ícones', () => {
    const uses = statCardIconProps()
    expect(uses.length).toBeGreaterThanOrEqual(11)
    for (const use of uses) {
      // Nome fixo no código: senão este teste não consegue conferir o ícone.
      expect(use.expression, `${use.file}: icon={${use.expression}}`).toBeNull()
      expect(Object.keys(STAT_CARD_ICONS), `${use.file}: ${use.literal}`).toContain(use.literal)
    }
  })

  it('nenhum arquivo de web/src importa todos os ícones da biblioteca', () => {
    const wildcard = /(?:import|export)\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s*['"]lucide-react['"]/
    const offenders = Object.entries(SOURCES).filter(([, source]) => wildcard.test(source)).map(([file]) => file)
    expect(offenders).toEqual([])
  })

  it('mostra o ícone pedido e cai no ícone padrão para um nome desconhecido', () => {
    const { container, rerender } = render(<StatCard label="Total de alunos" value={12} icon="Users" />)
    expect(screen.getByText('Total de alunos')).toBeInTheDocument()
    expect(container.querySelector('svg.lucide-users')).toBeTruthy()
    rerender(<StatCard label="Outro" value={1} icon="IconeQueNaoExiste" />)
    expect(container.querySelector('svg.lucide-activity')).toBeTruthy()
    rerender(<StatCard label="Protótipo" value={1} icon="toString" />)
    expect(container.querySelector('svg.lucide-activity')).toBeTruthy()
  })
})
