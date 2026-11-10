import { createElement, lazy, useEffect, useState } from 'react'
import { PageLoading } from '../components/ui/PageLoading'

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
//   arquivo outra vez e a tela abre;
// - o servidor responde, mas o arquivo continua faltando: é do build anterior (uma
//   atualização do IClass apagou os arquivos antigos) ou o navegador guardou a falha da
//   busca (o Chrome não busca de novo um import que falhou na mesma página). A página
//   recarrega uma vez, pega o build novo e a tela abre.
//
// Quem fica esperando é a tela que está aberta, e não o React.lazy. O React.lazy guarda
// para sempre o resultado da primeira busca: se a falha virasse erro, toda visita
// seguinte àquela tela mostraria "Algo deu errado nesta tela" até a pessoa recarregar à
// mão (ex.: o aluno tocou em Caderno com a Wi-Fi fora, voltou para o Início e, com a
// rede de volta, tocou em Caderno de novo). Por isso a falha vira uma tela de espera
// (RecoveringPage): cada vez que ela abre, confere o servidor, busca o arquivo e, se
// precisar, recarrega a página. Quem sai da tela para a espera: nada de recarga numa tela
// que a pessoa deixou.
//
// A marca no sessionStorage impede laço: outra recarga pedida em menos de 30 s, ou sem
// sessionStorage, mostra a tela de erro com o botão de recarregar. Passados 3 minutos sem
// resposta do servidor, também.
//
// A conferência do servidor não é uma consulta periódica (usePolling, H2-C): é uma espera
// curta, com fim, só enquanto a tela de espera está aberta, encadeada por setTimeout. Vai
// com X-IClass-Background: 1, como as consultas de fundo, porque a pessoa não fez nada.
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
    const response = await fetch(currentAddress() || '/', {
      method: 'HEAD',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'X-IClass-Background': '1' },
    })
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

function pickComponent(module, exportName) {
  const component = module ? module[exportName] : undefined
  if (!component) throw new Error(`A tela "${exportName}" não foi encontrada no arquivo carregado.`)
  return component
}

// O import da tela falhou. Espera o servidor responder, busca o arquivo de novo e, se ele
// continuar faltando, recarrega uma vez. isActive() diz se a tela de espera ainda está
// aberta. Devolve um destes:
// - { component }: o arquivo chegou, a tela abre sem recarregar;
// - { reloading: true }: a página vai recarregar (a tela fica no "Carregando..." até lá);
// - { error }: recarga recente, sem sessionStorage ou 3 minutos sem servidor: tela de erro;
// - { cancelled: true }: a pessoa saiu da tela antes; nada a fazer.
export async function recoverFailedImport(loader, exportName, error, env = {}, isActive = () => true) {
  const { storage, reload, online, now, probe, sleep, waitMs } = { ...defaultEnv(), ...env }
  const startedAt = now()
  for (let attempt = 0; ; attempt += 1) {
    if (!isActive()) return { cancelled: true }
    if (online() && await probe()) break
    if (!isActive()) return { cancelled: true }
    if (now() - startedAt >= waitMs) return { error }
    await sleep(SERVER_PROBE_DELAYS_MS[Math.min(attempt, SERVER_PROBE_DELAYS_MS.length - 1)])
  }
  // Servidor no ar: com o mesmo build (queda ou reinício), o arquivo chega agora, a não
  // ser que o navegador tenha guardado a falha.
  let module = null
  try {
    module = await loader()
  } catch {
    // Continua faltando: arquivo do build anterior ou falha guardada pelo navegador.
  }
  if (module) {
    try {
      return { component: pickComponent(module, exportName) }
    } catch (missing) {
      return { error: missing }
    }
  }
  if (!isActive()) return { cancelled: true }
  if (claimReload(storage, now())) {
    reload()
    return { reloading: true }
  }
  return { error }
}

// Tela de espera no lugar da tela cujo arquivo não chegou. Cada abertura tenta de novo;
// quando o arquivo chega, esta e as próximas aberturas mostram a tela de verdade.
function createRecoveringPage(loader, exportName, firstError, env, Loading) {
  let recovered = null
  function RecoveringPage(props) {
    const [outcome, setOutcome] = useState(null)
    useEffect(() => {
      if (recovered) return undefined
      let active = true
      recoverFailedImport(loader, exportName, firstError, env, () => active)
        .then((result) => {
          if (result.component) recovered = result.component
          if (active && (result.component || result.error)) setOutcome(result)
        })
        .catch((unexpected) => { if (active) setOutcome({ error: unexpected }) })
      return () => { active = false }
    }, [])
    const Page = recovered || (outcome && outcome.component)
    if (Page) return createElement(Page, props)
    // Na tela de erro (área de erro do layout ou do roteador), com o botão de recarregar.
    if (outcome && outcome.error) throw outcome.error
    return createElement(Loading)
  }
  RecoveringPage.displayName = `RecoveringPage(${exportName})`
  return RecoveringPage
}

// Carrega o módulo da tela e devolve { default: componente }, como o React.lazy espera.
// Se o arquivo não chega, o componente é a tela de espera (RecoveringPage), e nunca um
// erro guardado pelo React.lazy. Arquivo que chega sem a tela pedida é erro de código:
// vai direto para a tela de erro.
export function loadPageModule(loader, exportName = 'default', env = {}, Loading = PageLoading) {
  return Promise.resolve()
    .then(loader)
    .then(
      (module) => ({ default: pickComponent(module, exportName) }),
      (error) => ({ default: createRecoveringPage(loader, exportName, error, env, Loading) }),
    )
}

// lazyPage(loader, exportName = 'default', options): componente React.lazy para usar
// dentro de <Suspense>. exportName para as telas exportadas pelo nome (AppShell,
// StudentShell...). options.loading: o que a tela de espera mostra (o mesmo fallback do
// Suspense em volta; padrão PageLoading). As demais opções trocam o ambiente nos testes.
export function lazyPage(loader, exportName = 'default', options = {}) {
  const { loading = PageLoading, ...env } = options || {}
  return lazy(() => loadPageModule(loader, exportName, env, loading))
}
