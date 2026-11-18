import { describe, expect, it } from 'vitest'
import { CRITERIO_PADRAO, boletimChoiceOptions, boletimContext, consolidatedAverage, fmtGrade, fmtGradeValue, fmtMinimumGrade, gradeBand, gradeOf, gradeTone, isPassingGrade, isValidScore, parseGradeInput, previewQuickGrade, roundGrade, scoreBand, scoreFromGrade, validateQuickGrade } from './grades'

describe('notas na interface', () => {
  it('[UC-NOTAS-001] formata 0 a 100 como 0 a 10 com vírgula e esconde nota inválida', () => {
    expect(fmtGrade(85)).toBe('8,5')
    expect(fmtGrade(70)).toBe('7,0')
    expect(fmtGrade(0)).toBe('0,0')
    expect(fmtGrade(150)).toBe('—')
    expect(fmtGrade(-20)).toBe('—')
    expect(fmtGrade(null)).toBe('—')
    expect(fmtGrade('abc', '-')).toBe('-')
    expect(gradeOf(100)).toBe(10)
    expect(gradeOf(undefined)).toBeNull()
  })

  it('[UC-NOTAS-001] lê a nota digitada com vírgula ou ponto, de 0 a 10', () => {
    expect(parseGradeInput('8,5')).toBe(8.5)
    expect(parseGradeInput('8.5')).toBe(8.5)
    expect(parseGradeInput(' 10 ')).toBe(10)
    expect(parseGradeInput('')).toBeNull()
    expect(Number.isNaN(parseGradeInput('15'))).toBe(true)
    expect(Number.isNaN(parseGradeInput('-1'))).toBe(true)
    expect(Number.isNaN(parseGradeInput('dez'))).toBe(true)
  })

  it('[UC-NOTAS-001] valida o lançamento rápido como o servidor', () => {
    expect(validateQuickGrade({ grade: '', correctCount: '7', totalCount: '10' })).toEqual({ errors: {}, payload: { correctCount: 7, totalCount: 10 } })
    expect(validateQuickGrade({ grade: '8,5', correctCount: '', totalCount: '' }).payload).toEqual({ grade: 8.5 })
    expect(validateQuickGrade({ grade: '150', correctCount: '', totalCount: '' }).errors.grade).toMatch(/0 a 10/)
    expect(validateQuickGrade({ grade: '', correctCount: '3', totalCount: '2' }).errors.correctCount).toMatch(/total/)
    expect(validateQuickGrade({ grade: '', correctCount: '2', totalCount: '0' }).errors.totalCount).toMatch(/maior que zero/)
    expect(validateQuickGrade({ grade: '', correctCount: '2', totalCount: '20' }, { maxQuestions: 10 }).errors.totalCount).toMatch(/10 questões/)
    expect(validateQuickGrade({ grade: '', correctCount: '', totalCount: '' }).errors.grade).toMatch(/Informe a nota/)
    expect(previewQuickGrade({ correctCount: 7 }, 10)).toBe(7)
    expect(previewQuickGrade({ grade: 8.5 }, 10)).toBe(8.5)
  })

  it('[UC-NOTAS-003] boletim usa o curso ativo e pede escolha quando o aluno está em vários cursos fora dele', () => {
    const bia = { classes: [{ name: '1DES', courseId: 'DES' }, { name: '2RED', courseId: 'RED' }] }
    expect(boletimContext(bia, { courseId: 'RED', className: '2RED' })).toEqual({ courseId: 'RED', studentClass: '2RED' })
    expect(boletimContext(bia, { courseId: 'DES', className: '1DES' })).toEqual({ courseId: 'DES', studentClass: '1DES' })
    expect(boletimContext(bia, { courseId: 'OUTRO', className: 'X' }).choose).toHaveLength(2)
    expect(boletimContext({ classes: [{ name: '1DES', courseId: 'DES' }] }, {})).toEqual({ courseId: 'DES', studentClass: '1DES' })
  })

  it('[UC-NOTAS-003] arredonda como o boletim e as planilhas (metade para cima, sem ruído de ponto flutuante)', () => {
    expect(fmtGrade(73.5)).toBe('7,4')
    expect(fmtGrade(84.95)).toBe('8,5')
    expect(fmtGrade((60 + 87) / 2)).toBe('7,4')
    expect(roundGrade(200 / 3)).toBe(6.7)
    expect(fmtGradeValue(7.35)).toBe('7,4')
    expect(fmtGradeValue(null)).toBe('—')
    expect(fmtGradeValue(15)).toBe('—')
  })

  it('[UC-NOTAS-001] sem total digitado, usa o total da turma (quantidade configurada) na validação e na prévia', () => {
    const limits = { maxQuestions: 4, defaultTotal: 2 }
    const ok = validateQuickGrade({ grade: '', correctCount: '2', totalCount: '' }, limits)
    expect(ok.errors).toEqual({})
    expect(previewQuickGrade(ok.payload, limits.defaultTotal)).toBe(10)
    expect(validateQuickGrade({ grade: '', correctCount: '3', totalCount: '' }, limits).errors.correctCount).toMatch(/Nesta turma a prova tem 2 questões/)
    expect(validateQuickGrade({ grade: '', correctCount: '3', totalCount: '4' }, limits).errors).toEqual({})
    expect(validateQuickGrade({ grade: '', correctCount: '2', totalCount: '5' }, limits).errors.totalCount).toMatch(/4 questões/)
  })

  it('[UC-NOTAS-001] recusa nota que não confere com os acertos', () => {
    expect(validateQuickGrade({ grade: '10', correctCount: '0', totalCount: '4' }).errors.grade).toMatch(/Não confere com 0 de 4 acertos \(0,0\)/)
    expect(validateQuickGrade({ grade: '7,5', correctCount: '3', totalCount: '' }, { maxQuestions: 4 }).errors).toEqual({})
    expect(validateQuickGrade({ grade: '6,7', correctCount: '2', totalCount: '3' }).errors).toEqual({})
    expect(validateQuickGrade({ grade: '8', correctCount: '', totalCount: '' }).errors).toEqual({})
  })

  it('[UC-NOTAS-001] confere nota e acertos pela nota que será gravada (7,41 vira 7,4)', () => {
    expect(scoreFromGrade(7.41)).toBe(74)
    expect(scoreFromGrade(8.15)).toBe(82)
    expect(validateQuickGrade({ grade: '7,41', correctCount: '3', totalCount: '4' }).errors.grade).toMatch(/Não confere \(gravada como 7,4\) com 3 de 4 acertos \(7,5\)/)
    expect(validateQuickGrade({ grade: '7,59', correctCount: '3', totalCount: '4' }).errors.grade).toMatch(/gravada como 7,6/)
    expect(validateQuickGrade({ grade: '7,4', correctCount: '3', totalCount: '4' }).errors.grade).toMatch(/^Não confere com 3 de 4/)
    const ok = validateQuickGrade({ grade: '7,45', correctCount: '3', totalCount: '4' })
    expect(ok.errors).toEqual({})
    expect(previewQuickGrade(ok.payload)).toBe(7.5)
    expect(validateQuickGrade({ grade: '6,6', correctCount: '2', totalCount: '3' }).errors).toEqual({})
  })

  it('[UC-NOTAS-003] média do aluno: uma nota por prova (a consolidada), como no painel e no boletim', () => {
    const subs = [
      { id: 'a1', examKey: 'P1', applicationId: null, gradePublished: true, score: 60, consolidatedScore: 70 },
      { id: 'a2', examKey: 'P1', applicationId: null, gradePublished: true, score: 80, consolidatedScore: 70 },
      { id: 'b1', examKey: 'P2', applicationId: 'app_1', gradePublished: true, score: 100, consolidatedScore: 100 },
      { id: 'c1', examKey: 'P3', applicationId: null, gradePublished: false, score: 20, consolidatedScore: null },
    ]
    expect(consolidatedAverage(subs)).toBe(85)
    expect(fmtGrade(consolidatedAverage(subs))).toBe('8,5')
    expect(consolidatedAverage([{ examKey: 'P1', gradePublished: true, consolidatedScore: 150 }])).toBeNull()
    expect(consolidatedAverage([])).toBeNull()
  })

  it('[UC-NOTAS-003] seletor do boletim: nome do curso e, para o professor, só as matrículas do seu escopo', () => {
    const memberships = [{ name: '1DES', courseId: 'DES' }, { name: '2RED', courseId: 'RED' }]
    const summaries = [{ id: 'DES', name: 'Técnico em Desenvolvimento', classes: [{ name: '1DES' }] }]
    expect(boletimChoiceOptions(memberships, summaries, { restricted: true })).toEqual([
      { name: '1DES', courseId: 'DES', courseName: 'Técnico em Desenvolvimento', allowed: true },
      { name: '2RED', courseId: 'RED', courseName: '', allowed: false },
    ])
    expect(boletimChoiceOptions([{ name: '2DES', courseId: 'DES' }], summaries, { restricted: true })[0].allowed).toBe(false)
    expect(boletimChoiceOptions(memberships, summaries).map((m) => m.allowed)).toEqual([true, true])
  })
})

describe('faixas da nota pelo critério (regra única)', () => {
  it('[UC-TENTATIVA-003] com a mínima padrão 6,0 as faixas são as de sempre: 9, 7, 6 e 4', () => {
    expect(CRITERIO_PADRAO.mediaMinima).toBe(6)
    const tabela = [
      [10, 'excelente'], [9, 'excelente'], [8.95, 'excelente'], [8.94, 'bom'], [7, 'bom'], [6.95, 'bom'],
      [6.9, 'suficiente'], [6, 'suficiente'], [5.96, 'suficiente'], [5.94, 'abaixo'], [4, 'abaixo'],
      [3.9, 'muito_abaixo'], [0, 'muito_abaixo'], [null, null], [undefined, null], ['', null], [11, null], [-1, null], [NaN, null],
    ]
    for (const [nota, faixa] of tabela) expect(gradeBand(nota), `nota ${nota}`).toBe(faixa)
    expect(scoreBand(59.6)).toBe('suficiente')
    expect(scoreBand(150)).toBeNull()
    expect(isPassingGrade(5.95)).toBe(true)
    expect(isPassingGrade(5.9)).toBe(false)
    expect(isPassingGrade(null)).toBeNull()
    expect(fmtMinimumGrade()).toBe('6,0')
  })

  it('[UC-TENTATIVA-003] com mínima 5 (critério do curso) a aprovação e o alerta acompanham a mínima', () => {
    const criterio = { mediaMinima: 5 }
    expect(gradeBand(5, criterio)).toBe('suficiente')
    expect(gradeBand(4.9, criterio)).toBe('abaixo')
    expect(gradeBand(3, criterio)).toBe('abaixo')
    expect(gradeBand(2.9, criterio)).toBe('muito_abaixo')
    expect(gradeBand(7, criterio)).toBe('bom')
    expect(isPassingGrade(5.5, criterio)).toBe(true)
    expect(isPassingGrade(5.5, { mediaMinima: 7.5 })).toBe(false)
    expect(gradeBand(7, { mediaMinima: 7.5 })).toBe('abaixo')
    expect(gradeBand(8, { mediaMinima: 7.5 })).toBe('bom')
    expect(fmtMinimumGrade({ mediaMinima: 5.5 })).toBe('5,5')
    // Mínima inválida cai no padrão.
    expect(gradeBand(5.5, { mediaMinima: 'abc' })).toBe('abaixo')
    expect(gradeBand(5.5, { mediaMinima: 12 })).toBe('abaixo')
  })

  it('[UC-TENTATIVA-003] tom do Badge por escala, sem comparar nota com número na tela', () => {
    expect(['excelente', 'bom', 'suficiente', 'abaixo', 'muito_abaixo'].map((faixa) => ({ excelente: 9.5, bom: 7.5, suficiente: 6.5, abaixo: 5, muito_abaixo: 2 })[faixa])
      .map((nota) => [gradeTone(nota), gradeTone(nota, undefined, 'aluno'), gradeTone(nota, undefined, 'simples')]))
      .toEqual([
        ['success', 'success', 'success'],
        ['success', 'success', 'success'],
        ['success', 'warning', 'success'],
        ['warning', 'danger', 'warning'],
        ['danger', 'danger', 'warning'],
      ])
    expect(gradeTone(null)).toBe('neutral')
    expect(gradeTone(null, undefined, 'simples', 'warning')).toBe('warning')
  })

  it('[UC-TENTATIVA-003] nota só com espaços é vazia, como no servidor (antes virava 0)', () => {
    expect(gradeOf('  ')).toBeNull()
    expect(isValidScore('  ')).toBe(false)
    expect(fmtGrade(' ')).toBe('—')
    expect(gradeOf('85')).toBe(8.5)
  })
})
