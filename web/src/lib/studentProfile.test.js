import { describe, expect, it } from 'vitest'
import {
  NO_EMAIL_LABEL, displayEmail, isPlaceholderEmail, isStudentIdParam, studentFormIdentity,
  studentFormProblem, studentIdentityPayload, studentLoginLabel, studentRouteKey,
} from './studentProfile'

// P4-S3 (fase 3): o aluno sem e-mail guarda o endereço interno 'aluno-<id>@sem-email.invalid',
// que nunca aparece na tela; a ficha abre pelo id estável.
const PLACEHOLDER = 'aluno-alu_00000000000000f2@sem-email.invalid'

describe('[UC-IDENT-003] aluno sem e-mail na tela', () => {
  it('displayEmail troca o endereço interno por "sem e-mail" e deixa o e-mail real como está', () => {
    expect(NO_EMAIL_LABEL).toBe('sem e-mail')
    expect(isPlaceholderEmail(PLACEHOLDER)).toBe(true)
    expect(isPlaceholderEmail('ALUNO-ALU_00000000000000F2@SEM-EMAIL.INVALID')).toBe(true)
    expect(isPlaceholderEmail('eva@x.local')).toBe(false)
    expect(isPlaceholderEmail(null)).toBe(false)
    expect(displayEmail(PLACEHOLDER)).toBe('sem e-mail')
    expect(displayEmail({ email: PLACEHOLDER })).toBe('sem e-mail')
    expect(displayEmail('eva@x.local')).toBe('eva@x.local')
    expect(displayEmail(undefined)).toBe('')
  })

  it('formulário: abre com a caixa marcada e o e-mail vazio; o corpo manda semEmail e e-mail vazio', () => {
    expect(studentFormIdentity({ email: PLACEHOLDER })).toEqual({ semEmail: true, email: '', originalEmail: PLACEHOLDER })
    expect(studentFormIdentity({ email: 'eva@x.local' })).toEqual({ semEmail: false, email: 'eva@x.local', originalEmail: 'eva@x.local' })
    expect(studentIdentityPayload({ semEmail: true, email: 'sobrou@x.local' })).toEqual({ email: '', semEmail: true })
    expect(studentIdentityPayload({ semEmail: false, email: 'eva@x.local' })).toEqual({ email: 'eva@x.local', semEmail: false })
  })

  it('conferência antes de salvar: sem e-mail pede a matrícula; com e-mail pede o e-mail', () => {
    const base = { name: 'Eva', classes: ['1DES'] }
    expect(studentFormProblem({ ...base, semEmail: true, matricula: '  ' })).toBe('Para aluno sem e-mail, informe a matrícula.')
    expect(studentFormProblem({ ...base, semEmail: true, matricula: 'R7' })).toBe('')
    expect(studentFormProblem({ ...base, semEmail: false, email: '' })).toBe('Informe o e-mail do aluno ou marque "O aluno não tem e-mail".')
    expect(studentFormProblem({ ...base, email: 'eva@x.local' })).toBe('')
    expect(studentFormProblem({ ...base, name: '' , email: 'eva@x.local' })).toBe('Informe o nome do aluno.')
    expect(studentFormProblem({ name: 'Eva', email: 'eva@x.local', classes: [] })).toBe('Escolha ao menos uma turma.')
  })

  it('aviso da senha temporária: o aluno sem e-mail entra com a matrícula', () => {
    expect(studentLoginLabel({ semEmail: true, matricula: ' R7 ' })).toBe('Matrícula R7')
    expect(studentLoginLabel({ email: PLACEHOLDER, matricula: '' })).toBe('sem e-mail')
    expect(studentLoginLabel({ email: 'eva@x.local', matricula: 'R7' })).toBe('eva@x.local')
  })
})

describe('[UC-IDENT-001] endereço da ficha pelo id estável', () => {
  it('studentRouteKey usa o id; cadastro sem id cai no e-mail codificado', () => {
    expect(studentRouteKey({ id: 'alu_00000000000000e1', email: 'eva@x.local' })).toBe('alu_00000000000000e1')
    expect(studentRouteKey({ email: 'ana+1@x.local' })).toBe('ana%2B1%40x.local')
    expect(studentRouteKey(null)).toBe('')
  })

  it('isStudentIdParam reconhece só o formato alu_ + 16 hex', () => {
    expect(isStudentIdParam('alu_00000000000000e1')).toBe(true)
    expect(isStudentIdParam('alu_123')).toBe(false)
    expect(isStudentIdParam('eva@x.local')).toBe(false)
    expect(isStudentIdParam('novo')).toBe(false)
  })
})
