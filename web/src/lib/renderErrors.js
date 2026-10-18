// Último erro de renderização (tela de erro no lugar da página). A prova consulta isto ao
// desmontar: se a tela da prova sumiu por um erro de tela, isso NÃO é saída da prova
// (vai ao Monitor como erro técnico e não trava).
const RECENT_RENDER_ERROR_MS = 3000

let lastRenderError = null

let interrupted = null

// Mensagem do erro sem endereços: no build de produção o React manda "Minified React
// error #31; visit https://...", e o Monitor guarda só o código do erro.
function errorText(error) {
  return String(error?.message || error?.statusText || error || '')
    .replace(/;\s*visit https?:\/\/\S+[\s\S]*$/, '')
    .replace(/https?:\/\/\S+/g, '')
    .trim()
    .slice(0, 300)
}

export function markRenderError(error) {
  const message = errorText(error) || 'Erro desconhecido'
  lastRenderError = { at: Date.now(), message }
  return lastRenderError
}

// "Detalhes técnicos" da tela de erro: o código do erro do React em português, sem o
// endereço da documentação; outros erros sem endereços.
export function renderErrorDetails(error) {
  const message = errorText(error)
  const minified = message.match(/^Minified React error #(\d+)/)
  return minified ? `Erro interno da tela (código React #${minified[1]})` : message
}

// Prova em andamento cuja tela foi trocada pela tela de erro (a tentativa continua aberta
// e destravada). A tela de erro da prova usa isto para confirmar e registrar a saída.
export function markInterruptedExam(context) {
  interrupted = context ? { ...context } : null
}

export function interruptedExam() {
  return interrupted
}

export function clearInterruptedExam() {
  interrupted = null
}

export function recentRenderError(windowMs = RECENT_RENDER_ERROR_MS) {
  if (!lastRenderError) return null
  return Date.now() - lastRenderError.at <= windowMs ? lastRenderError : null
}

export function clearRenderError() {
  lastRenderError = null
}
