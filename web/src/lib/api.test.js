import { afterEach, describe, expect, it, vi } from 'vitest'

// A versão do build anunciada pelo servidor passa por noteServerBuild (lib/buildVersion.js).
const buildMock = vi.hoisted(() => ({ noteServerBuild: vi.fn() }))
vi.mock('./buildVersion', async (importOriginal) => ({ ...(await importOriginal()), noteServerBuild: buildMock.noteServerBuild }))

import { api, downloadFile, hasActiveSession, setAdminAccessDeniedHandler, setAuthProvider } from './api'

afterEach(() => {
  buildMock.noteServerBuild.mockReset()
  vi.restoreAllMocks()
  setAuthProvider(() => ({}))
  setAdminAccessDeniedHandler(null)
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

// Fase 2, H6b (SEG-03): o cabeçalho com e-mail e senha acabou. O instrutor só manda o token
// da sessão; a senha vai uma vez, no corpo do POST /api/session/admin-login.
describe('[UC-AUTH-001] pedidos do instrutor só com o token da sessão', () => {
  function okJson() { return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }) }

  it('sessão antiga só com e-mail:senha no armazenamento não vira cabeçalho Authorization', async () => {
    localStorage.setItem('iclass-v3-auth', JSON.stringify({ role: 'admin', adminAuth: 'admin@teste.local:teste' }))
    setAuthProvider(() => ({ role: 'admin', adminAuth: 'admin@teste.local:teste' }))
    const fetchMock = vi.fn(async () => okJson())
    vi.stubGlobal('fetch', fetchMock)
    await api.get('/api/admin/classes')
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers.Authorization).toBeUndefined()
    expect(JSON.stringify(headers)).not.toContain('teste')
    expect(hasActiveSession()).toBe(false)
  })

  it('com a sessão nova, só o x-admin-session vai no pedido', async () => {
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-admin' }))
    const fetchMock = vi.fn(async () => okJson())
    vi.stubGlobal('fetch', fetchMock)
    await api.get('/api/admin/classes')
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers['x-admin-session']).toBe('sessao-admin')
    expect(headers.Authorization).toBeUndefined()
  })
})

describe('[UC-REDE-001] painel recusado neste aparelho', () => {
  function json(body, status) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }

  it('403 com adminAccess avisa o AuthProvider (pedido comum e download); outro 403 não', async () => {
    const handler = vi.fn()
    setAdminAccessDeniedHandler(handler)
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-admin' }))
    const refusal = { error: 'O painel do professor só abre no computador onde o IClass está ligado. O administrador pode liberar outros aparelhos em Sistema → Rede.', adminAccess: 'local-only' }
    vi.stubGlobal('fetch', vi.fn(async (path) => (path === '/api/admin/outro' ? json({ error: 'Turma não autorizada.' }, 403) : json(refusal, 403))))
    await expect(api.get('/api/admin/classes')).rejects.toMatchObject({ status: 403, data: refusal })
    expect(handler).toHaveBeenCalledWith(refusal)
    await expect(downloadFile('/api/admin/gradebook?format=csv')).rejects.toMatchObject({ status: 403, data: refusal })
    expect(handler).toHaveBeenCalledTimes(2)
    await expect(api.get('/api/admin/outro')).rejects.toThrow('Turma não autorizada.')
    expect(handler).toHaveBeenCalledTimes(2)
  })
})
