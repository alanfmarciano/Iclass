import { afterEach, describe, expect, it, vi } from 'vitest'

// A versão do build anunciada pelo servidor passa por noteServerBuild (lib/buildVersion.js).
const buildMock = vi.hoisted(() => ({ noteServerBuild: vi.fn() }))
vi.mock('./buildVersion', async (importOriginal) => ({ ...(await importOriginal()), noteServerBuild: buildMock.noteServerBuild }))

import { getConnectionState, resetConnectionForTests } from './connection'
import { BACKGROUND_HEADER, INSTRUCTOR_TIMEOUT_MS, NETWORK_MESSAGE, RETRYABLE_MESSAGE, POLL_TIMEOUT_MS, TIMEOUT_MESSAGE, api, dispositionFileName, downloadFile, fetchBlob, hasActiveSession, isLongAdminOperation, setAdminAccessDeniedHandler, setAuthProvider, setPasswordChangeRequiredHandler } from './api'

afterEach(() => {
  resetConnectionForTests()
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

describe('fetchBlob e o nome do arquivo (fase 3, C8: prévia e ZIP das entregas)', () => {
  it('[UC-NOTAS-002] nome com acento vem do filename* (o filename simples do servidor troca o acento por ?)', () => {
    const disposition = "attachment; filename=\"Entregas - Relat?rio - 1DES.zip\"; filename*=UTF-8''Entregas%20-%20Relat%C3%B3rio%20-%201DES.zip"
    expect(dispositionFileName(disposition, 'x.zip')).toBe('Entregas - Relatório - 1DES.zip')
    expect(dispositionFileName('attachment; filename="notas.csv"', 'x')).toBe('notas.csv')
    expect(dispositionFileName("attachment; filename*=UTF-8''%E0%A4%A", 'x.zip')).toBe('x.zip')
    expect(dispositionFileName('', 'x.zip')).toBe('x.zip')
  })

  it('[UC-NOTAS-002] lê o arquivo com a sessão, repassa o cancelamento e devolve o Blob', async () => {
    setAuthProvider(() => ({ adminSession: 'token-123' }))
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png', 'content-disposition': "inline; filename*=UTF-8''foto%20%C3%A1.png" } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const result = await fetchBlob('/api/admin/assignments/a/files/f?inline=1', { signal: controller.signal })
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/assignments/a/files/f?inline=1', { headers: { 'x-admin-session': 'token-123' }, signal: controller.signal })
    expect(result.name).toBe('foto á.png')
    expect(result.blob.size).toBe(3)
  })

  it('[UC-NOTAS-002] cancelado por quem chamou sai como AbortError, sem a mensagem de conexão', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path, init) => { throw Object.assign(new Error('aborted'), { name: 'AbortError', signal: init.signal }) }))
    const controller = new AbortController()
    controller.abort()
    const error = await fetchBlob('/x', { signal: controller.signal }).catch((caught) => caught)
    expect(error.name).toBe('AbortError')
    expect(error.message).not.toBe(NETWORK_MESSAGE)
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
    // ZIP das entregas de uma tarefa (fase 3, C6): só o export, não as outras rotas da tarefa.
    expect(isLongAdminOperation('/api/admin/assignments/asg_1700000000000_abcdef/export?versoes=todas')).toBe(true)
    expect(isLongAdminOperation('/api/admin/assignments/asg_1700000000000_abcdef')).toBe(false)
    expect(isLongAdminOperation('/api/admin/assignments/asg_1700000000000_abcdef/grade')).toBe(false)
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

// Frente do H3 (contrato do cliente HTTP): toda resposta alimenta lib/connection.js, e o
// 503 de gravação (retryable) sai com o texto fixo das telas (decisões §3), sem logout.
describe('[UC-AUTH-001] respostas de estado do servidor no cliente', () => {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('503 retryable: "Não foi possível gravar agora. Tente de novo em instantes." com err.retryable, e a conexão segue online', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(503, { success: false, error: 'Não foi possível gravar os dados agora. Tente de novo em alguns segundos.', retryable: true })))
    const err = await api.post('/api/admin/students', { name: 'x' }).catch((e) => e)
    expect(RETRYABLE_MESSAGE).toBe('Não foi possível gravar agora. Tente de novo em instantes.')
    expect(err.message).toBe(RETRYABLE_MESSAGE)
    expect(err.status).toBe(503)
    expect(err.retryable).toBe(true)
    expect(getConnectionState()).toBe('online')
  })

  it('503 starting marca err.starting e leva a conexão a starting; a resposta seguinte volta a online', async () => {
    const fetchMock = vi.fn(async () => json(503, { error: 'O IClass está iniciando. Aguarde alguns segundos.', starting: true }))
    vi.stubGlobal('fetch', fetchMock)
    const err = await api.get('/api/student/sync').catch((e) => e)
    expect(err.starting).toBe(true)
    expect(err.message).toBe('O IClass está iniciando. Aguarde alguns segundos.')
    expect(getConnectionState()).toBe('starting')
    fetchMock.mockImplementation(async () => json(200, { ok: true }))
    await api.get('/api/student/sync')
    expect(getConnectionState()).toBe('online')
  })

  it('duas falhas de rede seguidas levam a conexão a offline; o cancelamento de quem chamou não conta', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (options?.signal?.aborted) throw new DOMException('cancelado', 'AbortError')
      throw new TypeError('Failed to fetch')
    }))
    const controller = new AbortController()
    controller.abort()
    await api.get('/api/x', { signal: controller.signal }).catch(() => {})
    await api.get('/api/x', { signal: controller.signal }).catch(() => {})
    expect(getConnectionState()).toBe('online')
    const first = await api.get('/api/x').catch((e) => e)
    expect(first.network).toBe(true)
    expect(getConnectionState()).toBe('online')
    await api.get('/api/x').catch(() => {})
    expect(getConnectionState()).toBe('offline')
  })
})

// Fase 3, C9 (P1-g; D12 do P1): envio de arquivo com progresso pelo XMLHttpRequest, com as
// mesmas mensagens e marcas de erro do request().
class FakeXhr {
  static last = null
  constructor() {
    FakeXhr.last = this
    this.headers = {}
    this.upload = {}
    this.status = 0
    this.responseText = ''
    this.responseHeaders = {}
    this.aborted = false
  }
  open(method, path, async) { this.method = method; this.path = path; this.async = async }
  setRequestHeader(name, value) { this.headers[name] = value }
  getResponseHeader(name) { return this.responseHeaders[String(name).toLowerCase()] ?? null }
  send(body) { this.body = body }
  abort() { this.aborted = true; if (this.onabort) this.onabort() }
  // Ajudantes do teste
  progress(loaded, total) { this.upload.onprogress?.({ lengthComputable: true, loaded, total }) }
  respond(status, data, headers = {}) {
    this.upload.onload?.()
    this.status = status
    this.responseText = data === undefined ? '' : JSON.stringify(data)
    this.responseHeaders = { 'content-type': data === undefined ? 'text/plain' : 'application/json; charset=utf-8', ...headers }
    this.onload?.()
  }
  failNetwork() { this.onerror?.() }
}

describe('uploadWithProgress (envio da atividade com barra de progresso)', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  async function start(options = {}) {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const { uploadWithProgress } = await import('./api')
    const form = new FormData()
    form.append('files', new File(['%PDF'], 'relatorio.pdf', { type: 'application/pdf' }))
    const promise = uploadWithProgress('/api/student/assignments/asg_1/submit', form, options)
    return { promise, xhr: FakeXhr.last, form }
  }

  it('manda o FormData com a sessão do aluno, avisa o progresso e devolve o JSON', async () => {
    setAuthProvider(() => ({ role: 'student', sessionToken: 'token-aluno' }))
    const seen = []
    const { promise, xhr, form } = await start({ onProgress: (p) => seen.push(p.percent) })
    expect(xhr.method).toBe('POST')
    expect(xhr.path).toBe('/api/student/assignments/asg_1/submit')
    expect(xhr.headers).toEqual({ 'x-session-token': 'token-aluno' })
    // Sem Content-Type: o navegador põe o multipart com o separador.
    expect(xhr.headers['Content-Type']).toBeUndefined()
    expect(xhr.body).toBe(form)
    xhr.progress(25, 100)
    xhr.progress(250, 1000)
    xhr.progress(1000, 1000)
    xhr.respond(201, { success: true, version: { n: 1 } }, { 'x-iclass-build': 'abc' })
    await expect(promise).resolves.toEqual({ success: true, version: { n: 1 } })
    expect(seen).toEqual([25, 25, 100, 100])
    expect(buildMock.noteServerBuild).toHaveBeenCalledWith('abc')
    expect(getConnectionState()).toBe('online')
  })

  it('C9 ajuste 1: cabeçalhos a mais (x-envio-id) vão junto, e a sessão não é trocada por eles', async () => {
    setAuthProvider(() => ({ role: 'student', sessionToken: 'token-aluno' }))
    const { promise, xhr } = await start({ headers: { 'x-envio-id': 'abcdefghijklmnopqrstuvwx', 'x-session-token': 'outro' } })
    expect(xhr.headers).toEqual({ 'x-envio-id': 'abcdefghijklmnopqrstuvwx', 'x-session-token': 'token-aluno' })
    xhr.respond(200, { success: true, repetido: true, version: { n: 1 } })
    await expect(promise).resolves.toEqual({ success: true, repetido: true, version: { n: 1 } })
  })

  it('recusa do servidor sai com a mensagem dele, o status e o corpo', async () => {
    setAuthProvider(() => ({ role: 'student', sessionToken: 't' }))
    const { promise, xhr } = await start()
    xhr.respond(413, { success: false, error: 'O arquivo "a.pdf" passa do limite de 10 MB por arquivo desta tarefa.', code: 'file_too_large' })
    await expect(promise).rejects.toMatchObject({ status: 413, message: 'O arquivo "a.pdf" passa do limite de 10 MB por arquivo desta tarefa.', data: { code: 'file_too_large' } })
  })

  it('503 retryable sai com o texto fixo e a marca retryable (pode tentar de novo)', async () => {
    const { promise, xhr } = await start()
    xhr.respond(503, { success: false, error: 'Falha', retryable: true })
    await expect(promise).rejects.toMatchObject({ status: 503, retryable: true, message: RETRYABLE_MESSAGE })
  })

  it('rede caída no meio do envio: status 0, err.network e a mensagem de conexão', async () => {
    const { promise, xhr } = await start()
    xhr.progress(10, 100)
    xhr.failNetwork()
    await expect(promise).rejects.toMatchObject({ status: 0, network: true, message: NETWORK_MESSAGE })
  })

  it('cancelar pelo signal sai como AbortError, sem mensagem de conexão', async () => {
    const controller = new AbortController()
    const { promise, xhr } = await start({ signal: controller.signal })
    controller.abort()
    expect(xhr.aborted).toBe(true)
    const err = await promise.catch((e) => e)
    expect(err.name).toBe('AbortError')
    expect(err.network).toBeUndefined()
  })

  it('prazo estourado aborta e sai com err.timeout', async () => {
    vi.useFakeTimers()
    try {
      const { promise, xhr } = await start({ timeoutMs: 1000 })
      const caught = promise.catch((e) => e)
      vi.advanceTimersByTime(1001)
      const err = await caught
      expect(xhr.aborted).toBe(true)
      expect(err).toMatchObject({ status: 0, timeout: true, message: TIMEOUT_MESSAGE })
    } finally {
      vi.useRealTimers()
    }
  })

  it('C9 ajuste 2: rede parada sem cair (nada sobe por stallMs) aborta e sai com err.timeout e err.stalled', async () => {
    vi.useFakeTimers()
    try {
      const { promise, xhr } = await start({ stallMs: 1000 })
      const caught = promise.catch((e) => e)
      xhr.progress(10, 100)
      vi.advanceTimersByTime(999)
      expect(xhr.aborted).toBe(false)
      vi.advanceTimersByTime(2)
      const err = await caught
      expect(xhr.aborted).toBe(true)
      expect(err).toMatchObject({ status: 0, timeout: true, stalled: true, message: TIMEOUT_MESSAGE })
    } finally {
      vi.useRealTimers()
    }
  })

  it('C9 ajuste 2: rede lenta mas andando não é parada (cada pedaço recomeça o prazo)', async () => {
    vi.useFakeTimers()
    try {
      const { promise, xhr } = await start({ stallMs: 1000 })
      for (let step = 1; step <= 10; step += 1) {
        vi.advanceTimersByTime(900)
        xhr.progress(step * 10, 100)
      }
      expect(xhr.aborted).toBe(false)
      xhr.respond(201, { success: true, version: { n: 1 } })
      await expect(promise).resolves.toEqual({ success: true, version: { n: 1 } })
      // Depois da resposta, o prazo não dispara mais nada.
      vi.advanceTimersByTime(5000)
      expect(xhr.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // Contrato mudado na J2 (pendência do C9): o upload.onload diz que o corpo saiu para o
  // navegador, não que o servidor recebeu; numa rede lenta o servidor ainda recebe sem
  // nenhum evento até a resposta. O prazo sem novidade para aí; quem encerra é o timeoutMs
  // de quem chama ou o Cancelar.
  it('J2 (C9): corpo todo enviado (100%) esperando a resposta não estoura o prazo sem novidade', async () => {
    vi.useFakeTimers()
    try {
      const { xhr } = await start({ stallMs: 1000 })
      xhr.progress(100, 100)
      xhr.upload.onload?.()
      vi.advanceTimersByTime(10 * 60 * 1000)
      expect(xhr.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('J2 (C9): depois do 100%, o timeoutMs de quem chama continua valendo', async () => {
    vi.useFakeTimers()
    try {
      const { promise, xhr } = await start({ stallMs: 1000, timeoutMs: 5000 })
      const caught = promise.catch((e) => e)
      xhr.progress(100, 100)
      xhr.upload.onload?.()
      vi.advanceTimersByTime(4000)
      expect(xhr.aborted).toBe(false)
      vi.advanceTimersByTime(1001)
      const err = await caught
      expect(xhr.aborted).toBe(true)
      expect(err).toMatchObject({ status: 0, timeout: true })
      expect(err.stalled).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sem stallMs (padrão) o envio parado espera (quem chama decide o prazo)', async () => {
    vi.useFakeTimers()
    try {
      const { xhr } = await start()
      vi.advanceTimersByTime(10 * 60 * 1000)
      expect(xhr.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('troca de senha obrigatória (403) avisa o AuthProvider, como o request()', async () => {
    const handler = vi.fn()
    setPasswordChangeRequiredHandler(handler)
    const { promise, xhr } = await start()
    xhr.respond(403, { error: 'Troque a senha.', passwordChangeRequired: true })
    await expect(promise).rejects.toMatchObject({ status: 403 })
    expect(handler).toHaveBeenCalledWith({ error: 'Troque a senha.', passwordChangeRequired: true })
  })
})
