// Cliente único de API do IClass V3.
// Repository pattern: nenhuma tela usa fetch cru — tudo passa por aqui.
// As REGRAS DE NEGÓCIO permanecem no backend Express (server-authoritative).
import { BUILD_HEADER, noteServerBuild } from './buildVersion'
import { AUTOSAVE_TIMEOUT_MS, INSTRUCTOR_TIMEOUT_MS, KEYSTROKE_TIMEOUT_MS, POLL_TIMEOUT_MS } from './requestTimeouts'
import { reportFailure, reportResponse, setConnectionProbe } from './connection'
import { PREVIEW_HEADER, currentPreviewToken, isPreviewPortalRequest, notifyPreviewEnded } from './previewSession'
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
// Pré-visualização como aluno que o servidor encerrou (401 { code: 'preview_ended' }: 60 min,
// Sair do painel, senha trocada, turma fora do escopo, servidor reiniciado): o AuthProvider
// fecha a prévia e volta ao painel com o motivo (lib/previewSession.js), em vez de tratar
// como sessão de aluno vencida (o que levaria o instrutor ao login).
function notePreviewEnded(status, data, headers) {
  if (status !== 401 || !data || data.code !== 'preview_ended' || !headers[PREVIEW_HEADER]) return
  notifyPreviewEnded(data)
}
const AUTH_STORAGE_KEY = 'iclass-v3-auth'

function getStoredAuth() {
  if (typeof localStorage === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)) || {} } catch { return {} }
}

// path: o pedido. Com a pré-visualização aberta nesta aba (lib/previewSession.js, C15 /
// P5-S6b, D21 do P5), os pedidos do portal levam só o x-preview-session (nunca o
// x-admin-session: o portal na prévia é o do aluno virtual, e uma rota que aceitasse a
// sessão do painel mostraria outra coisa); /api/admin/* e o Sair do instrutor continuam
// com a sessão do painel.
function authHeaders(path) {
  const headers = {}
  const previewToken = currentPreviewToken()
  if (previewToken && isPreviewPortalRequest(path)) {
    headers[PREVIEW_HEADER] = previewToken
    return headers
  }
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
// Gravação que falhou no servidor (contrato das respostas de estado: 503 { retryable: true },
// decisões §3): passageiro, a sessão continua. As telas mostram este texto (err.message) e
// err.retryable = true; a prova online trata à parte (mantém as respostas e tenta de novo).
export const RETRYABLE_MESSAGE = 'Não foi possível gravar agora. Tente de novo em instantes.'
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
  /^\/api\/admin\/assignments\/[^/]+\/export$/, // ZIP com as entregas de uma tarefa
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
// headers: cabeçalhos a mais (o fim da pré-visualização manda o x-preview-session junto
// com a sessão do painel); os de sessão vêm depois e valem mais.
async function request(path, { method = 'GET', body, auth = true, raw, keepalive = false, timeoutMs, background = false, signal, headers: extraHeaders = null } = {}) {
  const fileUpload = isFormData(body)
  const headers = { ...(fileUpload ? {} : { 'Content-Type': 'application/json' }), ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}), ...(auth ? authHeaders(path) : {}) }
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
    throw noteFailure(failure(error))
  }
  let data = null
  try {
    noteBuildFrom(res, path, headers)
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('application/json')) data = await res.json().catch(() => null)
    else if (raw) data = await res.text()
  } catch (error) {
    finish()
    throw noteFailure(failure(error))
  }
  finish()
  // O prazo estourou enquanto o corpo chegava (o json() acima engole a falha).
  if (timedOut) throw noteFailure(connectionError('timeout'))
  if (signal && signal.aborted) throw abortError(signal)
  reportResponse(res.status, data)
  if (!res.ok) {
    noteAdminAccessDenied(res.status, data)
    notePasswordChangeRequired(res.status, data)
    notePreviewEnded(res.status, data, headers)
    throw responseError(res.status, data)
  }
  return data
}

// Falha sem resposta (rede ou tempo-limite) conta para o estado da conexão (lib/connection.js);
// o cancelamento de quem chamou não conta.
function noteFailure(err) {
  if (err && (err.timeout || err.network)) reportFailure(err)
  return err
}

// Erro de uma resposta HTTP que não é 2xx: mensagem do servidor, status e corpo. 503 de
// gravação (retryable) e de início (starting) ganham marcas próprias; o retryable sai com
// o texto fixo das telas (decisões §3).
function responseError(status, data) {
  const retryable = status === 503 && !!data && data.retryable === true
  const message = retryable ? RETRYABLE_MESSAGE : ((data && (data.error || data.message)) || `Erro ${status}`)
  const err = new Error(message)
  err.status = status; err.data = data
  if (retryable) err.retryable = true
  if (status === 503 && data && data.starting === true) err.starting = true
  return err
}

// Conferência do servidor enquanto a conexão não está 'online' (lib/connection.js): o
// próprio request() leva o resultado ao estado.
setConnectionProbe(() => request('/api/session/status', { auth: false, background: true, timeoutMs: POLL_TIMEOUT_MS }))
// Nome do arquivo do Content-Disposition: o filename* (UTF-8, com os acentos de
// "Relatório final.pdf") vale mais que o filename (só ASCII, a reserva dos navegadores
// antigos); sem nenhum, o nome de reserva de quem chamou.
export function dispositionFileName(disposition, fallbackName = 'arquivo') {
  const value = String(disposition || '')
  const extended = value.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/)
  if (extended) {
    try {
      const decoded = decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''))
      if (decoded) return decoded
    } catch {}
  }
  const match = value.match(/filename="?([^";]+)"?/i)
  return match ? match[1] : fallbackName
}

// Lê um arquivo de rota autenticada como Blob (prévia de imagem, PDF e texto das entregas
// no painel, fase 3 C8, e o download abaixo): { blob, name, type }. Sem prazo (o arquivo
// pode ser grande); sem rede, a mesma mensagem de conexão dos outros pedidos; recusa do
// servidor com a mensagem dele. signal: cancela (a prévia que saiu da tela).
export async function fetchBlob(path, { fallbackName = 'arquivo', signal } = {}) {
  const headers = authHeaders(path)
  let res
  try {
    res = await fetch(path, signal ? { headers, signal } : { headers })
  } catch (error) {
    if (signal && signal.aborted) throw abortError(signal)
    throw noteFailure(connectionError('network'))
  }
  noteBuildFrom(res, path, headers)
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    reportResponse(res.status, data)
    noteAdminAccessDenied(res.status, data)
    notePasswordChangeRequired(res.status, data)
    notePreviewEnded(res.status, data, headers)
    throw responseError(res.status, data)
  }
  reportResponse(res.status, null)
  let blob
  try {
    blob = await res.blob()
  } catch (error) {
    if (signal && signal.aborted) throw abortError(signal)
    throw noteFailure(connectionError('network'))
  }
  const name = dispositionFileName(res.headers.get('content-disposition'), fallbackName)
  return { blob, name, type: blob.type || res.headers.get('content-type') || '' }
}

// Baixa um arquivo de rota autenticada (CSV, etc.). window.open não manda o
// cabeçalho de sessão e abria "Acesso não autorizado." (UXI-01). O Blob preserva
// os bytes (inclusive o BOM UTF-8 que o Excel usa para os acentos).
// Sem prazo (o arquivo pode ser grande, como o backup completo); sem rede, a mesma
// mensagem de conexão dos outros pedidos.
export async function downloadFile(path, fallbackName = 'arquivo') {
  const { blob, name } = await fetchBlob(path, { fallbackName })
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

// Envio de arquivo com progresso (fase 3, C9 / P1-g; D12 do P1): o fetch não diz quanto
// do corpo já subiu, e o aluno no celular, na Wi-Fi da sala, precisa ver a barra andar.
// XMLHttpRequest com os mesmos cabeçalhos de sessão, as mesmas mensagens e marcas de erro
// do request() (status 0 com err.network ou err.timeout, 503 retryable com o texto fixo,
// a mensagem do servidor nas recusas), o mesmo estado da conexão e a mesma conferência
// da versão do build. Sem pacote novo.
// onProgress({ loaded, total, percent }): a cada pedaço enviado (percent de 0 a 100; o
// 100 sai quando o corpo terminou de subir, antes da resposta). signal: cancela (o erro
// sai como AbortError, sem mensagem de conexão). timeoutMs: prazo (padrão 0 = sem prazo,
// porque o tempo depende do tamanho do arquivo e da rede da sala). headers: cabeçalhos a
// mais do pedido (o envio da atividade manda o x-envio-id); os de sessão vêm sempre.
// stallMs (C9, ajuste 2): prazo SEM NOVIDADE, contado de novo a cada pedaço que sobe e
// quando a resposta começa a chegar (padrão 0 = desligado). A Wi-Fi da sala congestionada
// pode parar de passar dados sem fechar a conexão; sem este prazo o envio ficava parado
// até o sistema desistir da conexão, muitos minutos depois. Estourado, o pedido é
// cancelado e o erro sai como o do tempo-limite (status 0, err.timeout), com err.stalled.
// Devolve o JSON da resposta (ou null sem corpo JSON).
export function uploadWithProgress(path, formData, { method = 'POST', onProgress, signal, timeoutMs = 0, stallMs = 0, headers: extraHeaders = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortError(signal)); return }
    if (typeof XMLHttpRequest !== 'function') { reject(noteFailure(connectionError('network'))); return }
    const headers = { ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}), ...authHeaders(path) }
    const xhr = new XMLHttpRequest()
    let settled = false
    let timedOut = false
    let stalled = false
    let timer = null
    let stallTimer = null
    const stallLimit = Math.max(0, Number(stallMs) || 0)
    const onCallerAbort = () => { try { xhr.abort() } catch {} }
    const finish = () => {
      settled = true
      if (timer) clearTimeout(timer)
      if (stallTimer) clearTimeout(stallTimer)
      if (signal) signal.removeEventListener('abort', onCallerAbort)
    }
    const timeoutError = () => {
      const err = noteFailure(connectionError('timeout'))
      if (stalled) err.stalled = true
      return err
    }
    const fail = (err) => { if (settled) return; finish(); reject(err) }
    // Algo andou (pedaço enviado, resposta chegando): o prazo sem novidade recomeça.
    const armStall = () => {
      if (!stallLimit || settled) return
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => { stalled = true; timedOut = true; try { xhr.abort() } catch {} }, stallLimit)
    }
    const report = (loaded, total) => {
      if (typeof onProgress !== 'function') return
      const safeTotal = Number(total) > 0 ? Number(total) : 0
      const percent = safeTotal ? Math.max(0, Math.min(100, Math.round((Number(loaded) / safeTotal) * 100))) : 0
      try { onProgress({ loaded: Number(loaded) || 0, total: safeTotal, percent }) } catch {}
    }
    try {
      xhr.open(method, path, true)
      Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value))
    } catch {
      fail(noteFailure(connectionError('network')))
      return
    }
    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        armStall()
        if (event && event.lengthComputable) report(event.loaded, event.total)
      }
      xhr.upload.onload = () => { armStall(); report(1, 1) }
    }
    // Cabeçalhos ou pedaços da resposta chegando também contam como novidade.
    xhr.onreadystatechange = () => { if (xhr.readyState >= 2) armStall() }
    xhr.onload = () => {
      if (settled) return
      const status = xhr.status
      // Status 0 no onload: o navegador não recebeu resposta de verdade (conexão cortada).
      if (!status) { fail(timedOut ? timeoutError() : noteFailure(connectionError('network'))); return }
      const res = { headers: { get: (name) => xhr.getResponseHeader(name) } }
      noteBuildFrom(res, path, headers)
      let data = null
      const ct = xhr.getResponseHeader('content-type') || ''
      if (ct.includes('application/json')) {
        try { data = JSON.parse(xhr.responseText) } catch { data = null }
      }
      finish()
      reportResponse(status, data)
      if (status < 200 || status >= 300) {
        noteAdminAccessDenied(status, data)
        notePasswordChangeRequired(status, data)
        notePreviewEnded(status, data, headers)
        reject(responseError(status, data))
        return
      }
      resolve(data)
    }
    xhr.onerror = () => fail(timedOut ? timeoutError() : noteFailure(connectionError('network')))
    xhr.ontimeout = () => fail(timeoutError())
    xhr.onabort = () => {
      if (timedOut) fail(timeoutError())
      else fail(abortError(signal))
    }
    if (signal) signal.addEventListener('abort', onCallerAbort, { once: true })
    const limit = Math.max(0, Number(timeoutMs) || 0)
    if (limit > 0) timer = setTimeout(() => { timedOut = true; try { xhr.abort() } catch {} }, limit)
    try {
      xhr.send(formData)
      armStall()
    } catch {
      fail(noteFailure(connectionError('network')))
    }
  })
}

export const api = {
  get: (p, opts) => request(p, { ...opts }),
  post: (p, body, opts) => request(p, { method: 'POST', body, ...opts }),
  put: (p, body, opts) => request(p, { method: 'PUT', body, ...opts }),
  delete: (p, opts) => request(p, { method: 'DELETE', ...opts }),
}
