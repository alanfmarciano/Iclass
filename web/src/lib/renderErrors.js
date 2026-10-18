// Último erro de renderização (tela de erro no lugar da página). A prova consulta isto ao
// desmontar: se a tela da prova sumiu por um erro de tela, isso NÃO é saída da prova
// (vai ao Monitor como erro técnico e não trava).
const RECENT_RENDER_ERROR_MS = 3000

let lastRenderError = null

export function markRenderError(error) {
  // No build de produção o React manda "Minified React error #31; visit https://...":
  // o Monitor guarda só o código do erro, sem o endereço.
  const message = String(error?.message || error?.statusText || error || 'Erro desconhecido')
    .replace(/;\s*visit https?:\/\/\S+[\s\S]*$/, '')
    .slice(0, 300)
  lastRenderError = { at: Date.now(), message }
  return lastRenderError
}

export function recentRenderError(windowMs = RECENT_RENDER_ERROR_MS) {
  if (!lastRenderError) return null
  return Date.now() - lastRenderError.at <= windowMs ? lastRenderError : null
}

export function clearRenderError() {
  lastRenderError = null
}
