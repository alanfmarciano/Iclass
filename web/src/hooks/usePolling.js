import { useCallback, useEffect, useRef } from 'react'
import { POLL_TIMEOUT_MS } from '../lib/requestTimeouts'

// Consulta periódica ao servidor (fase 2, H2-C: DES-09). Toda tela que pergunta de
// tempos em tempos (notificações, fórum, matrículas, presença do aluno...) passa por
// aqui, e não por um setInterval: com o servidor lento, o setInterval disparava uma
// consulta nova antes de a anterior voltar, as consultas se acumulavam e pioravam a
// lentidão da sala inteira; com a aba em segundo plano, continuava perguntando à toa.
//
// usePolling(task, { intervalMs, enabled, pauseWhenHidden, maxBackoffMs, immediate,
//   background, timeoutMs, resetKey }) → { runNow }
// - task(requestOptions): a consulta. Recebe { background, timeoutMs } para repassar à
//   api (api.get(caminho, requestOptions)): por padrão a consulta sai com
//   X-IClass-Background: 1 (a pessoa não fez nada; o servidor não conta como uso da
//   sessão) e prazo de 10 s. Devolver false ou rejeitar conta como falha;
// - roda logo ao ligar (immediate: false espera o primeiro intervalo) e agenda a próxima
//   intervalMs DEPOIS de terminar: nunca duas ao mesmo tempo;
// - falha: espera min(teto, intervalMs × 2^falhas), com variação de 0,8 a 1,2 para os
//   aparelhos da sala não voltarem todos no mesmo instante. O teto é maxBackoffMs (15 s)
//   ou o próprio intervalo, se ele for maior: a falha nunca deixa a consulta mais
//   frequente. O primeiro sucesso volta ao intervalo normal;
// - aba oculta (pauseWhenHidden): não agenda nada; ao voltar a ficar visível, consulta na
//   hora;
// - runNow(): consulta agora (depois de uma ação na tela). Com uma em andamento, marca
//   uma única consulta logo depois dela;
// - resetKey: o que a consulta pergunta (endpoint, curso e turma...). Quando muda, a
//   consulta recomeça do zero, como se tivesse acabado de ligar: com immediate, pergunta
//   na hora o endereço novo (antes a resposta da turma anterior ficava na tela até o
//   intervalo seguinte); sem immediate, a primeira vem depois de um intervalo. A
//   resposta atrasada do endereço anterior fica a cargo da tela, que a descarta;
// - desligar (enabled false), trocar o intervalo ou desmontar limpa tudo.
// A sincronização da prova (ExamRunner) é a exceção: não pausa com a aba oculta e tem a
// própria guarda.
export const DEFAULT_MAX_BACKOFF_MS = 15000

export function pollingDelay(intervalMs, failures, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS, random = Math.random) {
  if (!failures) return intervalMs
  const cap = Math.max(maxBackoffMs, intervalMs)
  const base = Math.min(cap, intervalMs * 2 ** Math.min(failures, 30))
  return Math.round(base * (0.8 + random() * 0.4))
}

function pageHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

export function usePolling(task, options = {}) {
  const {
    intervalMs,
    enabled = true,
    pauseWhenHidden = true,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    immediate = true,
    background = true,
    timeoutMs = POLL_TIMEOUT_MS,
    resetKey = null,
  } = options
  const taskRef = useRef(task)
  taskRef.current = task
  const requestRef = useRef({ background, timeoutMs })
  requestRef.current = { background, timeoutMs }
  const controlRef = useRef(null)
  const interval = Number(intervalMs) || 0
  const active = !!enabled && interval > 0

  useEffect(() => {
    if (!active) return undefined
    let stopped = false
    let running = false
    let queued = false
    let failures = 0
    let timer = null
    const hidden = () => pauseWhenHidden && pageHidden()
    const clearTimer = () => {
      if (timer) { clearTimeout(timer); timer = null }
    }
    const schedule = (delay) => {
      clearTimer()
      if (stopped || hidden()) return
      timer = setTimeout(run, delay)
    }
    async function run() {
      timer = null
      if (stopped) return
      if (running) { queued = true; return }
      running = true
      let ok = true
      try {
        ok = (await taskRef.current({ ...requestRef.current })) !== false
      } catch {
        ok = false
      }
      running = false
      if (stopped) return
      failures = ok ? 0 : failures + 1
      if (queued) {
        queued = false
        schedule(0)
      } else {
        schedule(pollingDelay(interval, failures, maxBackoffMs))
      }
    }
    const runNow = () => {
      if (stopped) return
      if (running) { queued = true; return }
      clearTimer()
      run()
    }
    controlRef.current = runNow
    const onVisibility = () => {
      if (!pauseWhenHidden) return
      if (pageHidden()) clearTimer()
      else runNow()
    }
    document.addEventListener('visibilitychange', onVisibility)
    if (immediate && !hidden()) run()
    else schedule(interval)
    return () => {
      stopped = true
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibility)
      if (controlRef.current === runNow) controlRef.current = null
    }
  }, [active, interval, pauseWhenHidden, maxBackoffMs, immediate, resetKey])

  const runNow = useCallback(() => {
    if (controlRef.current) controlRef.current()
  }, [])
  return { runNow }
}
