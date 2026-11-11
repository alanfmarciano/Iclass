import { Suspense } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS, SERVER_PROBE_TIMEOUT_MS, SERVER_WAIT_MS, lazyPage, loadPageModule, recoverFailedImport } from './lazyPage'
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

  it('import que falha nunca vira erro guardado pelo React.lazy: vira a tela de espera', async () => {
    // O React.lazy guarda para sempre o resultado da primeira busca. Antes, a falha virava
    // erro (ou uma promise que não resolvia) e ficava guardada.
    const loaded = await settledWithin(loadPageModule(() => Promise.reject(chunkError()), 'default', env()))
    expect(loaded.state).toBe('resolved')
    expect(typeof loaded.value.default).toBe('function')
    expect(loaded.value.default.displayName).toBe('RecoveringPage(default)')
  })

  it('servidor no ar e o arquivo continua faltando (atualização): busca de novo, recarrega uma vez e fica carregando', async () => {
    const options = env()
    const loader = vi.fn(() => Promise.reject(chunkError()))
    const result = await recoverFailedImport(loader, 'default', chunkError(), options)
    expect(result).toEqual({ reloading: true })
    expect(options.probe).toHaveBeenCalledTimes(1)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(options.reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBe('1000000')
  })

  it('segunda recarga em menos de 30 s não acontece: mostra o erro', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(1_000_000 - CHUNK_RELOAD_WINDOW_MS + 1))
    const options = env()
    const result = await recoverFailedImport(() => Promise.reject(chunkError()), 'default', chunkError(), options)
    expect(result.error.message).toMatch(/Failed to fetch dynamically imported module/)
    expect(options.reload).not.toHaveBeenCalled()
  })

  it('passados 30 s da última recarga, uma nova atualização recarrega outra vez', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(1_000_000 - CHUNK_RELOAD_WINDOW_MS))
    const options = env()
    const result = await recoverFailedImport(() => Promise.reject(chunkError()), 'default', chunkError(), options)
    expect(result).toEqual({ reloading: true })
    expect(options.reload).toHaveBeenCalledTimes(1)
  })

  it('servidor fora do ar (Reiniciar, queda): não recarrega; espera, confere de novo e abre a tela quando ele volta', async () => {
    // Antes, a página recarregava na hora e caía na página de erro do navegador
    // ("Não é possível acessar esse site"): o aluno saía do IClass.
    const answers = [false, false, false, true]
    const options = env({ probe: vi.fn(async () => answers.shift()) })
    function Caderno() { return null }
    const loader = vi.fn(() => Promise.resolve({ default: Caderno }))
    const result = await recoverFailedImport(loader, 'default', chunkError(), options)
    expect(result).toEqual({ component: Caderno })
    expect(options.reload).not.toHaveBeenCalled()
    expect(options.probe).toHaveBeenCalledTimes(4)
    expect(options.sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 3000])
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull()
  })

  it('a espera pelo servidor cresce até 5 s e, passados 3 minutos sem resposta, mostra o erro sem recarregar', async () => {
    const options = env({ probe: vi.fn(async () => false) })
    const loader = vi.fn(() => Promise.reject(chunkError()))
    const result = await recoverFailedImport(loader, 'default', chunkError(), options)
    expect(result.error.message).toMatch(/Failed to fetch dynamically imported module/)
    expect(options.reload).not.toHaveBeenCalled()
    expect(loader).not.toHaveBeenCalled()
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
    const result = await recoverFailedImport(() => Promise.resolve({ default: Tela }), 'default', chunkError(), options)
    expect(result).toEqual({ component: Tela })
    expect(options.probe).toHaveBeenCalledTimes(1)
    expect(options.reload).not.toHaveBeenCalled()
  })

  it('quem saiu da tela enquanto o servidor estava fora não leva recarga quando ele volta', async () => {
    // Ex.: o aluno voltou para a prova (já carregada) durante o reinício.
    let open = true
    const answers = [false, true]
    const options = env({ probe: vi.fn(async () => answers.shift()) })
    options.sleep = vi.fn(async (ms) => { options.clock.now += ms; open = false })
    const loader = vi.fn(() => Promise.reject(chunkError()))
    const result = await recoverFailedImport(loader, 'default', chunkError(), options, () => open)
    expect(result).toEqual({ cancelled: true })
    expect(loader).not.toHaveBeenCalled()
    expect(options.reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull()
  })

  it('sem sessionStorage (ou bloqueado) mostra o erro sem recarregar (nada de laço)', async () => {
    const noStorage = env({ storage: null })
    expect((await recoverFailedImport(() => Promise.reject(chunkError()), 'default', chunkError(), noStorage)).error).toBeTruthy()
    expect(noStorage.reload).not.toHaveBeenCalled()

    const blocked = { getItem: () => { throw new Error('bloqueado') }, setItem: () => { throw new Error('bloqueado') } }
    const blockedEnv = env({ storage: blocked })
    expect((await recoverFailedImport(() => Promise.reject(chunkError()), 'default', chunkError(), blockedEnv)).error).toBeTruthy()
    expect(blockedEnv.reload).not.toHaveBeenCalled()
  })

  it('a conferência pede o endereço atual por HEAD, sem cache, como consulta de fundo, e só aceita resposta 2xx', async () => {
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
      const result = await recoverFailedImport(loader, 'default', chunkError(), options)
      expect(result).toEqual({ reloading: true })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(fetchMock).toHaveBeenCalledWith('/aluno/caderno?aba=2', expect.objectContaining({
        method: 'HEAD',
        cache: 'no-store',
        headers: expect.objectContaining({ 'X-IClass-Background': '1' }),
      }))
      expect(options.sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000])
      expect(options.reload).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      window.history.replaceState(null, '', '/')
    }
  })

  it('com o servidor travado (aceita a conexão e não responde), cada conferência tem prazo e os 3 minutos de espera valem', async () => {
    // Fase 2, H2-C: antes, o HEAD de conferência não tinha prazo; com o servidor travado
    // o fetch ficava pendurado, a espera nunca chegava aos 3 minutos e a tela ficava no
    // "Carregando..." para sempre, sem o botão de recarregar.
    vi.useFakeTimers()
    const options = env({
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
    delete options.probe
    const fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('cancelado', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const loader = vi.fn(() => Promise.reject(chunkError()))
      let result = null
      recoverFailedImport(loader, 'default', chunkError(), options).then((value) => { result = value })
      // Uma conferência pendurada desiste no prazo e a próxima sai depois da espera de 1 s.
      await vi.advanceTimersByTimeAsync(SERVER_PROBE_TIMEOUT_MS)
      expect(result).toBeNull()
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(SERVER_WAIT_MS + SERVER_PROBE_TIMEOUT_MS)
      expect(result).not.toBeNull()
      expect(result.error).toBeTruthy()
      expect(loader).not.toHaveBeenCalled()
      expect(options.reload).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('arquivo carregado sem a tela pedida é erro, sem recarga', async () => {
    const options = env()
    const result = await settledWithin(loadPageModule(() => Promise.resolve({ Outra: () => null }), 'AppShell', options))
    expect(result.state).toBe('rejected')
    expect(result.error.message).toBe('A tela "AppShell" não foi encontrada no arquivo carregado.')
    expect(options.reload).not.toHaveBeenCalled()
    const recovered = await recoverFailedImport(() => Promise.resolve({ Outra: () => null }), 'AppShell', chunkError(), options)
    expect(recovered.error.message).toBe('A tela "AppShell" não foi encontrada no arquivo carregado.')
    expect(options.reload).not.toHaveBeenCalled()
  })

  it('dentro do Suspense mostra "Carregando..." e depois a tela; com a recarga recente, a tela de erro', async () => {
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

  it('a tela de espera mostra o que o layout pediu (options.loading)', async () => {
    function EsperaDoLayout() { return <p>Esperando o layout</p> }
    const Layout = lazyPage(() => Promise.reject(chunkError()), 'AppShell', { ...env({ probe: vi.fn(async () => false), sleep: () => new Promise(() => {}) }), loading: EsperaDoLayout })
    render(<Suspense fallback={<PageLoading />}><Layout /></Suspense>)
    expect(await screen.findByText('Esperando o layout')).toBeInTheDocument()
  })

  // Sala com Wi-Fi instável: o aluno toca em Caderno (ainda não carregado) com a rede fora,
  // volta para o Início, a rede volta e ele toca em Caderno de novo. Antes, a falha ficava
  // guardada pelo React.lazy e toda visita ao Caderno mostrava "Algo deu errado nesta
  // tela", sem recarga, até o aluno recarregar o navegador à mão.
  function roomNetwork() {
    const network = { up: false }
    const options = {
      storage: sessionStorage,
      reload: vi.fn(),
      online: () => true,
      now: () => Date.now(),
      probe: vi.fn(async () => network.up),
      sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    }
    return { network, options }
  }

  function Portal({ page: Page }) {
    return <AppErrorBoundary><Suspense fallback={<PageLoading />}>{Page ? <Page /> : <p>Início do aluno</p>}</Suspense></AppErrorBoundary>
  }

  it('tela que falhou com a rede fora e foi deixada: na volta, com a rede no ar, recarrega uma vez em vez da tela de erro', async () => {
    const { network, options } = roomNetwork()
    // O Chrome guarda a falha do import: buscar de novo na mesma página falha sempre.
    const loader = vi.fn(() => Promise.reject(chunkError()))
    const Caderno = lazyPage(loader, 'default', options)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      window.history.replaceState(null, '', '/aluno/caderno')
      const view = render(<Portal page={Caderno} />)
      expect(await screen.findByRole('status')).toHaveTextContent('Carregando...')
      await waitFor(() => expect(options.probe).toHaveBeenCalled())

      // Volta para o Início ainda sem rede; a rede volta com ele lá.
      window.history.replaceState(null, '', '/aluno')
      view.rerender(<Portal />)
      expect(screen.getByText('Início do aluno')).toBeInTheDocument()
      network.up = true
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(options.reload).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull()

      // Toca em Caderno de novo.
      window.history.replaceState(null, '', '/aluno/caderno')
      view.rerender(<Portal page={Caderno} />)
      await waitFor(() => expect(options.reload).toHaveBeenCalledTimes(1))
      expect(screen.queryByText('Algo deu errado nesta tela')).not.toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent('Carregando...')
    } finally {
      consoleError.mockRestore()
      window.history.replaceState(null, '', '/')
    }
  })

  it('tela que falhou e foi deixada: se o arquivo chega na volta, abre sem recarregar, e as próximas visitas abrem direto', async () => {
    const { network, options } = roomNetwork()
    function CadernoReal() { return <p>Caderno do aluno</p> }
    const loader = vi.fn()
      .mockImplementationOnce(() => Promise.reject(chunkError()))
      .mockImplementation(() => Promise.resolve({ default: CadernoReal }))
    const Caderno = lazyPage(loader, 'default', options)
    const view = render(<Portal page={Caderno} />)
    expect(await screen.findByRole('status')).toHaveTextContent('Carregando...')
    view.rerender(<Portal />)
    network.up = true
    view.rerender(<Portal page={Caderno} />)
    expect(await screen.findByText('Caderno do aluno')).toBeInTheDocument()
    expect(options.reload).not.toHaveBeenCalled()
    const calls = loader.mock.calls.length
    view.rerender(<Portal />)
    view.rerender(<Portal page={Caderno} />)
    expect(screen.getByText('Caderno do aluno')).toBeInTheDocument()
    expect(loader.mock.calls.length).toBe(calls)
  })

  it('App.jsx carrega todas as telas e layouts com lazyPage; só o login fica no pacote inicial', () => {
    const staticImports = [...appSource.matchAll(/^import\s+.+?\s+from\s+['"](\.\/[^'"]+)['"]/gm)].map((match) => match[1])
    const screens = staticImports.filter((specifier) => /^\.\/features\/|^\.\/components\/layout\//.test(specifier))
    expect(screens).toEqual(['./features/LoginPage'])
    const lazyScreens = [...appSource.matchAll(/lazyPage\(\(\) => import\('([^']+)'\)/g)].map((match) => match[1])
    // 28 telas do instrutor (a Auditoria entrou no H7a-2, a Privacidade (LGPD) no H8a-1, o
    // Endereço da sala em tela cheia no H6a e Cadastros encerrados no H7c), 10 do aluno (com
    // Minha conta, H5a, e Meus dados, H8c), a prova, a página pública dos Termos e da
    // Privacidade (H8a-1), o guia público do certificado (/certificado, H6c) e os 3 layouts.
    expect(lazyScreens.length).toBe(44)
    expect(lazyScreens).toContain('./features/CertificadoPage')
    expect(lazyScreens).toContain('./features/admin/EnderecoSalaPage')
    expect(lazyScreens).toContain('./features/student/MeusDadosPage')
    expect(lazyScreens).toContain('./features/admin/CadastrosEncerradosPage')
    expect(lazyScreens).toContain('./features/student/ContaPage')
    expect(lazyScreens).toContain('./features/admin/AuditoriaPage')
    expect(lazyScreens).toContain('./features/admin/PrivacidadePage')
    expect(lazyScreens).toContain('./features/LegalDocumentPage')
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
    // Fase 2, H5a e H8a-2 (contrato dos layouts): no portal do aluno, a troca de senha
    // obrigatória e depois o primeiro acesso (StudentPrivacyGate) ficam entre o Suspense
    // e o portão da turma (nos dois layouts); a prova não passa por nenhum dos dois.
    for (const line of studentShellSource.split('\n').filter((text) => text.includes('<Outlet'))) {
      expect(line).toContain('<Suspense fallback={<PageLoading />}><StudentPasswordChangeGate><StudentPrivacyGate><StudentCourseGate><Outlet /></StudentCourseGate></StudentPrivacyGate></StudentPasswordChangeGate></Suspense>')
    }
    expect(studentExamShellSource).not.toContain('StudentPasswordChangeGate')
    expect(studentExamShellSource).not.toContain('StudentPrivacyGate')
    expect(studentExamShellSource).toMatch(/<AppErrorBoundary area="prova" fallback=\{ExamErrorScreen\}><Suspense fallback=\{<PageLoading \/>\}><StudentCourseGate><Outlet \/><\/StudentCourseGate><\/Suspense><\/AppErrorBoundary>/)
    // Fase 2, H9c (ENG-05): todo Outlet tem a área de erro, com a área certa para o
    // registro no servidor e o texto do layout (o menu continua à vista).
    for (const [name, source, area, description] of [
      ['AppShell.jsx', appShellSource, 'admin', 'ADMIN_ERROR_DESCRIPTION'],
      ['LumenAdminShell.jsx', lumenShellSource, 'admin', 'ADMIN_ERROR_DESCRIPTION'],
      ['StudentShell.jsx', studentShellSource, 'aluno', 'STUDENT_ERROR_DESCRIPTION'],
    ]) {
      for (const line of source.split('\n').filter((text) => text.includes('<Outlet'))) {
        expect(line, name).toContain(`<AppErrorBoundary area="${area}" description={${description}}><Suspense`)
        expect(line, `${name}: área de erro dentro do div com key={pathname}`).toMatch(/key=\{pathname\}[^>]*>\s*<AppErrorBoundary|^\s*<AppErrorBoundary/)
      }
    }
  })
})
