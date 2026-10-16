// Cliente único de API do IClass V3.
// Repository pattern: nenhuma tela usa fetch cru — tudo passa por aqui.
// As REGRAS DE NEGÓCIO permanecem no backend Express (server-authoritative).
let authProvider = () => ({})
export function setAuthProvider(fn) { authProvider = fn } // injetado pelo AuthProvider
const AUTH_STORAGE_KEY = 'iclass-v3-auth'

function getStoredAuth() {
  if (typeof localStorage === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)) || {} } catch { return {} }
}

function authHeaders() {
  const headers = {}
  const providedAuth = authProvider() || {}
  const a = (providedAuth.adminSession || providedAuth.adminAuth || providedAuth.sessionToken) ? providedAuth : getStoredAuth()
  // Instrutor: preferir TOKEN de sessão (não expõe senha). Fallback legado: "email:senha".
  if (a.adminSession) headers['x-admin-session'] = a.adminSession
  else if (a.adminAuth) headers['Authorization'] = a.adminAuth
  if (a.sessionToken) headers['x-session-token'] = a.sessionToken       // aluno
  return headers
}

async function request(path, { method = 'GET', body, auth = true, raw } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(auth ? authHeaders() : {}) }
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
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
// Baixa um arquivo de rota autenticada (CSV, etc.). window.open não manda o
// cabeçalho de sessão e abria "Acesso não autorizado." (UXI-01). O Blob preserva
// os bytes (inclusive o BOM UTF-8 que o Excel usa para os acentos).
export async function downloadFile(path, fallbackName = 'arquivo') {
  const res = await fetch(path, { headers: authHeaders() })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    const err = new Error((data && (data.error || data.message)) || `Erro ${res.status}`)
    err.status = res.status
    throw err
  }
  const blob = await res.blob()
  const disposition = res.headers.get('content-disposition') || ''
  const match = disposition.match(/filename="?([^";]+)"?/i)
  const name = match ? match[1] : fallbackName
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return name
}

export const api = {
  get: (p, opts) => request(p, { ...opts }),
  post: (p, body, opts) => request(p, { method: 'POST', body, ...opts }),
  put: (p, body, opts) => request(p, { method: 'PUT', body, ...opts }),
  delete: (p, opts) => request(p, { method: 'DELETE', ...opts }),
}
