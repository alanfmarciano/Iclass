import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadFile, hasActiveSession, setAuthProvider } from './api'

afterEach(() => {
  vi.restoreAllMocks()
  setAuthProvider(() => ({}))
  localStorage.clear()
})

describe('[UC-PROVA-003] sessão aberta no navegador (AVA-12)', () => {
  it('fica fechada logo depois do logout, mesmo com a sessão antiga ainda no armazenamento', () => {
    localStorage.setItem('iclass-v3-auth', JSON.stringify({ role: 'student', sessionToken: 'token-antigo' }))
    setAuthProvider(() => ({ role: 'student', sessionToken: 'token-aluno' }))
    expect(hasActiveSession()).toBe(true)
    // O AuthProvider limpa o provedor na hora do logout, antes de trocar de rota.
    setAuthProvider(() => ({}))
    expect(hasActiveSession()).toBe(false)
  })

  it('instrutor com sessão também conta como sessão aberta', () => {
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-admin' }))
    expect(hasActiveSession()).toBe(true)
  })
})

describe('downloadFile', () => {
  it('[UC-NOTAS-002] baixa o CSV com a sessão do instrutor e preserva os bytes (BOM)', async () => {
    setAuthProvider(() => ({ adminSession: 'token-123' }))
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41])
    const fetchMock = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="planilha_notas_1DES.csv"' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    let saved = null
    URL.createObjectURL = vi.fn((blob) => { saved = blob; return 'blob:x' })
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const name = await downloadFile('/api/admin/gradebook?format=csv', 'fallback.csv')

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/gradebook?format=csv', { headers: { 'x-admin-session': 'token-123' } })
    expect(name).toBe('planilha_notas_1DES.csv')
    expect(click).toHaveBeenCalledOnce()
    const stored = new Uint8Array(await saved.arrayBuffer())
    expect([...stored.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })

  it('[UC-NOTAS-002] mostra a mensagem do servidor quando o download é recusado', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Turma não autorizada para esta conta.' }), { status: 403, headers: { 'content-type': 'application/json' } })))
    await expect(downloadFile('/api/admin/gradebook?format=csv')).rejects.toThrow('Turma não autorizada para esta conta.')
  })
})
