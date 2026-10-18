import { useState } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { examDraftStorageKey, importExamDraftKey, readExamDraft, writeExamDraft } from '../../../lib/examDrafts'

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
// Sessão aberta no navegador (o logout a fecha antes de o portal ir para o login).
const sessionMock = vi.hoisted(() => vi.fn(() => true))
const toast = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../../../lib/api', () => ({ api: apiMock, hasActiveSession: sessionMock }))
vi.mock('../useStudent', () => ({ useStudent: () => ({ email: 'ana@escola.local', studentClass: '1DES', courseId: 'curso' }) }))
vi.mock('../../../context/ToastProvider', () => ({ useToast: () => toast }))

import ExamRunner from './ExamRunner'
import { AppErrorBoundary } from '../../../components/ui/ErrorScreen'
import { ExamErrorScreen } from './ExamErrorScreen'
import { clearInterruptedExam, clearRenderError } from '../../../lib/renderErrors'

const EXAM = 'Avaliacao_Ciclo'
// Chave da cópia local que o servidor entrega ao dono da tentativa (32 bytes em base64).
const LOCAL_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => (index * 37 + 11) % 256)))

async function localKey(raw = LOCAL_KEY) {
  return importExamDraftKey(raw)
}

async function writeCopy(attemptId, answers, saved, raw = LOCAL_KEY) {
  await writeExamDraft({ attemptId, applicationId: 'app-1', cryptoKey: await localKey(raw), answers, saved })
}

async function readCopy(attemptId = 'att-1') {
  if (localStorage.getItem(examDraftStorageKey(attemptId)) === null) return null
  return readExamDraft({ attemptId, cryptoKey: await localKey() })
}

function syncResponse({ timerRemaining = 600, answers = {}, attemptOutcome = null, startedAt = Date.now() - 1000, status = 'running', finishOutcome = null, localCopyKey, timeOver = false, reopenedAt = null } = {}) {
  return {
    success: true,
    onlineExamConfigs: {
      [EXAM]: {
        applicationId: 'app-1',
        status,
        onlineActive: true,
        startTime: Date.now() - 60000,
        durationMinutes: 30,
        timerMode: 'per_attempt',
        maxAttempts: 1,
        versionSnapshots: [{
          version: 'A',
          questions: [{ originalNumber: 1, text: 'Quanto é 1 + 1?', alternatives: [{ letter: 'A', text: 'Dois' }, { letter: 'B', text: 'Três' }, { letter: 'C', text: 'Onze' }] }],
        }],
      },
    },
    examConfigVersion: 'v1',
    applicationId: 'app-1',
    attemptId: startedAt ? 'att-1' : null,
    state: startedAt ? { attemptId: 'att-1', startedAt, timerRemaining, answers, assignedVersion: 'A', status: 'active', ...(reopenedAt ? { reopenedAt } : {}) } : {},
    attemptsUsed: attemptOutcome ? 1 : 0,
    maxAttempts: 1,
    messages: [],
    questionReports: [],
    attemptOutcome,
    finishOutcome,
    timeOver,
    localCopyKey: localCopyKey === undefined ? (startedAt ? LOCAL_KEY : null) : localCopyKey,
  }
}

// Roteador de dados como o do app (main.jsx): o ExamRunner usa useBlocker. A página
// anterior no histórico é o início do portal, para testar o voltar do navegador.
function renderRunner(history = ['/aluno'], element = <ExamRunner />) {
  const router = createMemoryRouter([
    { path: '/aluno/prova/:examKey', element },
    { path: '/aluno/provas', element: <p>Lista de provas</p> },
    { path: '/aluno/modulos', element: <p>Página de módulos</p> },
    { path: '/aluno', element: <p>Início do portal</p> },
    { path: '/login', element: <p>Tela de login</p> },
  ], { initialEntries: [...history, `/aluno/prova/${EXAM}?applicationId=app-1`], initialIndex: history.length })
  const view = render(<RouterProvider router={router} />)
  router.unmountView = view.unmount
  return router
}

// jsdom não tem tela cheia: o navegador de teste ganha a API (como um computador) e
// enterFullscreen simula a página já em tela cheia.
function installFullscreenApi() {
  Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, writable: true, value: vi.fn(async () => {}) })
}

function removeFullscreenApi() {
  delete Element.prototype.requestFullscreen
  delete Element.prototype.webkitRequestFullscreen
}

function enterFullscreen() {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.body })
  act(() => { document.dispatchEvent(new Event('fullscreenchange')) })
}

function postsTo(path) {
  return apiMock.post.mock.calls.filter(([url]) => url === path)
}

beforeEach(() => {
  apiMock.get.mockReset()
  apiMock.post.mockReset()
  apiMock.post.mockResolvedValue({ success: true })
  sessionMock.mockReset()
  sessionMock.mockReturnValue(true)
  Object.values(toast).forEach((fn) => fn.mockReset())
  sessionStorage.clear()
  localStorage.clear()
  installFullscreenApi()
})

afterEach(() => {
  cleanup()
  delete document.fullscreenElement
  removeFullscreenApi()
})

describe('[UC-TENTATIVA-001] ExamRunner: fim do tempo, salvamento e recarga', () => {
  it('congela as respostas no zero e insiste no envio automático até o servidor confirmar (CONF-01, UXA-01)', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 2 }))
    let submits = 0
    apiMock.post.mockImplementation(async (url) => {
      if (url !== '/api/student/submit') return { success: true }
      submits += 1
      if (submits === 1) throw new TypeError('Failed to fetch')
      return { success: true, gradePublished: false, answeredCount: 1 }
    })
    renderRunner()
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Dois/ }))

    expect(await screen.findByText('Tempo esgotado', {}, { timeout: 4000 })).toBeVisible()
    expect(screen.queryByRole('button', { name: /Três/ })).not.toBeInTheDocument()
    expect(await screen.findByText(/Sem conexão com o servidor/, {}, { timeout: 3000 })).toBeVisible()
    expect(await screen.findByText('Prova enviada!', {}, { timeout: 4000 })).toBeVisible()
    expect(screen.getByText('1 resposta registrada.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Voltar ao início' })).toBeVisible()

    const calls = postsTo('/api/student/submit')
    expect(calls).toHaveLength(2)
    calls.forEach(([, body]) => expect(body).toMatchObject({ auto: true, attemptId: 'att-1', answers: { 1: 'A' }, examConfigVersion: 'v1' }))
    expect(await readCopy()).toBeNull()
  }, 15000)

  it('manda junto com a sincronização as respostas que mudaram desde o último salvamento (CONF-X4)', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    renderRunner()
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Três/ }))
    await waitFor(async () => expect(await readCopy()).toMatchObject({ attemptId: 'att-1', answers: { 1: 'B' }, saved: false }))

    await waitFor(() => expect(postsTo('/api/student/autosave-progress').length).toBeGreaterThan(0), { timeout: 6000 })
    const [, body] = postsTo('/api/student/autosave-progress')[0]
    expect(body).toMatchObject({ attemptId: 'att-1', answers: { 1: 'B' } })
    await waitFor(async () => expect((await readCopy())?.saved).toBe(true))
  }, 15000)

  it('ao recarregar (ou abrir outra aba) restaura da cópia cifrada o que o servidor ainda não tinha e salva (AVA-11)', async () => {
    await writeCopy('att-1', { 1: 'C' }, false)
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600, answers: {} }))
    renderRunner()
    enterFullscreen()
    expect(await screen.findByText('1/1 respondidas')).toBeVisible()
    await waitFor(() => expect(postsTo('/api/student/autosave-progress').length).toBeGreaterThan(0), { timeout: 6000 })
    expect(postsTo('/api/student/autosave-progress')[0][1]).toMatchObject({ attemptId: 'att-1', answers: { 1: 'C' } })
  }, 15000)

  it('ao sair ou recarregar a página envia as respostas pendentes com keepalive (AVA-11)', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    renderRunner()
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Onze/ }))
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    const call = postsTo('/api/student/autosave-progress').find(([, , options]) => options?.keepalive === true)
    expect(call).toBeTruthy()
    expect(call[1]).toMatchObject({ attemptId: 'att-1', answers: { 1: 'C' } })
  })

  it('recarregar a página registra a saída da página (o servidor destrava se a sessão voltar em 60 s) e a aba oculta da descarga não conta como troca de aba', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Onze/ })
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    try {
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    } finally {
      delete document.hidden
    }
    const left = activityLogs('exam_left')
    expect(left).toHaveLength(1)
    expect(left[0][1]).toMatchObject({ details: 'Página da prova foi fechada ou recarregada', pageExit: true, attemptId: 'att-1' })
    expect(left[0][2]).toMatchObject({ keepalive: true })
    expect(activityLogs('tab_blur')).toHaveLength(0)

    // Página restaurada do cache do navegador: trocar de aba volta a contar.
    act(() => { window.dispatchEvent(new Event('pageshow')) })
    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(activityLogs('tab_blur')).toHaveLength(1)
  })

  it('tentativa entregue pelo servidor no fim do tempo enquanto a página estava sem rede: reenvia o que só esta página tinha (UXA-01)', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValueOnce(syncResponse({ timerRemaining: 600 }))
    apiMock.get.mockResolvedValue(syncResponse({
      startedAt: null,
      attemptOutcome: { attemptId: 'att-1', finalizedByServer: true, source: 'deadline_server_auto_submit', answeredCount: 0 },
    }))
    apiMock.post.mockImplementation(async (url) => {
      if (url === '/api/student/autosave-progress') throw new TypeError('Failed to fetch')
      if (url === '/api/student/submit') return { success: true, replacedServerFinalization: true, answeredCount: 1, lateBySeconds: 95 }
      return { success: true }
    })
    renderRunner()
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Dois/ }))

    expect(await screen.findByText('Prova enviada!', {}, { timeout: 7000 })).toBeVisible()
    expect(apiMock.get.mock.calls[1][0]).toContain('attemptId=att-1')
    expect(postsTo('/api/student/submit')[0][1]).toMatchObject({ auto: true, attemptId: 'att-1', answers: { 1: 'A' } })
    expect(screen.getByText(/95 s depois do fim do tempo/)).toBeVisible()
    expect(await readCopy()).toBeNull()
  }, 15000)

  it('depois de recarregar, tentativa já finalizada no servidor: apaga a cópia (ilegível sem a chave) e só mostra a entrega', async () => {
    await writeCopy('att-1', { 1: 'A' }, false)
    apiMock.get.mockResolvedValue(syncResponse({
      startedAt: null,
      attemptOutcome: { attemptId: 'att-1', finalizedByServer: true, source: 'deadline_server_auto_submit', answeredCount: 1 },
    }))
    renderRunner()
    expect(await screen.findByText('Tempo esgotado: prova entregue')).toBeVisible()
    expect(apiMock.get.mock.calls[0][0]).toContain('attemptId=att-1')
    expect(postsTo('/api/student/submit')).toHaveLength(0)
    expect(localStorage.getItem(examDraftStorageKey('att-1'))).toBeNull()
  })

  it('a cópia gravada no aparelho é cifrada: sem as respostas em texto e sem a chave (AVA-11)', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    renderRunner()
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Onze/ }))
    await waitFor(() => expect(localStorage.getItem(examDraftStorageKey('att-1'))).not.toBeNull())
    const stored = localStorage.getItem(examDraftStorageKey('att-1'))
    expect(stored).not.toContain('"answers"')
    expect(stored).not.toContain(LOCAL_KEY)
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(LOCAL_KEY)
    expect(await readCopy()).toMatchObject({ answers: { 1: 'C' } })
  })

  it('apaga as cópias de outras tentativas e alunos encontradas no aparelho (AVA-11)', async () => {
    const otherKey = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)))
    await writeCopy('att-de-outro-aluno', { 1: 'B' }, false, otherKey)
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    renderRunner()
    enterFullscreen()
    expect(await screen.findByText('0/1 respondidas')).toBeVisible()
    await waitFor(() => expect(localStorage.getItem(examDraftStorageKey('att-de-outro-aluno'))).toBeNull())
    expect(postsTo('/api/student/autosave-progress')).toHaveLength(0)
  })

  it('sem a chave do servidor (ou sem WebCrypto) a prova segue sem cópia local', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600, localCopyKey: null }))
    renderRunner()
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Dois/ }))
    expect(screen.getByText('1/1 respondidas')).toBeVisible()
    expect(localStorage.length).toBe(0)
  })

  it('o tempo coletivo acaba enquanto o aluno lê as instruções: Iniciar leva à tela de tempo esgotado', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ startedAt: null }))
    apiMock.post.mockImplementation(async (url) => {
      if (url.endsWith('/start-attempt')) {
        throw Object.assign(new Error('O tempo desta aplicação já terminou.'), { status: 409, data: { timeOver: true } })
      }
      return { success: true }
    })
    renderRunner()
    await user.click(await screen.findByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Iniciar prova' }))
    expect(await screen.findByText('Não foi possível abrir a prova')).toBeVisible()
    expect(screen.getByText(/O tempo desta aplicação já terminou/)).toBeVisible()
  })

  it('o "+N min" da turma reabre a tentativa entregue no fim do tempo: a tela sai de "entregue" e volta às questões (AVA-03)', async () => {
    const user = userEvent.setup()
    let delivered = false
    apiMock.get.mockImplementation(async () => (delivered
      ? syncResponse({ timerRemaining: 300, answers: { 1: 'A' }, reopenedAt: Date.now() })
      : syncResponse({ timerRemaining: 2 })))
    apiMock.post.mockImplementation(async (url) => {
      if (url !== '/api/student/submit') return { success: true }
      delivered = true
      return { success: true, gradePublished: false, answeredCount: 1 }
    })
    renderRunner()
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Dois/ }))
    expect(await screen.findByText('Prova enviada!', {}, { timeout: 5000 })).toBeVisible()

    expect(await screen.findByRole('button', { name: /Três/ }, { timeout: 6000 })).toBeVisible()
    expect(toast.info).toHaveBeenCalledWith('O professor deu mais tempo à turma: sua prova foi reaberta.')
    expect(screen.getByText('1/1 respondidas')).toBeVisible()
    expect(screen.queryByText('Prova enviada!')).not.toBeInTheDocument()
    expect(postsTo('/api/student/submit')).toHaveLength(1)
  }, 15000)

  it('página aberta depois da entrega ("Tentativas esgotadas") volta às questões quando o "+N min" da turma reabre a tentativa (G1-mais5)', async () => {
    let reopened = false
    apiMock.get.mockImplementation(async () => (reopened
      ? syncResponse({ timerRemaining: 277, answers: { 1: 'A' }, reopenedAt: Date.now() })
      : { ...syncResponse({ startedAt: null }), attemptsUsed: 1 }))
    renderRunner()
    expect(await screen.findByText(/Tentativas esgotadas/)).toBeVisible()
    reopened = true
    enterFullscreen()
    expect(await screen.findByRole('button', { name: /Três/ }, { timeout: 6000 })).toBeVisible()
    expect(toast.info).toHaveBeenCalledWith('O professor deu mais tempo à turma: sua prova foi reaberta.')
    expect(screen.getByText('1/1 respondidas')).toBeVisible()
    expect(screen.queryByText(/Tentativas esgotadas/)).not.toBeInTheDocument()
    expect(postsTo('/api/student/submit')).toHaveLength(0)
  }, 15000)

  it('página que mostrava "o tempo desta aplicação já terminou" volta às questões quando a tentativa é reaberta (G1-mais5)', async () => {
    let reopened = false
    apiMock.get.mockImplementation(async () => (reopened
      ? syncResponse({ timerRemaining: 290, answers: { 1: 'B' }, reopenedAt: Date.now() })
      : syncResponse({ startedAt: null, timeOver: true })))
    renderRunner()
    expect(await screen.findByText(/O tempo desta aplicação já terminou/)).toBeVisible()
    reopened = true
    enterFullscreen()
    expect(await screen.findByRole('button', { name: /Três/ }, { timeout: 6000 })).toBeVisible()
    expect(screen.queryByText(/O tempo desta aplicação já terminou/)).not.toBeInTheDocument()
    expect(screen.getByText('1/1 respondidas')).toBeVisible()
  }, 15000)

  it('envio automático que o servidor recusa porque o professor deu mais tempo: a prova continua sem entregar', async () => {
    const user = userEvent.setup()
    let extended = false
    apiMock.get.mockImplementation(async () => syncResponse({ timerRemaining: extended ? 300 : 2, answers: extended ? { 1: 'A' } : {} }))
    apiMock.post.mockImplementation(async (url) => {
      if (url !== '/api/student/submit') return { success: true }
      extended = true
      throw Object.assign(new Error('O professor deu mais tempo. A prova continua.'), { status: 409, data: { deadlineExtended: true, timerRemaining: 300 } })
    })
    renderRunner()
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Dois/ }))
    await waitFor(() => expect(postsTo('/api/student/submit')).toHaveLength(1), { timeout: 4000 })
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('O professor deu mais tempo. A prova continua.'))
    expect(await screen.findByRole('button', { name: /Três/ }, { timeout: 4000 })).toBeVisible()
    expect(screen.getByText('1/1 respondidas')).toBeVisible()
    expect(screen.queryByText('Prova enviada!')).not.toBeInTheDocument()
    expect(postsTo('/api/student/submit')).toHaveLength(1)
  }, 15000)

  it('aplicação encerrada com "desconsiderar" mostra a entrega de quem já tinha sido entregue no fim do tempo', async () => {
    apiMock.get.mockResolvedValue(syncResponse({
      startedAt: null,
      status: 'finished',
      finishOutcome: 'delivered',
      attemptOutcome: { attemptId: 'att-1', finalizedByServer: true, source: 'deadline_server_auto_submit', answeredCount: 2 },
    }))
    renderRunner()
    expect(await screen.findByText('Tempo esgotado: prova entregue')).toBeVisible()
    expect(screen.getByText('2 respostas registradas.')).toBeVisible()
    expect(screen.queryByText(/desconsiderou/)).not.toBeInTheDocument()
  })

  it('aplicação encerrada sem tentativa deste aluno desconsiderada mostra só que foi encerrada', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ startedAt: null, status: 'finished', finishOutcome: null }))
    renderRunner()
    expect(await screen.findByText('Esta aplicação foi encerrada pelo professor.')).toBeVisible()
    expect(screen.queryByText(/desconsiderou/)).not.toBeInTheDocument()
  })
})

// Identificadores opacos que o servidor manda no lugar da letra original (AVA-05).
const IDS = { dois: 'K1QW0Z8V3M2PA', tres: '0B7XN4R2T9LQC', onze: 'Z9Y8X7W6V5U4T' }

// Versão embaralhada: na tela a ordem é Três (A), Dois (B), Onze (C).
function withIds(response) {
  const question = response.onlineExamConfigs[EXAM].versionSnapshots[0].questions[0]
  question.alternatives = [
    { id: IDS.tres, letter: IDS.tres, text: 'Três' },
    { id: IDS.dois, letter: IDS.dois, text: 'Dois' },
    { id: IDS.onze, letter: IDS.onze, text: 'Onze' },
  ]
  return response
}

function startedAttemptResponse() {
  return { success: true, attemptId: 'att-1', examConfigVersion: 'v1', localCopyKey: LOCAL_KEY, state: { attemptId: 'att-1', startedAt: Date.now(), timerRemaining: 600, answers: {}, assignedVersion: 'A' } }
}

function activityLogs(eventType) {
  return postsTo('/api/student/log-activity').filter(([, body]) => body.eventType === eventType)
}

describe('[UC-PROVA-003] ExamRunner: letras da posição, tela cheia e saída da prova', () => {
  it('mostra a letra da posição na versão do aluno e responde com o identificador da alternativa (AVA-05)', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(withIds(syncResponse({ timerRemaining: 600 })))
    renderRunner()
    enterFullscreen()
    const tres = await screen.findByRole('button', { name: /Três/ })
    expect(within(tres).getByText('A')).toBeVisible()
    expect(within(screen.getByRole('button', { name: /Dois/ })).getByText('B')).toBeVisible()
    expect(within(screen.getByRole('button', { name: /Onze/ })).getByText('C')).toBeVisible()
    expect(screen.queryByText(IDS.tres)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Dois/ }))
    expect(screen.getByRole('button', { name: /Dois/ })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(postsTo('/api/student/autosave-progress').length).toBeGreaterThan(0), { timeout: 6000 })
    expect(postsTo('/api/student/autosave-progress')[0][1]).toMatchObject({ attemptId: 'att-1', answers: { 1: IDS.dois } })
  }, 15000)

  it('ao recarregar, a resposta salva (identificador) volta marcada na alternativa certa (AVA-05)', async () => {
    apiMock.get.mockResolvedValue(withIds(syncResponse({ timerRemaining: 600, answers: { 1: IDS.onze } })))
    renderRunner()
    enterFullscreen()
    expect(await screen.findByText('1/1 respondidas')).toBeVisible()
    expect(screen.getByRole('button', { name: /Onze/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Três/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('letra avulsa de uma cópia antiga do aparelho vira o identificador depois que o servidor confirma (AVA-05)', async () => {
    await writeCopy('att-1', { 1: 'B' }, false)
    apiMock.get.mockResolvedValueOnce(withIds(syncResponse({ timerRemaining: 600, answers: {} })))
    apiMock.get.mockResolvedValue(withIds(syncResponse({ timerRemaining: 600, answers: { 1: IDS.dois } })))
    renderRunner()
    enterFullscreen()
    expect(await screen.findByText('1/1 respondidas')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: /Dois/ })).toHaveAttribute('aria-pressed', 'true'), { timeout: 7000 })
    expect(postsTo('/api/student/autosave-progress')[0][1]).toMatchObject({ answers: { 1: 'B' } })
    const saves = postsTo('/api/student/autosave-progress').length
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 4500)) })
    expect(postsTo('/api/student/autosave-progress')).toHaveLength(saves)
  }, 20000)

  it('aparelho sem tela cheia (iPhone): a prova abre sem exigir tela cheia, avisa o aluno e registra uma vez para o Monitor (UXA-02)', async () => {
    removeFullscreenApi()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    renderRunner()
    expect(await screen.findByRole('button', { name: /Dois/ })).toBeVisible()
    expect(screen.queryByText('Tela cheia obrigatória')).not.toBeInTheDocument()
    expect(screen.getByText(/Este aparelho não permite tela cheia/)).toBeVisible()
    await waitFor(() => expect(activityLogs('fullscreen_unsupported')).toHaveLength(1))
    expect(activityLogs('fullscreen_unsupported')[0][1]).toMatchObject({ attemptId: 'att-1', applicationId: 'app-1' })
    await waitFor(() => expect(apiMock.get.mock.calls.length).toBeGreaterThan(1), { timeout: 6000 })
    expect(activityLogs('fullscreen_unsupported')).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Prova pausada' })).not.toBeInTheDocument()
  }, 15000)

  it('Iniciar prova sem API de tela cheia leva às questões, não a uma tela de tela cheia sem saída (UXA-02)', async () => {
    const user = userEvent.setup()
    removeFullscreenApi()
    apiMock.get.mockResolvedValueOnce(syncResponse({ startedAt: null }))
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    apiMock.post.mockImplementation(async (url) => (url.endsWith('/start-attempt') ? startedAttemptResponse() : { success: true }))
    renderRunner()
    expect(await screen.findByText(/Este aparelho não permite/)).toBeVisible()
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Iniciar prova' }))
    expect(await screen.findByRole('button', { name: /Dois/ })).toBeVisible()
    expect(screen.queryByText('Tela cheia obrigatória')).not.toBeInTheDocument()
  })

  it('com tela cheia disponível, Iniciar prova pede a tela cheia e as questões só aparecem nela', async () => {
    const user = userEvent.setup()
    Element.prototype.requestFullscreen = vi.fn(async function requestFullscreen() { enterFullscreen() })
    apiMock.get.mockResolvedValueOnce(syncResponse({ startedAt: null }))
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    apiMock.post.mockImplementation(async (url) => (url.endsWith('/start-attempt') ? startedAttemptResponse() : { success: true }))
    renderRunner()
    await user.click(await screen.findByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Iniciar prova' }))
    expect(Element.prototype.requestFullscreen).toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: /Dois/ })).toBeVisible()
    expect(screen.queryByText(/Este aparelho não permite/)).not.toBeInTheDocument()
    expect(activityLogs('fullscreen_unsupported')).toHaveLength(0)
  })

  it('voltar à prova com a página já em tela cheia mostra as questões (antes ficava presa em "Voltar à tela cheia")', async () => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.body })
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    renderRunner()
    expect(await screen.findByRole('button', { name: /Dois/ })).toBeVisible()
    expect(screen.queryByText('Tela cheia obrigatória')).not.toBeInTheDocument()
  })

  it('voltar do navegador durante a prova pede confirmação; continuar mantém a prova e sair registra no Monitor (AVA-12, UXA-X1)', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    const router = renderRunner()
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Dois/ }))

    await act(async () => { router.navigate(-1) })
    expect(await screen.findByRole('dialog', { name: 'Sair da prova agora?' })).toBeVisible()
    expect(screen.getByText('Você usou o botão voltar do navegador.')).toBeVisible()
    expect(router.state.location.pathname).toBe(`/aluno/prova/${EXAM}`)
    await user.click(screen.getByRole('button', { name: 'Continuar na prova' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(router.state.location.pathname).toBe(`/aluno/prova/${EXAM}`)
    expect(screen.getByRole('button', { name: /Dois/ })).toHaveAttribute('aria-pressed', 'true')
    expect(activityLogs('exam_left')).toHaveLength(0)

    await act(async () => { router.navigate(-1) })
    await user.click(await screen.findByRole('button', { name: 'Salvar e sair' }))
    expect(await screen.findByText('Início do portal')).toBeVisible()
    expect(router.state.location.pathname).toBe('/aluno')
    expect(activityLogs('exam_left')).toHaveLength(1)
    expect(activityLogs('exam_left')[0][1]).toMatchObject({ attemptId: 'att-1', details: 'Saiu da prova pelo botão voltar do navegador' })
    expect(postsTo('/api/student/autosave-progress').some(([, body]) => body.answers?.[1] === 'A')).toBe(true)
  }, 15000)

  it('link para outra página do portal durante a prova pede confirmação e registra a saída (AVA-12)', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    const router = renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    await act(async () => { router.navigate('/aluno/modulos') })
    expect(await screen.findByText('Você tentou abrir outra página do portal.')).toBeVisible()
    expect(screen.queryByText('Página de módulos')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Salvar e sair' }))
    expect(await screen.findByText('Página de módulos')).toBeVisible()
    expect(activityLogs('exam_left')[0][1]).toMatchObject({ details: 'Saiu da prova por um link do portal' })
  })

  it('o botão Sair da prova confirma uma vez só e leva à lista de provas; o login (sessão encerrada) não é bloqueado', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    await user.click(screen.getByRole('button', { name: 'Sair', exact: true }))
    await user.click(await screen.findByRole('button', { name: 'Salvar e sair' }))
    expect(await screen.findByText('Lista de provas')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(activityLogs('exam_left')).toHaveLength(1)
    expect(activityLogs('exam_left')[0][1]).toMatchObject({ details: 'Aluno saiu usando o botão da prova' })

    // Sessão encerrada (logout ou revogação): a ida ao login passa sem perguntar e sem
    // registrar saída (a sessão acabou de fato, não foi o aluno que saiu).
    cleanup()
    apiMock.post.mockClear()
    const router = renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    sessionMock.mockReturnValue(false)
    await act(async () => { router.navigate('/login') })
    expect(await screen.findByText('Tela de login')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(activityLogs('exam_left')).toHaveLength(0)
  })

  it('com a sessão aberta, voltar pela lista do histórico até a entrada do login também pede confirmação e registra (AVA-12, UXA-X1)', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    // Login, início do portal, lista de provas e a prova: history.go(-3) é escolher o
    // login na lista do botão voltar (toque longo no Safari do iPhone).
    const router = renderRunner(['/login', '/aluno', '/aluno/provas'])
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Dois/ }))

    await act(async () => { router.navigate(-3) })
    expect(await screen.findByRole('dialog', { name: 'Sair da prova agora?' })).toBeVisible()
    expect(screen.getByText('Você usou o botão voltar do navegador.')).toBeVisible()
    expect(router.state.location.pathname).toBe(`/aluno/prova/${EXAM}`)
    expect(screen.queryByText('Tela de login')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Continuar na prova' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Dois/ })).toHaveAttribute('aria-pressed', 'true')
    expect(activityLogs('exam_left')).toHaveLength(0)

    await act(async () => { router.navigate(-3) })
    await user.click(await screen.findByRole('button', { name: 'Salvar e sair' }))
    expect(await screen.findByText('Tela de login')).toBeVisible()
    expect(activityLogs('exam_left')).toHaveLength(1)
    expect(activityLogs('exam_left')[0][1]).toMatchObject({ attemptId: 'att-1', details: 'Saiu da prova pelo botão voltar do navegador' })
    expect(postsTo('/api/student/autosave-progress').some(([, body]) => body.answers?.[1] === 'A')).toBe(true)
  }, 15000)

  it('saída que escapa da confirmação (desmontagem com a prova em andamento) salva as respostas e fica registrada no Monitor', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    const router = renderRunner()
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Dois/ }))
    act(() => { router.unmountView() })
    const left = activityLogs('exam_left')
    expect(left).toHaveLength(1)
    expect(left[0][1]).toMatchObject({ attemptId: 'att-1', applicationId: 'app-1', examKey: EXAM, details: 'Saiu da prova pela navegação' })
    expect(left[0][2]).toMatchObject({ keepalive: true })
    const saves = postsTo('/api/student/autosave-progress')
    expect(saves.at(-1)[1]).toMatchObject({ answers: { 1: 'A' } })
    expect(saves.at(-1)[2]).toMatchObject({ keepalive: true })
  })

  it('desmontagem por fim da sessão salva as respostas sem registrar saída', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    const router = renderRunner()
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Dois/ }))
    sessionMock.mockReturnValue(false)
    act(() => { router.unmountView() })
    expect(activityLogs('exam_left')).toHaveLength(0)
    expect(postsTo('/api/student/autosave-progress').at(-1)[1]).toMatchObject({ answers: { 1: 'A' } })
  })

  it('erro de tela durante a prova não conta como saída: tela de erro em português e erro técnico no Monitor, sem travar (G4)', async () => {
    const user = userEvent.setup()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    clearRenderError()
    let quebrar = null
    // Um pedaço da tela da prova que quebra na renderização (como um enunciado malformado).
    function PedacoDaProva() {
      const [quebrado, setQuebrado] = useState(false)
      quebrar = () => setQuebrado(true)
      if (quebrado) throw new Error('Cannot read properties of undefined (reading \'map\')')
      return null
    }
    try {
      apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
      renderRunner(['/aluno'], <AppErrorBoundary><ExamRunner /><PedacoDaProva /></AppErrorBoundary>)
      enterFullscreen()
      await user.click(await screen.findByRole('button', { name: /Dois/ }))
      act(() => { quebrar() })
      expect(await screen.findByText('Algo deu errado nesta tela')).toBeVisible()
      expect(screen.getByRole('button', { name: 'Recarregar a página' })).toBeVisible()
      expect(activityLogs('exam_left')).toHaveLength(0)
      const technical = activityLogs('exam_render_error')
      expect(technical).toHaveLength(1)
      expect(technical[0][1]).toMatchObject({ attemptId: 'att-1', applicationId: 'app-1', examKey: EXAM })
      expect(technical[0][1].details).toMatch(/^Erro técnico na tela da prova: Cannot read properties of undefined/)
      expect(postsTo('/api/student/autosave-progress').at(-1)[1]).toMatchObject({ answers: { 1: 'A' } })
    } finally {
      consoleError.mockRestore()
      clearRenderError()
    }
  })

  it('depois de um erro de tela na prova, o voltar do navegador pede confirmação e a saída fica registrada no Monitor (G4)', async () => {
    const user = userEvent.setup()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    clearRenderError()
    clearInterruptedExam()
    let quebrar = null
    function PedacoDaProva() {
      const [quebrado, setQuebrado] = useState(false)
      quebrar = () => setQuebrado(true)
      if (quebrado) throw new Error('Minified React error #31; visit https://reactjs.org/docs/error-decoder.html?invariant=31 for the full message')
      return null
    }
    try {
      apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
      const router = renderRunner(['/aluno'], <AppErrorBoundary fallback={ExamErrorScreen}><ExamRunner /><PedacoDaProva /></AppErrorBoundary>)
      enterFullscreen()
      await user.click(await screen.findByRole('button', { name: /Dois/ }))
      act(() => { quebrar() })
      expect(await screen.findByText('Algo deu errado nesta tela')).toBeVisible()
      // Detalhes técnicos sem o endereço da documentação e em português.
      expect(screen.getByText('Erro interno da tela (código React #31)')).toBeInTheDocument()
      expect(screen.queryByText(/https?:/)).not.toBeInTheDocument()
      expect(activityLogs('exam_left')).toHaveLength(0)

      await act(async () => { router.navigate(-1) })
      expect(await screen.findByRole('dialog', { name: 'Sair da prova agora?' })).toBeVisible()
      expect(screen.getByText('Você usou o botão voltar do navegador.')).toBeVisible()
      expect(router.state.location.pathname).toBe(`/aluno/prova/${EXAM}`)
      expect(activityLogs('exam_left')).toHaveLength(0)
      await user.click(screen.getByRole('button', { name: 'Sair da prova' }))
      await waitFor(() => expect(router.state.location.pathname).toBe('/aluno'))
      const left = activityLogs('exam_left')
      expect(left).toHaveLength(1)
      expect(left[0][1]).toMatchObject({ attemptId: 'att-1', applicationId: 'app-1', examKey: EXAM, studentClass: '1DES', email: 'ana@escola.local' })
      expect(left[0][1].details).toBe('Saiu da prova pelo botão voltar do navegador (depois de um erro de tela)')
      // Saída já registrada: fechar a página depois não registra de novo.
      act(() => { window.dispatchEvent(new Event('pagehide')) })
      expect(activityLogs('exam_left')).toHaveLength(1)
    } finally {
      consoleError.mockRestore()
      clearRenderError()
      clearInterruptedExam()
    }
  })

  it('depois de um erro de tela na prova, sair da página pede a confirmação do navegador e registra a saída da página (G4)', async () => {
    const user = userEvent.setup()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    clearRenderError()
    clearInterruptedExam()
    let quebrar = null
    function PedacoDaProva() {
      const [quebrado, setQuebrado] = useState(false)
      quebrar = () => setQuebrado(true)
      if (quebrado) throw new Error('Cannot read properties of undefined (reading \'map\')')
      return null
    }
    try {
      apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
      renderRunner(['/aluno'], <AppErrorBoundary fallback={ExamErrorScreen}><ExamRunner /><PedacoDaProva /></AppErrorBoundary>)
      enterFullscreen()
      await user.click(await screen.findByRole('button', { name: /Dois/ }))
      act(() => { quebrar() })
      expect(await screen.findByText('Algo deu errado nesta tela')).toBeVisible()
      const beforeUnload = new Event('beforeunload', { cancelable: true })
      act(() => { window.dispatchEvent(beforeUnload) })
      expect(beforeUnload.defaultPrevented).toBe(true)
      act(() => { window.dispatchEvent(new Event('pagehide')) })
      const left = activityLogs('exam_left')
      expect(left).toHaveLength(1)
      expect(left[0][1]).toMatchObject({ attemptId: 'att-1', applicationId: 'app-1', pageExit: true, details: 'Página da prova foi fechada ou recarregada (depois de um erro de tela)' })
      expect(left[0][2]).toMatchObject({ keepalive: true })
    } finally {
      consoleError.mockRestore()
      clearRenderError()
      clearInterruptedExam()
    }
  })

  it('alternativas sem identificador respondem com a letra da posição, nunca com a letra que veio (AVA-05)', async () => {
    const user = userEvent.setup()
    const response = syncResponse({ timerRemaining: 600 })
    // Lista de questões sem os identificadores: letter é a original, fora de ordem.
    response.onlineExamConfigs[EXAM].versionSnapshots[0].questions[0].alternatives = [
      { letter: 'C', text: 'Onze' },
      { letter: 'A', text: 'Dois' },
      { letter: 'B', text: 'Três' },
    ]
    apiMock.get.mockResolvedValue(response)
    renderRunner()
    enterFullscreen()
    const dois = await screen.findByRole('button', { name: /Dois/ })
    expect(within(dois).getByText('B')).toBeVisible()
    await user.click(dois)
    await waitFor(() => expect(postsTo('/api/student/autosave-progress').length).toBeGreaterThan(0), { timeout: 6000 })
    expect(postsTo('/api/student/autosave-progress')[0][1]).toMatchObject({ answers: { 1: 'B' } })
  }, 15000)

  it('cabeçalho compacto: título encurtado e Sair, Mensagens e Enviar sempre acessíveis (UXA-03, ACS-16)', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    renderRunner()
    enterFullscreen()
    const heading = await screen.findByRole('heading', { level: 1 })
    expect(heading).toHaveClass('truncate')
    expect(heading.parentElement).toHaveClass('min-w-0')
    expect(screen.getByRole('button', { name: 'Sair', exact: true })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Mensagens', exact: true })).toBeVisible()
    const send = screen.getByRole('button', { name: 'Enviar', exact: true })
    expect(send).toHaveTextContent('Enviar')
    expect(send.parentElement).toHaveClass('shrink-0')
    // Celular: duas linhas (título e cronômetro; contagem e botões). A contagem não fica
    // mais embaixo do título, na coluna estreita ao lado do cronômetro (320 px).
    const counter = screen.getByText('0/1 respondidas')
    expect(heading.parentElement).not.toContainElement(counter)
    expect(heading.parentElement).toHaveClass('col-span-2', 'row-start-1')
    expect(counter.parentElement).toHaveClass('row-start-2', 'min-w-0')
    expect(send.parentElement).toHaveClass('row-start-2')
    expect(screen.getByTitle('Tempo restante')).toHaveClass('row-start-1')
  })
})
