import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthProvider'

// Abre um item do sino do instrutor (UXI-X2). A pendência é de um curso + turma:
// se a turma ativa for outra (ou nenhuma, no modo instituição), troca o workspace
// antes de navegar, para o link cair na tela certa e não no seletor de curso.
export function useAdminNotificationOpener() {
  const { auth, setActiveWorkspace } = useAuth()
  const navigate = useNavigate()
  const workspace = auth.activeWorkspace
  return useCallback(async (item) => {
    if (item.courseId && item.studentClass
      && (!workspace || workspace.courseId !== item.courseId || workspace.className !== item.studentClass)) {
      setActiveWorkspace({
        courseId: item.courseId,
        courseName: item.courseName || item.courseId,
        schoolId: item.schoolId || '',
        className: item.studentClass,
        period: item.period || '',
      })
    }
    if (item.href) navigate(item.href)
    return false
  }, [workspace, setActiveWorkspace, navigate])
}
