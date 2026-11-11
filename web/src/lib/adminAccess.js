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
// Com a conexão segura funcionando (a recusa traz httpsUrl) ou sem ela (httpsUrl null).
export const HTTPS_REQUIRED_TEXT = 'O painel do professor em outro aparelho só abre pela conexão segura (https). Abra o endereço seguro. Se o navegador avisar que a conexão não é particular, instale antes o certificado do IClass neste aparelho: o passo a passo está na página /certificado.'
export const HTTPS_UNAVAILABLE_TEXT = 'O painel do professor em outro aparelho só abre pela conexão segura (https), e ela não está funcionando neste IClass agora. Use o painel no computador onde o IClass está ligado; o motivo aparece em Sistema → Rede.'
// Guia público de instalação do certificado e o arquivo da CA (H6c, OPS-08).
export const CERTIFICATE_GUIDE_PATH = '/certificado'
export const CA_DOWNLOAD_PATH = '/iclass-ca.crt'
export const SECURE_CONNECTION_LINK_TEXT = 'Usar conexão segura'
// Aviso fixo quando o painel abre por http em outro aparelho ('rede-sem-https'), com o
// link "Usar conexão segura" para o guia /certificado (H6c).
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
    description: 'Outros aparelhos entram só pela conexão segura (https). Antes de trocar, instale o certificado do IClass em cada aparelho dos professores (guia em /certificado): sem ele, o navegador avisa que a conexão não é particular.',
    unavailable: 'Indisponível agora: a conexão segura (https) não está funcionando para os outros aparelhos da rede. O motivo aparece abaixo, em "Conexão segura".',
  },
])

export function adminAccessLabel(mode) {
  return (ADMIN_ACCESS_OPTIONS.find((option) => option.value === mode) || ADMIN_ACCESS_OPTIONS[0]).label
}

// Texto do aviso para uma recusa (403 com adminAccess, ou /api/connection). httpsUrl
// (opcional) separa "abra o endereço seguro" de "a conexão segura não está funcionando".
export function adminAccessRefusalText(adminAccess, serverText, httpsUrl) {
  if (serverText) return serverText
  if (adminAccess === 'local-only') return LOCAL_ONLY_TEXT
  if (adminAccess === 'https-required') return httpsUrl === null ? HTTPS_UNAVAILABLE_TEXT : HTTPS_REQUIRED_TEXT
  return ''
}

// Endereço seguro do login do professor (https://IP:porta/login?mode=admin), ou ''.
export function secureAdminLoginUrl(httpsUrl) {
  if (typeof httpsUrl !== 'string' || !/^https:\/\//.test(httpsUrl)) return ''
  return `${httpsUrl.replace(/\/+$/, '')}/login?mode=admin`
}

// Data de validade do certificado, por extenso curto (dd/mm/aaaa). Texto vazio se inválida.
export function formatCertificateDate(value) {
  const time = Date.parse(value || '')
  if (!Number.isFinite(time)) return ''
  return new Date(time).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Uma consulta, sem sessão. Falha de rede devolve null (a tela segue sem aviso).
export async function fetchConnectionInfo() {
  try {
    return await api.get('/api/connection', { auth: false })
  } catch {
    return null
  }
}
