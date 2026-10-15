import { BookOpen, ChevronRight, LogOut, Menu } from 'lucide-react'
import { ThemeToggle } from '../ui/ThemeToggle'
import { Badge } from '../ui/Badge'
import { useAuth } from '../../context/AuthProvider'
import { NotificationBell } from '../ui/NotificationBell'

function initials(s = '') {
  return s.split(/[ @.]/).filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase()).join('')
}

export function Topbar({ onMenu, breadcrumb }) {
  const { auth, logout, clearActiveWorkspace } = useAuth()
  const workspace = auth.activeWorkspace
  const courseLabel = workspace ? `${workspace.courseName || workspace.courseId} · ${workspace.className}` : ''

  return (
    <header className="glass-panel z-20 flex h-[72px] shrink-0 items-center gap-2 border-x-0 border-t-0 px-4 md:px-7">
      <button onClick={onMenu} className="grid h-10 w-10 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-text md:hidden" aria-label="Menu"><Menu size={21} /></button>
      <nav aria-label="Trilha" className="hidden items-center gap-1.5 text-[13px] text-muted sm:flex">
        {breadcrumb.map((b, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className={i === breadcrumb.length - 1 ? 'font-semibold text-text' : ''}>{b}</span>
            {i < breadcrumb.length - 1 && <ChevronRight size={13} className="text-subtle" />}
          </span>
        ))}
      </nav>
      <div className="flex-1" />
      {auth.role === 'admin' && courseLabel && (
        <button
          onClick={clearActiveWorkspace}
          className="hidden h-10 items-center gap-2 rounded-xl border border-primary/20 bg-primary-soft px-3 text-[13px] font-semibold text-primary transition-all duration-300 hover:border-primary/40 hover:bg-primary-soft sm:flex"
          title="Trocar curso ou turma"
        >
          <BookOpen size={15} />
          <span className="max-w-[180px] truncate">{courseLabel}</span>
        </button>
      )}
      <NotificationBell
        endpoint={workspace ? `/api/admin/notifications?courseId=${encodeURIComponent(workspace.courseId)}&studentClass=${encodeURIComponent(workspace.className)}` : '/api/admin/notifications'}
        seenEndpoint="/api/admin/notifications/seen"
      />
      <ThemeToggle />
      <Badge className="hidden lg:inline-flex" tone={auth.accountRole === 'professor' ? 'info' : 'neutral'}>
        {auth.accountRole === 'professor' ? 'Professor' : 'Administrador'}
      </Badge>
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-primary to-primary-hover text-sm font-semibold text-primary-fg shadow-[0_8px_22px_var(--primary-glow)]" title={auth.email}>{initials(auth.email || 'AM')}</div>
      <button onClick={logout} className="grid h-10 w-10 place-items-center rounded-lg text-muted transition-all duration-300 hover:bg-danger-soft hover:text-danger" aria-label="Sair"><LogOut size={17} /></button>
    </header>
  )
}
