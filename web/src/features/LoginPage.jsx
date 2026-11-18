import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, BookOpen, CheckCircle2, ChevronDown, GraduationCap, KeyRound, Layers3, LogIn, ShieldCheck, Sparkles, User, UserPlus, Wifi } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { ThemeToggle } from '../components/ui/ThemeToggle'
import { useAuth } from '../context/AuthProvider'
import { useToast } from '../context/ToastProvider'
import { api } from '../lib/api'
import { useBranding } from '../context/BrandingProvider'

const emptyGuardian = { name: '', phone: '', email: '', parentesco: '' }
const LOCAL_QUICK_KEY = 'iclass-local-quick-token'
export default function LoginPage() {
  const [mode, setMode] = useState(() => {
    if (typeof window === 'undefined') return 'student'
    return new URLSearchParams(window.location.search).get('mode') === 'admin' ? 'admin' : 'student'
  }) // 'student' | 'admin'
  const [studentAction, setStudentAction] = useState('login') // login | register | recover
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [nomeSocial, setNomeSocial] = useState('')
  const [phone, setPhone] = useState('')
  const [guardian, setGuardian] = useState(emptyGuardian)
  const [showGuardian, setShowGuardian] = useState(false)
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const [courseValue, setCourseValue] = useState('')
  const [classValue, setClassValue] = useState('')
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(false)
  const [quickLoginBusy, setQuickLoginBusy] = useState(null)
  const [demoEnabled, setDemoEnabled] = useState(false)
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
        const msg = r === 'idle' ? 'Sua sessão expirou por inatividade. Faça login novamente.' : r === 'restart' ? 'O servidor foi reiniciado. Faça login novamente.' : 'Sua sessão expirou. Faça login novamente.'
        toast.info(msg)
      }
    } catch {}
  }, [])

  useEffect(() => {
    api.get('/api/classes', { auth: false }).then((r) => setClasses(Array.isArray(r) ? r : (r.classes || []))).catch(() => setClasses([]))
  }, [])

  // Botões de acesso rápido só aparecem quando o servidor está em modo demonstração (TEST_MODE=1).
  useEffect(() => {
    api.get('/api/test-mode', { auth: false }).then((r) => setDemoEnabled(r?.enabled === true)).catch(() => setDemoEnabled(false))
  }, [])

  async function submit(e) {
    e.preventDefault(); setLoading(true)
    try {
      if (mode === 'admin') {
        await loginAdmin(email, password); nav('/')
      } else if (studentAction === 'register') {
        if (!acceptedTerms) { toast.error('Aceite os Termos de Uso e a Política de Privacidade'); setLoading(false); return }
        const courseId = courseValue
        const studentClass = classValue
        const hasGuardian = guardian.name || guardian.phone || guardian.email || guardian.parentesco
        await api.post('/api/student/register', {
          name, nomeSocial, email, password, phone, courseId, studentClass,
          guardian: hasGuardian ? guardian : undefined,
          acceptedTerms,
        }, { auth: false })
        await loginStudent(email, password)
        toast.success('Solicitação de matrícula enviada')
        nav('/aluno')
      } else if (studentAction === 'recover') {
        await api.post('/api/student/recover', { email }, { auth: false })
        toast.success('Solicitação enviada ao instrutor')
        setStudentAction('login')
      } else {
        await loginStudent(email, password); nav('/aluno')
      }
    } catch (err) { toast.error(err.message || 'Falha no login') } finally { setLoading(false) }
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
        await loginAdmin(account.email, account.password)
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
                <Button type="button" variant="secondary" icon={ShieldCheck} loading={quickLoginBusy === 'admin'} disabled={quickLoginBusy !== null} onClick={() => quickLogin('admin')} className="px-2 text-xs">Administrador</Button>
                <Button type="button" variant="secondary" icon={GraduationCap} loading={quickLoginBusy === 'professor'} disabled={quickLoginBusy !== null} onClick={() => quickLogin('professor')} className="px-2 text-xs">Professor</Button>
                <Button type="button" variant="secondary" icon={User} loading={quickLoginBusy === 'student'} disabled={quickLoginBusy !== null} onClick={() => quickLogin('student')} className="px-2 text-xs">Aluno</Button>
              </div>
            </div>
          )}

          <div className="glass-panel rounded-[24px] p-5 shadow-lg sm:p-7">
            <div className="flex rounded-xl border border-border bg-surface-2 p-1 text-sm">
              <button onClick={() => { setMode('student'); setStudentAction('login') }} className={`flex-1 rounded-lg py-2.5 font-semibold ${mode === 'student' ? 'bg-surface text-text shadow-sm' : 'text-text hover:text-text'}`}>Aluno</button>
              <button onClick={() => setMode('admin')} className={`flex-1 rounded-lg py-2.5 font-semibold ${mode === 'admin' ? 'bg-surface text-text shadow-sm' : 'text-text hover:text-text'}`}>Instrutor</button>
            </div>
            {mode === 'student' && (
              <div className="mt-3 flex rounded-xl bg-surface-2 p-1 text-xs">
                <button type="button" onClick={() => setStudentAction('login')} className={`flex-1 rounded-lg py-2 font-semibold ${studentAction === 'login' ? 'bg-surface text-text shadow-sm' : 'text-text hover:text-text'}`}>Entrar</button>
                <button type="button" onClick={() => setStudentAction('register')} className={`flex-1 rounded-lg py-2 font-semibold ${studentAction === 'register' ? 'bg-surface text-text shadow-sm' : 'text-text hover:text-text'}`}>Cadastro</button>
                <button type="button" onClick={() => setStudentAction('recover')} className={`flex-1 rounded-lg py-2 font-semibold ${studentAction === 'recover' ? 'bg-surface text-text shadow-sm' : 'text-text hover:text-text'}`}>Senha</button>
              </div>
            )}
            <form onSubmit={submit} className="mt-5 max-h-[58vh] space-y-4 overflow-auto pr-1">
            {isRegister && (
              <>
                <Input id="ln" label="Nome completo" value={name} onChange={(e) => setName(e.target.value)} required />
                <Input id="lns" label="Nome social (opcional)" value={nomeSocial} onChange={(e) => setNomeSocial(e.target.value)} helper="Se preenchido, será exibido no lugar do nome completo." />
              </>
            )}
            <Input id="le" label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={mode === 'admin' ? 'admin@exemplo.com' : 'voce@exemplo.com'} required />
            {!(mode === 'student' && studentAction === 'recover') && (
              <Input id="lp" label="Senha" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
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
              <div className="rounded-xl border border-border bg-surface-2/30">
                <button type="button" onClick={() => setShowGuardian((v) => !v)} className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-text">
                  <span>Responsável (opcional)</span>
                  <ChevronDown size={16} className={`transition-transform ${showGuardian ? 'rotate-180' : ''}`} />
                </button>
                {showGuardian && (
                  <div className="p-3 pt-0 space-y-3">
                    <p className="text-xs text-subtle">Preencha se você for menor de idade ou a instituição exigir.</p>
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
                <span>Li e aceito os <span className="text-text font-medium">Termos de Uso</span> e a <span className="text-text font-medium">Política de Privacidade</span>.</span>
              </label>
            )}
            <Button type="submit" size="lg" icon={mode === 'admin' || studentAction === 'login' ? LogIn : studentAction === 'register' ? UserPlus : KeyRound} loading={loading} className="w-full">
              {mode === 'admin' ? 'Entrar como instrutor' : studentAction === 'register' ? 'Criar conta' : studentAction === 'recover' ? 'Solicitar nova senha' : 'Entrar como aluno'}
              {!loading && <ArrowRight size={16} className="ml-auto" />}
            </Button>
          </form>
        </div>
          <p className="mt-5 flex items-center justify-center gap-2 text-center text-xs text-subtle"><ShieldCheck size={13} /> Ambiente protegido · acesso pela rede da instituição</p>
        </section>
      </main>
    </div>
  )
}
