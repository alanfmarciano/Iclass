// Cliente único de API do IClass V3.
// Repository pattern: nenhuma tela usa fetch cru — tudo passa por aqui.
// As REGRAS DE NEGÓCIO permanecem no backend Express (server-authoritative).
import { BUILD_HEADER, noteServerBuild } from './buildVersion'
import { AUTOSAVE_TIMEOUT_MS, INSTRUCTOR_TIMEOUT_MS, KEYSTROKE_TIMEOUT_MS, POLL_TIMEOUT_MS } from './requestTimeouts'
let authProvider = () => ({})
export function setAuthProvider(fn) { authProvider = fn } // injetado pelo AuthProvider
// Há sessão aberta neste navegador? O logout limpa o provedor na hora (antes de o portal
// trocar de rota), então logo depois dele a resposta já é não. A prova online usa isto
// para deixar a ida ao login passar sem confirmação só quando a sessão acabou de fato.
export function hasActiveSession() {
  const current = authProvider() || {}
  return !!(current.sessionToken || current.adminSession)
}
// Painel do professor recusado neste aparelho (403 com adminAccess, SEG-03): o servidor
// diz que o painel só abre no computador do IClass ou só pela conexão segura. O
// AuthProvider registra aqui o que fazer (encerrar a sessão e mostrar o motivo no login).
let adminAccessDeniedHandler = null
export function setAdminAccessDeniedHandler(fn) { adminAccessDeniedHandler = typeof fn === 'function' ? fn : null }
function noteAdminAccessDenied(status, data) {
  if (status !== 403 || !data || typeof data.adminAccess !== 'string' || !adminAccessDeniedHandler) return
  try { adminAccessDeniedHandler(data) } catch {}
}
// Troca de senha obrigatória (H5a, 403 { passwordChangeRequired: true }): o servidor
// recusa tudo até a senha nova. O AuthProvider registra aqui o que fazer (marcar a
// sessão, e o portal ou o painel mostram o formulário de troca no lugar da página).
let passwordChangeRequiredHandler = null
export function setPasswordChangeRequiredHandler(fn) { passwordChangeRequiredHandler = typeof fn === 'function' ? fn : null }
function notePasswordChangeRequired(status, data) {
  if (status !== 403 || !data || data.passwordChangeRequired !== true || !passwordChangeRequiredHandler) return
  try { passwordChangeRequiredHandler(data) } catch {}
}
const AUTH_STORAGE_KEY = 'iclass-v3-auth'

function getStoredAuth() {
  if (typeof localStorage === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)) || {} } catch { return {} }
}

function authHeaders() {
  const headers = {}
  const providedAuth = authProvider() || {}
  const a = (providedAuth.adminSession || providedAuth.sessionToken) ? providedAuth : getStoredAuth()
  // Instrutor: só o token da sessão. A senha passa uma vez, no POST /api/session/admin-login;
  // nenhum pedido leva cabeçalho com e-mail e senha (o servidor não aceita mais, SEG-03).
  if (a.adminSession) headers['x-admin-session'] = a.adminSession
  if (a.sessionToken) headers['x-session-token'] = a.sessionToken       // aluno
  return headers
}

// Versão do build anunciada pelo servidor (autorrecuperação depois de atualizar o IClass,
// lib/buildVersion.js). Só o portal do aluno recarrega sozinho: nas telas do professor uma
// recarga no meio de uma edição perderia o que não foi salvo, e lá o F5 fica com ele.
function noteBuildFrom(res, path, headers) {
  const studentRequest = !!headers['x-session-token'] || String(path || '').startsWith('/api/student/')
  if (!studentRequest || headers['x-admin-session']) return
  noteServerBuild(res.headers?.get?.(BUILD_HEADER))
}

// --- Tempo-limite e falhas de conexão (fase 2: H2-C, DES-09; H9c, ENG-04) ---------
// Um pedido pendurado (celular com a Wi-Fi caindo, servidor travado) segurava a tela
// girando sem fim e o laço que esperava a resposta. Agora cada pedido tem um prazo:
// - instrutor (pedido com a sessão do painel, ou o login dele): 60 s;
// - aluno: sem prazo, porque a prova tem as próprias tentativas e um erro falso no meio
//   dela confunde mais do que espera;
// - consultas periódicas (usePolling) e envio de teclas: 10 s; salvamento automático da
//   prova: 15 s (quem chama passa timeoutMs);
// - operações longas do professor (backup, restauração, compactar, limpar estado de
//   prova, resetar sala, clonar e arquivar curso): sem prazo. As telas passam
//   timeoutMs: 0 e, por segurança, os caminhos de LONG_ADMIN_OPERATIONS também ficam sem
//   prazo quando quem chama não diz nada (o servidor termina a operação de qualquer
//   jeito, e um "não respondeu" no meio dela seria um aviso falso).
// O pedido com keepalive (saída da página) nunca tem prazo: a página já está indo embora.
// Envio de arquivo (corpo FormData: restauração de backup, Biblioteca, comprovante da
// chamada, imagem do editor) também fica sem prazo quando quem chama não diz nada: o
// tempo depende do tamanho do arquivo e da rede da sala. Antes esses envios usavam fetch
// direto e, sem rede, a tela mostrava o "Failed to fetch" do navegador.
// Estourado o prazo ou sem rede, o erro sai com status 0, err.timeout ou err.network e
// uma mensagem fixa em português (quem tenta de novo, como o envio automático da prova,
// trata status 0 como falha passageira).
export { INSTRUCTOR_TIMEOUT_MS, POLL_TIMEOUT_MS, KEYSTROKE_TIMEOUT_MS, AUTOSAVE_TIMEOUT_MS }
export const TIMEOUT_MESSAGE = 'O servidor do IClass demorou demais para responder. Confira se ele está ligado e tente de novo.'
export const NETWORK_MESSAGE = 'Sem conexão com o servidor do IClass. Confira a rede e tente de novo.'
// Consulta automática, que a pessoa não pediu (usePolling, conferências de fundo): o
// servidor não conta como uso da sessão.
export const BACKGROUND_HEADER = 'X-IClass-Background'

const LONG_ADMIN_OPERATIONS = [
  /^\/api\/admin\/backup(\/|$)/, // backup no servidor, downloads, restauração e prévia
  /^\/api\/admin\/storage\/compact$/,
  /^\/api\/admin\/flush-exam-state$/,
  /^\/api\/admin\/reset$/,
  /^\/api\/admin\/courses\/[^/]+\/(clone|purge)$/,
  /^\/api\/admin\/archived-courses\//,
]
const INSTRUCTOR_LOGIN_PATHS = ['/api/session/admin-login', '/api/setup/admin-session']

function pathOnly(path) {
  return String(path || '').split(/[?#]/)[0]
}

export function isLongAdminOperation(path) {
  const clean = pathOnly(path)
  return LONG_ADMIN_OPERATIONS.some((pattern) => pattern.test(clean))
}

// Prazo do pedido quando quem chama não passa timeoutMs.
function defaultTimeoutMs(path, headers, fileUpload) {
  const instructor = !!headers['x-admin-session'] || INSTRUCTOR_LOGIN_PATHS.includes(pathOnly(path))
  if (!instructor || fileUpload || isLongAdminOperation(path)) return 0
  return INSTRUCTOR_TIMEOUT_MS
}

function isFormData(body) {
  return typeof FormData !== 'undefined' && body instanceof FormData
}

function connectionError(kind) {
  const err = new Error(kind === 'timeout' ? TIMEOUT_MESSAGE : NETWORK_MESSAGE)
  err.status = 0
  err.data = null
  if (kind === 'timeout') err.timeout = true
  else err.network = true
  return err
}

function abortError(signal) {
  const reason = signal && signal.reason
  if (reason instanceof Error) return reason
  const err = new Error('Pedido cancelado.')
  err.name = 'AbortError'
  err.aborted = true
  err.status = 0
  return err
}

// keepalive: a requisição sobrevive ao fechamento/recarga da página (pagehide).
// Diferente do sendBeacon, leva os cabeçalhos de sessão.
// timeoutMs: prazo em ms (0 = sem prazo; sem o campo, o padrão acima). background: true
// manda X-IClass-Background: 1. signal: AbortSignal de quem chama (cancelar é dele: o
// erro sai como AbortError, sem mensagem de conexão).
// body: objeto (vai como JSON) ou FormData (envio de arquivo: vai como está, e o
// navegador põe o Content-Type multipart com o separador).
async function request(path, { method = 'GET', body, auth = true, raw, keepalive = false, timeoutMs, background = false, signal } = {}) {
  const fileUpload = isFormData(body)
  const headers = { ...(fileUpload ? {} : { 'Content-Type': 'application/json' }), ...(auth ? authHeaders() : {}) }
  if (background) headers[BACKGROUND_HEADER] = '1'
  const limit = keepalive ? 0 : (timeoutMs === undefined || timeoutMs === null ? defaultTimeoutMs(path, headers, fileUpload) : Math.max(0, Number(timeoutMs) || 0))
  const canAbort = typeof AbortController === 'function'
  const controller = canAbort && (limit > 0 || signal) ? new AbortController() : null
  let timedOut = false
  let timer = null
  const onCallerAbort = () => { if (controller) controller.abort() }
  if (controller && signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  if (controller && limit > 0) timer = setTimeout(() => { timedOut = true; controller.abort() }, limit)
  const finish = () => {
    if (timer) clearTimeout(timer)
    if (controller && signal) signal.removeEventListener('abort', onCallerAbort)
  }
  // Falha do fetch ou da leitura do corpo: tempo-limite, cancelamento de quem chamou ou
  // rede (TypeError "Failed to fetch", corpo cortado no meio).
  const failure = (error) => {
    if (timedOut) return connectionError('timeout')
    if (signal && signal.aborted) return abortError(signal)
    return connectionError('network')
  }

  let res
  try {
    res = await fetch(path, {
      method,
      headers,
      body: fileUpload ? body : (body ? JSON.stringify(body) : undefined),
      ...(keepalive ? { keepalive: true } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    })
  } catch (error) {
    finish()
    throw failure(error)
  }
  let data = null
  try {
    noteBuildFrom(res, path, headers)
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('application/json')) data = await res.json().catch(() => null)
    else if (raw) data = await res.text()
  } catch (error) {
    finish()
    throw failure(error)
  }
  finish()
  // O prazo estourou enquanto o corpo chegava (o json() acima engole a falha).
  if (timedOut) throw connectionError('timeout')
  if (signal && signal.aborted) throw abortError(signal)
  if (!res.ok) {
    noteAdminAccessDenied(res.status, data)
    notePasswordChangeRequired(res.status, data)
    const err = new Error((data && (data.error || data.message)) || `Erro ${res.status}`)
    err.status = res.status; err.data = data
    throw err
  }
  return data
}
// Baixa um arquivo de rota autenticada (CSV, etc.). window.open não manda o
// cabeçalho de sessão e abria "Acesso não autorizado." (UXI-01). O Blob preserva
// os bytes (inclusive o BOM UTF-8 que o Excel usa para os acentos).
// Sem prazo (o arquivo pode ser grande, como o backup completo); sem rede, a mesma
// mensagem de conexão dos outros pedidos.
export async function downloadFile(path, fallbackName = 'arquivo') {
  const headers = authHeaders()
  let res
  try {
    res = await fetch(path, { headers })
  } catch {
    throw connectionError('network')
  }
  noteBuildFrom(res, path, headers)
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    noteAdminAccessDenied(res.status, data)
    notePasswordChangeRequired(res.status, data)
    const err = new Error((data && (data.error || data.message)) || `Erro ${res.status}`)
    err.status = res.status; err.data = data
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
