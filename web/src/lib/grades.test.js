import { describe, expect, it } from 'vitest'
import { boletimContext, fmtGrade, fmtGradeValue, gradeOf, parseGradeInput, previewQuickGrade, roundGrade, validateQuickGrade } from './grades'

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
})
