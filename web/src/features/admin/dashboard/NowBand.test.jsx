import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NowBand } from './NowBand'

afterEach(cleanup)

// C19 (P5-S5): a chamada feita só para um grupo não aparece como lançada na faixa
// "Agora"; o resto da turma continua cobrado.
describe('[UC-GRUPO-003] NowBand · chamada de um grupo só', () => {
  const now = (aula) => ({ aula: { ordem: 1, nome: 'Lógica', inicio: '08:00', fim: '08:50', toleranciaMin: 10, ...aula }, aplicacao: null, online: { count: 0 } })

  it('mostra "feita só para parte da turma" quando o servidor manda chamadaParcial', () => {
    render(<NowBand now={now({ chamadaStatus: 'rascunho', chamadaParcial: true })} onChamada={() => {}} />)
    expect(screen.getByText('Chamada feita só para parte da turma →')).toBeTruthy()
    expect(screen.queryByText(/Chamada lançada/)).toBeNull()
  })

  it('sem grupo, o mesmo texto de antes', () => {
    render(<NowBand now={now({ chamadaStatus: 'rascunho' })} onChamada={() => {}} />)
    expect(screen.getByText('Chamada em rascunho →')).toBeTruthy()
    cleanup()
    render(<NowBand now={now({ chamadaStatus: 'concluida' })} onChamada={() => {}} />)
    expect(screen.getByText('Chamada lançada ✓')).toBeTruthy()
  })
})
