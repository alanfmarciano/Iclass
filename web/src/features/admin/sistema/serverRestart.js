// Espera o servidor voltar depois do Reiniciar da tela Sistema (H3c, CONF-12).
//
// O servidor grava, fecha o banco e sai; o supervisor (ou o relançamento sem supervisor)
// sobe outro processo, que tem outro instanceId. A tela consulta /api/health até ver o
// instanceId novo já pronto (status diferente de 'starting'), por no máximo 90 s.
//
// Contrato de polling (H2-C): isto não é uma consulta periódica (usePolling), é uma espera
// curta e com fim depois de um clique, como a conferência do servidor do lazyPage:
// encadeada por setTimeout (uma consulta por vez, nunca setInterval), cada consulta com
// prazo próprio (REQUEST_TIMEOUT_MS: uma resposta presa não segura a espera além dos
// 90 s), e para sozinha quando o servidor volta, no fim do prazo ou quando a tela sai
// (isCancelled). O que é periódico na tela Sistema (o cartão Saúde) usa o useApi com
// pollMs, que passa pelo usePolling depois da junção com a trilha B (H2-C reescreve o
// useApi). Na lista de exceções do teste estático pollingSources esta espera entra na
// mesma categoria do lazyPage: não usa setInterval (serverRestart.test.js confere).
import { api } from '../../../lib/api'

export const RESTART_WAIT_MS = 90000
export const RESTART_POLL_MS = 1500
export const REQUEST_TIMEOUT_MS = 5000

// /api/health responde 503 com corpo JSON durante o boot ('starting') e com problemas
// ('degraded'): o corpo vale do mesmo jeito. Sem resposta (servidor fora): null.
// A consulta que passou do prazo conta como "sem resposta" (servidor ainda fora).
function withDeadline(promise, ms) {
  let timer
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms) }),
  ]).finally(() => clearTimeout(timer))
}

export function readServerHealth() {
  const read = api.get('/api/health', { auth: false, timeoutMs: REQUEST_TIMEOUT_MS }).catch((err) => {
    if (err && err.data && err.data.instanceId) return err.data
    return null
  })
  return withDeadline(read, REQUEST_TIMEOUT_MS)
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// previousInstanceId: o instanceId lido antes de pedir o reinício (null se não deu para
// ler). Sem ele, vale a primeira resposta pronta depois de o servidor ter ficado fora.
// Devolve { ok: true, health } quando voltou ou { ok: false } depois de timeoutMs.
export async function waitForServerRestart({
  previousInstanceId = null,
  timeoutMs = RESTART_WAIT_MS,
  intervalMs = RESTART_POLL_MS,
  readHealth = readServerHealth,
  sleep = defaultSleep,
  now = () => Date.now(),
  isCancelled = () => false,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const deadline = now() + timeoutMs
  let sawDown = false
  while (now() < deadline) {
    await sleep(intervalMs)
    if (isCancelled()) return { ok: false, cancelled: true }
    const health = await withDeadline(readHealth(), Math.max(1, Math.min(requestTimeoutMs, deadline - now())))
    if (isCancelled()) return { ok: false, cancelled: true }
    if (!health || !health.instanceId) { sawDown = true; continue }
    if (health.status === 'starting') { sawDown = true; continue }
    const changed = previousInstanceId ? health.instanceId !== previousInstanceId : sawDown
    if (changed) return { ok: true, health }
  }
  return { ok: false }
}
