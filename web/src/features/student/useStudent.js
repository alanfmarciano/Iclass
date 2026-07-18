import { useAuth } from '../../context/AuthProvider'
// Extrai email, turma e curso do aluno autenticado (usados nas queries da API).
export function useStudent() {
  const { auth } = useAuth()
  const s = auth.student || {}
  const active = auth.activeClass || (s.classes && s.classes[0]) || {}
  return {
    email: auth.email,
    name: s.name,
    displayName: (s.nomeSocial && s.nomeSocial.trim()) || s.name,
    studentClass: active.name || s.studentClass || '',
    courseId: active.courseId || (s.courses && s.courses[0]?.id) || '',
    period: active.period || s.period || '',
    classes: s.classes || [],
    courses: s.courses || [],
  }
}
