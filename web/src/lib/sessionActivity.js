export function isStudentExamPath(pathname = '') {
  return /^\/aluno\/prova\/[^/]+\/?$/.test(String(pathname))
}

export function shouldExpireForIdle({ role, pathname, idleForMs, idleLimitMs }) {
  if (role === 'student' && isStudentExamPath(pathname)) return false
  return Number(idleForMs) > Number(idleLimitMs)
}
