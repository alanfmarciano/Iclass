export function isStudentExamPath(pathname = '') {
  return /^\/aluno\/prova\/[^/]+\/?$/.test(String(pathname))
}

// Aba da prova aberta neste navegador (P3-S13): a aba da prova anota no localStorage, a
// cada conferência da sessão (60 s), que continua aberta. Outra aba do portal parada não
// encerra a sessão por inatividade enquanto essa marca é recente: o "Sair" automático
// revogava o token da prova, o aluno tinha de entrar de novo e a prova travava como
// "Saiu da conta e entrou de novo".
export const EXAM_TAB_ALIVE_KEY = 'iclass-exam-tab-alive'
export const EXAM_TAB_ALIVE_MS = 3 * 60 * 1000

export function markExamTabAlive(storage, now = Date.now()) {
  try { storage?.setItem(EXAM_TAB_ALIVE_KEY, String(now)) } catch {}
}

export function clearExamTabAlive(storage) {
  try { storage?.removeItem(EXAM_TAB_ALIVE_KEY) } catch {}
}

export function examTabAliveElsewhere(storage, now = Date.now()) {
  try {
    const at = Number(storage?.getItem(EXAM_TAB_ALIVE_KEY))
    return Number.isFinite(at) && at > 0 && now - at >= 0 && now - at < EXAM_TAB_ALIVE_MS
  } catch { return false }
}

export function shouldExpireForIdle({ role, pathname, idleForMs, idleLimitMs, examOpenElsewhere = false }) {
  if (role === 'student' && isStudentExamPath(pathname)) return false
  if (role === 'student' && examOpenElsewhere === true) return false
  return Number(idleForMs) > Number(idleLimitMs)
}
