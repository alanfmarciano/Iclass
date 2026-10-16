import { afterEach, describe, expect, it } from 'vitest'
import { clearAllExamDrafts, clearExamDraft, examDraftKey, readExamDraft, sameExamAnswers, writeExamDraft } from './examDrafts'

afterEach(() => sessionStorage.clear())

describe('[UC-TENTATIVA-001] cópia local das respostas da prova (AVA-11)', () => {
  it('guarda por aplicação e aluno, devolve e apaga no envio', () => {
    const key = examDraftKey({ email: 'Ana@Escola.local', applicationId: 'app-1', examKey: 'Avaliacao_X' })
    expect(key).toBe('iclass-exam-draft:ana@escola.local:app-1')
    writeExamDraft(key, { attemptId: 'att-1', answers: { 1: 'A', 2: 'C' } })
    expect(readExamDraft(key)).toMatchObject({ attemptId: 'att-1', answers: { 1: 'A', 2: 'C' }, saved: false })
    clearExamDraft(key)
    expect(readExamDraft(key)).toBeNull()
  })

  it('o logout apaga todas as cópias de prova e preserva o resto da sessão', () => {
    writeExamDraft(examDraftKey({ email: 'a@x', applicationId: 'app-1' }), { attemptId: 'att-1', answers: { 1: 'A' } })
    writeExamDraft(examDraftKey({ email: 'b@x', applicationId: 'app-2' }), { attemptId: 'att-2', answers: { 1: 'B' }, saved: true })
    sessionStorage.setItem('iclass-logout-reason', 'manual')
    clearAllExamDrafts()
    expect(Object.keys(sessionStorage).filter((key) => key.startsWith('iclass-exam-draft:'))).toEqual([])
    expect(sessionStorage.getItem('iclass-logout-reason')).toBe('manual')
  })

  it('ignora cópia corrompida e compara respostas sem depender da ordem', () => {
    sessionStorage.setItem('iclass-exam-draft:x:app', '{quebrado')
    expect(readExamDraft('iclass-exam-draft:x:app')).toBeNull()
    expect(sameExamAnswers({ 2: 'B', 1: 'A' }, { 1: 'A', 2: 'B' })).toBe(true)
    expect(sameExamAnswers({ 1: 'A' }, { 1: 'A', 2: 'B' })).toBe(false)
  })
})
