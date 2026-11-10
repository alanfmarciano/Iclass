import { NavLink } from 'react-router-dom'
import { LayoutDashboard, MonitorPlay, ClipboardList, BarChart3, Unlock, PenLine, Users, UserCheck, KeyRound, MessagesSquare, Palette, Settings, GraduationCap, Building2, School, LayoutGrid, ClipboardCheck, Megaphone, FolderOpen, CalendarDays, Sparkles } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useAuth } from '../../context/AuthProvider'
import { canAccessAdminPath } from '../../lib/adminPermissions'
import { useBranding } from '../../context/BrandingProvider'
import { useApi } from '../../hooks/useApi'

const COURSE_GROUPS = [
  { label: 'Visão geral', items: [
    { to: '/', icon: LayoutDashboard, text: 'Dashboard', end: true },
    { to: '/matriculas', icon: UserCheck, text: 'Matrículas', adminOnly: true },
  ] },
  { label: 'Avaliações', items: [
    { to: '/provas', icon: ClipboardList, text: 'Provas' },
    { to: '/monitor', icon: MonitorPlay, text: 'Monitor Online' },
    { to: '/resultados', icon: BarChart3, text: 'Resultados' },
  ] },
  { label: 'Conteúdo', items: [
    { to: '/materiais', icon: Unlock, text: 'Materiais & Liberação' },
    { to: '/editor', icon: PenLine, text: 'Editor de Conteúdo' },
    { to: '/biblioteca', icon: FolderOpen, text: 'Biblioteca' },
  ] },
  { label: 'Gestão', items: [
    { to: '/alunos', icon: Users, text: 'Alunos' },
    { to: '/chamada', icon: ClipboardCheck, text: 'Chamada' },
    { to: '/avisos', icon: Megaphone, text: 'Avisos' },
    { to: '/calendario', icon: CalendarDays, text: 'Calendário' },
    { to: '/forum', icon: MessagesSquare, text: 'Fórum & Dúvidas' },
  ] },
]

const INSTITUTION_GROUPS = [
  { label: 'Gestão acadêmica', items: [
    { to: '/', icon: LayoutGrid, text: 'Acesso Cursos', end: true, always: true },
    { to: '/turmas', icon: School, text: 'Cursos e turmas' },
    { to: '/diretorio', icon: Users, text: 'Alunos' },
  ] },
  { label: 'Instituição', items: [
    { to: '/escolas', icon: Building2, text: 'Escolas' },
    { to: '/identidade', icon: Palette, text: 'Identidade Visual' },
    { to: '/admins', icon: KeyRound, text: 'Administradores' },
    { to: '/sistema', icon: Settings, text: 'Sistema' },
  ] },
]

export function getAdminNavGroups(auth, pendingEnrollments = 0) {
  const baseGroups = auth.activeWorkspace?.courseId && auth.activeWorkspace?.className ? COURSE_GROUPS : INSTITUTION_GROUPS
  return baseGroups
    .map((group) => ({ ...group, items: group.items
      .filter((item) => (!item.adminOnly || auth.accountRole !== 'professor') && (item.always || canAccessAdminPath(auth, item.to)))
      .map((item) => item.to === '/matriculas' ? { ...item, badge: pendingEnrollments } : item) }))
    .filter((group) => group.items.length > 0)
}

export function Sidebar({ open, onNavigate }) {
  const { auth } = useAuth()
  const { branding } = useBranding()
  const logo = branding?.logoLightUrl || branding?.logoDarkUrl || ''
  const brandName = branding?.displayName || 'IClass'
  const inCourse = !!(auth.activeWorkspace?.courseId && auth.activeWorkspace?.className)
  const enrollmentPath = inCourse && auth.accountRole !== 'professor' ? `/api/admin/enrollment-requests?courseId=${encodeURIComponent(auth.activeWorkspace.courseId)}&studentClass=${encodeURIComponent(auth.activeWorkspace.className)}` : null
  const enrollments = useApi(enrollmentPath, [auth.activeWorkspace?.courseId, auth.activeWorkspace?.className], { pollMs: 15000 })
  const visibleGroups = getAdminNavGroups(auth, enrollments.data?.pendingCount || 0)

  return (
    <aside aria-hidden={!open ? 'true' : undefined} inert={!open ? '' : undefined} className={cn('fixed inset-y-0 left-0 z-40 flex w-[272px] shrink-0 flex-col overflow-hidden border-r border-border bg-[var(--sidebar)] backdrop-blur-2xl transition-transform duration-300 md:static md:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
      <div className="flex h-[72px] items-center gap-3 border-b border-border px-5">
        {logo ? <img src={logo} alt={brandName} className="h-9 max-w-[165px] object-contain" /> : (
          <>
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-fg shadow-[0_10px_28px_var(--primary-glow)]"><GraduationCap size={20} /></span>
            <div className="min-w-0"><span className="block truncate font-semibold tracking-[-0.025em] text-text">{brandName}</span><span className="block text-[10px] font-medium uppercase tracking-[.16em] text-subtle">Learning OS</span></div>
          </>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-5">
        {!inCourse && (
          <div className="mx-1 mb-5 flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-xs text-muted"><Sparkles size={14} className="text-primary" /><span>Ambiente da instituição</span></div>
        )}
        {visibleGroups.map((g) => (
          <div key={g.label} className="mb-6">
            <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[.18em] text-subtle">{g.label}</p>
            {g.items.map((it) => (
              <NavLink key={it.to} to={it.to} end={it.end} onClick={onNavigate}
                className={({ isActive }) => cn('group mb-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] transition-all duration-300',
                  isActive ? 'bg-primary-soft font-semibold text-text shadow-[inset_0_0_0_1px_var(--primary-soft)]' : 'text-muted hover:bg-surface-2 hover:text-text')}>
                {({ isActive }) => <><span className={cn('grid h-7 w-7 place-items-center rounded-lg transition-colors', isActive ? 'bg-primary text-primary-fg' : 'text-subtle group-hover:text-text')}><it.icon size={16} /></span><span className="truncate">{it.text}</span>{it.badge > 0 ? <span className="ml-auto rounded-full bg-warning px-2 py-0.5 text-[10px] font-bold text-white">{it.badge}</span> : isActive && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}</>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="border-t border-border px-5 py-4">
        <div className="flex items-center gap-2 text-[11px] text-subtle"><span className="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_10px_var(--success)]" />Sistema ativo <span className="ml-auto">v3</span></div>
      </div>
    </aside>
  )
}
