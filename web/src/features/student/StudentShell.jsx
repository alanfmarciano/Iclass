import { useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Home, BookOpen, ClipboardList, NotebookPen, MessagesSquare, Megaphone, FolderOpen, GraduationCap, Menu, LogOut, CalendarDays, Sparkles } from 'lucide-react'
import { ThemeToggle } from '../../components/ui/ThemeToggle'
import { useAuth } from '../../context/AuthProvider'
import { cn } from '../../lib/cn'
import { api } from '../../lib/api'
import { StudentCourseGate } from './StudentCourseGate'
import { useBranding } from '../../context/BrandingProvider'
import { LumenShell } from '../../components/layout/LumenShell'
import { StudentExamAvailability } from './StudentExamAvailability'
import { NotificationBell } from '../../components/ui/NotificationBell'
import { useStudentHeartbeat } from './useStudentHeartbeat'
const NAV = [
  { to: '/aluno', icon: Home, text: 'Início', end: true },
  { to: '/aluno/modulos', icon: BookOpen, text: 'Módulos' },
  { to: '/aluno/biblioteca', icon: FolderOpen, text: 'Biblioteca' },
  { to: '/aluno/provas', icon: ClipboardList, text: 'Provas' },
  { to: '/aluno/caderno', icon: NotebookPen, text: 'Caderno' },
  { to: '/aluno/duvidas', icon: MessagesSquare, text: 'Dúvidas' },
  { to: '/aluno/avisos', icon: Megaphone, text: 'Avisos' },
  { to: '/aluno/calendario', icon: CalendarDays, text: 'Calendário' },
]
export function StudentShell() {
  const [open, setOpen] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches)
  const { auth, logout, setActiveClass } = useAuth()
  const { branding, interfacePreset } = useBranding()
  const { pathname } = useLocation()
  const nav = useNavigate()
  const s = auth.student || {}
  const classes = s.classes || []
  const activeClass = auth.activeClass || classes[0] || {}
  const cls = activeClass.name || s.studentClass || ''
  const course = (s.courses || []).find((c) => c.id === activeClass.courseId) || null
  const logo = branding?.logoLightUrl || branding?.logoDarkUrl || ''
  const brandName = branding?.displayName || 'IClass'
  const pageTitle = NAV.find((item) => item.to === pathname)?.text || 'Portal do Aluno'
  const notificationsEndpoint = cls && activeClass.courseId ? `/api/student/notifications?courseId=${encodeURIComponent(activeClass.courseId)}&studentClass=${encodeURIComponent(cls)}` : null
  // Abrir um aviso pelo sino já conta como lido (UXA-X3).
  const openNotification = async (item) => {
    let markedRead = false
    if (item.type === 'aviso' && String(item.id || '').startsWith('aviso:')) {
      try { await api.post('/api/student/announcements/read', { id: item.id.slice('aviso:'.length) }); markedRead = true } catch { /* segue para a tela */ }
    }
    if (item.href) nav(item.href)
    return markedRead
  }
  const notifications = <NotificationBell endpoint={notificationsEndpoint} seenEndpoint="/api/student/notifications/seen" onOpenItem={openNotification} />
  useStudentHeartbeat()

  if (interfacePreset === 'lumen') {
    const studentName = ((s.nomeSocial && s.nomeSocial.trim()) || s.name) || auth.email || 'Aluno'
    const contextLabel = course?.name || activeClass.courseId || cls || ''
    return (
      <>
        <LumenShell
          navGroups={[{ label: 'Sua jornada', items: NAV }]}
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
          onLogout={() => { logout(); nav('/login') }}
          notifications={notifications}
        >
          <div key={pathname} className="app-enter" style={{ paddingBottom: 'var(--exam-banner-space, 0px)' }}><StudentCourseGate><Outlet /></StudentCourseGate></div>
        </LumenShell>
        <StudentExamAvailability />
      </>
    )
  }

  return (
    <div className="app-canvas h-full flex text-text">
      <aside aria-hidden={!open ? 'true' : undefined} inert={!open ? '' : undefined} className={cn('fixed inset-y-0 left-0 z-40 flex w-[272px] flex-col overflow-hidden border-r border-border bg-[var(--sidebar)] backdrop-blur-2xl transition-transform duration-300 md:static md:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
        <div className="flex h-[72px] items-center gap-3 border-b border-border px-5">
          {logo ? <img src={logo} alt={brandName} className="h-9 max-w-[165px] object-contain" /> : <>
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-fg shadow-[0_10px_28px_var(--primary-glow)]"><GraduationCap size={20} /></span>
          <div><span className="block font-semibold tracking-[-0.025em]">{brandName}</span><span className="block text-[10px] font-medium uppercase tracking-[.16em] text-subtle">Student space</span></div></>}
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
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => cn('group mb-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] transition-all duration-300',
                isActive ? 'bg-primary-soft font-semibold text-text shadow-[inset_0_0_0_1px_var(--primary-soft)]' : 'text-muted hover:bg-surface-2 hover:text-text')}>
              {({ isActive }) => <><span className={cn('grid h-7 w-7 place-items-center rounded-lg transition-colors', isActive ? 'bg-primary text-primary-fg' : 'text-subtle group-hover:text-text')}><n.icon size={16} /></span>{n.text}{isActive && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}</>}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center justify-between border-t border-border p-3">
          <button onClick={() => { logout(); nav('/login') }} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted transition-all duration-300 hover:bg-danger-soft hover:text-danger"><LogOut size={16} /> Sair</button>
          <ThemeToggle />
        </div>
      </aside>
      {open && <button type="button" aria-label="Fechar menu" className="fixed inset-0 z-30 bg-black/55 backdrop-blur-sm md:hidden" onClick={() => setOpen(false)} />}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="glass-panel z-20 flex h-[72px] items-center gap-2 border-x-0 border-t-0 px-4 md:px-7">
          <button onClick={() => setOpen((o) => !o)} className="grid h-10 w-10 place-items-center rounded-lg text-muted hover:bg-surface-2 md:hidden" aria-label="Menu"><Menu size={21} /></button>
          <div className="flex items-center gap-2 text-[13px]"><Sparkles size={14} className="text-primary" /><span className="text-subtle">Portal do Aluno</span><span className="text-subtle">/</span><strong className="font-semibold text-text">{pageTitle}</strong></div>
          <div className="flex-1" />
          {notifications}
        </header>
        <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8 xl:px-10">
          <div key={pathname} className="app-enter" style={{ paddingBottom: 'var(--exam-banner-space, 0px)' }}><StudentCourseGate><Outlet /></StudentCourseGate></div>
        </main>
      </div>
      <StudentExamAvailability />
    </div>
  )
}
