// Autorrecuperação depois de uma atualização do IClass. O servidor manda em toda resposta
// da API a versão do build que ele serve (cabeçalho X-IClass-Build) e este navegador
// compara com a versão do bundle que está rodando (gravada pelo Vite no build, em
// vite.config.js). Diferente: avisa "O IClass foi atualizado. Recarregando...", deixa a
// tela salvar o que estiver pendente (a prova registra a recarga como evento técnico, sem
// travar) e recarrega sozinho. Antes, um navegador com o bundle de antes da atualização
// ficava preso (na prova, "Tela cheia obrigatória" sem questões) até alguém mandar
// apertar F5.
/* global __ICLASS_BUILD__ */
export const CLIENT_BUILD = typeof __ICLASS_BUILD__ === 'string' ? __ICLASS_BUILD__ : ''
export const BUILD_HEADER = 'x-iclass-build'
export const UPDATE_RELOAD_MESSAGE = 'O IClass foi atualizado. Recarregando...'
export const UPDATE_NOTICE_ID = 'iclass-update-notice'
// Evento técnico neutro da prova recarregada pela atualização (Monitor: não travou a prova).
export const UPDATE_RELOAD_EVENT = 'exam_update_reload'
// Tempo para o aviso aparecer e as gravações pendentes saírem (keepalive) antes da recarga.
export const UPDATE_RELOAD_DELAY_MS = 1500
const RELOAD_GUARD_KEY = 'iclass-update-reload'

// Só no build de produção: no `vite dev` e nos testes o bundle não tem versão fixa.
const ENABLED = !!import.meta.env.PROD && !!CLIENT_BUILD

let reloadScheduled = false
const beforeReload = new Set()

// A tela registra o que fazer logo antes da recarga (salvar respostas, marcar que não é
// saída da prova). Devolve a função que desfaz o registro.
export function onBeforeUpdateReload(fn) {
  beforeReload.add(fn)
  return () => { beforeReload.delete(fn) }
}

// A recarga da atualização já foi pedida (as telas não tratam a descarga como saída).
export function updateReloadPending() {
  return reloadScheduled
}

function sessionStore() {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { return null }
}

function readGuard(storage) {
  try { return storage ? storage.getItem(RELOAD_GUARD_KEY) || '' : '' } catch { return '' }
}

function writeGuard(storage, value) {
  try {
    if (!storage) return
    if (value) storage.setItem(RELOAD_GUARD_KEY, value)
    else storage.removeItem(RELOAD_GUARD_KEY)
  } catch { /* sem armazenamento: segue sem a trava de laço */ }
}

function showUpdateNotice() {
  if (typeof document === 'undefined' || !document.body || document.getElementById(UPDATE_NOTICE_ID)) return
  const notice = document.createElement('div')
  notice.id = UPDATE_NOTICE_ID
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  notice.className = 'fixed inset-x-0 top-0 z-[1000] bg-primary px-4 py-3 text-center text-sm font-semibold text-primary-fg shadow-lg'
  notice.textContent = UPDATE_RELOAD_MESSAGE
  document.body.appendChild(notice)
}

// Versão do servidor vista numa resposta. Devolve true quando agendou a recarga.
export function noteServerBuild(serverBuild, {
  clientBuild = CLIENT_BUILD,
  enabled = ENABLED,
  reload = () => window.location.reload(),
  storage = sessionStore(),
  delayMs = UPDATE_RELOAD_DELAY_MS,
} = {}) {
  const server = String(serverBuild || '').trim()
  if (!enabled || !server || !clientBuild) return false
  if (server === clientBuild) {
    // Bundle em dia: libera a trava para a próxima atualização.
    if (readGuard(storage)) writeGuard(storage, '')
    return false
  }
  if (reloadScheduled) return false
  // Já recarregou por esta versão e o bundle continua outro (cache, proxy): não entra em
  // laço de recargas; a próxima atualização volta a valer.
  if (readGuard(storage) === server) return false
  writeGuard(storage, server)
  reloadScheduled = true
  showUpdateNotice()
  for (const fn of [...beforeReload]) {
    try { fn() } catch { /* uma tela com erro não impede a recarga */ }
  }
  setTimeout(() => { reload() }, delayMs)
  return true
}

// Só para os testes: volta ao estado de antes de qualquer recarga agendada.
export function resetUpdateReloadForTests() {
  reloadScheduled = false
  beforeReload.clear()
  if (typeof document !== 'undefined') document.getElementById(UPDATE_NOTICE_ID)?.remove()
}
