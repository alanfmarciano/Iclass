import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api, setAdminAccessDeniedHandler, setAuthProvider, setPasswordChangeRequiredHandler } from '../lib/api'
import { PREVIEW_ENDED_FALLBACK, PREVIEW_EXPIRED_TEXT, PREVIEW_HEADER, clearStoredPreview, previewFromResponse, readStoredPreview, setPreviewEndedHandler, storePreview } from '../lib/previewSession'
import { revokedLogoutFromError } from '../lib/sessionRevoked'
import { clearExamTabAlive, examTabAliveElsewhere, isStudentExamPath, markExamTabAlive, shouldExpireForIdle } from '../lib/sessionActivity'
import { clearAllExamDrafts } from '../lib/examDrafts'
import { usePolling } from '../hooks/usePolling'
import { useOnReconnect } from '../hooks/useServerConnection'
import { reduceStoredStudentAuth, studentSessionProfile } from '../lib/studentProfile'
import { adminAccountFields, isReadOnlyAccount } from '../lib/adminPermissions'

const AuthCtx = createContext()
const LS = 'iclass-v3-auth'

// --- Segurança de sessão (ajustável) ---------------------------------------
const IDLE_MS = 60 * 60 * 1000         // 60 min sem atividade do usuário -> logout
const ABSOLUTE_MS = 8 * 60 * 60 * 1000 // 8 h desde o login -> logout
const REVALIDATE_MS = 60 * 1000        // checagem periódica de instância/servidor
const NET_FAIL_TOLERANCE = 3           // falhas de rede toleradas antes de considerar offline
const SETTINGS_REFRESH_MS = 30 * 1000  // configurações públicas (tempo de sessão, manutenção)

// localStorage, ou null quando o navegador o bloqueia (janela privada com dados bloqueados).
function safeLocalStorage() {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

export function AuthProvider({ children }) {
  // A sessão do aluno guardada por uma versão anterior trazia o cadastro inteiro: fica só
  // o perfil que o portal usa (H5b; SEG-10, SEG-16), e o efeito abaixo regrava.
  const [auth, setAuth] = useState(() => {
    try { return reduceStoredStudentAuth(JSON.parse(localStorage.getItem(LS)) || {}) || {} } catch { return {} }
  })
  const [authReady, setAuthReady] = useState(false)
  const [maintenance, setMaintenance] = useState({ enabled: false, message: '' })
  // Pré-visualização como aluno (C15 / P5-S6b, D21 do P5): só desta aba (sessionStorage),
  // só da conta do painel que a abriu e dentro do prazo. A sessão do instrutor (auth) não
  // muda: o portal na prévia vê o aluno virtual pelo PreviewStudentScope.
  const [preview, setPreview] = useState(() => {
    let stored = {}
    try { stored = JSON.parse(localStorage.getItem(LS)) || {} } catch { stored = {} }
    const found = stored.role === 'admin' && stored.adminSession ? readStoredPreview({ adminEmail: stored.email || '' }) : null
    if (!found) clearStoredPreview()
    return found
  })
  // Motivo do fim da prévia pelo servidor ou pelo prazo (a tela do painel mostra num aviso)
  // e a tela do painel para onde o portal volta.
  const [previewNotice, setPreviewNotice] = useState(null)
  const [previewReturn, setPreviewReturn] = useState('/')
  const previewRef = useRef(preview)
  useEffect(() => { previewRef.current = preview }, [preview])
  const lastActivityRef = useRef(Date.now())
  const idleMsRef = useRef(IDLE_MS)
  const absMsRef = useRef(ABSOLUTE_MS)
  const netFailRef = useRef(0)

  useEffect(() => { setAuthProvider(() => auth) }, [auth])
  // Configurações públicas (tempo de sessão, manutenção): ao abrir e a cada 30 s, uma
  // consulta por vez e só com a aba à vista (usePolling).
  usePolling(async (requestOptions) => {
    try {
      const r = await api.get('/api/settings/public', { auth: false, ...requestOptions })
      if (r?.session) { idleMsRef.current = (r.session.idleMinutes || 60) * 60000; absMsRef.current = (r.session.absoluteHours || 8) * 3600000 }
      if (r?.maintenance) setMaintenance(r.maintenance)
      return true
    } catch { return false }
  }, { intervalMs: SETTINGS_REFRESH_MS })
  useEffect(() => {
    if (auth?.role) localStorage.setItem(LS, JSON.stringify(auth))
    else localStorage.removeItem(LS)
  }, [auth])

  // Encerra a sessão. Revoga o token no servidor (best-effort): o do instrutor em
  // /api/session/logout e o do aluno em /api/student/logout (H5b; DES-X2: antes o "Sair" do
  // aluno só limpava o navegador, e o token continuava valendo até expirar). Os cabeçalhos
  // saem na hora da chamada, antes de a sessão ser limpa abaixo; keepalive para o pedido
  // sobreviver à troca de página, e a falha de rede não segura a saída.
  // message (opcional): texto do servidor para o login mostrar (painel recusado neste aparelho).
  const doLogout = useCallback((reason, message) => {
    try { if (reason) sessionStorage.setItem('iclass-logout-reason', reason) } catch {}
    try {
      if (message) sessionStorage.setItem('iclass-logout-message', String(message))
      else sessionStorage.removeItem('iclass-logout-message')
    } catch {}
    try { sessionStorage.removeItem('iclass-workspace-switch') } catch {}
    // A prévia é da sessão do painel: o Sair do instrutor também a encerra no servidor.
    clearStoredPreview()
    previewRef.current = null
    setPreview(null)
    setPreviewNotice(null)
    clearAllExamDrafts() // cópia local das respostas da prova não fica para o próximo usuário
    clearExamTabAlive(safeLocalStorage())
    try {
      const cur = JSON.parse(localStorage.getItem(LS)) || {}
      if (cur.role === 'admin' && cur.adminSession) {
        api.post('/api/session/logout', {}, { keepalive: true }).catch(() => {})
      } else if (cur.role === 'student' && cur.sessionToken) {
        api.post('/api/student/logout', {}, { keepalive: true }).catch(() => {})
      }
    } catch {}
    setAuthProvider(() => ({}))
    setAuth({})
    setAuthReady(true)
  }, [])

  // Painel recusado neste aparelho (403 com adminAccess, SEG-03): o administrador deixou o
  // painel só no computador do IClass (ou só pela conexão segura). Encerra a sessão do
  // instrutor e o login mostra o motivo. Só com sessão de instrutor aberta: a recusa do
  // próprio login já aparece na tela de login.
  const authRef = useRef(auth)
  useEffect(() => { authRef.current = auth }, [auth])
  useEffect(() => {
    setAdminAccessDeniedHandler((data) => {
      if (authRef.current?.role !== 'admin') return
      doLogout('admin-network', data?.error)
    })
    return () => setAdminAccessDeniedHandler(null)
  }, [doLogout])

  // Troca de senha obrigatória (H5a, 403 { passwordChangeRequired: true }): a sessão
  // passa a mostrar o formulário de troca (portal do aluno e painel do instrutor).
  useEffect(() => {
    setPasswordChangeRequiredHandler((data) => {
      if (!authRef.current?.role) return
      setAuth((current) => (current.role ? {
        ...current,
        mustChangePassword: true,
        passwordChangeReason: data?.passwordChangeReason || current.passwordChangeReason || null,
      } : current))
    })
    return () => setPasswordChangeRequiredHandler(null)
  }, [])

  // O servidor disse (ping do aluno) se a troca vale para esta sessão agora.
  const syncPasswordChange = useCallback((required, reason) => {
    setAuth((current) => {
      if (current.role !== 'student') return current
      const nextRequired = required === true
      const nextReason = nextRequired ? (reason || null) : null
      if ((current.mustChangePassword === true) === nextRequired && (current.passwordChangeReason || null) === nextReason) return current
      return { ...current, mustChangePassword: nextRequired, passwordChangeReason: nextReason }
    })
  }, [])

  // Validação inicial da sessão guardada (uma vez, ao montar).
  useEffect(() => {
    let cancelled = false
    async function validateStoredSession() {
      if (!auth?.role) { setAuthReady(true); return }
      setAuthProvider(() => auth)

      // Expiração por tempo, sem depender do servidor.
      const now = Date.now()
      if (auth.loginAt && now - auth.loginAt > absMsRef.current) { if (!cancelled) doLogout('expired'); return }

      // Instância do servidor que mudou (reinício): a sessão é conferida abaixo, como em
      // qualquer abertura; só um 401/403 de verdade manda para o login (frente do H3).
      let serverInst = null
      try {
        try { const st = await api.get('/api/session/status', { auth: false }); serverInst = st.instanceId } catch { /* rede: não desloga aqui */ }

        if (auth.role === 'student') {
          if (!auth.email || !auth.sessionToken) throw Object.assign(new Error('Sessão incompleta'), { status: 401 })
          const presence = await api.get(`/api/ping?email=${encodeURIComponent(auth.email)}`)
          if (!cancelled && serverInst && serverInst !== auth.serverInstanceId) setAuth((c) => ({ ...c, serverInstanceId: serverInst }))
          if (!cancelled && presence && typeof presence.passwordChangeRequired === 'boolean') {
            syncPasswordChange(presence.passwordChangeRequired, presence.passwordChangeReason)
          }
        } else if (auth.role === 'admin') {
          // Sessão guardada no formato antigo (só e-mail e senha, sem token) não vale mais:
          // cai no login, e a senha some do armazenamento (SEG-03).
          if (!auth.adminSession) throw Object.assign(new Error('Sessão incompleta'), { status: 401 })
          const who = await api.get('/api/admin/whoami')
          if (!cancelled) {
            setAuth((current) => ({
              ...current,
              adminSession: who.sessionToken || current.adminSession,
              adminAuth: undefined, // migra sessões legadas: remove a senha do storage
              loginAt: current.loginAt || Date.now(),
              serverInstanceId: who.instanceId || current.serverInstanceId,
              email: who.email || current.email,
              ...adminAccountFields(who),
              mustChangePassword: who.mustChangePassword === true,
              passwordChangeReason: who.mustChangePassword === true ? (who.passwordChangeReason || null) : null,
            }))
          }
        }
        if (!cancelled) { lastActivityRef.current = Date.now(); setAuthReady(true) }
      } catch (err) {
        // 401/403 => sessão inválida (expirada/reiniciada). Erro de rede => mantém e tenta depois.
        // 403 com adminAccess: o painel não abre neste aparelho (motivo vindo do servidor).
        if (err && err.status === 403 && err.data?.adminAccess) { if (!cancelled) doLogout('admin-network', err.data.error) }
        else if (err && (err.status === 401 || err.status === 403)) {
          // Sessão encerrada por uma ação (senha redefinida ou trocada, Sair em outra aba):
          // o login mostra o motivo do servidor.
          // Servidor reiniciado e a sessão não voltou (mais de 60 min fora do ar, mais de
          // 8 h desde o login): o login diz que o servidor foi reiniciado.
          const revoked = revokedLogoutFromError(err)
          const restarted = !!(serverInst && auth.serverInstanceId && serverInst !== auth.serverInstanceId)
          if (!cancelled) { if (revoked) doLogout(revoked.reason, revoked.message); else doLogout(restarted ? 'restart' : 'expired') }
        }
        else if (!cancelled) setAuthReady(true)
      }
    }
    validateStoredSession()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Timeout de inatividade + revalidação periódica (instância) + on focus/visibility.
  // A cada 60 s pelo usePolling (uma conferência por vez; com a aba oculta não confere e,
  // ao voltar a ficar visível, confere na hora).
  async function check(requestOptions) {
    if (!auth?.role) return true
    const now = Date.now()
    const pathname = typeof window === 'undefined' ? '' : window.location.pathname
    if (isStudentExamPath(pathname) && auth.role === 'student') {
      // Ler uma questão por vários minutos continua sendo atividade válida.
      // Mantém a sessão enquanto a rota protegida da prova estiver aberta.
      lastActivityRef.current = now
      // Outras abas do portal neste navegador não encerram a sessão da prova por inatividade.
      markExamTabAlive(safeLocalStorage(), now)
    } else if (shouldExpireForIdle({
      role: auth.role,
      pathname,
      idleForMs: now - lastActivityRef.current,
      idleLimitMs: idleMsRef.current,
      examOpenElsewhere: auth.role === 'student' && examTabAliveElsewhere(safeLocalStorage(), now),
    })) {
      doLogout('idle'); return true
    }
    if (auth.loginAt && now - auth.loginAt > absMsRef.current) { doLogout('expired'); return true }
    try {
      const st = await api.get('/api/session/status', { auth: false, ...requestOptions })
      netFailRef.current = 0
      if (st.instanceId && auth.serverInstanceId && st.instanceId !== auth.serverInstanceId) return revalidate(st.instanceId, requestOptions)
      return true
    } catch {
      netFailRef.current += 1 // rede instável: tolera, não desloga por 1 falha isolada
      return false
    }
  }

  // O servidor reiniciou (instanceId novo). Antes, o navegador mandava todos para o login
  // (doLogout('restart')), inclusive quem estava no meio da prova, e apagava a cópia local
  // das respostas. Agora o servidor retoma as sessões gravadas (H3a-2) e aqui a sessão é
  // conferida (frente do H3: CONF-03, UXA-06):
  // - aluno: GET /api/ping; instrutor: GET /api/admin/whoami;
  // - 2xx: a sessão continua, com o instanceId novo (a cópia local da prova fica);
  // - 401/403 (ou sessionRevoked): login, com o motivo do servidor se houver ou "O servidor
  //   foi reiniciado";
  // - rede ou 503 (iniciando, gravação): a sessão continua e a conferência seguinte tenta
  //   de novo (o instanceId guardado continua o antigo).
  async function revalidate(instanceId, requestOptions) {
    const current = authRef.current || {}
    if (!current.role) return true
    try {
      if (current.role === 'student') {
        const presence = await api.get(`/api/ping?email=${encodeURIComponent(current.email || '')}`, requestOptions)
        if (presence && typeof presence.passwordChangeRequired === 'boolean') syncPasswordChange(presence.passwordChangeRequired, presence.passwordChangeReason)
        setAuth((c) => (c.role === 'student' ? { ...c, serverInstanceId: instanceId } : c))
      } else {
        const who = await api.get('/api/admin/whoami', requestOptions)
        setAuth((c) => (c.role === 'admin' ? {
          ...c,
          // Papel e permissões podem ter mudado enquanto o servidor estava fora.
          ...adminAccountFields(who),
          serverInstanceId: who.instanceId || instanceId,
          adminSession: who.sessionToken || c.adminSession,
          mustChangePassword: who.mustChangePassword === true,
          passwordChangeReason: who.mustChangePassword === true ? (who.passwordChangeReason || null) : null,
        } : c))
      }
      return true
    } catch (err) {
      if (err && err.status === 403 && err.data?.adminAccess) { doLogout('admin-network', err.data.error); return true }
      if (err && err.status === 403 && err.data?.passwordChangeRequired) {
        // A sessão vale; só a troca de senha está pendente (o formulário já aparece).
        setAuth((c) => (c.role ? { ...c, serverInstanceId: instanceId } : c))
        return true
      }
      if (err && (err.status === 401 || err.status === 403 || err.data?.sessionRevoked === true)) {
        const revoked = revokedLogoutFromError(err)
        if (revoked) doLogout(revoked.reason, revoked.message)
        else doLogout('restart')
        return true
      }
      return false
    }
  }
  // Sessão recusada (401) numa chamada de fundo, como o ping de presença do aluno (15 s),
  // que costuma chegar antes da conferência da instância (60 s). Mesmo critério da abertura
  // e da revalidação: motivo do servidor (senha redefinida, Sair, outro aparelho) se houver;
  // senão, se o servidor é outro (instanceId novo: reiniciou e a sessão não voltou, mais de
  // 60 min fora do ar), "O servidor foi reiniciado"; senão, sessão expirada. Antes, o ping
  // saía sem motivo e o aluno chegava ao login sem aviso nenhum (frente do H3, ajuste 1).
  const endSessionFromError = useCallback(async (err) => {
    const revoked = revokedLogoutFromError(err)
    if (revoked) { doLogout(revoked.reason, revoked.message); return }
    const known = authRef.current?.serverInstanceId || null
    let restarted = false
    if (known) {
      try {
        const st = await api.get('/api/session/status', { auth: false, background: true, timeoutMs: 5000 })
        restarted = !!(st?.instanceId && st.instanceId !== known)
      } catch { /* sem resposta: fica "expirada" */ }
    }
    doLogout(restarted ? 'restart' : 'expired')
  }, [doLogout])
  const revalidation = usePolling(check, { intervalMs: REVALIDATE_MS, enabled: !!auth?.role, immediate: false })
  // A conexão voltou (lib/connection.js: de 'offline' ou 'starting' para 'online'): confere
  // na hora, sem esperar o minuto da revalidação (o servidor pode ter reiniciado).
  useOnReconnect(() => { if (authRef.current?.role) revalidation.runNow() })
  useEffect(() => {
    if (!auth?.role) return
    const markActivity = () => { lastActivityRef.current = Date.now() }
    const evs = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click']
    evs.forEach((e) => window.addEventListener(e, markActivity, { passive: true }))
    const onFocus = () => { if (document.visibilityState !== 'hidden') revalidation.runNow() }
    window.addEventListener('focus', onFocus)
    return () => {
      evs.forEach((e) => window.removeEventListener(e, markActivity))
      window.removeEventListener('focus', onFocus)
    }
  }, [auth?.role, revalidation.runNow])

  const establishAdminSession = useCallback((who, fallbackEmail, extra = {}) => {
    const next = {
      role: 'admin',
      adminSession: who.sessionToken,
      serverInstanceId: who.instanceId || null,
      loginAt: Date.now(),
      email: who.email || fallbackEmail,
      activeCourse: null,
      activeWorkspace: null,
      ...adminAccountFields(who),
      mustChangePassword: who.mustChangePassword === true,
      passwordChangeReason: who.mustChangePassword === true ? (who.passwordChangeReason || null) : null,
      ...extra,
    }
    setAuthProvider(() => next)
    // Grava já, como no login do aluno: com as telas sob demanda (H2-A), o React espera o
    // arquivo do painel antes de desenhar, e o efeito que grava a sessão só rodava depois.
    // Nesse intervalo, um envio que lê a sessão guardada (backup, biblioteca, chamada) ou
    // uma recarga logo após entrar saía sem sessão (401).
    try { localStorage.setItem(LS, JSON.stringify(next)) } catch {}
    setAuth(next)
    lastActivityRef.current = Date.now()
    setAuthReady(true)
    return true
  }, [])

  const loginAdmin = useCallback(async (email, password) => {
    // A senha vai uma vez, no corpo do POST de login (SEG-03); a resposta traz o TOKEN da
    // sessão e o instanceId, como o whoami. Guardamos o token, nunca a senha.
    const who = await api.post('/api/session/admin-login', { email, password }, { auth: false })
    return establishAdminSession(who, email, { localSetupMode: false })
  }, [establishAdminSession])

  const loginAdminSetup = useCallback(async (token) => {
    const who = await api.post('/api/setup/admin-session', { token }, { auth: false })
    return establishAdminSession(who, who.email, { localSetupMode: who.localSetupMode === true })
  }, [establishAdminSession])

  const establishStudentSession = useCallback(async (r, fallbackEmail) => {
    let instanceId = r.instanceId || null
    if (!instanceId) {
      try { const st = await api.get('/api/session/status', { auth: false }); instanceId = st.instanceId } catch {}
    }
    const classes = r.student?.classes || []
    const firstClass = classes.length === 1 ? classes[0] : null
    const nextAuth = {
      role: 'student', email: r.student?.email || r.email || fallbackEmail, sessionToken: r.sessionToken,
      serverInstanceId: instanceId, loginAt: Date.now(),
      student: studentSessionProfile(r.student), activeClass: firstClass,
      localSetupMode: r.localSetupMode === true,
      // Troca de senha obrigatória (H5a): o portal mostra o formulário de troca primeiro.
      mustChangePassword: r.mustChangePassword === true,
      passwordChangeReason: r.mustChangePassword === true ? (r.passwordChangeReason || null) : null,
    }
    setAuthProvider(() => nextAuth)
    localStorage.setItem(LS, JSON.stringify(nextAuth))
    setAuth(nextAuth)
    lastActivityRef.current = Date.now()
    setAuthReady(true)
    return r.student
  }, [])

  const loginStudent = useCallback(async (email, password) => {
    const r = await api.post('/api/student/login', { email, password }, { auth: false })
    return establishStudentSession(r, email)
  }, [establishStudentSession])

  const loginLocalQuick = useCallback(async (token, profile) => {
    const session = await api.post('/api/setup/quick-session', { token, profile }, { auth: false })
    if (session.sessionType === 'student') return establishStudentSession(session, session.email)
    return establishAdminSession(session, session.email, { localSetupMode: true })
  }, [establishAdminSession, establishStudentSession])

  const setActiveClass = useCallback((activeClass) => {
    setAuth((current) => ({ ...current, activeClass }))
  }, [])

  const setActiveCourse = useCallback((activeCourse) => {
    setAuth((current) => ({
      ...current,
      activeCourse,
      activeWorkspace: activeCourse ? current.activeWorkspace : null,
    }))
  }, [])

  const setActiveWorkspace = useCallback((activeWorkspace) => {
    setAuth((current) => ({
      ...current,
      activeWorkspace,
      activeCourse: activeWorkspace
        ? { id: activeWorkspace.courseId, name: activeWorkspace.courseName }
        : null,
    }))
  }, [])

  // Guarda de saída (A18): uma tela com mudanças não gravadas (Corrigir provas) registra
  // aqui uma função guard(proceed). As saídas que não mudam o endereço, e por isso não
  // passam pelo useBlocker nem pelo beforeunload da tela ("Trocar curso ou turma" e o
  // "Sair" do topo), perguntam a ela antes: guard devolve true quando assumiu a saída (mostra
  // o diálogo e chama proceed se a pessoa confirmar) e false quando não há o que perder.
  // setLeaveGuard(guard) devolve a função que tira o registro (para o efeito da tela).
  const leaveGuardRef = useRef(null)
  const setLeaveGuard = useCallback((guard) => {
    leaveGuardRef.current = typeof guard === 'function' ? guard : null
    return () => { if (leaveGuardRef.current === guard) leaveGuardRef.current = null }
  }, [])
  // Devolve true quando saiu agora e false quando a tela segurou a saída para perguntar.
  const leaveGuarded = useCallback((proceed) => {
    const guard = leaveGuardRef.current
    let held = false
    if (guard) {
      try { held = guard(proceed) === true } catch { held = false }
    }
    if (held) return false
    proceed()
    return true
  }, [])

  const doClearActiveWorkspace = useCallback((preservePath) => {
    try {
      if (preservePath !== false) sessionStorage.setItem('iclass-workspace-switch', '1')
      else sessionStorage.removeItem('iclass-workspace-switch')
    } catch {}
    setAuth((current) => ({ ...current, activeWorkspace: null, activeCourse: null }))
  }, [])

  // clearActiveWorkspace(preservePath?, { force }?): "Trocar curso ou turma". O botão do
  // topo passa o evento do clique (preservePath vira true). force pula a guarda de saída:
  // só para a limpeza automática (o curso ou a turma sumiu, AdminCourseGate).
  const clearActiveWorkspace = useCallback((preservePath = true, options = {}) => {
    if (options && options.force === true) { doClearActiveWorkspace(preservePath); return true }
    return leaveGuarded(() => doClearActiveWorkspace(preservePath))
  }, [doClearActiveWorkspace, leaveGuarded])

  // --- Pré-visualização como aluno (C15 / P5-S6b) --------------------------------------
  // startPreview(resposta do POST /api/admin/preview-sessions, { origem }): grava a prévia
  // nesta aba antes de mudar o estado (o lib/api.js lê o token de lá no pedido seguinte)
  // e devolve a prévia. Quem chama leva para /aluno.
  const startPreview = useCallback((response, { origem = '/' } = {}) => {
    const next = previewFromResponse(response, { origem, adminEmail: authRef.current?.email || '' })
    if (!next) throw new Error('O servidor não abriu a pré-visualização. Tente de novo.')
    storePreview(next)
    previewRef.current = next
    setPreviewNotice(null)
    setPreview(next)
    return next
  }, [])

  // endPreview({ message, notifyServer }): fecha a prévia desta aba e devolve a tela do
  // painel de onde ela veio (quem chama navega para lá). Avisa o servidor (best-effort,
  // keepalive) com o cabeçalho da prévia e a sessão do painel; message (opcional) aparece
  // como aviso no painel (fim pelo servidor ou pelo prazo).
  const endPreview = useCallback(({ message = '', notifyServer = true } = {}) => {
    const current = previewRef.current
    clearStoredPreview()
    previewRef.current = null
    setPreview(null)
    const origem = current?.origem || '/'
    setPreviewReturn(origem)
    if (message) setPreviewNotice({ message: String(message), at: Date.now() })
    if (current && notifyServer) {
      api.post('/api/admin/preview-sessions/end', {}, { keepalive: true, headers: { [PREVIEW_HEADER]: current.token } }).catch(() => {})
    }
    return origem
  }, [])

  const clearPreviewNotice = useCallback(() => setPreviewNotice(null), [])

  // O servidor encerrou a prévia (401 preview_ended): volta ao painel com o motivo dele.
  useEffect(() => {
    setPreviewEndedHandler((data) => {
      if (!previewRef.current) return
      endPreview({ message: data?.error || PREVIEW_ENDED_FALLBACK, notifyServer: false })
    })
    return () => setPreviewEndedHandler(null)
  }, [endPreview])

  // Prazo da prévia (60 min): o relógio da aba fecha sem esperar o próximo pedido.
  useEffect(() => {
    if (!preview) return undefined
    const wait = Math.max(0, Number(preview.expiraEm) - Date.now())
    const timer = setTimeout(() => endPreview({ message: PREVIEW_EXPIRED_TEXT, notifyServer: false }), Math.min(wait, 2147483000))
    return () => clearTimeout(timer)
  }, [preview, endPreview])

  // logout(reason?, message?): reason só como texto (um onClick={logout} passaria o evento).
  // O "Sair" da pessoa (sem reason: o onClick passa o evento) passa pela guarda de saída
  // (A18) e devolve false quando a tela segurou a saída para perguntar; o fim da sessão
  // pelo sistema (reason em texto: prazo, reinício, revogada) sai sempre.
  const logout = useCallback((reason, message) => {
    const why = typeof reason === 'string' ? reason : undefined
    const text = typeof message === 'string' ? message : undefined
    if (why) { doLogout(why, text); return true }
    return leaveGuarded(() => doLogout(why, text))
  }, [doLogout, leaveGuarded])

  // Conta do painel só de consulta (Coordenação): as telas escondem os botões de gravar.
  // Vem do readOnly do whoami e do login (adminAccountFields); o aluno nunca é.
  const readOnly = auth?.role === 'admin' && isReadOnlyAccount(auth)

  return (
    <AuthCtx.Provider value={{ auth, readOnly, authReady, maintenance, loginAdmin, loginAdminSetup, loginLocalQuick, loginStudent, logout, endSessionFromError, setAuth, setActiveClass, setActiveCourse, setActiveWorkspace, clearActiveWorkspace, setLeaveGuard, syncPasswordChange, preview, startPreview, endPreview, previewNotice, clearPreviewNotice, previewReturn }}>
      {children}
    </AuthCtx.Provider>
  )
}

export const useAuth = () => useContext(AuthCtx)

// Portal do aluno na pré-visualização (C15 / P5-S6b, D21 do P5): as telas do aluno (dentro
// do RequireRole('student')) leem useAuth() e veem o aluno virtual da prévia, com
// auth.preview. A sessão do painel continua no AuthProvider, intocada:
// - logout (o Sair do portal) e endSessionFromError (sessão recusada) fecham a prévia em
//   vez de encerrar a sessão do instrutor;
// - setAuth, setActiveClass e syncPasswordChange não fazem nada (a prévia tem uma turma só
//   e não troca senha).
export function PreviewStudentScope({ children }) {
  const parent = useContext(AuthCtx)
  const preview = parent?.preview || null
  const value = useMemo(() => {
    if (!parent || !preview) return parent
    const aluno = preview.aluno || {}
    const noop = () => {}
    return {
      ...parent,
      auth: {
        role: 'student',
        email: aluno.email || '',
        student: aluno,
        activeClass: (aluno.classes || [])[0] || null,
        serverInstanceId: parent.auth?.serverInstanceId || null,
        loginAt: preview.iniciadaEm || Date.now(),
        mustChangePassword: false,
        passwordChangeReason: null,
        preview,
      },
      logout: () => { parent.endPreview() },
      endSessionFromError: async (err) => {
        const data = err && err.data
        parent.endPreview({ message: (data && data.code === 'preview_ended' && data.error) || PREVIEW_ENDED_FALLBACK, notifyServer: !(data && data.code === 'preview_ended') })
      },
      setAuth: noop,
      setActiveClass: noop,
      syncPasswordChange: noop,
    }
  }, [parent, preview])
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}
