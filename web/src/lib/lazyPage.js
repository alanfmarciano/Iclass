import { lazy } from 'react'

// Telas carregadas sob demanda (fase 2, H2-A: DES-06). Cada tela vira um arquivo próprio
// do build: o celular do aluno não baixa mais o painel do instrutor, e a primeira
// abertura cai de 1,5 MB para cerca de 100 KB em gzip. Toda tela nova do App.jsx entra
// com lazyPage(() => import('./caminho/da/Tela')).
//
// O arquivo de uma tela pode não chegar por dois motivos, e cada um pede uma coisa:
// - o servidor está fora do ar (Reiniciar, queda, build sendo refeito) ou a Wi-Fi caiu:
//   recarregar a página levaria à página de erro do navegador ("Não é possível acessar
//   esse site") e tiraria a pessoa do IClass. A tela fica no "Carregando..." e confere o
//   servidor de novo (1 s, 2 s, 3 s e depois a cada 5 s). Quando ele volta, busca o
//   arquivo outra vez e a tela abre sem recarregar;
// - o servidor responde, mas o arquivo é do build anterior (uma atualização do IClass
//   apagou os arquivos antigos): a página recarrega uma vez, pega o build novo e a tela
//   abre. Só recarrega se a pessoa ainda está na tela que esperava o arquivo.
// A marca no sessionStorage impede laço: outra falha em menos de 30 s, ou sem
// sessionStorage, mostra a tela de erro com o botão de recarregar. Passados 3 minutos sem
// resposta do servidor, também.
export const CHUNK_RELOAD_KEY = 'iclass-chunk-reload'
export const CHUNK_RELOAD_WINDOW_MS = 30000
export const SERVER_WAIT_MS = 3 * 60 * 1000
export const SERVER_PROBE_DELAYS_MS = [1000, 2000, 3000, 5000]

function sessionStore() {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { return null }
}

function currentAddress() {
  if (typeof window === 'undefined' || !window.location) return ''
  return `${window.location.pathname}${window.location.search}`
}

// O servidor entrega a página de novo? Pede o mesmo endereço que a recarga pediria
// (HEAD, sem cache): só uma resposta 2xx vale. Erro de rede, 503 do build sendo refeito
// ou do servidor iniciando: ainda não.
async function serverAnswers() {
  if (typeof fetch !== 'function') return false
  try {
    const response = await fetch(currentAddress() || '/', { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
    return !!response && response.ok
  } catch {
    return false
  }
}

function defaultEnv() {
  return {
    storage: sessionStore(),
    reload: () => window.location.reload(),
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    now: () => Date.now(),
    probe: serverAnswers,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    address: currentAddress,
    waitMs: SERVER_WAIT_MS,
  }
}

// Tenta marcar a recarga. Devolve false quando não deve recarregar (marca recente ou
// sem onde guardar a marca).
function claimReload(storage, now) {
  if (!storage) return false
  try {
    const last = Number(storage.getItem(CHUNK_RELOAD_KEY) || 0)
    if (last && now - last >= 0 && now - last < CHUNK_RELOAD_WINDOW_MS) return false
    storage.setItem(CHUNK_RELOAD_KEY, String(now))
    return true
  } catch {
    return false
  }
}

// O import da tela falhou. Espera o servidor responder, busca o arquivo de novo e, se ele
// continuar faltando, recarrega uma vez. Devolve o módulo, uma promise que não resolve (a
// página vai recarregar) ou relança o erro (tela de erro do app).
async function recoverFailedImport(loader, error, env) {
  const { storage, reload, online, now, probe, sleep, address, waitMs } = env
  const startedAt = now()
  const waitingAt = address()
  for (let attempt = 0; ; attempt += 1) {
    if (online() && await probe()) break
    if (now() - startedAt >= waitMs) throw error
    await sleep(SERVER_PROBE_DELAYS_MS[Math.min(attempt, SERVER_PROBE_DELAYS_MS.length - 1)])
  }
  // Servidor no ar: com o mesmo build (queda ou reinício), o arquivo chega agora.
  try {
    return await loader()
  } catch {
    // Continua faltando: arquivo do build anterior.
  }
  if (address() === waitingAt && claimReload(storage, now())) {
    reload()
    // A página vai recarregar: a tela fica no "Carregando..." até lá.
    return new Promise(() => {})
  }
  throw error
}

// Carrega o módulo da tela e devolve { default: componente }, como o React.lazy espera.
export function loadPageModule(loader, exportName = 'default', env = {}) {
  const options = { ...defaultEnv(), ...env }
  return Promise.resolve()
    .then(loader)
    .catch((error) => recoverFailedImport(loader, error, options))
    .then((module) => {
      const component = module ? module[exportName] : undefined
      if (!component) throw new Error(`A tela "${exportName}" não foi encontrada no arquivo carregado.`)
      return { default: component }
    })
}

// lazyPage(loader, exportName = 'default'): componente React.lazy para usar dentro de
// <Suspense>. exportName para as telas exportadas pelo nome (AppShell, StudentShell...).
export function lazyPage(loader, exportName = 'default', env) {
  return lazy(() => loadPageModule(loader, exportName, env))
}
