import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { BookOpen } from 'lucide-react'
import { useAuth } from '../../context/AuthProvider'
import { useBranding } from '../../context/BrandingProvider'
import { AdminCourseGate } from '../../features/admin/AdminCourseGate'
import { getAdminNavGroups } from './Sidebar'
import { LumenShell } from './LumenShell'
import { NotificationBell } from '../ui/NotificationBell'
import { useAdminNotificationOpener } from './useAdminNotificationOpener'
import { useApi } from '../../hooks/useApi'

export function LumenAdminShell() {
  const { auth, logout, clearActiveWorkspace } = useAuth()
  const { branding } = useBranding()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const logo = branding?.logoLightUrl || branding?.logoDarkUrl || ''
  const brandName = branding?.displayName || 'IClass'
  const workspace = auth.activeWorkspace
  const courseLabel = workspace ? `${workspace.courseName || workspace.courseId} · ${workspace.className}` : ''
  const accountLabel = auth.accountRole === 'professor' ? 'Professor' : 'Administrador'
  const enrollmentPath = workspace?.courseId && auth.accountRole !== 'professor' ? `/api/admin/enrollment-requests?courseId=${encodeURIComponent(workspace.courseId)}&studentClass=${encodeURIComponent(workspace.className)}` : null
  const enrollments = useApi(enrollmentPath, [workspace?.courseId, workspace?.className], { pollMs: 15000 })
  const openNotification = useAdminNotificationOpener()

  return (
    <LumenShell
      navGroups={getAdminNavGroups(auth, enrollments.data?.pendingCount || 0)}
      brandName={brandName}
      logo={logo}
      conceptLabel={courseLabel || 'Ambiente da instituição'}
      userName={auth.email || accountLabel}
      userDetail={accountLabel}
      pathname={pathname}
      contextAction={courseLabel ? {
        icon: BookOpen,
        label: courseLabel,
        title: 'Trocar curso ou turma',
        onClick: clearActiveWorkspace,
      } : null}
      onLogout={() => { logout(); navigate('/login') }}
      notifications={<NotificationBell buttonClassName="lumen-icon-button relative" endpoint={workspace ? `/api/admin/notifications?courseId=${encodeURIComponent(workspace.courseId)}&studentClass=${encodeURIComponent(workspace.className)}` : '/api/admin/notifications'} seenEndpoint="/api/admin/notifications/seen" onOpenItem={openNotification} />}
    >
      <div key={pathname} className="app-enter"><AdminCourseGate><Outlet /></AdminCourseGate></div>
    </LumenShell>
  )
}
