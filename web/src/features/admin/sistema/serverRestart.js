// Espera o servidor voltar depois do Reiniciar da tela Sistema (H3c, CONF-12).
//
// O servidor grava, fecha o banco e sai; o supervisor (ou o relançamento sem supervisor)
// sobe outro processo, que tem outro instanceId. A tela consulta /api/health até ver o
// instanceId novo já pronto (status diferente de 'starting'), por no máximo 90 s.
// Laço com setTimeout (uma consulta por vez), sem setInterval: quando a trilha B trouxer
// o usePolling para cá, ele não precisa mudar (as consultas param sozinhas no fim).
import { api } from '../../../lib/api'

export const RESTART_WAIT_MS = 90000
export const RESTART_POLL_MS = 1500

// /api/health responde 503 com corpo JSON durante o boot ('starting') e com problemas
// ('degraded'): o corpo vale do mesmo jeito. Sem resposta (servidor fora): null.
export async function readServerHealth() {
  try {
    return await api.get('/api/health', { auth: false })
  } catch (err) {
    if (err && err.data && err.data.instanceId) return err.data
    return null
  }
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
} = {}) {
  const deadline = now() + timeoutMs
  let sawDown = false
  while (now() < deadline) {
    await sleep(intervalMs)
    if (isCancelled()) return { ok: false, cancelled: true }
    const health = await readHealth()
    if (!health || !health.instanceId) { sawDown = true; continue }
    if (health.status === 'starting') { sawDown = true; continue }
    const changed = previousInstanceId ? health.instanceId !== previousInstanceId : sawDown
    if (changed) return { ok: true, health }
  }
  return { ok: false }
}
