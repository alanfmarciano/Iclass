import { Suspense } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS, SERVER_WAIT_MS, lazyPage, loadPageModule } from './lazyPage'
import { AppErrorBoundary } from '../components/ui/ErrorScreen'
import { PageLoading } from '../components/ui/PageLoading'
import appSource from '../App.jsx?raw'
import appShellSource from '../components/layout/AppShell.jsx?raw'
import lumenShellSource from '../components/layout/LumenAdminShell.jsx?raw'
import studentShellSource from '../features/student/StudentShell.jsx?raw'
import studentExamShellSource from '../features/student/StudentExamShell.jsx?raw'

// Fase 2, H2-A (DES-06): as telas chegam sob demanda. Depois de uma atualização do
// IClass, os arquivos do build anterior somem: a aba aberta antes recarrega uma vez para
// pegar o build novo, sem laço de recargas. Com o servidor fora do ar ou sem rede, nunca
// recarrega (cairia na página de erro do navegador): espera ele voltar e busca de novo.
function chunkError() {
  return new TypeError('Failed to fetch dynamically imported module: http://192.168.0.10:3000/assets/MonitorPage-antigo.js')
}

// Relógio e espera falsos: cada espera avança o relógio, sem esperar de verdade.
function env(extra = {}) {
  const clock = { now: 1_000_000 }
  return {
    storage: sessionStorage,
    reload: vi.fn(),
    online: () => true,
    now: () => clock.now,
    probe: vi.fn(async () => true),
    sleep: vi.fn(async (ms) => { clock.now += ms }),
    address: () => '/monitor',
    clock,
    ...extra,
  }
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

  it('servidor no ar e o arquivo continua faltando (atualização): busca de novo, recarrega uma vez e fica carregando', async () => {
    const options = env()
    const loader = vi.fn(() => Promise.reject(chunkError()))
    const result = await settledWithin(loadPageModule(loader, 'default', options))
    expect(result.state).toBe('pending')
    expect(options.probe).toHaveBeenCalledTimes(1)
    expect(loader).toHaveBeenCalledTimes(2)
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

  it('servidor fora do ar (Reiniciar, queda): não recarrega; espera, confere de novo e abre a tela quando ele volta', async () => {
    // Antes, a página recarregava na hora e caía na página de erro do navegador
    // ("Não é possível acessar esse site"): o aluno saía do IClass.
    const answers = [false, false, false, true]
    const options = env({ probe: vi.fn(async () => answers.shift()) })
    function Caderno() { return null }
    const loader = vi.fn()
      .mockImplementationOnce(() => Promise.reject(chunkError()))
      .mockImplementationOnce(() => Promise.resolve({ default: Caderno }))
    const result = await settledWithin(loadPageModule(loader, 'default', options))
    expect(result).toEqual({ state: 'resolved', value: { default: Caderno } })
    expect(options.reload).not.toHaveBeenCalled()
    expect(options.probe).toHaveBeenCalledTimes(4)
    expect(options.sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 3000])
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull()
  })

  it('a espera pelo servidor cresce até 5 s e, passados 3 minutos sem resposta, mostra o erro sem recarregar', async () => {
    const options = env({ probe: vi.fn(async () => false) })
    const loader = vi.fn(() => Promise.reject(chunkError()))
    const result = await settledWithin(loadPageModule(loader, 'default', options))
    expect(result.state).toBe('rejected')
    expect(result.error.message).toMatch(/Failed to fetch dynamically imported module/)
    expect(options.reload).not.toHaveBeenCalled()
    expect(loader).toHaveBeenCalledTimes(1)
    const waits = options.sleep.mock.calls.map(([ms]) => ms)
    expect(waits.slice(0, 5)).toEqual([1000, 2000, 3000, 5000, 5000])
    expect(Math.max(...waits)).toBe(5000)
    expect(options.clock.now - 1_000_000).toBeGreaterThanOrEqual(SERVER_WAIT_MS)
    expect(options.clock.now - 1_000_000).toBeLessThan(SERVER_WAIT_MS + 5000)
  })

  it('sem rede (navigator.onLine false) não confere o servidor nem recarrega: espera a rede voltar', async () => {
    const onlineAnswers = [false, false, true]
    const options = env({ online: () => onlineAnswers.shift() ?? true })
    function Tela() { return null }
    const loader = vi.fn()
      .mockImplementationOnce(() => Promise.reject(chunkError()))
      .mockImplementationOnce(() => Promise.resolve({ default: Tela }))
    const result = await settledWithin(loadPageModule(loader, 'default', options))
    expect(result.state).toBe('resolved')
    expect(options.probe).toHaveBeenCalledTimes(1)
    expect(options.reload).not.toHaveBeenCalled()
  })

  it('quem saiu da tela enquanto o servidor estava fora não leva recarga quando ele volta', async () => {
    // Ex.: o aluno voltou para a prova (já carregada) durante o reinício.
    const addresses = ['/aluno/caderno', '/aluno/prova/P1']
    const answers = [false, true]
    const options = env({ probe: vi.fn(async () => answers.shift()), address: () => (addresses.length > 1 ? addresses.shift() : addresses[0]) })
    const result = await settledWithin(loadPageModule(() => Promise.reject(chunkError()), 'default', options))
    expect(result.state).toBe('rejected')
    expect(options.reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull()
  })

  it('sem sessionStorage (ou bloqueado) relança o erro sem recarregar (nada de laço)', async () => {
    const noStorage = env({ storage: null })
    expect((await settledWithin(loadPageModule(() => Promise.reject(chunkError()), 'default', noStorage))).state).toBe('rejected')
    expect(noStorage.reload).not.toHaveBeenCalled()

    const blocked = { getItem: () => { throw new Error('bloqueado') }, setItem: () => { throw new Error('bloqueado') } }
    const blockedEnv = env({ storage: blocked })
    expect((await settledWithin(loadPageModule(() => Promise.reject(chunkError()), 'default', blockedEnv))).state).toBe('rejected')
    expect(blockedEnv.reload).not.toHaveBeenCalled()
  })

  it('a conferência pede o endereço atual por HEAD, sem cache, e só aceita resposta 2xx', async () => {
    window.history.replaceState(null, '', '/aluno/caderno?aba=2')
    const options = env()
    delete options.probe
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const loader = vi.fn(() => Promise.reject(chunkError()))
      const result = await settledWithin(loadPageModule(loader, 'default', options))
      expect(result.state).toBe('pending')
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(fetchMock).toHaveBeenCalledWith('/aluno/caderno?aba=2', expect.objectContaining({ method: 'HEAD', cache: 'no-store' }))
      expect(options.sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000])
      expect(options.reload).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      window.history.replaceState(null, '', '/')
    }
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

  it('layouts: em volta do Outlet, área de erro → Suspense → portões → Outlet, na ordem do contrato', () => {
    const shells = {
      'AppShell.jsx': appShellSource,
      'LumenAdminShell.jsx': lumenShellSource,
      'StudentShell.jsx': studentShellSource,
      'StudentExamShell.jsx': studentExamShellSource,
    }
    let outlets = 0
    for (const [name, source] of Object.entries(shells)) {
      const lines = source.split('\n').filter((line) => line.includes('<Outlet'))
      expect(lines.length, name).toBeGreaterThan(0)
      for (const line of lines) {
        outlets += 1
        const position = (tag) => line.indexOf(tag)
        const suspense = position('<Suspense fallback={<PageLoading />}>')
        const gate = Math.max(position('<StudentCourseGate>'), position('<AdminCourseGate>'))
        const boundary = position('<AppErrorBoundary')
        expect(suspense, `${name}: Suspense em volta do Outlet`).toBeGreaterThanOrEqual(0)
        expect(gate, `${name}: portão da turma`).toBeGreaterThan(suspense)
        expect(position('<Outlet'), `${name}: Outlet dentro do portão`).toBeGreaterThan(gate)
        if (boundary >= 0) expect(boundary, `${name}: área de erro por fora do Suspense`).toBeLessThan(suspense)
      }
    }
    // AppShell, LumenAdminShell, StudentShell (clássico e lumen) e a prova.
    expect(outlets).toBe(5)
    expect(studentExamShellSource).toMatch(/<AppErrorBoundary fallback=\{ExamErrorScreen\}><Suspense fallback=\{<PageLoading \/>\}><StudentCourseGate><Outlet \/><\/StudentCourseGate><\/Suspense><\/AppErrorBoundary>/)
  })
})
