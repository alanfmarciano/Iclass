import { describe, expect, it } from 'vitest'
import { isStudentExamPath, shouldExpireForIdle } from './sessionActivity'

describe('atividade de sessao durante prova', () => {
  it('reconhece apenas a rota de execucao da prova', () => {
    expect(isStudentExamPath('/aluno/prova/Avaliacao_FUTEC_1')).toBe(true)
    expect(isStudentExamPath('/aluno/provas')).toBe(false)
    expect(isStudentExamPath('/admin/provas')).toBe(false)
  })

  it('nao expira aluno por inatividade enquanto a prova esta aberta', () => {
    expect(shouldExpireForIdle({
      role: 'student',
      pathname: '/aluno/prova/Avaliacao_FUTEC_1',
      idleForMs: 10 * 60 * 1000,
      idleLimitMs: 5 * 60 * 1000,
    })).toBe(false)
  })

  it('mantem a expiracao normal fora da prova e para instrutores', () => {
    expect(shouldExpireForIdle({ role: 'student', pathname: '/aluno', idleForMs: 600001, idleLimitMs: 600000 })).toBe(true)
    expect(shouldExpireForIdle({ role: 'admin', pathname: '/aluno/prova/Avaliacao_FUTEC_1', idleForMs: 600001, idleLimitMs: 600000 })).toBe(true)
  })
})
