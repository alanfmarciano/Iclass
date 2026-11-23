import { Suspense, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Home, BookOpen, ClipboardList, FileUp, NotebookPen, MessagesSquare, Megaphone, FolderOpen, GraduationCap, Menu, LogOut, CalendarDays, Sparkles, UserRound, ShieldCheck, CircleHelp, Mail } from 'lucide-react'
import { ThemeToggle } from '../../components/ui/ThemeToggle'
import { useAuth } from '../../context/AuthProvider'
import { usePreview } from '../../hooks/usePreview'
import { cn } from '../../lib/cn'
import { api } from '../../lib/api'
import { StudentCourseGate } from './StudentCourseGate'
import { StudentPasswordChangeGate } from './StudentPasswordChangeGate'
import { StudentPrivacyGate, notePublishedLegalVersion } from './StudentPrivacyGate'
import { useBranding } from '../../context/BrandingProvider'
import { LumenShell } from '../../components/layout/LumenShell'
import { StudentExamAvailability } from './StudentExamAvailability'
import { NotificationBell } from '../../components/ui/NotificationBell'
import { useStudentHeartbeat } from './useStudentHeartbeat'
import { PageLoading } from '../../components/ui/PageLoading'
import { AppErrorBoundary, STUDENT_ERROR_DESCRIPTION } from '../../components/ui/ErrorScreen'
import { navBadgeLabel, setMessageCount, studentMessageCount, useMessageCount, useMessageCountScope } from '../../lib/messageCounter'
import { PREVIEW_DISABLED_TEXT } from '../../lib/previewSession'
import { PreviewBanner } from './PreviewBanner'
const NAV = [
  { to: '/aluno', icon: Home, text: 'Início', end: true },
  { to: '/aluno/modulos', icon: BookOpen, text: 'Módulos' },
  { to: '/aluno/biblioteca', icon: FolderOpen, text: 'Biblioteca' },
  { to: '/aluno/provas', icon: ClipboardList, text: 'Provas' },
  // Atividades com prazo e envio de arquivo (fase 3, C9 / P1-g; FUN-01).
  { to: '/aluno/atividades', icon: FileUp, text: 'Atividades' },
  { to: '/aluno/caderno', icon: NotebookPen, text: 'Caderno' },
  { to: '/aluno/duvidas', icon: MessagesSquare, text: 'Dúvidas' },
  // Conversa particular com os professores (fase 3, C14 / P5-S7b; FUN-14). O número é o
  // de conversas com mensagem nova, lido do sino (lib/messageCounter.js).
  { to: '/aluno/mensagens', icon: Mail, text: 'Mensagens' },
  { to: '/aluno/avisos', icon: Megaphone, text: 'Avisos' },
  { to: '/aluno/calendario', icon: CalendarDays, text: 'Calendário' },
  { to: '/aluno/conta', icon: UserRound, text: 'Minha conta' },
  { to: '/aluno/meus-dados', icon: ShieldCheck, text: 'Meus dados' },
  // Ajuda do aluno (fase 3, A1, OPS-13): a página pública /ajuda/aluno, a mesma do
  // "Problemas para entrar?" do login. Fica por último (os quatro primeiros itens vão para
  // a barra de baixo do visual Lumen).
  { to: '/ajuda/aluno', icon: CircleHelp, text: 'Ajuda' },
]
// A tela da prova chega sob demanda (lib/lazyPage.js). Dois segundos depois de o portal
// abrir, o navegador já busca o arquivo dela, uma vez: quando o professor libera a
// prova, a turma inteira não baixa o mesmo arquivo no mesmo instante, e quem perder a
// rede no caminho já tem a prova no aparelho. Falha aqui não importa (a rota tenta de
// novo ao abrir a prova).
export const EXAM_PREFETCH_DELAY_MS = 2000
let examScreenPrefetched = false
export function prefetchExamScreen() {
  if (examScreenPrefetched) return
  examScreenPrefetched = true
  import('./exam/ExamRunner').catch(() => { examScreenPrefetched = false })
  import('./StudentExamShell').catch(() => { examScreenPrefetched = false })
}
// Na pré-visualização a prova não abre (C15 / P5-S6b): o arquivo dela não é buscado.
function usePrefetchExamScreen(enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined
    const timer = setTimeout(prefetchExamScreen, EXAM_PREFETCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [enabled])
}

export function StudentShell() {
  const [open, setOpen] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches)
  const { auth, logout, setActiveClass, endPreview } = useAuth()
  // Pré-visualização como aluno (C15 / P5-S6b, D21 do P5): faixa no topo, sem presença,
  // sem pré-carregar a prova, sem "Marcar como lidas" e sem marcar aviso como lido; o Sair
  // do portal fecha a prévia e volta para a tela do painel de onde ela saiu.
  const preview = usePreview()
  const { branding, interfacePreset } = useBranding()
  const { pathname } = useLocation()
  const nav = useNavigate()
  // No celular o menu cobre a página: fecha ao escolher um destino (igual ao painel do
  // professor); antes a página nova ficava atrás dele até tocar no fundo escurecido.
  useEffect(() => {
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches) setOpen(false)
  }, [pathname])
  const s = auth.student || {}
  const classes = s.classes || []
  const activeClass = auth.activeClass || classes[0] || {}
  const cls = activeClass.name || s.studentClass || ''
  const course = (s.courses || []).find((c) => c.id === activeClass.courseId) || null
  const logo = branding?.logoLightUrl || branding?.logoDarkUrl || ''
  const brandName = branding?.displayName || 'IClass'
  // Título da página: o item do menu do endereço ou do começo dele (/aluno/atividades/<id>
  // continua "Atividades").
  const pageTitle = (NAV.find((item) => item.to === pathname) || NAV.find((item) => !item.end && pathname.startsWith(`${item.to}/`)))?.text || 'Portal do Aluno'
  const notificationsContext = cls && activeClass.courseId ? `courseId=${encodeURIComponent(activeClass.courseId)}&studentClass=${encodeURIComponent(cls)}` : ''
  const notificationsEndpoint = notificationsContext ? `/api/student/notifications?${notificationsContext}` : null
  // "Marcar como lidas" vale só para o sino desta turma/curso (aluno em duas turmas).
  const notificationsSeenEndpoint = notificationsContext ? `/api/student/notifications/seen?${notificationsContext}` : '/api/student/notifications/seen'
  // Abrir um aviso pelo sino já conta como lido (UXA-X3).
  const openNotification = async (item) => {
    let markedRead = false
    if (!preview && item.type === 'aviso' && String(item.id || '').startsWith('aviso:')) {
      try { await api.post('/api/student/announcements/read', { id: item.id.slice('aviso:'.length) }); markedRead = true } catch { /* segue para a tela */ }
    }
    if (item.href) nav(item.href)
    return markedRead
  }
  // Com a troca de senha pedida (H5a), o servidor recusa o sino e a faixa da prova (403):
  // nenhum dos dois consulta até a senha nova.
  const passwordChangePending = auth.mustChangePassword === true
  // O sino traz a versão publicada dos documentos: outra versão derruba a guarda do portão
  // de primeiro acesso (StudentPrivacyGate).
  const studentEmail = auth.email || s.email || ''
  const onPresence = (data) => notePublishedLegalVersion(studentEmail, data?.legalVersion)
  const onNotifications = (data) => {
    onPresence(data)
    setMessageCount(studentMessageCount(data))
  }
  useMessageCountScope(`${studentEmail}::${notificationsContext}`)
  const newMessages = useMessageCount()
  const navItems = NAV.map((item) => (item.to === '/aluno/mensagens' ? { ...item, badge: newMessages, badgeTone: 'primary' } : item))
  const notifications = <NotificationBell endpoint={passwordChangePending ? null : notificationsEndpoint} seenEndpoint={preview ? null : notificationsSeenEndpoint} seenDisabledText={preview ? PREVIEW_DISABLED_TEXT : ''} onOpenItem={openNotification} onData={onNotifications} />
  const examAvailability = passwordChangePending ? null : <StudentExamAvailability />
  useStudentHeartbeat({ onPresence, enabled: !preview })
  usePrefetchExamScreen(!preview)
  const leavePortal = () => {
    if (preview) { nav(endPreview() || '/'); return }
    logout(); nav('/login')
  }

  if (interfacePreset === 'lumen') {
    const studentName = ((s.nomeSocial && s.nomeSocial.trim()) || s.name) || auth.email || 'Aluno'
    const contextLabel = course?.name || activeClass.courseId || cls || ''
    return (
      <>
        <LumenShell
          navGroups={[{ label: 'Sua jornada', items: navItems }]}
          brandName={brandName}
          logo={logo}
          conceptLabel="Portal do Aluno"
          userName={studentName}
          userDetail={contextLabel}
          pathname={pathname}
          contextAction={classes.length > 1 ? {
            icon: BookOpen,
            label: contextLabel || 'Trocar curso',
            title: 'Trocar curso ou turma',
            onClick: () => { setActiveClass(null); nav('/aluno') },
          } : null}
          onLogout={leavePortal}
          logoutLabel={preview ? 'Sair da pré-visualização' : undefined}
          notifications={notifications}
          banner={preview ? <PreviewBanner className="mb-3 shrink-0 rounded-xl border" /> : null}
        >
          <div key={pathname} className="app-enter" style={{ paddingBottom: 'var(--exam-banner-space, 0px)' }}><AppErrorBoundary area="aluno" description={STUDENT_ERROR_DESCRIPTION}><Suspense fallback={<PageLoading />}><StudentPasswordChangeGate><StudentPrivacyGate><StudentCourseGate><Outlet /></StudentCourseGate></StudentPrivacyGate></StudentPasswordChangeGate></Suspense></AppErrorBoundary></div>
        </LumenShell>
        {examAvailability}
      </>
    )
  }

  // No celular a gaveta do menu (e o fundo escuro) fica acima da faixa "Prova disponível"
  // (z-[70]): antes a faixa cobria o rodapé da gaveta e o toque em Sair caía nela. No
  // desktop a gaveta é estática e a faixa fica à direita, fora dela.
  return (
    <div className="app-canvas h-full flex text-text">
      <aside aria-hidden={!open ? 'true' : undefined} inert={!open ? '' : undefined} className={cn('fixed inset-y-0 left-0 z-[80] flex w-[272px] flex-col overflow-hidden border-r border-border bg-[var(--sidebar)] backdrop-blur-2xl transition-transform duration-300 md:static md:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
        <div className="flex h-[72px] items-center gap-3 border-b border-border px-5">
          {logo ? <img src={logo} alt={brandName} className="h-9 max-w-[165px] object-contain" /> : <>
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-fg shadow-[0_10px_28px_var(--primary-glow)]"><GraduationCap size={20} /></span>
          <div><span className="block font-semibold tracking-[-0.025em]">{brandName}</span><span className="block text-[10px] font-medium uppercase tracking-[.16em] text-subtle">Área do aluno</span></div></>}
        </div>
        <div className="glass-panel mx-3 my-5 flex items-center gap-3 rounded-xl p-3.5">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-primary to-primary-hover text-sm font-semibold text-primary-fg shadow-[0_8px_22px_var(--primary-glow)]">{(((s.nomeSocial && s.nomeSocial.trim()) || s.name) || auth.email || 'A')[0]?.toUpperCase()}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{((s.nomeSocial && s.nomeSocial.trim()) || s.name) || auth.email}</p>
            <p className="mt-0.5 truncate text-[11px] text-subtle">{course?.name || activeClass.courseId || cls || 'Selecione um curso'}</p>
          </div>
        </div>
        {classes.length > 1 && (
          <div className="mx-3 mb-3">
            <button
              type="button"
              onClick={() => { setActiveClass(null); nav('/aluno') }}
              className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-left text-xs text-muted transition-all duration-300 hover:bg-surface-2 hover:text-text"
            >
              Trocar curso/turma
            </button>
          </div>
        )}
        <nav className="flex-1 overflow-y-auto px-3">
          <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[.18em] text-subtle">Sua jornada</p>
          {navItems.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => cn('group mb-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] transition-all duration-300',
                isActive ? 'bg-primary-soft font-semibold text-text shadow-[inset_0_0_0_1px_var(--primary-soft)]' : 'text-muted hover:bg-surface-2 hover:text-text')}>
              {({ isActive }) => <><span className={cn('grid h-7 w-7 place-items-center rounded-lg transition-colors', isActive ? 'bg-primary text-primary-fg' : 'text-subtle group-hover:text-text')}><n.icon size={16} /></span>{n.text}{n.badge > 0 ? <><span aria-hidden="true" className="ml-auto rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-fg">{n.badge > 99 ? '99+' : n.badge}</span><span className="sr-only">{`, ${navBadgeLabel(n)}`}</span></> : isActive && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}</>}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center justify-between border-t border-border p-3">
          <button onClick={leavePortal} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted transition-all duration-300 hover:bg-danger-soft hover:text-danger"><LogOut size={16} /> {preview ? 'Sair da pré-visualização' : 'Sair'}</button>
          <ThemeToggle />
        </div>
      </aside>
      {open && <button type="button" aria-label="Fechar menu" className="fixed inset-0 z-[75] bg-black/55 backdrop-blur-sm md:hidden" onClick={() => setOpen(false)} />}
      <div className="flex-1 flex flex-col min-w-0">
        {preview && <PreviewBanner />}
        <header className="glass-panel z-20 flex h-[72px] items-center gap-2 border-x-0 border-t-0 px-4 md:px-7">
          <button onClick={() => setOpen((o) => !o)} className="grid h-10 w-10 place-items-center rounded-lg text-muted hover:bg-surface-2 md:hidden" aria-label="Menu"><Menu size={21} /></button>
          <div className="flex items-center gap-2 text-[13px]"><Sparkles size={14} className="text-primary" /><span className="text-subtle">Portal do Aluno</span><span className="text-subtle">/</span><strong className="font-semibold text-text">{pageTitle}</strong></div>
          <div className="flex-1" />
          {notifications}
        </header>
        <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8 xl:px-10">
          <div key={pathname} className="app-enter" style={{ paddingBottom: 'var(--exam-banner-space, 0px)' }}><AppErrorBoundary area="aluno" description={STUDENT_ERROR_DESCRIPTION}><Suspense fallback={<PageLoading />}><StudentPasswordChangeGate><StudentPrivacyGate><StudentCourseGate><Outlet /></StudentCourseGate></StudentPrivacyGate></StudentPasswordChangeGate></Suspense></AppErrorBoundary></div>
        </main>
      </div>
      {examAvailability}
    </div>
  )
}
