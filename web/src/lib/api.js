// Cliente único de API do IClass V3.
// Repository pattern: nenhuma tela usa fetch cru — tudo passa por aqui.
// As REGRAS DE NEGÓCIO permanecem no backend Express (server-authoritative).
let authProvider = () => ({})
export function setAuthProvider(fn) { authProvider = fn } // injetado pelo AuthProvider
// Há sessão aberta neste navegador? O logout limpa o provedor na hora (antes de o portal
// trocar de rota), então logo depois dele a resposta já é não. A prova online usa isto
// para deixar a ida ao login passar sem confirmação só quando a sessão acabou de fato.
export function hasActiveSession() {
  const current = authProvider() || {}
  return !!(current.sessionToken || current.adminSession || current.adminAuth)
}
const AUTH_STORAGE_KEY = 'iclass-v3-auth'

function getStoredAuth() {
  if (typeof localStorage === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)) || {} } catch { return {} }
}

// keepalive: a requisição sobrevive ao fechamento/recarga da página (pagehide).
// Diferente do sendBeacon, leva os cabeçalhos de sessão.
async function request(path, { method = 'GET', body, auth = true, raw, keepalive = false } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (auth) {
    const providedAuth = authProvider() || {}
    const a = (providedAuth.adminSession || providedAuth.adminAuth || providedAuth.sessionToken) ? providedAuth : getStoredAuth()
    // Instrutor: preferir TOKEN de sessão (não expõe senha). Fallback legado: "email:senha".
    if (a.adminSession) headers['x-admin-session'] = a.adminSession
    else if (a.adminAuth) headers['Authorization'] = a.adminAuth
    if (a.sessionToken) headers['x-session-token'] = a.sessionToken       // aluno
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    ...(keepalive ? { keepalive: true } : {}),
  })
  let data = null
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) data = await res.json().catch(() => null)
  else if (raw) data = await res.text()
  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || `Erro ${res.status}`)
    err.status = res.status; err.data = data
    throw err
  }
  return data
}
export const api = {
  get: (p, opts) => request(p, { ...opts }),
  post: (p, body, opts) => request(p, { method: 'POST', body, ...opts }),
  put: (p, body, opts) => request(p, { method: 'PUT', body, ...opts }),
  delete: (p, opts) => request(p, { method: 'DELETE', ...opts }),
}
