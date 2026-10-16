// Cópia local das respostas da prova (sessionStorage, uma por aplicação). Serve para
// restaurar o que ainda não chegou ao servidor quando a página é recarregada ou a
// rede cai. É apagada no envio da prova e no logout. Toda leitura/escrita tolera
// armazenamento indisponível (aba privada, cota cheia): a prova funciona sem ela.
const PREFIX = 'iclass-exam-draft:'

function storage() {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { return null }
}

export function examDraftKey({ email, applicationId, examKey }) {
  return `${PREFIX}${String(email || '').trim().toLowerCase()}:${applicationId || examKey || ''}`
}

export function readExamDraft(key) {
  const store = storage()
  if (!store || !key) return null
  try {
    const draft = JSON.parse(store.getItem(key) || 'null')
    if (!draft || typeof draft !== 'object' || !draft.answers || typeof draft.answers !== 'object') return null
    return draft
  } catch { return null }
}

// saved: true quando o servidor já confirmou estas respostas.
export function writeExamDraft(key, { attemptId, answers, saved = false }) {
  const store = storage()
  if (!store || !key || !attemptId) return
  try {
    store.setItem(key, JSON.stringify({ attemptId, answers: answers || {}, saved: saved === true, updatedAt: Date.now() }))
  } catch { /* armazenamento cheio ou bloqueado: segue sem a cópia local */ }
}

export function clearExamDraft(key) {
  const store = storage()
  if (!store || !key) return
  try { store.removeItem(key) } catch { /* ignora */ }
}

// Logout: nenhuma resposta fica para o próximo usuário do computador.
export function clearAllExamDrafts() {
  const store = storage()
  if (!store) return
  try {
    const keys = []
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index)
      if (key && key.startsWith(PREFIX)) keys.push(key)
    }
    keys.forEach((key) => store.removeItem(key))
  } catch { /* ignora */ }
}

// Mesmas respostas? (as chaves são números de questão; a ordem não importa)
export function sameExamAnswers(a, b) {
  const left = a || {}
  const right = b || {}
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if ((left[key] ?? null) !== (right[key] ?? null)) return false
  }
  return true
}
