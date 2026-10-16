// Envio automático do fim do tempo: o navegador insiste até o servidor dar uma
// resposta definitiva, em vez de mostrar só um aviso de erro.
export const AUTO_SUBMIT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]

export function autoSubmitRetryDelay(attempt) {
  const index = Math.max(0, Math.min(Number(attempt) || 0, AUTO_SUBMIT_RETRY_DELAYS_MS.length - 1))
  return AUTO_SUBMIT_RETRY_DELAYS_MS[index]
}

// retry: sem rede, servidor fora do ar ou ocupado. finalized: a janela de tolerância
// passou e o servidor já entregou as respostas salvas. locked/paused: a tentativa voltou
// a depender do professor (bloqueio por foco ou aplicação pausada). fatal: o resto.
export function classifyAutoSubmitError(error) {
  const status = Number(error?.status || 0)
  if (!status || status >= 500 || status === 429) return 'retry'
  if (status === 408 && error?.data?.deadlineExceeded) return 'finalized'
  if (status === 423) return 'locked'
  if (status === 403 && error?.data?.applicationPaused) return 'paused'
  return 'fatal'
}

export function countAnswered(answers) {
  return Object.values(answers || {}).filter((value) => value !== null && value !== undefined && value !== '').length
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
