// Envio automático do fim do tempo: o navegador insiste até o servidor dar uma
// resposta definitiva, em vez de mostrar só um aviso de erro.
export const AUTO_SUBMIT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]

// Recusa do servidor ao envio automático de uma prova sem prazo (POST /api/student/submit).
export const NO_DEADLINE_CODE = 'no_deadline'

// Número que pode faltar na resposta do servidor: null, ausente, texto vazio ou valor
// que não é número viram null ("não informado"), nunca zero. Number(null) e Number('')
// valem 0, e era assim que uma prova sem prazo virava "o tempo acabou".
export function optionalNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

// Segundos que faltam na tentativa (state.timerRemaining do servidor). null = a prova
// não tem prazo ("Cronômetro ativo" desligado, sem duração ou sem início): sem
// cronômetro na tela e sem envio automático por tempo. Com prazo, nunca menos que zero.
export function remainingSeconds(value) {
  const seconds = optionalNumber(value)
  return seconds === null ? null : Math.max(0, seconds)
}

export function autoSubmitRetryDelay(attempt) {
  const index = Math.max(0, Math.min(Number(attempt) || 0, AUTO_SUBMIT_RETRY_DELAYS_MS.length - 1))
  return AUTO_SUBMIT_RETRY_DELAYS_MS[index]
}

// retry: sem rede, servidor fora do ar ou ocupado. finalized: a janela de tolerância
// passou e o servidor já entregou as respostas salvas. locked/paused: a tentativa voltou
// a depender do professor (bloqueio por foco ou aplicação pausada). extended: o
// professor deu mais tempo (ou reabriu a tentativa no "+N min" da turma) e a prova
// continua. no_deadline: a prova não tem prazo (o servidor não fecha a tentativa) e
// continua aberta, sem cronômetro. fatal: o resto.
export function classifyAutoSubmitError(error) {
  const status = Number(error?.status || 0)
  if (!status || status >= 500 || status === 429) return 'retry'
  if (status === 408 && error?.data?.deadlineExceeded) return 'finalized'
  if (status === 409 && error?.data?.code === NO_DEADLINE_CODE) return 'no_deadline'
  if (status === 409 && error?.data?.deadlineExtended) return 'extended'
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
