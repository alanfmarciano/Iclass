import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearAllExamDrafts,
  clearExamDraftsForApplication,
  clearOtherExamDrafts,
  examDraftCryptoAvailable,
  examDraftStorageKey,
  findExamDraftAttempt,
  importExamDraftKey,
  readExamDraft,
  sameExamAnswers,
  writeExamDraft,
} from './examDrafts'

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
}

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('[UC-TENTATIVA-001] cópia local cifrada das respostas da prova (AVA-11)', () => {
  it('grava cifrada em localStorage por tentativa, com IV novo a cada gravação, e só abre com a chave da tentativa', async () => {
    const cryptoKey = await importExamDraftKey(randomKey())
    expect(cryptoKey).toBeTruthy()
    expect(cryptoKey.extractable).toBe(false)

    expect(await writeExamDraft({ attemptId: 'att-1', applicationId: 'app-1', cryptoKey, answers: { 1: 'A', 2: 'C' } })).toBe(true)
    const first = JSON.parse(localStorage.getItem(examDraftStorageKey('att-1')))
    expect(first).toMatchObject({ v: 2, attemptId: 'att-1', applicationId: 'app-1' })
    const stored = localStorage.getItem(examDraftStorageKey('att-1'))
    expect(stored).not.toContain('"answers"')
    expect(stored).not.toContain('"A"')
    expect(Object.keys(sessionStorage)).toEqual([])

    await writeExamDraft({ attemptId: 'att-1', applicationId: 'app-1', cryptoKey, answers: { 1: 'A', 2: 'C' } })
    const second = JSON.parse(localStorage.getItem(examDraftStorageKey('att-1')))
    expect(second.iv).not.toBe(first.iv)
    expect(second.data).not.toBe(first.data)

    expect(await readExamDraft({ attemptId: 'att-1', cryptoKey })).toMatchObject({ attemptId: 'att-1', answers: { 1: 'A', 2: 'C' }, saved: false })

    // Outra chave (outra tentativa ou outro aluno) não decifra: a cópia é descartada.
    const otherKey = await importExamDraftKey(randomKey())
    expect(await readExamDraft({ attemptId: 'att-1', cryptoKey: otherKey })).toBeNull()
    expect(localStorage.getItem(examDraftStorageKey('att-1'))).toBeNull()
  })

  it('uma cópia não serve para outra tentativa, mesmo copiada para a chave dela', async () => {
    const cryptoKey = await importExamDraftKey(randomKey())
    await writeExamDraft({ attemptId: 'att-1', applicationId: 'app-1', cryptoKey, answers: { 1: 'B' } })
    const envelope = JSON.parse(localStorage.getItem(examDraftStorageKey('att-1')))
    localStorage.setItem(examDraftStorageKey('att-2'), JSON.stringify({ ...envelope, attemptId: 'att-2' }))
    expect(await readExamDraft({ attemptId: 'att-2', cryptoKey })).toBeNull()
  })

  it('a chave nunca vai para o armazenamento do navegador', async () => {
    const rawKey = randomKey()
    const cryptoKey = await importExamDraftKey(rawKey)
    await writeExamDraft({ attemptId: 'att-9', applicationId: 'app-9', cryptoKey, answers: { 3: 'D' }, saved: true })
    const everything = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })
    expect(everything).not.toContain(rawKey)
  })

  it('gravações fora de ordem: vale a mais recente; limpeza descarta a que estava a caminho', async () => {
    const cryptoKey = await importExamDraftKey(randomKey())
    const older = writeExamDraft({ attemptId: 'att-1', applicationId: 'app-1', cryptoKey, answers: { 1: 'A' } })
    const newer = writeExamDraft({ attemptId: 'att-1', applicationId: 'app-1', cryptoKey, answers: { 1: 'B' } })
    await Promise.all([older, newer])
    expect((await readExamDraft({ attemptId: 'att-1', cryptoKey })).answers).toEqual({ 1: 'B' })

    const pending = writeExamDraft({ attemptId: 'att-1', applicationId: 'app-1', cryptoKey, answers: { 1: 'C' } })
    clearExamDraftsForApplication('app-1')
    expect(await pending).toBe(false)
    expect(localStorage.getItem(examDraftStorageKey('att-1'))).toBeNull()
  })

  it('apaga cópias de outras tentativas e alunos, as da versão anterior e tudo no logout', async () => {
    const cryptoKey = await importExamDraftKey(randomKey())
    await writeExamDraft({ attemptId: 'att-mine', applicationId: 'app-1', cryptoKey, answers: { 1: 'A' } })
    await writeExamDraft({ attemptId: 'att-other', applicationId: 'app-1', cryptoKey, answers: { 1: 'B' } })
    await writeExamDraft({ attemptId: 'att-old', applicationId: 'app-0', cryptoKey, answers: { 1: 'C' } })
    sessionStorage.setItem('iclass-exam-draft:ana@x:app-1', JSON.stringify({ attemptId: 'att-mine', answers: { 1: 'A' } }))
    localStorage.setItem('iclass-theme', 'dark')
    expect(findExamDraftAttempt('app-0')).toBe('att-old')

    clearOtherExamDrafts('att-mine')
    expect(Object.keys(localStorage).filter((key) => key.startsWith('iclass-exam-draft:'))).toEqual([examDraftStorageKey('att-mine')])
    expect(Object.keys(sessionStorage)).toEqual([])
    expect(findExamDraftAttempt('app-1')).toBe('att-mine')

    clearAllExamDrafts()
    expect(Object.keys(localStorage)).toEqual(['iclass-theme'])
  })

  it('sem WebCrypto (http fora de localhost) não grava cópia nenhuma e nada quebra', async () => {
    const cryptoKey = await importExamDraftKey(randomKey())
    vi.stubGlobal('isSecureContext', false)
    expect(examDraftCryptoAvailable()).toBe(false)
    expect(await importExamDraftKey(randomKey())).toBeNull()
    expect(await writeExamDraft({ attemptId: 'att-1', applicationId: 'app-1', cryptoKey, answers: { 1: 'A' } })).toBe(false)
    expect(await readExamDraft({ attemptId: 'att-1', cryptoKey })).toBeNull()
    expect(localStorage.length).toBe(0)

    // Contexto inseguro de verdade: o navegador nem expõe crypto.subtle.
    vi.unstubAllGlobals()
    vi.stubGlobal('crypto', { getRandomValues: (array) => array })
    expect(examDraftCryptoAvailable()).toBe(false)
    expect(await writeExamDraft({ attemptId: 'att-1', applicationId: 'app-1', cryptoKey, answers: { 1: 'A' } })).toBe(false)
    expect(localStorage.length).toBe(0)
  })

  it('compara respostas sem depender da ordem e recusa chave com tamanho errado', async () => {
    expect(sameExamAnswers({ 2: 'B', 1: 'A' }, { 1: 'A', 2: 'B' })).toBe(true)
    expect(sameExamAnswers({ 1: 'A' }, { 1: 'A', 2: 'B' })).toBe(false)
    expect(await importExamDraftKey(btoa('curta'))).toBeNull()
    expect(await importExamDraftKey('não é base64')).toBeNull()
  })
})
