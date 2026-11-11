import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, BookOpen, CheckCircle2, ChevronDown, ExternalLink, GraduationCap, KeyRound, Layers3, LogIn, MonitorX, RefreshCw, ShieldCheck, Sparkles, User, UserPlus, Wifi } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { ThemeToggle } from '../components/ui/ThemeToggle'
import { useAuth } from '../context/AuthProvider'
import { useToast } from '../context/ToastProvider'
import { api } from '../lib/api'
import { passwordHint } from '../lib/passwordPolicy'
import { useBranding } from '../context/BrandingProvider'
import { InsecureConnectionNotice } from '../components/ui/InsecureConnectionNotice'
import { adminAccessRefusalText, CERTIFICATE_GUIDE_PATH, LOCAL_ONLY_TEXT, secureAdminLoginUrl } from '../lib/adminAccess'
import { useConnectionInfo } from '../hooks/useConnectionInfo'
import { DOCUMENTS_CHANGED_MESSAGE, MINOR_GUARDIAN_MESSAGE, guardianComplete, isMinorBirthDate, todayIso } from '../lib/legalAcceptance'

const emptyGuardian = { name: '', phone: '', email: '', parentesco: '' }
// Links dos Termos e da Política (H8a-2): abrem em nova aba, com o curso escolhido no
// cadastro (os marcadores do texto usam os dados da escola dele).
function legalHref(path, courseId) {
  return courseId ? `${path}?courseId=${encodeURIComponent(courseId)}` : path
}
function LegalLink({ path, courseId, children }) {
  return <a href={legalHref(path, courseId)} target="_blank" rel="noopener noreferrer" className="font-medium text-text underline">{children}</a>
}
const LOCAL_QUICK_KEY = 'iclass-local-quick-token'
export const RECOVER_SENT_TEXT = 'Pedido enviado. Avise o professor: ele vai gerar uma senha temporária para você. No próximo acesso, entre com ela e escolha uma senha nova.'
export default function LoginPage() {
  const [mode, setMode] = useState(() => {
    if (typeof window === 'undefined') return 'student'
    return new URLSearchParams(window.location.search).get('mode') === 'admin' ? 'admin' : 'student'
  }) // 'student' | 'admin'
  const [studentAction, setStudentActionState] = useState('login') // login | register | recover
  // Pedido de nova senha enviado (UXA-13): a tela diz o próximo passo no lugar do formulário.
  const [recoverSent, setRecoverSent] = useState(false)
  const setStudentAction = (action) => { setRecoverSent(false); setStudentActionState(action) }
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [nomeSocial, setNomeSocial] = useState('')
  const [phone, setPhone] = useState('')
  const [guardian, setGuardian] = useState(emptyGuardian)
  const [showGuardian, setShowGuardian] = useState(false)
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  // Data de nascimento (H8a-2, SEG-09): obrigatória no autocadastro; para menor de 18
  // anos, o responsável também.
  const [birthDate, setBirthDate] = useState('')
  // Documentos que a tela mostra no aceite (GET /api/legal/documents): os ids vão no
  // cadastro, e o servidor responde 409 se a escola publicou outra versão no meio.
  const [legalDocs, setLegalDocs] = useState(null)
  const [legalDocsAttempt, setLegalDocsAttempt] = useState(0)
  const [courseValue, setCourseValue] = useState('')
  const [classValue, setClassValue] = useState('')
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(false)
  // Login com atraso por senha errada (H5b; SEG-06, 429 { loginDelayed }): o aviso fica na
  // tela, e não só no toast, para quem chamar o professor saber o que dizer.
  const [delayNotice, setDelayNotice] = useState(null)
  const [quickLoginBusy, setQuickLoginBusy] = useState(null)
  const [demoEnabled, setDemoEnabled] = useState(false)
  // Como o servidor trata o painel do professor neste aparelho (GET /api/connection, SEG-03),
  // relido quando a tela volta a ficar visível, ao abrir a aba do instrutor e no
  // "Verificar de novo": o administrador pode liberar o aparelho com esta tela aberta.
  const { connection, checking: checkingConnection, refresh: refreshConnection, override: overrideConnection } = useConnectionInfo()
  const [localQuickToken, setLocalQuickToken] = useState(() => {
    if (typeof sessionStorage === 'undefined') return ''
    try { return sessionStorage.getItem(LOCAL_QUICK_KEY) || '' } catch { return '' }
  })
  const { loginAdmin, loginAdminSetup, loginLocalQuick, loginStudent } = useAuth()
  const nav = useNavigate()
  const toast = useToast()
  const setupHandledRef = useRef(false)
  const { branding } = useBranding()
  const bLogo = branding?.logoLightUrl || branding?.logoDarkUrl || ''
  const bName = branding?.displayName || 'IClass'
  const bWelcome = branding?.loginWelcome || ''
  const bgStyle = branding?.loginBgUrl ? { backgroundImage: 'url('+branding.loginBgUrl+')', backgroundSize: 'cover', backgroundPosition: 'center' } : (branding?.loginBgColor ? { background: branding.loginBgColor } : undefined)

  useEffect(() => {
    if (setupHandledRef.current || typeof window === 'undefined') return
    const localQuickPrefix = '#local-quick='
    if (window.location.hash.startsWith(localQuickPrefix)) {
      setupHandledRef.current = true
      const token = decodeURIComponent(window.location.hash.slice(localQuickPrefix.length)).trim()
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
      if (token) {
        setLocalQuickToken(token)
        try { sessionStorage.setItem(LOCAL_QUICK_KEY, token) } catch {}
      }
      return
    }
    const prefix = '#admin-setup='
    if (!window.location.hash.startsWith(prefix)) return
    setupHandledRef.current = true
    const token = decodeURIComponent(window.location.hash.slice(prefix.length)).trim()
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    if (!token) return

    setMode('admin')
    setLoading(true)
    loginAdminSetup(token)
      .then(() => nav('/', { replace: true }))
      .catch((error) => toast.error(error.message || 'Não foi possível autorizar o modo administrativo local.'))
      .finally(() => setLoading(false))
  }, [loginAdminSetup, nav, toast])

  useEffect(() => {
    try {
      const r = sessionStorage.getItem('iclass-logout-reason')
      if (r) {
        sessionStorage.removeItem('iclass-logout-reason')
        let serverMessage = ''
        try { serverMessage = sessionStorage.getItem('iclass-logout-message') || ''; sessionStorage.removeItem('iclass-logout-message') } catch {}
        if (r === 'admin-network') {
          // Painel recusado neste aparelho com a sessão aberta: volta na aba do instrutor,
          // com o aviso da tela e o motivo do servidor.
          setMode('admin')
          toast.error(serverMessage || LOCAL_ONLY_TEXT)
          return
        }
        // Sessão encerrada por uma ação no servidor (lib/sessionRevoked.js): o texto vem dele.
        if (r === 'logout') return
        if (r === 'password_reset' || r === 'password_changed') {
          toast.info(serverMessage || 'A senha desta conta foi alterada. Entre de novo com a senha nova.')
          return
        }
        if (r === 'replaced') {
          toast.info(serverMessage || 'Sessão encerrada porque a conta foi acessada em outro dispositivo. Faça login novamente.')
          return
        }
        const msg = r === 'idle' ? 'Sua sessão expirou por inatividade. Faça login novamente.' : r === 'restart' ? 'O servidor foi reiniciado. Faça login novamente.' : 'Sua sessão expirou. Faça login novamente.'
        toast.info(msg)
      }
    } catch {}
  }, [])

  const registering = mode === 'student' && studentAction === 'register'
  useEffect(() => {
    if (!registering) return undefined
    let active = true
    const query = courseValue ? `?courseId=${encodeURIComponent(courseValue)}` : ''
    api.get(`/api/legal/documents${query}`, { auth: false })
      .then((data) => { if (active) setLegalDocs(data) })
      .catch(() => { if (active) setLegalDocs(null) })
    return () => { active = false }
  }, [registering, courseValue, legalDocsAttempt])

  // Menor de 18 anos: a seção do responsável abre sozinha e passa a ser obrigatória.
  const minorRegistration = registering && isMinorBirthDate(birthDate)
  useEffect(() => { if (minorRegistration) setShowGuardian(true) }, [minorRegistration])

  useEffect(() => {
    api.get('/api/classes', { auth: false }).then((r) => setClasses(Array.isArray(r) ? r : (r.classes || []))).catch(() => setClasses([]))
  }, [])

  // Botões de acesso rápido só aparecem quando o servidor está em modo demonstração (TEST_MODE=1).
  useEffect(() => {
    api.get('/api/test-mode', { auth: false }).then((r) => setDemoEnabled(r?.enabled === true)).catch(() => setDemoEnabled(false))
  }, [])

  // Recusa do painel vinda de um 403 (o administrador mudou a regra com a tela aberta):
  // atualiza o aviso da aba do instrutor sem esperar outra consulta.
  function noteRefusal(err) {
    const adminAccess = err?.status === 403 && err?.data?.adminAccess
    if (!adminAccess) return
    const patch = { adminAccess, adminAccessError: err.data.error || '', insecureAdmin: false }
    if (err.data.httpsUrl !== undefined) patch.httpsUrl = err.data.httpsUrl
    overrideConnection((current) => ({ ...(current || {}), ...patch }))
  }

  // Alunos pela conexão segura (Sistema → Rede, H6c): a tela foi aberta por http antes da
  // troca, e o servidor recusa o login, o cadastro e o pedido de senha por http com a
  // resposta de estado do contrato 9, { adminAccess: 'https-required', httpsUrl }. Vai
  // para a mesma tela no endereço seguro.
  function goSecureForStudent(err) {
    const httpsUrl = err?.status === 403 && err?.data?.adminAccess === 'https-required' ? err.data.httpsUrl : ''
    if (typeof httpsUrl !== 'string' || !/^https:\/\//.test(httpsUrl)) return false
    window.location.assign(`${httpsUrl.replace(/\/+$/, '')}/login`)
    return true
  }

  async function submit(e) {
    e.preventDefault(); setLoading(true); setDelayNotice(null)
    try {
      if (mode === 'admin') {
        try { await loginAdmin(email, password) } catch (err) { noteRefusal(err); throw err }
        nav('/')
      } else if (studentAction === 'register') {
        if (!birthDate) { toast.error('Informe a data de nascimento.'); setLoading(false); return }
        if (minorRegistration && !guardianComplete(guardian)) { setShowGuardian(true); toast.error(MINOR_GUARDIAN_MESSAGE); setLoading(false); return }
        if (!acceptedTerms) { toast.error('Aceite os Termos de Uso e a Política de Privacidade'); setLoading(false); return }
        const courseId = courseValue
        const studentClass = classValue
        const hasGuardian = guardian.name || guardian.phone || guardian.email || guardian.parentesco
        try {
          await api.post('/api/student/register', {
            name, nomeSocial, email, password, phone, courseId, studentClass, birthDate,
            guardian: hasGuardian ? guardian : undefined,
            acceptedTerms,
            termsDocumentId: legalDocs?.terms?.documentId || undefined,
            privacyDocumentId: legalDocs?.privacy?.documentId || undefined,
          }, { auth: false })
        } catch (err) {
          // A escola publicou outra versão enquanto a tela estava aberta: busca a nova e
          // pede o aceite de novo.
          if (err?.status === 409 && err?.data?.code === 'documents_changed') {
            setAcceptedTerms(false)
            setLegalDocsAttempt((value) => value + 1)
            throw Object.assign(new Error(err.data.error || DOCUMENTS_CHANGED_MESSAGE), { status: 409 })
          }
          throw err
        }
        await loginStudent(email, password)
        toast.success('Solicitação de matrícula enviada')
        nav('/aluno')
      } else if (studentAction === 'recover') {
        await api.post('/api/student/recover', { email }, { auth: false })
        setRecoverSent(true)
      } else {
        await loginStudent(email, password); nav('/aluno')
      }
    } catch (err) {
      if (mode === 'student' && goSecureForStudent(err)) { toast.info(err.message || 'Abra o endereço seguro para entrar.'); return }
      // Login em espera: o aviso fixo acima do botão já mostra o texto; o toast repetido
      // cobria o botão "Entrar" no celular.
      const delayed = err?.status === 429 && err?.data?.loginDelayed
      if (delayed) setDelayNotice({ mode, text: err.message })
      if (!delayed || !(mode === 'admin' || studentAction === 'login')) toast.error(err.message || 'Falha no login')
    } finally { setLoading(false) }
  }

  async function quickLogin(kind) {
    setQuickLoginBusy(kind)
    try {
      if (localQuickToken) {
        await loginLocalQuick(localQuickToken, kind)
        nav(kind === 'student' ? '/aluno' : '/')
        return
      }
      const accounts = await api.post('/api/test/seed', {}, { auth: false })
      if (kind === 'student') {
        await loginStudent(accounts.student.email, accounts.student.password)
        nav('/aluno')
      } else {
        const account = kind === 'admin' ? accounts.admin : accounts.professor
        try { await loginAdmin(account.email, account.password) } catch (err) { noteRefusal(err); throw err }
        nav('/')
      }
    } catch (err) {
      if (localQuickToken && [403, 404, 410].includes(err?.status)) {
        setLocalQuickToken('')
        try { sessionStorage.removeItem(LOCAL_QUICK_KEY) } catch {}
      }
      toast.error(err.message || 'Falha no acesso rápido')
    } finally {
      setQuickLoginBusy(null)
    }
  }

  const isRegister = mode === 'student' && studentAction === 'register'
  // Painel do professor recusado neste aparelho ('local' ou 'rede' sem conexão segura).
  const adminRefusal = connection && connection.adminAccess && connection.adminAccess !== 'ok'
    ? adminAccessRefusalText(connection.adminAccess, connection.adminAccessError, connection.httpsUrl)
    : ''
  // 'rede' com a conexão segura funcionando: o botão leva ao login no endereço https.
  const secureLoginUrl = adminRefusal && connection.adminAccess === 'https-required' ? secureAdminLoginUrl(connection.httpsUrl) : ''
  const activeCourses = Array.from(new Map((classes || []).map((c) => [c.courseId, c.courseName])).entries()).map(([id, name]) => ({ id, name }))
  const courseClasses = (classes || []).filter((c) => c.courseId === courseValue)
  const setG = (patch) => setGuardian((g) => ({ ...g, ...patch }))

  return (
    <div className="login-page app-canvas relative min-h-full overflow-y-auto" style={bgStyle}>
      <span className="ambient-orb pointer-events-none absolute -left-32 top-1/3 h-80 w-80 rounded-full bg-primary-soft blur-3xl" aria-hidden />
      <span className="ambient-orb ambient-orb-delayed pointer-events-none absolute right-8 top-12 h-72 w-72 rounded-full bg-info-soft blur-3xl" aria-hidden />
      <div className="absolute right-5 top-5 z-20 rounded-xl glass-panel"><ThemeToggle /></div>

      <main className="relative z-10 mx-auto grid min-h-full w-full max-w-[1360px] items-center gap-10 px-5 py-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(430px,.78fr)] lg:px-12 lg:py-10 xl:gap-24">
        <section className="hidden max-w-2xl lg:block app-enter">
          <div className="mb-16 flex items-center gap-3">
            {bLogo ? <img src={bLogo} alt={bName} className="h-11 max-w-[210px] object-contain" /> : (
              <>
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary text-primary-fg shadow-[0_12px_32px_var(--primary-glow)]"><GraduationCap size={23} /></span>
                <span className="text-xl font-semibold tracking-[-0.03em] text-text">{bName}</span>
              </>
            )}
          </div>
          <div className="mb-9 inline-flex items-center gap-2 rounded-full border border-border bg-surface-glass px-3.5 py-2 text-xs font-medium text-muted backdrop-blur-xl">
            <Sparkles size={14} className="text-primary" /> Aprendizagem que flui com você
          </div>
          <h1 className="max-w-xl text-5xl font-semibold leading-[1.04] tracking-[-0.055em] text-text xl:text-6xl">
            Conhecimento em movimento. <span className="text-primary">Resultados reais.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-muted">
            {bWelcome || 'Um ambiente claro e conectado para transformar aulas, conteúdos e progresso em uma jornada de aprendizagem única.'}
          </p>

          <div className="mt-10 grid max-w-xl grid-cols-3 gap-3">
            {[
              [Layers3, 'Tudo conectado', 'Conteúdo e gestão'],
              [CheckCircle2, 'Progresso claro', 'Acompanhamento vivo'],
              [Wifi, 'Local e seguro', 'Na rede da instituição'],
            ].map(([Icon, title, copy]) => (
              <div key={title} className="glass-panel rounded-xl p-4">
                <Icon size={18} className="mb-5 text-primary" />
                <p className="text-sm font-semibold text-text">{title}</p>
                <p className="mt-1 text-xs leading-5 text-subtle">{copy}</p>
              </div>
            ))}
          </div>

          <div className="relative mt-5 max-w-xl overflow-hidden rounded-xl glass-panel p-5">
            <span className="absolute right-5 top-5 rounded-full bg-success-soft px-2.5 py-1 text-[11px] font-medium text-success">Em andamento</span>
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-soft text-primary"><BookOpen size={20} /></span>
              <div><p className="text-xs text-subtle">Sua próxima conquista</p><p className="mt-1 text-sm font-semibold text-text">Fundamentos de Tecnologia</p></div>
            </div>
            <div className="mt-5 flex items-center justify-between text-xs"><span className="text-muted">Progresso da jornada</span><strong className="text-text">72%</strong></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="progress-reveal h-full w-[72%] rounded-full bg-primary" /></div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-[510px] app-enter">
          <div className="mb-7 flex items-center justify-center gap-3 lg:hidden">
            {bLogo ? <img src={bLogo} alt={bName} className="h-10 max-w-[190px] object-contain" /> : <><span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-fg"><GraduationCap size={21} /></span><span className="text-xl font-semibold tracking-[-0.03em]">{bName}</span></>}
          </div>
          <div className="mb-6">
            <p className="text-[11px] font-semibold uppercase tracking-[.18em] text-primary">Bem-vindo de volta</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-text">Acesse sua conta</h2>
            <p className="mt-2 text-sm text-muted">Escolha seu perfil e continue de onde parou.</p>
          </div>

          {(demoEnabled || localQuickToken) && (
            <div className="mb-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-subtle">{localQuickToken ? 'Acesso rápido local' : 'Acesso rápido de demonstração'}</p>
              <div className="grid grid-cols-3 gap-2">
                <Button type="button" variant="secondary" icon={ShieldCheck} loading={quickLoginBusy === 'admin'} disabled={quickLoginBusy !== null || !!adminRefusal} onClick={() => quickLogin('admin')} className="px-2 text-xs">Administrador</Button>
                <Button type="button" variant="secondary" icon={GraduationCap} loading={quickLoginBusy === 'professor'} disabled={quickLoginBusy !== null || !!adminRefusal} onClick={() => quickLogin('professor')} className="px-2 text-xs">Professor</Button>
                <Button type="button" variant="secondary" icon={User} loading={quickLoginBusy === 'student'} disabled={quickLoginBusy !== null} onClick={() => quickLogin('student')} className="px-2 text-xs">Aluno</Button>
              </div>
              {adminRefusal && (
                <p data-testid="quick-admin-refused" className="mt-2 text-xs text-muted">Administrador e Professor não entram neste aparelho: o painel do professor não abre aqui (veja a aba Instrutor).</p>
              )}
            </div>
          )}

          <div className="glass-panel rounded-[24px] p-5 shadow-lg sm:p-7">
            <div className="flex rounded-xl border border-border bg-surface-2 p-1 text-sm">
              <button onClick={() => { setMode('student'); setStudentAction('login') }} className={`flex-1 rounded-lg py-2.5 font-semibold ${mode === 'student' ? 'bg-surface text-text shadow-sm' : 'text-text hover:text-text'}`}>Aluno</button>
              <button onClick={() => { setMode('admin'); refreshConnection() }} className={`flex-1 rounded-lg py-2.5 font-semibold ${mode === 'admin' ? 'bg-surface text-text shadow-sm' : 'text-text hover:text-text'}`}>Instrutor</button>
            </div>
            {mode === 'student' && (
              <div className="mt-3 flex rounded-xl bg-surface-2 p-1 text-xs">
                <button type="button" onClick={() => setStudentAction('login')} className={`flex-1 rounded-lg py-2 font-semibold ${studentAction === 'login' ? 'bg-surface text-text shadow-sm' : 'text-text hover:text-text'}`}>Entrar</button>
                <button type="button" onClick={() => setStudentAction('register')} className={`flex-1 rounded-lg py-2 font-semibold ${studentAction === 'register' ? 'bg-surface text-text shadow-sm' : 'text-text hover:text-text'}`}>Cadastro</button>
                <button type="button" onClick={() => setStudentAction('recover')} className={`flex-1 rounded-lg py-2 font-semibold ${studentAction === 'recover' ? 'bg-surface text-text shadow-sm' : 'text-text hover:text-text'}`}>Senha</button>
              </div>
            )}
            {mode === 'admin' && adminRefusal && (
              <div role="alert" data-testid="admin-access-refused" className="mt-4 flex items-start gap-2.5 rounded-lg border border-danger bg-danger-soft px-4 py-3 text-sm text-text">
                <MonitorX aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-danger" />
                <div className="min-w-0 space-y-2">
                  <p>{adminRefusal}</p>
                  {secureLoginUrl && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <a href={secureLoginUrl} data-testid="open-secure-address" className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-fg hover:opacity-90">
                        <ExternalLink aria-hidden="true" size={15} /> Abrir endereço seguro
                      </a>
                      <a href={CERTIFICATE_GUIDE_PATH} data-testid="certificate-guide-link" className="text-sm font-semibold text-text underline">Como instalar o certificado</a>
                    </div>
                  )}
                  <Button type="button" variant="secondary" size="sm" icon={RefreshCw} loading={checkingConnection} onClick={() => refreshConnection({ force: true })}>Verificar de novo</Button>
                </div>
              </div>
            )}
            {mode === 'admin' && !adminRefusal && <InsecureConnectionNotice connection={connection} className="mt-4" />}
            {mode === 'student' && studentAction === 'recover' && recoverSent ? (
              <div role="status" data-testid="recover-sent" className="mt-5 space-y-4">
                <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-text">
                  <KeyRound aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-primary" />
                  <p>{RECOVER_SENT_TEXT}</p>
                </div>
                <Button type="button" size="lg" variant="secondary" icon={LogIn} className="w-full" onClick={() => setStudentAction('login')}>Voltar para o login</Button>
              </div>
            ) : (
            // Sem altura máxima nem rolagem própria (UXA-13): o cadastro inteiro rola com a
            // página, e o botão Criar conta não fica escondido numa caixa rolável no celular.
            <form onSubmit={submit} className="mt-5 space-y-4">
            {isRegister && (
              <>
                <Input id="ln" label="Nome completo" value={name} onChange={(e) => setName(e.target.value)} required />
                <Input id="lns" label="Nome social (opcional)" value={nomeSocial} onChange={(e) => setNomeSocial(e.target.value)} helper="Se preenchido, será exibido no lugar do nome completo." />
              </>
            )}
            <Input id="le" label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={mode === 'admin' ? 'admin@exemplo.com' : 'voce@exemplo.com'} required />
            {!(mode === 'student' && studentAction === 'recover') && (
              <Input id="lp" label="Senha" type="password" autoComplete={isRegister ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required
                helper={isRegister ? passwordHint('student') : undefined} />
            )}
            {isRegister && (
              <Input id="lph" label="Telefone (opcional)" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(11) 90000-0000" />
            )}
            {isRegister && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="lcc" className="text-sm font-medium text-text">Curso</label>
                <select id="lcc" value={courseValue} onChange={(e) => { setCourseValue(e.target.value); setClassValue('') }} required className="h-11 rounded-lg border border-border bg-surface-2 px-3.5 text-sm text-text">
                  <option value="">Selecione o curso...</option>
                  {activeCourses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            {isRegister && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="lc" className="text-sm font-medium text-text">Turma</label>
                <select id="lc" value={classValue} onChange={(e) => setClassValue(e.target.value)} required disabled={!courseValue} className="h-11 rounded-lg border border-border bg-surface-2 px-3.5 text-sm text-text disabled:opacity-50">
                  <option value="">{courseValue ? 'Selecione a turma...' : 'Escolha um curso primeiro'}</option>
                  {courseClasses.map((c, i) => <option key={`${c.name}-${i}`} value={c.name}>{c.name}{c.period ? ` - ${c.period}` : ''}</option>)}
                </select>
              </div>
            )}
            {isRegister && (
              <Input id="lbd" label="Data de nascimento" type="date" min="1900-01-01" max={todayIso()} value={birthDate} onChange={(e) => setBirthDate(e.target.value)} required
                helper={minorRegistration ? 'Menor de 18 anos: informe também o responsável, logo abaixo.' : undefined} />
            )}
            {isRegister && (
              <div className="rounded-xl border border-border bg-surface-2/30">
                <button type="button" onClick={() => setShowGuardian((v) => !v)} className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-text">
                  <span>{minorRegistration ? 'Responsável (obrigatório para menores de 18 anos)' : 'Responsável (opcional)'}</span>
                  <ChevronDown size={16} className={`transition-transform ${showGuardian ? 'rotate-180' : ''}`} />
                </button>
                {showGuardian && (
                  <div className="p-3 pt-0 space-y-3">
                    <p className="text-xs text-subtle">{minorRegistration ? MINOR_GUARDIAN_MESSAGE : 'Preencha se você for menor de idade ou a instituição exigir.'}</p>
                    <Input id="lgn" label="Nome do responsável" value={guardian.name} onChange={(e) => setG({ name: e.target.value })} />
                    <Input id="lgp" label="Telefone do responsável" value={guardian.phone} onChange={(e) => setG({ phone: e.target.value })} placeholder="(11) 90000-0000" />
                    <Input id="lge" label="E-mail do responsável" type="email" value={guardian.email} onChange={(e) => setG({ email: e.target.value })} />
                    <Input id="lgr" label="Parentesco" value={guardian.parentesco} onChange={(e) => setG({ parentesco: e.target.value })} placeholder="Mãe, pai, tutor..." />
                  </div>
                )}
              </div>
            )}
            {isRegister && (
              <label className="flex items-start gap-2 text-xs text-muted">
                <input type="checkbox" checked={acceptedTerms} onChange={(e) => setAcceptedTerms(e.target.checked)} required className="mt-0.5" />
                <span>Li e aceito os <LegalLink path="/termos" courseId={courseValue}>Termos de Uso</LegalLink> e li a <LegalLink path="/privacidade" courseId={courseValue}>Política de Privacidade</LegalLink>.</span>
              </label>
            )}
            {delayNotice && delayNotice.mode === mode && (mode === 'admin' || studentAction === 'login') && (
              <p role="status" data-testid="login-delayed" className="rounded-lg border border-warning bg-warning-soft px-4 py-3 text-sm text-text">{delayNotice.text}</p>
            )}
            <Button type="submit" size="lg" icon={mode === 'admin' || studentAction === 'login' ? LogIn : studentAction === 'register' ? UserPlus : KeyRound} loading={loading} disabled={mode === 'admin' && !!adminRefusal} className="w-full">
              {mode === 'admin' ? 'Entrar como instrutor' : studentAction === 'register' ? 'Criar conta' : studentAction === 'recover' ? 'Solicitar nova senha' : 'Entrar como aluno'}
              {!loading && <ArrowRight size={16} className="ml-auto" />}
            </Button>
          </form>
            )}
        </div>
          <p className="mt-5 flex items-center justify-center gap-2 text-center text-xs text-subtle"><ShieldCheck size={13} /> Ambiente protegido · acesso pela rede da instituição</p>
          <p className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-xs text-muted" data-testid="login-legal-links">
            <LegalLink path="/termos" courseId={isRegister ? courseValue : ''}>Termos de Uso</LegalLink>
            <span aria-hidden="true">·</span>
            <LegalLink path="/privacidade" courseId={isRegister ? courseValue : ''}>Política de Privacidade</LegalLink>
          </p>
        </section>
      </main>
    </div>
  )
}
