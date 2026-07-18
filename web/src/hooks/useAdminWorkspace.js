import { useAuth } from '../context/AuthProvider'

export function useAdminWorkspace() {
  const { auth, setActiveWorkspace, clearActiveWorkspace } = useAuth()
  const workspace = auth.activeWorkspace || null
  return {
    workspace,
    courseId: workspace?.courseId || '',
    courseName: workspace?.courseName || '',
    schoolId: workspace?.schoolId || '',
    className: workspace?.className || '',
    period: workspace?.period || '',
    setActiveWorkspace,
    clearActiveWorkspace,
  }
}
