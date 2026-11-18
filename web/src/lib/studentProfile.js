// Perfil do aluno guardado no navegador (H5b; SEG-10, SEG-16).
//
// O login do aluno devolvia o cadastro inteiro (responsável, telefones, acessibilidade...)
// e o portal guardava tudo em localStorage ('iclass-v3-auth'). O servidor agora manda só
// estes campos (backend/utils/studentProfile.js, mesma lista); aqui o portal reduz também
// o que já estava guardado de uma versão anterior, ao abrir. A matrícula fica fora: Minha
// conta a lê na hora (GET /api/student/account).
export const STUDENT_SESSION_PROFILE_FIELDS = Object.freeze([
  'email',
  'name',
  'nomeSocial',
  'status',
  'studentClass',
  'period',
  'classes',
  'courses',
  'courseId',
  'currentCourseId',
  'enrollmentRequests',
  'mustChangePassword',
  'passwordChangeReason',
])

export function studentSessionProfile(student) {
  const profile = {}
  if (!student || typeof student !== 'object') return profile
  for (const field of STUDENT_SESSION_PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(student, field) && student[field] !== undefined) profile[field] = student[field]
  }
  return profile
}

// Sessão guardada com o perfil reduzido (só a do aluno muda). Devolve o mesmo objeto
// quando não há nada a tirar, para não regravar à toa.
export function reduceStoredStudentAuth(auth) {
  if (!auth || auth.role !== 'student' || !auth.student || typeof auth.student !== 'object') return auth
  const extra = Object.keys(auth.student).some((key) => !STUDENT_SESSION_PROFILE_FIELDS.includes(key))
  if (!extra) return auth
  return { ...auth, student: studentSessionProfile(auth.student) }
}
