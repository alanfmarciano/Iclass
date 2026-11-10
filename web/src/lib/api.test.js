import { afterEach, describe, expect, it, vi } from 'vitest'

// A versão do build anunciada pelo servidor passa por noteServerBuild (lib/buildVersion.js).
const buildMock = vi.hoisted(() => ({ noteServerBuild: vi.fn() }))
vi.mock('./buildVersion', async (importOriginal) => ({ ...(await importOriginal()), noteServerBuild: buildMock.noteServerBuild }))

import { BACKGROUND_HEADER, INSTRUCTOR_TIMEOUT_MS, NETWORK_MESSAGE, POLL_TIMEOUT_MS, TIMEOUT_MESSAGE, api, downloadFile, hasActiveSession, isLongAdminOperation, setAdminAccessDeniedHandler, setAuthProvider, setPasswordChangeRequiredHandler } from './api'

afterEach(() => {
  buildMock.noteServerBuild.mockReset()
  vi.restoreAllMocks()
  setAuthProvider(() => ({}))
  setAdminAccessDeniedHandler(null)
  setPasswordChangeRequiredHandler(null)
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

// Fase 2, H5a (UXA-13): com a troca de senha pedida, o servidor responde 403
// { passwordChangeRequired: true } e o AuthProvider passa a mostrar o formulário de troca.
describe('[UC-SENHA-001] troca de senha obrigatória', () => {
  function json(body, status) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }

  it('403 com passwordChangeRequired avisa o AuthProvider (pedido comum e download); outro 403 não', async () => {
    const handler = vi.fn()
    setPasswordChangeRequiredHandler(handler)
    setAuthProvider(() => ({ role: 'student', sessionToken: 'token-aluno' }))
    const refusal = { error: 'Troque a senha antes de continuar.', passwordChangeRequired: true, passwordChangeReason: 'reset' }
    vi.stubGlobal('fetch', vi.fn(async (path) => (path === '/api/outro' ? json({ error: 'Aplicação não autorizada.' }, 403) : json(refusal, 403))))
    await expect(api.post('/api/student/notes/get', { moduleKey: 'geral' })).rejects.toMatchObject({ status: 403, data: refusal })
    expect(handler).toHaveBeenCalledWith(refusal)
    await expect(downloadFile('/api/student/arquivo')).rejects.toMatchObject({ status: 403 })
    expect(handler).toHaveBeenCalledTimes(2)
    await expect(api.get('/api/outro')).rejects.toThrow('Aplicação não autorizada.')
    expect(handler).toHaveBeenCalledTimes(2)
  })
})

// Fase 2, H9c (ENG-04) e H2-C (DES-09): cada pedido tem prazo. Antes, um pedido
// pendurado (Wi-Fi caindo, servidor travado) deixava a tela girando sem fim.
// fetch que só termina quando o pedido é cancelado (servidor que aceita e não responde).
function hangingFetch() {
  return vi.fn((_url, init = {}) => new Promise((_resolve, reject) => {
    if (init.signal) init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
  }))
}

describe('[UC-ERRO-002] tempo-limite e falhas de conexão do cliente', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('pedido do instrutor sem resposta desiste em 60 s com status 0 e a mensagem em português', async () => {
    vi.useFakeTimers()
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-admin' }))
    vi.stubGlobal('fetch', hangingFetch())
    const pending = api.get('/api/admin/students').catch((error) => error)
    await vi.advanceTimersByTimeAsync(INSTRUCTOR_TIMEOUT_MS - 1)
    let settled = false
    pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const error = await pending
    expect(INSTRUCTOR_TIMEOUT_MS).toBe(60000)
    expect(error.status).toBe(0)
    expect(error.timeout).toBe(true)
    expect(error.message).toBe(TIMEOUT_MESSAGE)
    expect(TIMEOUT_MESSAGE).toBe('O servidor do IClass demorou demais para responder. Confira se ele está ligado e tente de novo.')
  })

  it('o login do instrutor também tem o prazo de 60 s', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())
    const pending = api.post('/api/session/admin-login', { email: 'a', password: 'b' }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(INSTRUCTOR_TIMEOUT_MS)
    expect((await pending).timeout).toBe(true)
  })

  it('timeoutMs de quem chama vale (consulta periódica: 10 s); timeoutMs: 0 é sem prazo', async () => {
    vi.useFakeTimers()
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-admin' }))
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const quick = api.get('/api/admin/notifications', { timeoutMs: POLL_TIMEOUT_MS }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS)
    expect((await quick).timeout).toBe(true)

    let longSettled = false
    api.post('/api/admin/courses/curso1/clone', {}, { timeoutMs: 0 }).catch(() => {}).finally(() => { longSettled = true })
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(longSettled).toBe(false)
    // Sem prazo e sem quem cancele: o pedido sai sem signal.
    expect(fetchMock.mock.calls[1][1].signal).toBeUndefined()
  })

  it('operações longas do professor ficam sem prazo mesmo quando a tela não diz nada', async () => {
    vi.useFakeTimers()
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-admin' }))
    vi.stubGlobal('fetch', hangingFetch())
    const paths = [
      '/api/admin/backup/server', '/api/admin/backup/restore', '/api/admin/storage/compact', '/api/admin/flush-exam-state',
      '/api/admin/reset', '/api/admin/courses/c1/clone', '/api/admin/courses/c1/purge', '/api/admin/archived-courses/x/restore',
    ]
    for (const path of paths) expect(isLongAdminOperation(path), path).toBe(true)
    expect(isLongAdminOperation('/api/admin/students')).toBe(false)
    expect(isLongAdminOperation('/api/admin/backupx')).toBe(false)
    let settled = 0
    for (const path of paths) api.post(path, {}).catch(() => {}).finally(() => { settled += 1 })
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(settled).toBe(0)
  })

  it('pedido do aluno fica sem prazo (a prova tem as próprias tentativas)', async () => {
    vi.useFakeTimers()
    setAuthProvider(() => ({ role: 'student', sessionToken: 'token-aluno' }))
    vi.stubGlobal('fetch', hangingFetch())
    let settled = false
    api.post('/api/student/autosave-progress', {}).catch(() => {}).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(settled).toBe(false)
  })

  it('pedido com keepalive (saída da página) nunca tem prazo, mesmo pedindo um', async () => {
    vi.useFakeTimers()
    setAuthProvider(() => ({ role: 'student', sessionToken: 'token-aluno' }))
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)
    api.post('/api/student/log-keystrokes', {}, { keepalive: true, timeoutMs: 1000 }).catch(() => {})
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ keepalive: true }))
    expect(fetchMock.mock.calls[0][1].signal).toBeUndefined()
  })

  it('sem rede: status 0, err.network e a mensagem em português (no download também)', async () => {
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-admin' }))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const error = await api.get('/api/admin/students').catch((err) => err)
    expect(error.status).toBe(0)
    expect(error.network).toBe(true)
    expect(error.message).toBe(NETWORK_MESSAGE)
    expect(NETWORK_MESSAGE).toBe('Sem conexão com o servidor do IClass. Confira a rede e tente de novo.')
    await expect(downloadFile('/api/admin/gradebook?format=csv')).rejects.toThrow(NETWORK_MESSAGE)
  })

  it('o prazo vale também enquanto o corpo da resposta chega', async () => {
    vi.useFakeTimers()
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-admin' }))
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    })))
    const pending = api.get('/api/admin/students').catch((error) => error)
    await vi.advanceTimersByTimeAsync(INSTRUCTOR_TIMEOUT_MS)
    const error = await pending
    expect(error.timeout).toBe(true)
    expect(error.message).toBe(TIMEOUT_MESSAGE)
  })

  it('cancelar é de quem chamou: o erro sai como AbortError, sem a mensagem de conexão', async () => {
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-admin' }))
    vi.stubGlobal('fetch', hangingFetch())
    const controller = new AbortController()
    const pending = api.get('/api/admin/students', { signal: controller.signal }).catch((error) => error)
    controller.abort()
    const error = await pending
    expect(error.name).toBe('AbortError')
    expect(error.message).not.toBe(TIMEOUT_MESSAGE)
    expect(error.message).not.toBe(NETWORK_MESSAGE)
  })

  it('consulta de fundo leva X-IClass-Background: 1; o pedido comum não', async () => {
    setAuthProvider(() => ({ role: 'student', sessionToken: 'token-aluno' }))
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await api.get('/api/ping?email=a', { background: true, timeoutMs: POLL_TIMEOUT_MS })
    await api.get('/api/student/me')
    expect(BACKGROUND_HEADER).toBe('X-IClass-Background')
    expect(fetchMock.mock.calls[0][1].headers).toEqual(expect.objectContaining({ 'X-IClass-Background': '1', 'x-session-token': 'token-aluno' }))
    expect(fetchMock.mock.calls[1][1].headers).not.toHaveProperty('X-IClass-Background')
  })

  it('envio de arquivo (FormData) vai pelo cliente: corpo como está, sem Content-Type JSON, com a sessão, sem prazo e, sem rede, a mensagem em português', async () => {
    vi.useFakeTimers()
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-admin' }))
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const form = new FormData()
    form.append('file', new Blob(['conteúdo']), 'material.pdf')
    let settled = false
    api.post('/api/admin/library/upload', form).catch(() => {}).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    // Arquivo grande na Wi-Fi da sala: sem o prazo de 60 s do instrutor.
    expect(settled).toBe(false)
    const init = fetchMock.mock.calls[0][1]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(form)
    expect(init.headers).not.toHaveProperty('Content-Type')
    expect(init.headers).toEqual({ 'x-admin-session': 'sessao-admin' })
    expect(init.signal).toBeUndefined()
    vi.useRealTimers()

    // Antes, esses envios usavam fetch direto e a tela mostrava "Failed to fetch".
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const error = await api.post('/api/admin/backup/restore', form, { timeoutMs: 0 }).catch((err) => err)
    expect(error.status).toBe(0)
    expect(error.network).toBe(true)
    expect(error.message).toBe(NETWORK_MESSAGE)
    // Recusa do servidor: status e corpo dele (a restauração lê o 409 legacyBackup).
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Backup de versão anterior.', legacyBackup: true }), { status: 409, headers: { 'content-type': 'application/json' } })))
    const refused = await api.post('/api/admin/backup/restore', form, { timeoutMs: 0 }).catch((err) => err)
    expect(refused.status).toBe(409)
    expect(refused.data).toEqual({ error: 'Backup de versão anterior.', legacyBackup: true })
  })

  it('nenhuma tela chama fetch direto: tudo passa por lib/api.js (só a conferência do lazyPage fica de fora)', () => {
    const sources = import.meta.glob('../**/*.{js,jsx}', { query: '?raw', import: 'default', eager: true })
    const allowed = new Set(['lib/api.js', 'lib/lazyPage.js'])
    const offenders = []
    for (const [key, source] of Object.entries(sources)) {
      const file = key.startsWith('./') ? `lib/${key.slice(2)}` : key.replace(/^\.\.\//, '')
      if (/\.test\.[jt]sx?$/.test(file) || allowed.has(file)) continue
      source.split('\n').forEach((line, index) => {
        if (/(^|[^\w.])fetch\(|\b(window|globalThis|self)\.fetch\(/.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`)
      })
    }
    expect(offenders, 'Use api.get/post (lib/api.js), que tem prazo, sessão e mensagem de rede em português').toEqual([])
    expect(Object.keys(sources).some((key) => key.endsWith('features/admin/SistemaPage.jsx'))).toBe(true)
  })

  it('resposta de erro do servidor continua com o status e a mensagem dele', async () => {
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-admin' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Turma não encontrada.' }), { status: 404, headers: { 'content-type': 'application/json' } })))
    const error = await api.get('/api/admin/students').catch((err) => err)
    expect(error.status).toBe(404)
    expect(error.message).toBe('Turma não encontrada.')
    expect(error.timeout).toBeUndefined()
  })
})
