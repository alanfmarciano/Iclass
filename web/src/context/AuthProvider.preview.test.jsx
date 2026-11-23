import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 3, C15 / P5-S6b (CRIT-08, D21 do P5): a pré-visualização como aluno abre na mesma
// aba, por cima da sessão do painel, que não muda; o portal vê o aluno virtual e o Sair
// volta para a tela do painel de onde a prévia saiu.
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../lib/api', () => ({
  api: { get: mocks.get, post: mocks.post },
  setAuthProvider: () => {},
  setAdminAccessDeniedHandler: () => {},
  setPasswordChangeRequiredHandler: () => {},
}))
vi.mock('../hooks/usePolling', () => ({ usePolling: () => ({ runNow: () => {} }) }))
vi.mock('./ToastProvider', () => ({ useToast: () => mocks.toast }))

import { AuthProvider, useAuth } from './AuthProvider'
import { PreviewNotice, RequireRole } from '../components/RouteGuards'
import { PREVIEW_STORAGE_KEY, notifyPreviewEnded, previewFromResponse, storePreview } from '../lib/previewSession'

const LS = 'iclass-v3-auth'
const ADMIN = { role: 'admin', adminSession: 'sessao-painel', email: 'prof@escola.local', serverInstanceId: 'inst-1', loginAt: Date.now() }
const RESPONSE = {
  success: true,
  previewToken: 'tok-previa',
  expiraEm: Date.now() + 60 * 60 * 1000,
  rotulo: 'Pré-visualização como aluno de 1DES',
  aluno: { email: 'previa-ab12@previa.invalid', name: 'Pré-visualização', classes: [{ name: '1DES', courseId: 'redes' }], courses: [{ id: 'redes', name: 'Redes', className: '1DES' }], preview: true, previewGroupId: null },
}

let ctx = null
function Painel() {
  const auth = useAuth()
  const nav = useNavigate()
  ctx = auth
  return (
    <div>
      <p data-testid="painel">{auth.auth.role}</p>
      <button type="button" onClick={() => { auth.startPreview(RESPONSE, { origem: '/turmas' }); nav('/aluno') }}>Abrir prévia</button>
    </div>
  )
}
function Portal() {
  const auth = useAuth()
  const nav = useNavigate()
  return (
    <div>
      <p data-testid="portal">{`${auth.auth.role}:${auth.auth.email}:${auth.auth.activeClass?.name}:${auth.auth.preview ? 'prévia' : 'real'}`}</p>
      <button type="button" onClick={() => { auth.logout(); nav('/login') }}>Sair do portal</button>
      <button type="button" onClick={() => auth.endSessionFromError({ status: 401, data: { code: 'preview_ended', error: 'A pré-visualização terminou porque a sua sessão no painel acabou.' } })}>Sessão recusada</button>
    </div>
  )
}

function renderApp(path = '/turmas') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <PreviewNotice />
        <Routes>
          <Route path="/" element={<RequireRole role="admin"><p data-testid="inicio">Início do painel</p></RequireRole>} />
          <Route path="/turmas" element={<RequireRole role="admin"><Painel /></RequireRole>} />
          <Route path="/aluno" element={<RequireRole role="student"><Portal /></RequireRole>} />
          <Route path="/login" element={<p data-testid="login">login</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.setItem(LS, JSON.stringify(ADMIN))
  mocks.get.mockImplementation(async (path) => {
    if (path === '/api/session/status') return { instanceId: 'inst-1' }
    if (path === '/api/admin/whoami') return { email: ADMIN.email, sessionToken: 'sessao-painel', instanceId: 'inst-1', role: 'professor' }
    return {}
  })
  mocks.post.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
  ctx = null
  vi.useRealTimers()
})

describe('[UC-PREVIA-004] pré-visualização como aluno no navegador', () => {
  it('abre o portal na mesma aba com o aluno virtual; a sessão do painel continua intocada', async () => {
    renderApp()
    await waitFor(() => expect(screen.getByTestId('painel')).toHaveTextContent('admin'))
    fireEvent.click(screen.getByRole('button', { name: 'Abrir prévia' }))
    expect(await screen.findByTestId('portal')).toHaveTextContent('student:previa-ab12@previa.invalid:1DES:prévia')
    expect(JSON.parse(sessionStorage.getItem(PREVIEW_STORAGE_KEY)).token).toBe('tok-previa')
    expect(JSON.parse(localStorage.getItem(LS))).toMatchObject({ role: 'admin', adminSession: 'sessao-painel' })
    expect(localStorage.getItem(LS)).not.toContain('tok-previa')
  })

  it('o Sair do portal fecha a prévia (avisando o servidor) e volta para a tela de onde veio, sem sair do painel', async () => {
    renderApp()
    await waitFor(() => expect(screen.getByTestId('painel')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Abrir prévia' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sair do portal' }))
    // /login com o instrutor logado vai para o painel; o RequireRole leva à origem.
    expect(await screen.findByTestId('login')).toBeInTheDocument()
    expect(sessionStorage.getItem(PREVIEW_STORAGE_KEY)).toBeNull()
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/preview-sessions/end', {}, expect.objectContaining({ keepalive: true, headers: { 'x-preview-session': 'tok-previa' } }))
    expect(mocks.post).not.toHaveBeenCalledWith('/api/session/logout', expect.anything(), expect.anything())
    expect(JSON.parse(localStorage.getItem(LS))).toMatchObject({ role: 'admin', adminSession: 'sessao-painel' })
  })

  it('sem prévia, o instrutor que abre /aluno volta para a tela de onde a última prévia saiu', async () => {
    renderApp()
    await waitFor(() => expect(screen.getByTestId('painel')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Abrir prévia' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sessão recusada' }))
    // A prévia acabou pelo servidor: o portal volta para Turmas com o motivo num aviso.
    expect(await screen.findByTestId('painel')).toHaveTextContent('admin')
    await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledWith('A pré-visualização terminou porque a sua sessão no painel acabou.'))
    expect(mocks.post).not.toHaveBeenCalledWith('/api/admin/preview-sessions/end', expect.anything(), expect.anything())
  })

  it('401 preview_ended num pedido da prévia (lib/api.js) fecha a prévia e volta à origem com o motivo', async () => {
    renderApp()
    await waitFor(() => expect(screen.getByTestId('painel')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Abrir prévia' }))
    await screen.findByTestId('portal')
    act(() => { notifyPreviewEnded({ code: 'preview_ended', error: 'A pré-visualização terminou. Abra de novo pelo painel.' }) })
    expect(await screen.findByTestId('painel')).toBeInTheDocument()
    await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledWith('A pré-visualização terminou. Abra de novo pelo painel.'))
    expect(sessionStorage.getItem(PREVIEW_STORAGE_KEY)).toBeNull()
  })

  it('uma tela do painel aberta com a prévia (voltar do navegador) fecha a prévia antes de desenhar', async () => {
    storePreview(previewFromResponse(RESPONSE, { origem: '/turmas', adminEmail: ADMIN.email }))
    renderApp('/')
    expect(await screen.findByTestId('inicio')).toBeInTheDocument()
    expect(sessionStorage.getItem(PREVIEW_STORAGE_KEY)).toBeNull()
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/preview-sessions/end', {}, expect.objectContaining({ headers: { 'x-preview-session': 'tok-previa' } }))
  })

  it('recarregar a página mantém a prévia desta aba; a de outra conta ou vencida não vale', async () => {
    storePreview(previewFromResponse(RESPONSE, { origem: '/turmas', adminEmail: ADMIN.email }))
    const first = renderApp('/aluno')
    expect(await screen.findByTestId('portal')).toHaveTextContent('prévia')
    first.unmount()
    storePreview(previewFromResponse(RESPONSE, { origem: '/turmas', adminEmail: 'outra@escola.local' }))
    renderApp('/aluno')
    expect(await screen.findByTestId('inicio')).toBeInTheDocument()
    expect(sessionStorage.getItem(PREVIEW_STORAGE_KEY)).toBeNull()
  })

  it('o prazo da prévia fecha a aba na hora, com o aviso dos 60 minutos', async () => {
    storePreview(previewFromResponse({ ...RESPONSE, expiraEm: Date.now() + 1500 }, { origem: '/turmas', adminEmail: ADMIN.email }))
    renderApp('/aluno')
    expect(await screen.findByTestId('portal')).toBeInTheDocument()
    expect(await screen.findByTestId('painel', {}, { timeout: 4000 })).toBeInTheDocument()
    await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledWith('A pré-visualização terminou (ela dura 60 minutos). Abra de novo pelo painel.'))
  })

  it('o Sair do instrutor também fecha a prévia guardada', async () => {
    storePreview(previewFromResponse(RESPONSE, { origem: '/turmas', adminEmail: ADMIN.email }))
    renderApp('/turmas')
    await waitFor(() => expect(screen.getByTestId('painel')).toBeInTheDocument())
    act(() => { ctx.startPreview(RESPONSE, { origem: '/turmas' }) })
    act(() => { ctx.logout() })
    expect(sessionStorage.getItem(PREVIEW_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(LS)).toBeNull()
  })
})
