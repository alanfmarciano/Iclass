import { describe, expect, it } from 'vitest'
import { EXAM_TAB_ALIVE_KEY, EXAM_TAB_ALIVE_MS, clearExamTabAlive, examTabAliveElsewhere, isStudentExamPath, markExamTabAlive, shouldExpireForIdle } from './sessionActivity'

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

describe('aba da prova aberta em outra aba do mesmo navegador (P3-S13)', () => {
  function memoryStorage() {
    const data = new Map()
    return {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => data.set(key, String(value)),
      removeItem: (key) => data.delete(key),
    }
  }

  it('outra aba do portal parada não encerra a sessão enquanto a aba da prova está aberta', () => {
    const storage = memoryStorage()
    const now = 10_000_000
    expect(examTabAliveElsewhere(storage, now)).toBe(false)
    markExamTabAlive(storage, now)
    expect(examTabAliveElsewhere(storage, now + 60_000)).toBe(true)
    expect(shouldExpireForIdle({
      role: 'student', pathname: '/aluno', idleForMs: 61 * 60 * 1000, idleLimitMs: 60 * 60 * 1000,
      examOpenElsewhere: examTabAliveElsewhere(storage, now + 60_000),
    })).toBe(false)
  })

  it('a marca vence em 3 min, some no "Sair" e não vale para o instrutor', () => {
    const storage = memoryStorage()
    const now = 10_000_000
    markExamTabAlive(storage, now)
    expect(examTabAliveElsewhere(storage, now + EXAM_TAB_ALIVE_MS)).toBe(false)
    expect(examTabAliveElsewhere(storage, now - 1)).toBe(false)
    clearExamTabAlive(storage)
    expect(storage.getItem(EXAM_TAB_ALIVE_KEY)).toBe(null)
    expect(shouldExpireForIdle({ role: 'admin', pathname: '/admin', idleForMs: 600001, idleLimitMs: 600000, examOpenElsewhere: true })).toBe(true)
    expect(shouldExpireForIdle({ role: 'student', pathname: '/aluno', idleForMs: 600001, idleLimitMs: 600000, examOpenElsewhere: false })).toBe(true)
  })

  it('localStorage bloqueado não derruba a conferência', () => {
    const broken = { getItem: () => { throw new Error('bloqueado') }, setItem: () => { throw new Error('bloqueado') }, removeItem: () => { throw new Error('bloqueado') } }
    expect(() => markExamTabAlive(broken, 1)).not.toThrow()
    expect(() => clearExamTabAlive(broken)).not.toThrow()
    expect(examTabAliveElsewhere(broken, 1)).toBe(false)
    expect(examTabAliveElsewhere(null, 1)).toBe(false)
  })
})
