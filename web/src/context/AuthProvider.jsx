import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { api, setAuthProvider } from '../lib/api'
import { isStudentExamPath, shouldExpireForIdle } from '../lib/sessionActivity'

const AuthCtx = createContext()
const LS = 'iclass-v3-auth'

// --- Segurança de sessão (ajustável) ---------------------------------------
const IDLE_MS = 60 * 60 * 1000         // 60 min sem atividade do usuário -> logout
const ABSOLUTE_MS = 8 * 60 * 60 * 1000 // 8 h desde o login -> logout
const REVALIDATE_MS = 60 * 1000        // checagem periódica de instância/servidor
const NET_FAIL_TOLERANCE = 3           // falhas de rede toleradas antes de considerar offline

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS)) || {} } catch { return {} }
  })
  const [authReady, setAuthReady] = useState(false)
  const [maintenance, setMaintenance] = useState({ enabled: false, message: '' })
  const lastActivityRef = useRef(Date.now())
  const idleMsRef = useRef(IDLE_MS)
  const absMsRef = useRef(ABSOLUTE_MS)
  const netFailRef = useRef(0)

  useEffect(() => { setAuthProvider(() => auth) }, [auth])
  useEffect(() => {
    let cancelled = false
    const refreshSettings = () => api.get('/api/settings/public', { auth: false }).then((r) => {
      if (cancelled) return
      if (r?.session) { idleMsRef.current = (r.session.idleMinutes || 60) * 60000; absMsRef.current = (r.session.absoluteHours || 8) * 3600000 }
      if (r?.maintenance) setMaintenance(r.maintenance)
    }).catch(() => {})
    refreshSettings()
    const id = setInterval(refreshSettings, 30000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])
  useEffect(() => {
    if (auth?.role) localStorage.setItem(LS, JSON.stringify(auth))
    else localStorage.removeItem(LS)
  }, [auth])

  // Encerra a sessão. Para instrutor, revoga o token no servidor (best-effort).
  const doLogout = useCallback((reason) => {
    try { if (reason) sessionStorage.setItem('iclass-logout-reason', reason) } catch {}
    try { sessionStorage.removeItem('iclass-workspace-switch') } catch {}
    try {
      const cur = JSON.parse(localStorage.getItem(LS)) || {}
      if (cur.role === 'admin' && cur.adminSession) {
        api.post('/api/session/logout', {}, {}).catch(() => {})
      }
    } catch {}
    setAuthProvider(() => ({}))
    setAuth({})
    setAuthReady(true)
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

      try {
        // Instância do servidor: se mudou (reinício), força novo login.
        let serverInst = null
        try { const st = await api.get('/api/session/status', { auth: false }); serverInst = st.instanceId } catch { /* rede: não desloga aqui */ }
        if (serverInst && auth.serverInstanceId && serverInst !== auth.serverInstanceId) { if (!cancelled) doLogout('restart'); return }

        if (auth.role === 'student') {
          if (!auth.email || !auth.sessionToken) throw Object.assign(new Error('Sessao incompleta'), { status: 401 })
          await api.get(`/api/ping?email=${encodeURIComponent(auth.email)}`)
          if (!cancelled && serverInst && !auth.serverInstanceId) setAuth((c) => ({ ...c, serverInstanceId: serverInst }))
        } else if (auth.role === 'admin') {
          if (!auth.adminSession && !auth.adminAuth) throw Object.assign(new Error('Sessao incompleta'), { status: 401 })
          const who = await api.get('/api/admin/whoami')
          if (!cancelled) {
            setAuth((current) => ({
              ...current,
              adminSession: who.sessionToken || current.adminSession,
              adminAuth: undefined, // migra sessões legadas: remove a senha do storage
              loginAt: current.loginAt || Date.now(),
              serverInstanceId: who.instanceId || current.serverInstanceId,
              email: who.email || current.email,
              accountRole: who.role || 'admin',
              assignedClasses: who.assignedClasses || [],
              assignedCourseIds: who.assignedCourseIds || [],
              assignedSchoolIds: who.assignedSchoolIds || [],
              additionalPermissions: who.additionalPermissions || [],
              mustChangePassword: who.mustChangePassword === true,
            }))
          }
        }
        if (!cancelled) { lastActivityRef.current = Date.now(); setAuthReady(true) }
      } catch (err) {
        // 401/403 => sessão inválida (expirada/reiniciada). Erro de rede => mantém e tenta depois.
        if (err && (err.status === 401 || err.status === 403)) { if (!cancelled) doLogout('expired') }
        else if (!cancelled) setAuthReady(true)
      }
    }
    validateStoredSession()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Timeout de inatividade + revalidação periódica (instância) + on focus/visibility.
  useEffect(() => {
    if (!auth?.role) return
    const markActivity = () => { lastActivityRef.current = Date.now() }
    const evs = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click']
    evs.forEach((e) => window.addEventListener(e, markActivity, { passive: true }))

    async function check() {
      if (!auth?.role) return
      const now = Date.now()
      const pathname = typeof window === 'undefined' ? '' : window.location.pathname
      if (isStudentExamPath(pathname) && auth.role === 'student') {
        // Ler uma questão por vários minutos continua sendo atividade válida.
        // Mantém a sessão enquanto a rota protegida da prova estiver aberta.
        lastActivityRef.current = now
      } else if (shouldExpireForIdle({ role: auth.role, pathname, idleForMs: now - lastActivityRef.current, idleLimitMs: idleMsRef.current })) {
        doLogout('idle'); return
      }
      if (auth.loginAt && now - auth.loginAt > absMsRef.current) { doLogout('expired'); return }
      try {
        const st = await api.get('/api/session/status', { auth: false })
        netFailRef.current = 0
        if (st.instanceId && auth.serverInstanceId && st.instanceId !== auth.serverInstanceId) { doLogout('restart'); return }
      } catch {
        netFailRef.current += 1 // rede instável: tolera, não desloga por 1 falha isolada
      }
    }

    const id = setInterval(check, REVALIDATE_MS)
    const onFocus = () => { if (document.visibilityState !== 'hidden') check() }
    window.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(id)
      evs.forEach((e) => window.removeEventListener(e, markActivity))
      window.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
    }
  }, [auth?.role, auth?.serverInstanceId, auth?.loginAt, doLogout])

  const establishAdminSession = useCallback((who, fallbackEmail, extra = {}) => {
    const next = {
      role: 'admin',
      adminSession: who.sessionToken,
      serverInstanceId: who.instanceId || null,
      loginAt: Date.now(),
      email: who.email || fallbackEmail,
      activeCourse: null,
      activeWorkspace: null,
      accountRole: who.role || 'admin',
      assignedClasses: who.assignedClasses || [],
      assignedCourseIds: who.assignedCourseIds || [],
      assignedSchoolIds: who.assignedSchoolIds || [],
      additionalPermissions: who.additionalPermissions || [],
      mustChangePassword: who.mustChangePassword === true,
      ...extra,
    }
    setAuthProvider(() => next)
    setAuth(next)
    lastActivityRef.current = Date.now()
    setAuthReady(true)
    return true
  }, [])

  const loginAdmin = useCallback(async (email, password) => {
    const adminAuth = `${email}:${password}`
    setAuthProvider(() => ({ adminAuth })) // credencial temporária só para autenticar
    // whoami valida e emite um TOKEN de sessão + instanceId. Guardamos o token,
    // NÃO a senha (deixa de ficar em texto puro no localStorage).
    const who = await api.get('/api/admin/whoami')
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
      student: r.student, activeClass: firstClass,
      localSetupMode: r.localSetupMode === true,
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

  const clearActiveWorkspace = useCallback((preservePath = true) => {
    try {
      if (preservePath !== false) sessionStorage.setItem('iclass-workspace-switch', '1')
      else sessionStorage.removeItem('iclass-workspace-switch')
    } catch {}
    setAuth((current) => ({ ...current, activeWorkspace: null, activeCourse: null }))
  }, [])

  const logout = useCallback(() => { doLogout() }, [doLogout])

  return (
    <AuthCtx.Provider value={{ auth, authReady, maintenance, loginAdmin, loginAdminSetup, loginLocalQuick, loginStudent, logout, setAuth, setActiveClass, setActiveCourse, setActiveWorkspace, clearActiveWorkspace }}>
      {children}
    </AuthCtx.Provider>
  )
}

export const useAuth = () => useContext(AuthCtx)
