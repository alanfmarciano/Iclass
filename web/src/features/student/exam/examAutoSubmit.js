// Envio automático do fim do tempo: o navegador insiste até o servidor dar uma
// resposta definitiva, em vez de mostrar só um aviso de erro.
export const AUTO_SUBMIT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]

export function autoSubmitRetryDelay(attempt) {
  const index = Math.max(0, Math.min(Number(attempt) || 0, AUTO_SUBMIT_RETRY_DELAYS_MS.length - 1))
  return AUTO_SUBMIT_RETRY_DELAYS_MS[index]
}

// retry: sem rede, servidor fora do ar ou ocupado. finalized: a janela de tolerância
// passou e o servidor já entregou as respostas salvas. locked/paused: a tentativa voltou
// a depender do professor (bloqueio por foco ou aplicação pausada). extended: o
// professor deu mais tempo (ou reabriu a tentativa no "+N min" da turma) e a prova
// continua. fatal: o resto.
export function classifyAutoSubmitError(error) {
  const status = Number(error?.status || 0)
  if (!status || status >= 500 || status === 429) return 'retry'
  if (status === 408 && error?.data?.deadlineExceeded) return 'finalized'
  if (status === 409 && error?.data?.deadlineExtended) return 'extended'
  if (status === 423) return 'locked'
  if (status === 403 && error?.data?.applicationPaused) return 'paused'
  return 'fatal'
}

// Texto do aviso quando o envio automático volta com 409 deadlineExtended: com reason
// 'server_outage' o prazo só ficou à frente pelo tempo devolvido de uma queda do
// servidor (o professor não fez nada); sem reason, foi o professor que deu mais tempo.
// O ExamRunner (da trilha B) passa a usar este texto na frente do H3; até lá ele mostra
// o texto do professor nos dois casos.
export const AUTO_SUBMIT_EXTENDED_MESSAGE = 'O professor deu mais tempo. A prova continua.'
export const AUTO_SUBMIT_SERVER_OUTAGE_MESSAGE = 'O servidor ficou fora do ar e o tempo foi devolvido. A prova continua.'

export function autoSubmitExtendedMessage(error) {
  return error?.data?.reason === 'server_outage' ? AUTO_SUBMIT_SERVER_OUTAGE_MESSAGE : AUTO_SUBMIT_EXTENDED_MESSAGE
}

export function countAnswered(answers) {
  return Object.values(answers || {}).filter((value) => value !== null && value !== undefined && value !== '').length
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
