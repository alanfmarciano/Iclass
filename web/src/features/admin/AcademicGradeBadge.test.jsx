import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AcademicGradeBadge, academicGradeText, historyGrade } from './AcademicGradeBadge'
import { CRITERIO_PADRAO } from '../../lib/grades'

afterEach(cleanup)

// A9, ajuste 1: a ficha do aluno não mostra a nota parcial da prova que aguarda a correção
// nem a nota gravada da tentativa anulada (antes: "8,3" e "nota inválida").
describe('[UC-CORRECAO-001] nota da tentativa na ficha do aluno', () => {
  it('aguardando correção, anulada com zero, anulada sem contar, inválida e normal', () => {
    render(
      <div>
        <AcademicGradeBadge submission={{ score: null, awaitingCorrection: true }} />
        <AcademicGradeBadge submission={{ score: 0, integrity: 'zero' }} />
        <AcademicGradeBadge submission={{ score: null, integrity: 'desconsiderar' }} />
        <AcademicGradeBadge submission={{ score: null }} />
        <AcademicGradeBadge submission={{ score: 83 }} criterio={CRITERIO_PADRAO} />
      </div>,
    )
    expect(screen.getByText('aguardando correção')).toBeInTheDocument()
    expect(screen.getByText('0,0 · anulada')).toBeInTheDocument()
    expect(screen.getByText('anulada · não conta')).toBeInTheDocument()
    expect(screen.getByText('nota inválida')).toBeInTheDocument()
    expect(screen.getByText('8,3')).toBeInTheDocument()
  })

  it('texto da linha do tempo e leitura da lista de Resultados', () => {
    expect(academicGradeText({ awaitingCorrection: true, score: null })).toBe('aguardando correção')
    expect(academicGradeText({ integrity: 'zero', score: 0 })).toBe('nota 0,0 (anulada)')
    expect(academicGradeText({ integrity: 'desconsiderar', score: null })).toBe('anulada, não conta')
    expect(academicGradeText({ score: 70 })).toBe('nota 7,0')
    // GET /api/admin/submissions traz a nota gravada e a decisão em integrityDecision.
    expect(historyGrade({ score: 83, integrityDecision: 'zero' })).toMatchObject({ score: 0, integrity: 'zero', awaitingCorrection: false })
    expect(historyGrade({ score: 33, awaitingCorrection: true })).toMatchObject({ score: 33, integrity: null, awaitingCorrection: true })
  })
})
