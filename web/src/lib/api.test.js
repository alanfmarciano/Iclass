import { afterEach, describe, expect, it, vi } from 'vitest'

// A versão do build anunciada pelo servidor passa por noteServerBuild (lib/buildVersion.js).
const buildMock = vi.hoisted(() => ({ noteServerBuild: vi.fn() }))
vi.mock('./buildVersion', async (importOriginal) => ({ ...(await importOriginal()), noteServerBuild: buildMock.noteServerBuild }))

import { api, downloadFile, hasActiveSession, setAuthProvider } from './api'

afterEach(() => {
  buildMock.noteServerBuild.mockReset()
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

describe('[UC-MANUT-001] versão do build nas respostas da API', () => {
  function jsonResponse(body, status, build = 'versao-nova') {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-iclass-build': build } })
  }

  it('o portal do aluno confere a versão em toda resposta, também nas recusadas', async () => {
    setAuthProvider(() => ({ role: 'student', sessionToken: 'token-aluno' }))
    vi.stubGlobal('fetch', vi.fn(async (path) => (path === '/api/student/sync' ? jsonResponse({ success: true }, 200) : jsonResponse({ error: 'Sessão expirada.' }, 401))))
    await api.get('/api/student/sync')
    await expect(api.get('/api/ping')).rejects.toThrow('Sessão expirada.')
    expect(buildMock.noteServerBuild).toHaveBeenCalledTimes(2)
    expect(buildMock.noteServerBuild).toHaveBeenNthCalledWith(1, 'versao-nova')
    expect(buildMock.noteServerBuild).toHaveBeenNthCalledWith(2, 'versao-nova')
  })

  it('login do aluno (ainda sem sessão) também confere a versão', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sessionToken: 't' }, 200)))
    await api.post('/api/student/login', { email: 'a@b.c', password: 'x' }, { auth: false })
    expect(buildMock.noteServerBuild).toHaveBeenCalledWith('versao-nova')
  })

  it('telas do professor não recarregam sozinhas (uma edição em andamento se perderia)', async () => {
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-admin' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true }, 200)))
    await api.get('/api/admin/classes')
    await api.get('/api/status?studentClass=1DES')
    expect(buildMock.noteServerBuild).not.toHaveBeenCalled()
  })
})
