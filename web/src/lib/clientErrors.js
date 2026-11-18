import { api, hasActiveSession } from './api'
import { CLIENT_BUILD } from './buildVersion'
import { errorText } from './renderErrors'
import { POLL_TIMEOUT_MS } from './requestTimeouts'

// Erro de tela registrado no servidor (fase 2, H9c: ENG-05). Antes, só o erro de tela da
// prova chegava ao professor (Monitor); no resto do portal e no painel, a tela de erro
// aparecia e ninguém ficava sabendo. Agora a área de erro dos layouts (AppErrorBoundary
// com area) e a tela de erro da raiz (RouteErrorScreen) mandam um aviso curto para
// POST /api/client-error, que grava a linha "erro de tela" no crash.log da pasta de
// dados, ao lado dos erros do servidor.
//
// reportClientError(area, error):
// - area: 'raiz', 'admin', 'aluno' ou 'prova' (outra coisa não envia);
// - a mensagem passa pelo errorText de renderErrors.js (sem endereços, até 300
//   caracteres), com o caminho da página (até 200) e a versão do build (até 64);
// - no máximo um envio por mensagem e cinco por carga da página: uma tela que quebra em
//   laço não enche o registro;
// - só com sessão aberta (a rota pede sessão; na tela de login não há a quem atribuir);
// - nunca atrapalha a tela: falha do envio é ignorada, e o envio vai como consulta de
//   fundo (X-IClass-Background), com o prazo curto das consultas periódicas.
export const CLIENT_ERROR_AREAS = ['raiz', 'admin', 'aluno', 'prova']
export const CLIENT_ERROR_MAX_PER_PAGE = 5

const sentMessages = new Set()
let sentCount = 0

function currentPath() {
  if (typeof window === 'undefined' || !window.location) return '/'
  return String(window.location.pathname || '/').slice(0, 200)
}

export function reportClientError(area, error) {
  try {
    if (!CLIENT_ERROR_AREAS.includes(area)) return false
    if (!hasActiveSession()) return false
    const message = errorText(error) || 'Erro desconhecido'
    if (sentMessages.has(message) || sentCount >= CLIENT_ERROR_MAX_PER_PAGE) return false
    sentMessages.add(message)
    sentCount += 1
    const body = { area, message, path: currentPath() }
    const build = String(CLIENT_BUILD || '').slice(0, 64)
    if (build) body.build = build
    const sending = api.post('/api/client-error', body, { background: true, timeoutMs: POLL_TIMEOUT_MS })
    if (sending && typeof sending.catch === 'function') sending.catch(() => {})
    return true
  } catch {
    return false
  }
}

// Só para os testes: esquece os envios desta carga da página.
export function resetClientErrorReportsForTests() {
  sentMessages.clear()
  sentCount = 0
}
