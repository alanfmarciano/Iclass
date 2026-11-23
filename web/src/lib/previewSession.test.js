import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, fetchBlob, setAuthProvider } from './api'
import { resolveContentUrl } from './contentMarkdown'
import {
  PREVIEW_STORAGE_KEY, currentPreviewToken, isPreviewPortalRequest, previewBannerText, previewFromResponse,
  readStoredPreview, safePreviewOrigin, setPreviewEndedHandler, storePreview,
} from './previewSession'

// Fase 3, C15 / P5-S6b (CRIT-08, D21 do P5): a prévia fica só nesta aba (sessionStorage) e
// os pedidos do portal levam o x-preview-session no lugar da sessão do painel.
const RESPONSE = {
  success: true,
  previewToken: 'tok-previa',
  expiraEm: Date.now() + 60 * 60 * 1000,
  rotulo: 'Pré-visualização como aluno de 1DES · grupo Laboratório A',
  aluno: { email: 'previa-ab12@previa.invalid', name: 'Pré-visualização', classes: [{ name: '1DES', courseId: 'redes' }], courses: [{ id: 'redes', name: 'Redes' }], preview: true, previewGroupId: 'grp_1' },
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.restoreAllMocks()
  setAuthProvider(() => ({}))
  setPreviewEndedHandler(null)
  localStorage.clear()
  sessionStorage.clear()
})

describe('[UC-PREVIA-004] prévia guardada na aba', () => {
  it('monta a prévia da resposta do servidor com a origem do painel e guarda só no sessionStorage', () => {
    const preview = previewFromResponse(RESPONSE, { origem: '/turmas?curso=redes', adminEmail: 'Prof@Escola.local' })
    expect(preview).toMatchObject({ token: 'tok-previa', courseId: 'redes', studentClass: '1DES', groupId: 'grp_1', origem: '/turmas?curso=redes', adminEmail: 'prof@escola.local' })
    storePreview(preview)
    expect(JSON.parse(sessionStorage.getItem(PREVIEW_STORAGE_KEY)).token).toBe('tok-previa')
    expect(localStorage.getItem(PREVIEW_STORAGE_KEY)).toBeNull()
    expect(readStoredPreview({ adminEmail: 'prof@escola.local' })?.token).toBe('tok-previa')
    expect(previewBannerText(preview)).toBe('Pré-visualização como aluno de 1DES · grupo Laboratório A · nada é gravado')
  })

  it('não devolve prévia vencida, quebrada ou de outra conta do painel', () => {
    storePreview(previewFromResponse(RESPONSE, { adminEmail: 'prof@escola.local' }))
    expect(readStoredPreview({ adminEmail: 'outra@escola.local' })).toBeNull()
    expect(readStoredPreview({ adminEmail: 'prof@escola.local', now: RESPONSE.expiraEm + 1 })).toBeNull()
    sessionStorage.setItem(PREVIEW_STORAGE_KEY, '{quebrado')
    expect(readStoredPreview()).toBeNull()
    expect(currentPreviewToken()).toBe('')
    expect(previewFromResponse({ success: true })).toBeNull()
  })

  it('a origem fica sempre dentro do painel', () => {
    expect(safePreviewOrigin('/materiais')).toBe('/materiais')
    expect(safePreviewOrigin('/aluno/modulos')).toBe('/')
    expect(safePreviewOrigin('//outro.site/x')).toBe('/')
    expect(safePreviewOrigin('https://outro.site')).toBe('/')
    expect(safePreviewOrigin('/login')).toBe('/')
    expect(safePreviewOrigin(undefined)).toBe('/')
  })
})

describe('[UC-PREVIA-004] cabeçalhos com a prévia aberta', () => {
  it('portal leva só o x-preview-session; o painel e o Sair do instrutor, só a sessão do painel', async () => {
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-painel' }))
    storePreview(previewFromResponse(RESPONSE, { adminEmail: '' }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ok: true }))
    await api.get('/api/student/library?courseId=redes')
    await api.get('/api/data.js?courseId=redes')
    await api.post('/api/admin/preview-sessions/end', {}, { headers: { 'x-preview-session': 'tok-previa' } })
    await api.post('/api/session/logout', {})
    const headersOf = (index) => fetchMock.mock.calls[index][1].headers
    expect(headersOf(0)).toMatchObject({ 'x-preview-session': 'tok-previa' })
    expect(headersOf(0)['x-admin-session']).toBeUndefined()
    expect(headersOf(1)['x-preview-session']).toBe('tok-previa')
    expect(headersOf(1)['x-admin-session']).toBeUndefined()
    expect(headersOf(2)).toMatchObject({ 'x-admin-session': 'sessao-painel', 'x-preview-session': 'tok-previa' })
    expect(headersOf(3)['x-admin-session']).toBe('sessao-painel')
    expect(headersOf(3)['x-preview-session']).toBeUndefined()
  })

  it('sem prévia nada muda: o painel manda a sessão dele em qualquer rota', async () => {
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-painel' }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ok: true }))
    await api.get('/api/data.js?courseId=redes')
    expect(fetchMock.mock.calls[0][1].headers['x-admin-session']).toBe('sessao-painel')
    expect(fetchMock.mock.calls[0][1].headers['x-preview-session']).toBeUndefined()
    expect(isPreviewPortalRequest('/api/admin/classes')).toBe(false)
    expect(isPreviewPortalRequest('/uploads/a.pdf?access=x')).toBe(true)
  })

  it('401 preview_ended de um pedido da prévia avisa o AuthProvider; o de outro pedido não', async () => {
    const ended = vi.fn()
    setPreviewEndedHandler(ended)
    storePreview(previewFromResponse(RESPONSE, { adminEmail: '' }))
    const body = { error: 'A pré-visualização terminou (ela dura 60 minutos). Abra de novo pelo painel.', code: 'preview_ended', sessionRevoked: true, reason: 'expired' }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(body, 401))
    await expect(api.get('/api/student/dashboard')).rejects.toMatchObject({ status: 401 })
    await expect(fetchBlob('/uploads/apostila.pdf')).rejects.toMatchObject({ status: 401 })
    expect(ended).toHaveBeenCalledTimes(2)
    expect(ended.mock.calls[0][0].code).toBe('preview_ended')
    sessionStorage.clear()
    await expect(api.get('/api/student/dashboard')).rejects.toMatchObject({ status: 401 })
    expect(ended).toHaveBeenCalledTimes(2)
  })

  it('a figura da apostila abre com o token da prévia, não com a sessão do painel', () => {
    localStorage.setItem('iclass-v3-auth', JSON.stringify({ role: 'admin', adminSession: 'sessao-painel' }))
    expect(resolveContentUrl('/imagens/redes/topologia.png')).toBe('/imagens/redes/topologia.png?access=sessao-painel')
    storePreview(previewFromResponse(RESPONSE, { adminEmail: '' }))
    expect(resolveContentUrl('/imagens/redes/topologia.png')).toBe('/imagens/redes/topologia.png?access=tok-previa')
  })
})
