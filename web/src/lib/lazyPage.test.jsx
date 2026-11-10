import { Suspense } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS, lazyPage, loadPageModule } from './lazyPage'
import { AppErrorBoundary } from '../components/ui/ErrorScreen'
import { PageLoading } from '../components/ui/PageLoading'
import appSource from '../App.jsx?raw'

// Fase 2, H2-A (DES-06): as telas chegam sob demanda. Depois de uma atualização do
// IClass, os arquivos do build anterior somem: a aba aberta antes recarrega uma vez para
// pegar o build novo, sem laço de recargas e sem recarregar quando está sem rede.
function chunkError() {
  return new TypeError('Failed to fetch dynamically imported module: http://192.168.0.10:3000/assets/MonitorPage-antigo.js')
}

function env(extra = {}) {
  return { storage: sessionStorage, reload: vi.fn(), online: () => true, now: () => 1_000_000, ...extra }
}

async function settledWithin(promise, ms = 50) {
  return Promise.race([
    promise.then((value) => ({ state: 'resolved', value }), (error) => ({ state: 'rejected', error })),
    new Promise((resolve) => setTimeout(() => resolve({ state: 'pending' }), ms)),
  ])
}

beforeEach(() => { sessionStorage.clear() })
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks() })

describe('[UC-DESEMPENHO-001] lazyPage: telas sob demanda e recarga depois de uma atualização', () => {
  it('carrega a exportação padrão ou a exportação pelo nome', async () => {
    function Tela() { return null }
    await expect(loadPageModule(() => Promise.resolve({ default: Tela }), 'default', env())).resolves.toEqual({ default: Tela })
    await expect(loadPageModule(() => Promise.resolve({ AppShell: Tela }), 'AppShell', env())).resolves.toEqual({ default: Tela })
  })

  it('primeira falha do import recarrega a página uma vez e fica carregando até a recarga', async () => {
    const options = env()
    const result = await settledWithin(loadPageModule(() => Promise.reject(chunkError()), 'default', options))
    expect(result.state).toBe('pending')
    expect(options.reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBe('1000000')
  })

  it('segunda falha em menos de 30 s não recarrega de novo: mostra o erro', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(1_000_000 - CHUNK_RELOAD_WINDOW_MS + 1))
    const options = env()
    const result = await settledWithin(loadPageModule(() => Promise.reject(chunkError()), 'default', options))
    expect(result.state).toBe('rejected')
    expect(result.error.message).toMatch(/Failed to fetch dynamically imported module/)
    expect(options.reload).not.toHaveBeenCalled()
  })

  it('passados 30 s da última recarga, uma nova atualização recarrega outra vez', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(1_000_000 - CHUNK_RELOAD_WINDOW_MS))
    const options = env()
    const result = await settledWithin(loadPageModule(() => Promise.reject(chunkError()), 'default', options))
    expect(result.state).toBe('pending')
    expect(options.reload).toHaveBeenCalledTimes(1)
  })

  it('sem rede ou sem sessionStorage relança o erro sem recarregar (nada de laço)', async () => {
    const offline = env({ online: () => false })
    expect((await settledWithin(loadPageModule(() => Promise.reject(chunkError()), 'default', offline))).state).toBe('rejected')
    expect(offline.reload).not.toHaveBeenCalled()

    const noStorage = env({ storage: null })
    expect((await settledWithin(loadPageModule(() => Promise.reject(chunkError()), 'default', noStorage))).state).toBe('rejected')
    expect(noStorage.reload).not.toHaveBeenCalled()

    const blocked = { getItem: () => { throw new Error('bloqueado') }, setItem: () => { throw new Error('bloqueado') } }
    const blockedEnv = env({ storage: blocked })
    expect((await settledWithin(loadPageModule(() => Promise.reject(chunkError()), 'default', blockedEnv))).state).toBe('rejected')
    expect(blockedEnv.reload).not.toHaveBeenCalled()
  })

  it('arquivo carregado sem a tela pedida é erro, sem recarga', async () => {
    const options = env()
    const result = await settledWithin(loadPageModule(() => Promise.resolve({ Outra: () => null }), 'AppShell', options))
    expect(result.state).toBe('rejected')
    expect(result.error.message).toBe('A tela "AppShell" não foi encontrada no arquivo carregado.')
    expect(options.reload).not.toHaveBeenCalled()
  })

  it('dentro do Suspense mostra "Carregando..." e depois a tela; com a falha repetida, a tela de erro', async () => {
    let resolveModule
    const pending = new Promise((resolve) => { resolveModule = resolve })
    const Tela = lazyPage(() => pending, 'default', env())
    render(<Suspense fallback={<PageLoading />}><Tela /></Suspense>)
    expect(screen.getByRole('status')).toHaveTextContent('Carregando...')
    await act(async () => { resolveModule({ default: () => <p>Tela do Monitor</p> }) })
    expect(await screen.findByText('Tela do Monitor')).toBeInTheDocument()
    cleanup()

    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(1_000_000))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Quebrada = lazyPage(() => Promise.reject(chunkError()), 'default', env())
    render(<AppErrorBoundary><Suspense fallback={<PageLoading />}><Quebrada /></Suspense></AppErrorBoundary>)
    expect(await screen.findByText('Algo deu errado nesta tela')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recarregar a página' })).toBeVisible()
    consoleError.mockRestore()
  })

  it('App.jsx carrega todas as telas e layouts com lazyPage; só o login fica no pacote inicial', () => {
    const staticImports = [...appSource.matchAll(/^import\s+.+?\s+from\s+['"](\.\/[^'"]+)['"]/gm)].map((match) => match[1])
    const screens = staticImports.filter((specifier) => /^\.\/features\/|^\.\/components\/layout\//.test(specifier))
    expect(screens).toEqual(['./features/LoginPage'])
    const lazyScreens = [...appSource.matchAll(/lazyPage\(\(\) => import\('([^']+)'\)/g)].map((match) => match[1])
    // 24 telas do instrutor, 8 do aluno, a prova e os 3 layouts.
    expect(lazyScreens.length).toBe(36)
    expect(lazyScreens).toContain('./features/student/exam/ExamRunner')
    expect(lazyScreens).toContain('./components/layout/AppShell')
    expect(appSource).toMatch(/<Suspense fallback=\{<SessionLoading \/>\}>/)
  })
})
