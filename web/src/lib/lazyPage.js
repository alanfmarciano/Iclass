import { lazy } from 'react'

// Telas carregadas sob demanda (fase 2, H2-A: DES-06). Cada tela vira um arquivo próprio
// do build: o celular do aluno não baixa mais o painel do instrutor, e a primeira
// abertura cai de 1,5 MB para cerca de 100 KB em gzip. Toda tela nova do App.jsx entra
// com lazyPage(() => import('./caminho/da/Tela')).
//
// Depois de uma atualização do IClass, os arquivos do build anterior somem do servidor:
// uma aba aberta antes que abre uma tela ainda não carregada recebe 404 no import. Aqui
// a página recarrega uma vez (pega o build novo) e a tela abre. A marca no
// sessionStorage impede laço: outra falha em menos de 30 s, sem rede (navigator.onLine
// false) ou sem sessionStorage mostra a tela de erro com o botão de recarregar.
export const CHUNK_RELOAD_KEY = 'iclass-chunk-reload'
export const CHUNK_RELOAD_WINDOW_MS = 30000

function sessionStore() {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { return null }
}

function defaultEnv() {
  return {
    storage: sessionStore(),
    reload: () => window.location.reload(),
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    now: () => Date.now(),
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

// Carrega o módulo da tela e devolve { default: componente }, como o React.lazy espera.
export function loadPageModule(loader, exportName = 'default', env = {}) {
  const { storage, reload, online, now } = { ...defaultEnv(), ...env }
  return Promise.resolve().then(loader).then((module) => {
    const component = module ? module[exportName] : undefined
    if (!component) throw new Error(`A tela "${exportName}" não foi encontrada no arquivo carregado.`)
    return { default: component }
  }, (error) => {
    if (online() && claimReload(storage, now())) {
      reload()
      // A página vai recarregar: a tela fica no "Carregando..." até lá.
      return new Promise(() => {})
    }
    throw error
  })
}

// lazyPage(loader, exportName = 'default'): componente React.lazy para usar dentro de
// <Suspense>. exportName para as telas exportadas pelo nome (AppShell, StudentShell...).
export function lazyPage(loader, exportName = 'default', env) {
  return lazy(() => loadPageModule(loader, exportName, env))
}
