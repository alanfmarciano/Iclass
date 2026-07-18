import { describe, expect, it } from 'vitest'
import { detectTeacherClashes } from './gradeConflicts'
import { gradePrintHtml } from './gradePrint'

const grade = { '1': [{ ordem: 1, inicio: '07:00', disciplinaId: 'MAT' }, { ordem: 2, inicio: '08:00', disciplinaId: 'HIS' }] }

describe('detectTeacherClashes', () => {
  const professors = [
    { name: 'Ana', email: 'ana@x.com', assignedClasses: [{ courseId: 'DES', className: '1DES' }, { courseId: 'DES', className: '2DES' }] },
    { name: 'Beto', email: 'beto@x.com', assignedClasses: [{ courseId: 'DES', className: '3DES' }] },
  ]
  const allClasses = [
    { courseId: 'DES', name: '2DES', attendanceConfig: { grade: { '1': [{ ordem: 1, inicio: '07:00', disciplinaId: 'POR' }] } } },
    { courseId: 'DES', name: '3DES', attendanceConfig: { grade: { '1': [{ ordem: 1, inicio: '07:00', disciplinaId: 'GEO' }] } } },
  ]

  it('acusa quando o mesmo professor tem outra turma no mesmo dia e horário', () => {
    const clashes = detectTeacherClashes({ courseId: 'DES', className: '1DES', grade, allClasses, professors })
    expect(clashes).toHaveLength(1)
    expect(clashes[0]).toMatchObject({ professor: 'Ana', otherClass: '2DES', weekday: '1', inicio: '07:00', weekdayLabel: 'Segunda' })
  })

  it('não acusa conflito de professor que não leciona esta turma', () => {
    // Beto (3DES) tem aula 07:00 seg, mas não dá aula na 1DES → não é conflito dela.
    const clashes = detectTeacherClashes({ courseId: 'DES', className: '1DES', grade, allClasses, professors })
    expect(clashes.some(c => c.professor === 'Beto')).toBe(false)
  })

  it('retorna vazio quando não há sobreposição de horário', () => {
    const otherTime = [{ courseId: 'DES', name: '2DES', attendanceConfig: { grade: { '1': [{ ordem: 1, inicio: '13:00', disciplinaId: 'POR' }] } } }]
    const clashes = detectTeacherClashes({ courseId: 'DES', className: '1DES', grade, allClasses: otherTime, professors })
    expect(clashes).toEqual([])
  })
})

describe('gradePrintHtml', () => {
  it('gera uma tabela com os dias ativos, horários e nomes das disciplinas', () => {
    const html = gradePrintHtml({
      courseName: 'Desenvolvimento', turmaName: '1DES',
      attendanceConfig: { grade },
      disciplinas: [{ id: 'MAT', nome: 'Matemática', cor: '#0091ff' }, { id: 'HIS', nome: 'História', cor: '' }],
    })
    expect(html).toContain('1DES')
    expect(html).toContain('Segunda')
    expect(html).toContain('Matemática')
    expect(html).toContain('07:00')
    // Escapa conteúdo e não deixa dia sem aula na tabela.
    expect(html).not.toContain('Terça')
  })
})
