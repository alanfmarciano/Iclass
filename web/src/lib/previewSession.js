// Pré-visualização como aluno no navegador (fase 3, C15 / P5-S6b; CRIT-08, D21 do P5).
//
// O instrutor abre o portal da turma na mesma aba (PreviewLauncher -> POST
// /api/admin/preview-sessions). A prévia fica em sessionStorage, que é de cada aba: outra
// aba do painel continua no painel, e a sessão do instrutor (localStorage) não muda.
// O que fica guardado: o token da prévia (o servidor guarda só o hash), o prazo, o rótulo
// da faixa, o aluno virtual (sem dado pessoal), a turma, o grupo e a tela do painel de onde
// veio (origem), para o "Sair da pré-visualização" voltar para ela.
//
// lib/api.js lê daqui, na hora de cada pedido, o token que vai no cabeçalho
// x-preview-session; por isso o AuthProvider grava e apaga daqui antes de mudar o estado.
export const PREVIEW_STORAGE_KEY = 'iclass-v3-preview'
export const PREVIEW_HEADER = 'x-preview-session'
// Texto dos botões que gravam, desativados na prévia (D20/D21 do P5).
export const PREVIEW_DISABLED_TEXT = 'Desativado na pré-visualização'
export const PREVIEW_NOTHING_SAVED = 'nada é gravado'
export const PREVIEW_EXAM_TEXT = 'Na pré-visualização a prova não começa. Para ver as questões, use Provas > Visualizar.'
export const PREVIEW_DIALOG_TEXT = 'Nada do que você fizer na pré-visualização é gravado. A prova não começa.'
// Fim da prévia pelo prazo, sem resposta do servidor (o relógio da aba chegou ao expiraEm).
export const PREVIEW_EXPIRED_TEXT = 'A pré-visualização terminou (ela dura 60 minutos). Abra de novo pelo painel.'
export const PREVIEW_ENDED_FALLBACK = 'A pré-visualização terminou. Abra de novo pelo painel.'

function storage() {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { return null }
}

// Origem só dentro do painel ('/', '/turmas', '/materiais?x=1'): nunca um endereço de fora
// nem o próprio portal.
export function safePreviewOrigin(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text.startsWith('/') || text.startsWith('//') || /^\/aluno(?:[/?#]|$)/.test(text) || text.startsWith('/login')) return '/'
  return text
}

// Monta a prévia a partir da resposta do servidor (POST /api/admin/preview-sessions).
export function previewFromResponse(response, { origem = '/', adminEmail = '', now = Date.now() } = {}) {
  const aluno = response && response.aluno && typeof response.aluno === 'object' ? response.aluno : null
  const token = response && typeof response.previewToken === 'string' ? response.previewToken : ''
  const firstClass = aluno && Array.isArray(aluno.classes) ? aluno.classes[0] : null
  if (!aluno || !token || !firstClass) return null
  return {
    token,
    expiraEm: Number(response.expiraEm) || now + 60 * 60 * 1000,
    iniciadaEm: now,
    rotulo: typeof response.rotulo === 'string' && response.rotulo ? response.rotulo : `Pré-visualização como aluno de ${firstClass.name}`,
    courseId: firstClass.courseId || '',
    studentClass: firstClass.name || '',
    groupId: aluno.previewGroupId || null,
    aluno: { ...aluno, preview: true },
    origem: safePreviewOrigin(origem),
    adminEmail: String(adminEmail || '').toLowerCase(),
  }
}

export function isPreviewValid(preview, now = Date.now()) {
  return !!(preview && typeof preview === 'object' && typeof preview.token === 'string' && preview.token
    && preview.aluno && Array.isArray(preview.aluno.classes) && preview.aluno.classes.length > 0
    && Number(preview.expiraEm) > now)
}

// A prévia guardada nesta aba, ou null (vencida, quebrada ou de outra conta).
export function readStoredPreview({ adminEmail, now = Date.now() } = {}) {
  const store = storage()
  if (!store) return null
  let preview = null
  try { preview = JSON.parse(store.getItem(PREVIEW_STORAGE_KEY) || 'null') } catch { preview = null }
  if (!isPreviewValid(preview, now)) return null
  if (adminEmail !== undefined && String(preview.adminEmail || '') !== String(adminEmail || '').toLowerCase()) return null
  return preview
}

export function storePreview(preview) {
  const store = storage()
  if (!store) return
  try {
    if (preview) store.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(preview))
    else store.removeItem(PREVIEW_STORAGE_KEY)
  } catch {}
}

export function clearStoredPreview() {
  storePreview(null)
}

// Token da prévia aberta nesta aba (para o cabeçalho e os links de arquivo), ou ''.
export function currentPreviewToken(now = Date.now()) {
  const preview = readStoredPreview({ now })
  return preview ? preview.token : ''
}

// Pedido do portal (vai com o token da prévia no lugar da sessão do painel)? Tudo o que não
// é do painel: /api/admin/* e o Sair do instrutor continuam com a sessão do painel.
export function isPreviewPortalRequest(path) {
  const clean = String(path || '').split(/[?#]/)[0]
  if (/^\/api\/admin(?:\/|$)/.test(clean)) return false
  if (clean === '/api/session/logout') return false
  return true
}

// Fim da prévia dito pelo servidor (401 preview_ended num pedido com o x-preview-session):
// lib/api.js avisa daqui e o AuthProvider registra o que fazer.
let previewEndedHandler = null
export function setPreviewEndedHandler(fn) { previewEndedHandler = typeof fn === 'function' ? fn : null }
export function notifyPreviewEnded(data) {
  if (!previewEndedHandler) return
  try { previewEndedHandler(data) } catch {}
}

// Texto da faixa: 'Pré-visualização como aluno de 1DES · grupo Laboratório A · nada é gravado'.
export function previewBannerText(preview) {
  if (!preview) return ''
  return `${preview.rotulo || 'Pré-visualização como aluno'} · ${PREVIEW_NOTHING_SAVED}`
}
