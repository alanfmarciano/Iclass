// Estado da conexão com o servidor do IClass (frente do H3: CONF-03, UXA-06, DES-08).
// Antes, uma queda ou um reinício do servidor só aparecia como erro solto em cada tela, e
// o aluno na prova recarregava a página (no http://IP do celular não há cópia local das
// respostas: recarregar perdia o que ainda não tinha chegado ao servidor).
//
// Estados: 'online', 'offline' (sem resposta do servidor) e 'starting' (o servidor
// respondeu que está iniciando). Toda resposta do cliente da API (lib/api.js request) passa
// por aqui:
// - falha de rede ou tempo-limite: conta uma falha; 2 seguidas levam a 'offline' (uma
//   falha isolada do Wi-Fi da sala não acende a faixa);
// - 503 { starting: true }: 'starting' na hora;
// - 503 { maintenance: true }: não muda o estado (o servidor está no ar; a manutenção tem
//   a tela própria);
// - qualquer outra resposta HTTP, inclusive 503 { retryable: true } (a gravação falhou,
//   mas o servidor respondeu): 'online';
// - pedido cancelado por quem chamou: não conta.
// Fora de 'online', confere o servidor sozinho (GET /api/session/status pela sonda que o
// lib/api.js registra) a cada 2 s, recuando até 5 s, uma conferência por vez e encadeada
// por setTimeout. A primeira resposta volta o estado para 'online'.
// Quem assina (subscribe) recebe (estado, anterior) a cada troca: a faixa de conexão
// (ServerConnectionBanner), o AuthProvider (confere a sessão na volta) e a prova (salva as
// respostas na hora da volta).
export const CONNECTION_STATES = Object.freeze(['online', 'offline', 'starting'])
export const OFFLINE_AFTER_FAILURES = 2
export const PROBE_FIRST_MS = 2000
export const PROBE_MAX_MS = 5000

let state = 'online'
let failures = 0
let probe = null
let probeTimer = null
let probeRunning = false
let probeAttempts = 0
const listeners = new Set()

export function getConnectionState() {
  return state
}

// fn(estado, anterior) a cada troca. Devolve a função que cancela a assinatura.
export function subscribeConnection(fn) {
  if (typeof fn !== 'function') return () => {}
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// Sonda de conferência (o lib/api.js registra a dele; sem dependência circular). Devolve
// uma promessa; o resultado chega aqui pelas próprias respostas do request().
export function setConnectionProbe(fn) {
  probe = typeof fn === 'function' ? fn : null
  if (state !== 'online') scheduleProbe(0)
}

function setState(next) {
  if (next === state) return
  const previous = state
  state = next
  if (next === 'online') {
    probeAttempts = 0
    clearTimeout(probeTimer)
    probeTimer = null
  } else {
    scheduleProbe(PROBE_FIRST_MS)
  }
  listeners.forEach((fn) => {
    try { fn(next, previous) } catch { /* quem assina não derruba os outros */ }
  })
}

export function probeDelay(attempt) {
  return Math.min(PROBE_MAX_MS, PROBE_FIRST_MS + Math.max(0, Number(attempt) || 0) * 1000)
}

function scheduleProbe(delay) {
  if (state === 'online' || !probe || probeRunning || probeTimer) return
  probeTimer = setTimeout(runProbe, delay)
}

async function runProbe() {
  probeTimer = null
  if (state === 'online' || !probe || probeRunning) return
  probeRunning = true
  try { await probe() } catch { /* a falha já chegou pelo request() */ }
  probeRunning = false
  probeAttempts += 1
  scheduleProbe(probeDelay(probeAttempts))
}

// O servidor respondeu (qualquer status HTTP). status e data: para reconhecer o 503 de
// início e o de manutenção.
export function reportResponse(status, data) {
  if (status === 503 && data && data.starting === true) {
    failures = 0
    setState('starting')
    return
  }
  if (status === 503 && data && data.maintenance === true) {
    failures = 0
    return
  }
  reportSuccess()
}

export function reportSuccess() {
  failures = 0
  setState('online')
}

// Falha sem resposta (rede ou tempo-limite). Pedido cancelado por quem chamou não conta.
export function reportFailure(err) {
  if (err && (err.aborted || err.name === 'AbortError') && !err.timeout && !err.network) return
  failures += 1
  if (state === 'online' && failures >= OFFLINE_AFTER_FAILURES) setState('offline')
  else if (state === 'starting' && failures >= OFFLINE_AFTER_FAILURES) setState('offline')
}

// Só para os testes: volta ao estado inicial, sem assinantes (a sonda registrada fica).
export function resetConnectionForTests() {
  clearTimeout(probeTimer)
  probeTimer = null
  probeRunning = false
  probeAttempts = 0
  failures = 0
  state = 'online'
  listeners.clear()
}
