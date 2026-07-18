import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { BookOpen } from 'lucide-react'
import { useAuth } from '../../context/AuthProvider'
import { useBranding } from '../../context/BrandingProvider'
import { AdminCourseGate } from '../../features/admin/AdminCourseGate'
import { getAdminNavGroups } from './Sidebar'
import { LumenShell } from './LumenShell'
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
    >
      <div key={pathname} className="app-enter"><AdminCourseGate><Outlet /></AdminCourseGate></div>
    </LumenShell>
  )
}
