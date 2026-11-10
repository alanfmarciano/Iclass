// Painel do professor conforme o aparelho (SEG-03). O servidor decide (Sistema → Rede,
// settings.network.adminAccess) e conta como esta conexão é tratada em GET /api/connection:
// { secure, thisComputer, adminAccess: 'ok'|'local-only'|'https-required', adminAccessMode,
//   insecureAdmin, tlsAvailable, studentsHttps, httpsUrl }.
import { api } from './api'

export const ADMIN_ACCESS_MODES = Object.freeze({
  OPEN: 'rede-sem-https',
  LOCAL: 'local',
  SECURE: 'rede',
})

// Texto fixo do servidor para o painel recusado fora do computador do IClass.
export const LOCAL_ONLY_TEXT = 'O painel do professor só abre no computador onde o IClass está ligado. O administrador pode liberar outros aparelhos em Sistema → Rede.'
export const HTTPS_REQUIRED_TEXT = 'O painel do professor em outro aparelho só abre pela conexão segura (https), e ela ainda não está disponível neste IClass. Use o painel no computador onde o IClass está ligado.'
// Aviso fixo quando o painel abre por http em outro aparelho ('rede-sem-https'). O link
// "Usar conexão segura" (guia /certificado) entra com a conexão segura (H6c).
export const INSECURE_ADMIN_TITLE = 'Conexão sem proteção'
export const INSECURE_ADMIN_TEXT = 'Neste aparelho, a senha e os dados do painel passam pela rede da sala sem proteção: outra pessoa conectada à mesma rede pode ver o que trafega. Se puder, use o painel no computador onde o IClass está ligado.'

export const ADMIN_ACCESS_OPTIONS = Object.freeze([
  {
    value: ADMIN_ACCESS_MODES.OPEN,
    label: 'Todos os aparelhos da rede',
    description: 'Como antes: o painel abre em qualquer aparelho da rede da sala. Fora do computador do IClass, a senha passa pela rede sem proteção, e a tela avisa.',
  },
  {
    value: ADMIN_ACCESS_MODES.LOCAL,
    label: 'Só o computador do IClass',
    description: 'O painel só abre no computador onde o IClass está ligado. Outros aparelhos veem um aviso e não entram. Os alunos continuam entrando normalmente.',
  },
  {
    value: ADMIN_ACCESS_MODES.SECURE,
    label: 'Outros aparelhos só com conexão segura',
    description: 'Outros aparelhos entram só pela conexão segura (https), e cada um precisa instalar o certificado do IClass antes.',
    unavailable: 'Ainda não disponível: esta versão do IClass ainda não tem a conexão segura (https).',
  },
])

export function adminAccessLabel(mode) {
  return (ADMIN_ACCESS_OPTIONS.find((option) => option.value === mode) || ADMIN_ACCESS_OPTIONS[0]).label
}

// Texto do aviso para uma recusa (403 com adminAccess, ou /api/connection).
export function adminAccessRefusalText(adminAccess, serverText) {
  if (serverText) return serverText
  if (adminAccess === 'local-only') return LOCAL_ONLY_TEXT
  if (adminAccess === 'https-required') return HTTPS_REQUIRED_TEXT
  return ''
}

// Uma consulta, sem sessão. Falha de rede devolve null (a tela segue sem aviso).
export async function fetchConnectionInfo() {
  try {
    return await api.get('/api/connection', { auth: false })
  } catch {
    return null
  }
}
