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

import ExamRunner, { KEYSTROKE_BATCH_MAX, KEYSTROKE_KEEPALIVE_MAX_BYTES, keepaliveKeystrokeBatch, keystrokeRetryDelay } from './ExamRunner'
import { AppErrorBoundary } from '../../../components/ui/ErrorScreen'
import { ExamErrorScreen } from './ExamErrorScreen'
import { clearInterruptedExam, clearRenderError } from '../../../lib/renderErrors'
import { noteServerBuild, resetUpdateReloadForTests, UPDATE_RELOAD_MESSAGE } from '../../../lib/buildVersion'

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

// Questão da tentativa como o servidor entrega (sync e start-attempt).
function attemptQuestions() {
  return [{ originalNumber: 1, text: 'Quanto é 1 + 1?', alternatives: [{ letter: 'A', text: 'Dois' }, { letter: 'B', text: 'Três' }, { letter: 'C', text: 'Onze' }] }]
}

// Registro do teclado da aplicação (H8b) quando o teste não diz: sem o campo (vale
// 'eventos', como numa aplicação de antes desta versão). Os testes do envio em lotes
// usam 'tudo', porque digitam teclas comuns.
const syncDefaults = { keystrokeMode: undefined, proctoringRetentionDays: undefined }

function syncResponse({ timerRemaining = 600, answers = {}, attemptOutcome = null, startedAt = Date.now() - 1000, status = 'running', finishOutcome = null, localCopyKey, timeOver = false, reopenedAt = null, keystrokeMode = syncDefaults.keystrokeMode, proctoringRetentionDays = syncDefaults.proctoringRetentionDays } = {}) {
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
        ...(keystrokeMode !== undefined ? { keystrokeMode } : {}),
      },
    },
    ...(proctoringRetentionDays !== undefined ? { proctoringRetentionDays } : {}),
    // As questões chegam só da tentativa iniciada (sigilo da prova, G3), fora da
    // configuração da turma.
    questions: startedAt ? attemptQuestions() : null,
    questionsVersion: startedAt ? 'q1' : null,
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
  if (vi.isMockFunction(Math.random)) Math.random.mockRestore()
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

  it('reaberta pelo "+N min" depois do salvamento que falhou no fim do tempo: sem "Falha no último salvamento" quando o servidor tem tudo', async () => {
    const user = userEvent.setup()
    let delivered = false
    apiMock.get.mockImplementation(async () => (delivered
      ? syncResponse({ timerRemaining: 300, answers: { 1: 'A' }, reopenedAt: Date.now() })
      : syncResponse({ timerRemaining: 6 })))
    apiMock.post.mockImplementation(async (url) => {
      if (url === '/api/student/autosave-progress') {
        throw Object.assign(new Error('O prazo da prova terminou.'), { status: 408, data: { deadlineExceeded: true } })
      }
      if (url !== '/api/student/submit') return { success: true }
      delivered = true
      return { success: true, gradePublished: false, answeredCount: 1 }
    })
    renderRunner()
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Dois/ }))
    // O salvamento da sincronização caiu depois do prazo (408): a entrega automática saiu.
    await waitFor(() => expect(postsTo('/api/student/autosave-progress').length).toBeGreaterThan(0), { timeout: 6000 })
    await waitFor(() => expect(postsTo('/api/student/submit')).toHaveLength(1), { timeout: 6000 })
    expect(await screen.findByRole('button', { name: /Três/ }, { timeout: 8000 })).toBeVisible()
    expect(screen.getByText('1/1 respondidas')).toBeVisible()
    expect(screen.queryByText('Falha no último salvamento')).not.toBeInTheDocument()
  }, 25000)

  it('aplicação só preparada mostra que a prova ainda não começou, sem "Iniciar prova"; quando o professor inicia, abre as instruções', async () => {
    let status = 'prepared'
    apiMock.get.mockImplementation(async () => {
      const response = syncResponse({ startedAt: null, status })
      response.onlineExamConfigs[EXAM].onlineActive = status !== 'prepared'
      return response
    })
    renderRunner()
    expect(await screen.findByText('A prova ainda não começou')).toBeVisible()
    expect(screen.getByText('Aguardando o professor iniciar...')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Iniciar prova' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    status = 'running'
    expect(await screen.findByRole('button', { name: 'Iniciar prova' }, { timeout: 6000 })).toBeInTheDocument()
    expect(screen.queryByText('A prova ainda não começou')).not.toBeInTheDocument()
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
  const question = response.questions[0]
  question.alternatives = [
    { id: IDS.tres, letter: IDS.tres, text: 'Três' },
    { id: IDS.dois, letter: IDS.dois, text: 'Dois' },
    { id: IDS.onze, letter: IDS.onze, text: 'Onze' },
  ]
  return response
}

function startedAttemptResponse() {
  return { success: true, attemptId: 'att-1', examConfigVersion: 'v1', localCopyKey: LOCAL_KEY, state: { attemptId: 'att-1', startedAt: Date.now(), timerRemaining: 600, answers: {}, assignedVersion: 'A' }, questions: attemptQuestions(), questionsVersion: 'q1' }
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

  it('depois de um erro de tela na prova, "Recarregar a página" e "Recarregar e continuar" não contam como saída: vão ao Monitor como evento técnico neutro', async () => {
    const user = userEvent.setup()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const originalLocation = window.location
    const reload = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload } })
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
      const router = renderRunner(['/aluno'], <AppErrorBoundary fallback={ExamErrorScreen}><ExamRunner /><PedacoDaProva /></AppErrorBoundary>)
      enterFullscreen()
      await user.click(await screen.findByRole('button', { name: /Dois/ }))
      act(() => { quebrar() })
      expect(await screen.findByText('Algo deu errado nesta tela')).toBeVisible()

      // Botão da tela de erro: recarrega sem o aviso "sair do site?" e sem registrar saída.
      await user.click(screen.getByRole('button', { name: 'Recarregar a página' }))
      expect(reload).toHaveBeenCalledTimes(1)
      const beforeUnload = new Event('beforeunload', { cancelable: true })
      act(() => { window.dispatchEvent(beforeUnload) })
      expect(beforeUnload.defaultPrevented).toBe(false)
      act(() => { window.dispatchEvent(new Event('pagehide')) })
      // Antes: a recarga pelo botão mandava exam_left com pageExit (saída da página).
      expect(activityLogs('exam_left')).toHaveLength(0)
      const reloads = activityLogs('exam_error_reload')
      expect(reloads).toHaveLength(1)
      expect(reloads[0][1]).toMatchObject({ attemptId: 'att-1', applicationId: 'app-1', examKey: EXAM, details: 'Recarregou a página da prova pelo botão da tela de erro' })
      expect(reloads[0][1].pageExit).toBeUndefined()
      expect(reloads[0][2]).toMatchObject({ keepalive: true })

      // "Recarregar e continuar" no aviso do voltar do navegador: também não é saída.
      await act(async () => { router.navigate(-1) })
      expect(await screen.findByRole('dialog', { name: 'Sair da prova agora?' })).toBeVisible()
      await user.click(screen.getByRole('button', { name: 'Recarregar e continuar' }))
      expect(reload).toHaveBeenCalledTimes(2)
      act(() => { window.dispatchEvent(new Event('pagehide')) })
      expect(activityLogs('exam_left')).toHaveLength(0)
      expect(activityLogs('exam_error_reload')).toHaveLength(2)
      expect(router.state.location.pathname).toBe(`/aluno/prova/${EXAM}`)
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
      consoleError.mockRestore()
      clearRenderError()
      clearInterruptedExam()
    }
  })

  it('[UC-MANUT-001] o IClass foi atualizado com a prova aberta: salva, avisa e recarrega sozinho sem contar como saída nem travar', async () => {
    const user = userEvent.setup()
    const reload = vi.fn()
    try {
      apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
      renderRunner()
      enterFullscreen()
      await user.click(await screen.findByRole('button', { name: /Onze/ }))
      apiMock.post.mockClear()

      // Resposta do servidor já atualizado (cabeçalho X-IClass-Build com outra versão).
      let scheduled = false
      act(() => { scheduled = noteServerBuild('versao-nova', { enabled: true, clientBuild: 'versao-velha', reload, storage: sessionStorage, delayMs: 50 }) })
      expect(scheduled).toBe(true)
      expect(screen.getByRole('status')).toHaveTextContent(UPDATE_RELOAD_MESSAGE)

      // O que estava pendente sai com keepalive antes da recarga.
      const saved = postsTo('/api/student/autosave-progress').find(([, , opts]) => opts?.keepalive === true)
      expect(saved).toBeTruthy()
      expect(saved[1]).toMatchObject({ attemptId: 'att-1', answers: { 1: 'C' } })
      const reloads = activityLogs('exam_update_reload')
      expect(reloads).toHaveLength(1)
      expect(reloads[0][1]).toMatchObject({ attemptId: 'att-1', applicationId: 'app-1', examKey: EXAM })
      expect(reloads[0][1].pageExit).toBeUndefined()
      expect(reloads[0][2]).toMatchObject({ keepalive: true })

      // A descarga da recarga: sem "sair do site?", e a tela cheia que cai, o foco que sai
      // e a página que some não são do aluno (antes: exam_left com pageExit e prova pausada).
      const beforeUnload = new Event('beforeunload', { cancelable: true })
      act(() => { window.dispatchEvent(beforeUnload) })
      expect(beforeUnload.defaultPrevented).toBe(false)
      delete document.fullscreenElement
      act(() => { document.dispatchEvent(new Event('fullscreenchange')) })
      act(() => { window.dispatchEvent(new Event('blur')) })
      act(() => { window.dispatchEvent(new Event('pagehide')) })
      expect(activityLogs('exam_left')).toHaveLength(0)
      expect(activityLogs('fullscreen_exit')).toHaveLength(0)
      expect(activityLogs('tab_blur')).toHaveLength(0)
      expect(screen.queryByText(/Prova pausada/i)).toBeNull()
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    } finally {
      resetUpdateReloadForTests()
      sessionStorage.clear()
    }
  })

  it('[UC-MANUT-001] atualização do IClass com a tela de erro da prova aberta: a recarga automática é evento neutro, não saída', async () => {
    const user = userEvent.setup()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
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

      act(() => { noteServerBuild('versao-nova', { enabled: true, clientBuild: 'versao-velha', reload, storage: sessionStorage, delayMs: 50 }) })
      const beforeUnload = new Event('beforeunload', { cancelable: true })
      act(() => { window.dispatchEvent(beforeUnload) })
      expect(beforeUnload.defaultPrevented).toBe(false)
      act(() => { window.dispatchEvent(new Event('pagehide')) })
      expect(activityLogs('exam_left')).toHaveLength(0)
      const reloads = activityLogs('exam_update_reload')
      expect(reloads).toHaveLength(1)
      expect(reloads[0][1]).toMatchObject({ attemptId: 'att-1', applicationId: 'app-1', examKey: EXAM })
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    } finally {
      resetUpdateReloadForTests()
      sessionStorage.clear()
      consoleError.mockRestore()
      clearRenderError()
      clearInterruptedExam()
    }
  })

  it('alternativas sem identificador respondem com a letra da posição, nunca com a letra que veio (AVA-05)', async () => {
    const user = userEvent.setup()
    const response = syncResponse({ timerRemaining: 600 })
    // Lista de questões sem os identificadores: letter é a original, fora de ordem.
    response.questions[0].alternatives = [
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
    // Celular: título e cronômetro numa linha; contagem e botões na outra, e os botões
    // descem para a linha de baixo quando não cabem ao lado da contagem. Antes a 2ª linha
    // era uma grade fixa (contagem | botões) que, com zoom de 200% num celular de 390 px
    // (195 px CSS), passava da tela: Enviar e cronômetro cortados e a contagem embaixo dos
    // botões. O layout medido no navegador fica no e2e exam-zoom.spec.js.
    const counter = screen.getByText('0/1 respondidas')
    const timer = screen.getByTitle('Tempo restante')
    const firstLine = heading.parentElement.parentElement
    expect(firstLine).toContainElement(timer)
    expect(firstLine).not.toContainElement(counter)
    expect(heading.parentElement).toHaveClass('min-w-0', 'flex-1')
    expect(timer).toHaveClass('shrink-0', 'whitespace-nowrap')
    const secondLine = counter.parentElement.parentElement
    expect(secondLine).toHaveClass('flex-wrap')
    expect(secondLine).toContainElement(send)
    expect(counter.parentElement).toHaveClass('min-w-0')
    expect(send.parentElement).toHaveClass('ml-auto', 'shrink-0')
    // Botões compactos abaixo de 640 px (Sair e Mensagens só ícone).
    expect(screen.getByRole('button', { name: 'Sair', exact: true })).toHaveClass('!px-2')
    expect(send).toHaveClass('!px-2.5')
  })
})

// Sigilo da prova (AVA-02, DES-X1): a tela mostra só as questões da tentativa que o
// servidor entrega (sync/start-attempt) e avisa qual versão já tem, para o servidor não
// reenviar as questões a cada sincronização.
describe('[UC-SIGILO-001] ExamRunner: questões da tentativa', () => {
  it('mostra as questões entregues pela tentativa e ignora snapshots na configuração da turma', async () => {
    const response = syncResponse({ timerRemaining: 600 })
    response.questions[0].text = 'Questão da tentativa'
    // Servidor antigo mandava as versões na config; a tela não pode usá-las.
    response.onlineExamConfigs[EXAM].versionSnapshots = [{ version: 'A', questions: [{ originalNumber: 9, text: 'Questão vazada pela config', alternatives: [] }] }]
    apiMock.get.mockResolvedValue(response)
    renderRunner()
    enterFullscreen()
    expect(await screen.findByText('Questão da tentativa')).toBeInTheDocument()
    expect(screen.queryByText('Questão vazada pela config')).not.toBeInTheDocument()
    expect(apiMock.get.mock.calls[0][0]).toMatch(/[?&]questionsVersion=$/)
  })

  it('recebe as questões ao iniciar a tentativa e informa a versão que já tem no próximo sync', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ startedAt: null }))
    apiMock.post.mockImplementation(async (url) => (url.endsWith('/start-attempt')
      ? { ...startedAttemptResponse(), questionsVersion: 'v-inicio' }
      : { success: true }))
    renderRunner()
    await user.click(await screen.findByRole('checkbox'))
    expect(screen.queryByRole('button', { name: /Dois/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Iniciar prova' }))
    enterFullscreen()
    expect(await screen.findByRole('button', { name: /Dois/ })).toBeVisible()
    expect(postsTo('/api/student/exam-applications/app-1/start-attempt')).toHaveLength(1)

    // Próximo sync: o servidor não reenvia as questões (o navegador já tem v-inicio).
    const later = syncResponse({ timerRemaining: 590 })
    later.questions = null
    later.questionsVersion = 'v-inicio'
    apiMock.get.mockResolvedValue(later)
    await waitFor(() => expect(apiMock.get.mock.calls.some(([path]) => path.includes('questionsVersion=v-inicio'))).toBe(true), { timeout: 6000 })
    expect(screen.getByRole('button', { name: /Dois/ })).toBeVisible()
  }, 10000)
})

describe('[UC-NOTAS-001] ExamRunner: nota no fim da prova', () => {
  it('nota publicada no fim da prova aparece com vírgula (antes 7.5)', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    apiMock.post.mockImplementation(async (url) => (url === '/api/student/submit' ? { success: true, gradePublished: true, score: 75 } : { success: true }))
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    await user.click(screen.getByRole('button', { name: /Enviar prova \(/ }))
    await user.click(await screen.findByRole('button', { name: 'Enviar prova' }))
    expect(await screen.findByText('7,5')).toBeInTheDocument()
    expect(screen.queryByText('7.5')).not.toBeInTheDocument()
  })
})

// Prova sem prazo ("Cronômetro ativo" desligado): o servidor manda o tempo restante
// null (ou sem o campo). Antes o null virava 0 e a prova era enviada sozinha ao abrir.
function untimedSync({ timerRemaining = null, omitTimer = false, timerEnabled = false, ...options } = {}) {
  const response = syncResponse(options)
  response.onlineExamConfigs[EXAM].timerEnabled = timerEnabled
  if (response.state && response.state.startedAt) {
    if (omitTimer) delete response.state.timerRemaining
    else response.state.timerRemaining = timerRemaining
    response.state.deadlineAt = null
  }
  return response
}

function autoSubmits() {
  return postsTo('/api/student/submit').filter(([, body]) => body.auto === true)
}

describe('[UC-TENTATIVA-002] ExamRunner: prova sem prazo não é enviada sozinha', () => {
  it.each([
    ['null', { timerRemaining: null }],
    ['ausente', { omitTimer: true }],
    ['texto vazio', { timerRemaining: '' }],
    ['null com o cronômetro ligado na turma', { timerRemaining: null, timerEnabled: true }],
  ])('tempo restante %s ao abrir a tela: sem cronômetro, sem envio automático, e o aluno envia quando quiser', async (_label, options) => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(untimedSync(options))
    apiMock.post.mockImplementation(async (url) => (url === '/api/student/submit' ? { success: true, gradePublished: false, answeredCount: 1 } : { success: true }))
    renderRunner()
    enterFullscreen()
    const dois = await screen.findByRole('button', { name: /Dois/ })
    // Fica aberta: espera a sincronização seguinte (4 s) sem nada sair sozinho.
    await waitFor(() => expect(apiMock.get.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 6000 })
    expect(autoSubmits()).toHaveLength(0)
    expect(screen.queryByText('Tempo esgotado')).not.toBeInTheDocument()
    expect(document.querySelector('[title="Tempo restante"]')).toBeNull()
    expect(dois).toBeEnabled()

    await user.click(dois)
    await user.click(screen.getByRole('button', { name: /Enviar prova \(/ }))
    await user.click(await screen.findByRole('button', { name: 'Enviar prova' }))
    expect(await screen.findByText('Prova enviada!')).toBeVisible()
    expect(screen.queryByText(/O tempo acabou/)).not.toBeInTheDocument()
    const calls = postsTo('/api/student/submit')
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toMatchObject({ auto: false, attemptId: 'att-1', answers: { 1: 'A' } })
  }, 15000)

  it('clicar em "Iniciar prova" sem prazo (start-attempt com tempo restante null) abre as questões e não envia nada', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValueOnce(untimedSync({ startedAt: null }))
    apiMock.get.mockResolvedValue(untimedSync({ timerRemaining: null }))
    apiMock.post.mockImplementation(async (url) => {
      if (url.endsWith('/start-attempt')) {
        const started = startedAttemptResponse()
        started.state.timerRemaining = null
        started.state.deadlineAt = null
        return started
      }
      return { success: true }
    })
    renderRunner()
    // As instruções dizem que a prova não tem tempo limite (antes: "60 min · Ao iniciar").
    expect(await screen.findByText('Sem tempo limite')).toBeVisible()
    expect(screen.getByText('Desligado')).toBeVisible()
    expect(screen.getByText(/Esta prova não tem tempo limite: não há cronômetro/)).toBeVisible()
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Iniciar prova' }))
    enterFullscreen()
    expect(await screen.findByRole('button', { name: /Dois/ })).toBeEnabled()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(autoSubmits()).toHaveLength(0)
    expect(screen.queryByText('Tempo esgotado')).not.toBeInTheDocument()
    expect(document.querySelector('[title="Tempo restante"]')).toBeNull()
  }, 10000)

  it('servidor recusa o envio automático com no_deadline: a prova volta às questões, sem cronômetro e sem repetir o envio', async () => {
    const user = userEvent.setup()
    // Servidor desencontrado (manda 0, mas a tentativa não tem prazo): a tela tenta o
    // envio automático uma vez e o servidor recusa.
    apiMock.get.mockResolvedValue(untimedSync({ timerRemaining: 0, timerEnabled: true, answers: { 1: 'A' } }))
    apiMock.post.mockImplementation(async (url, body) => {
      if (url === '/api/student/submit' && body.auto === true) {
        throw Object.assign(new Error('Esta prova não tem tempo limite e continua aberta.'), { status: 409, data: { code: 'no_deadline', noDeadline: true } })
      }
      if (url === '/api/student/submit') return { success: true, gradePublished: false, answeredCount: 1 }
      return { success: true }
    })
    renderRunner()
    enterFullscreen()
    await waitFor(() => expect(autoSubmits()).toHaveLength(1), { timeout: 4000 })
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Esta prova não tem tempo limite. Continue respondendo e envie quando terminar.'))
    const dois = await screen.findByRole('button', { name: /Dois/ })
    expect(dois).toHaveAttribute('aria-pressed', 'true')
    const syncsBefore = apiMock.get.mock.calls.length
    await waitFor(() => expect(apiMock.get.mock.calls.length).toBeGreaterThan(syncsBefore), { timeout: 6000 })
    expect(autoSubmits()).toHaveLength(1)
    expect(document.querySelector('[title="Tempo restante"]')).toBeNull()
    expect(screen.getByRole('button', { name: /Três/ })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: /Enviar prova \(/ }))
    await user.click(await screen.findByRole('button', { name: 'Enviar prova' }))
    expect(await screen.findByText('Prova enviada!')).toBeVisible()
    expect(postsTo('/api/student/submit').at(-1)[1]).toMatchObject({ auto: false, answers: { 1: 'A' } })
  }, 15000)

  it('com prazo nada muda: o cronômetro aparece e chega a zero enviando sozinho', async () => {
    apiMock.get.mockResolvedValue(untimedSync({ timerRemaining: 2, timerEnabled: true }))
    apiMock.post.mockImplementation(async (url) => (url === '/api/student/submit' ? { success: true, gradePublished: false, answeredCount: 0 } : { success: true }))
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    expect(document.querySelector('[title="Tempo restante"]')).not.toBeNull()
    expect(await screen.findByText('Prova enviada!', {}, { timeout: 5000 })).toBeVisible()
    expect(autoSubmits()).toHaveLength(1)
  }, 10000)
})

// Fase 2, H2-C (DES-09) e decisões §5: a digitação sai em lotes de no máximo 500 teclas,
// um envio por vez, e a sincronização da prova nunca tem duas em voo. Antes, o buffer
// inteiro ia num envio só (depois de uma queda longa da rede, milhares de teclas, acima
// do limite do corpo do aluno) e voltava ao buffer quando falhava; com o servidor lento,
// o relógio de 4 s disparava sincronizações umas por cima das outras.
function typeKeys(count) {
  act(() => {
    for (let index = 0; index < count; index += 1) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }))
    }
  })
}

function keystrokeBatches() {
  return postsTo('/api/student/log-keystrokes').map(([, body, options]) => ({ seqs: body.events.map((event) => event.seq), options }))
}

describe('[UC-DESEMPENHO-002] ExamRunner: digitação em lotes e uma sincronização por vez', () => {
  // Aplicação que registra toda a digitação (keystrokeMode 'tudo', H8b): estes testes
  // são do envio em lotes; o filtro de cada modo fica em UC-LGPD-009.
  beforeEach(() => { syncDefaults.keystrokeMode = 'tudo' })
  afterEach(() => { syncDefaults.keystrokeMode = undefined })
  it('digitação acumulada sai em lotes de até 500, um envio por vez e logo um depois do outro, sem perder nem repetir teclas', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    let inFlight = 0
    let maxInFlight = 0
    let releaseFirst
    const first = new Promise((resolve) => { releaseFirst = resolve })
    let calls = 0
    apiMock.post.mockImplementation(async (url) => {
      if (url !== '/api/student/log-keystrokes') return { success: true }
      calls += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        if (calls === 1) await first
        else await new Promise((resolve) => setTimeout(resolve, 5))
        return { success: true }
      } finally {
        inFlight -= 1
      }
    })
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(20) // o 20º evento dispara o envio, que fica pendurado
    expect(keystrokeBatches()).toHaveLength(1)
    typeKeys(1180) // servidor lento: nada de envio novo enquanto o primeiro não volta
    expect(keystrokeBatches()).toHaveLength(1)
    await act(async () => { releaseFirst() })
    await waitFor(() => expect(keystrokeBatches().flatMap((batch) => batch.seqs)).toHaveLength(1200))
    const batches = keystrokeBatches()
    expect(batches.map((batch) => batch.seqs.length)).toEqual([20, 500, 500, 180])
    expect(batches.flatMap((batch) => batch.seqs)).toEqual(Array.from({ length: 1200 }, (_, index) => index + 1))
    expect(maxInFlight).toBe(1)
    expect(KEYSTROKE_BATCH_MAX).toBe(500)
    batches.forEach((batch) => expect(batch.options).toEqual({ timeoutMs: 10000 }))
  }, 15000)

  it('envio que falha pela rede volta para a frente do buffer e sai no fim do recuo; lote recusado pelo servidor (413) não é reenviado para sempre', async () => {
    // Variação do recuo no mínimo (0,8): o primeiro recuo é de 1,6 s.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    const outcomes = [
      Object.assign(new Error('Sem conexão'), { status: 0, network: true }),
      null,
      Object.assign(new Error('Corpo grande demais'), { status: 413 }),
      null,
    ]
    apiMock.post.mockImplementation(async (url) => {
      if (url !== '/api/student/log-keystrokes') return { success: true }
      const outcome = outcomes.shift()
      if (outcome) throw outcome
      return { success: true }
    })
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(20) // falha pela rede
    await waitFor(() => expect(keystrokeBatches()).toHaveLength(1))
    await act(async () => {})
    // A tecla seguinte não reenvia na hora (antes saía um envio a cada tecla com a rede
    // fora): espera o recuo e então leva as 20 que falharam, na ordem, e a nova.
    typeKeys(1)
    expect(keystrokeBatches()).toHaveLength(1)
    await waitFor(() => expect(keystrokeBatches()).toHaveLength(2), { timeout: 4000 })
    expect(keystrokeBatches()[1].seqs).toEqual(Array.from({ length: 21 }, (_, index) => index + 1))
    await act(async () => {})
    typeKeys(20) // 22 a 41: recusado com 413
    await waitFor(() => expect(keystrokeBatches()).toHaveLength(3))
    expect(keystrokeBatches()[2].seqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 22))
    await act(async () => {})
    typeKeys(20)
    await waitFor(() => expect(keystrokeBatches()).toHaveLength(4))
    expect(keystrokeBatches()[3].seqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 42))
  }, 15000)

  it('lote recusado pela turma (403) não é reenviado a cada recuo: espera uma sincronização aceita e então sai, sem perder teclas', async () => {
    // Variação do recuo no mínimo (0,8): o primeiro recuo é de 1,6 s.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let syncRefused = false
    let refusedSyncs = 0
    apiMock.get.mockImplementation(async (url) => {
      if (String(url).startsWith('/api/student/sync') && syncRefused) {
        refusedSyncs += 1
        throw Object.assign(new Error('Turma não autorizada para este estudante.'), { status: 403 })
      }
      return syncResponse({ timerRemaining: 600 })
    })
    let keystrokeCalls = 0
    apiMock.post.mockImplementation(async (url) => {
      if (url !== '/api/student/log-keystrokes') return { success: true }
      keystrokeCalls += 1
      if (keystrokeCalls === 1) throw Object.assign(new Error('Turma não autorizada para este estudante.'), { status: 403 })
      return { success: true }
    })
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(20) // recusado com 403
    await waitFor(() => expect(keystrokeBatches()).toHaveLength(1))
    syncRefused = true
    const refusedAt = Date.now()
    // O recuo (1,6 s) passa e uma sincronização também é recusada: nenhum reenvio (antes
    // saía um a cada recuo, até 30 s, enquanto a tela estivesse aberta).
    await waitFor(() => {
      expect(refusedSyncs).toBeGreaterThan(0)
      expect(Date.now() - refusedAt).toBeGreaterThan(2500)
    }, { timeout: 6000 })
    expect(keystrokeBatches()).toHaveLength(1)
    // A turma volta a valer: a sincronização seguinte é aceita e as 20 teclas saem.
    syncRefused = false
    await waitFor(() => expect(keystrokeBatches()).toHaveLength(2), { timeout: 6000 })
    expect(keystrokeBatches()[1].seqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
    await act(async () => {})
    expect(keystrokeBatches()).toHaveLength(2)
  }, 20000)

  it('lote de aplicação que não existe mais (404) é descartado; sessão recusada (401) não tenta de novo depois que a prova sai da tela', async () => {
    let sessionGone = false
    apiMock.get.mockImplementation(async (url) => {
      if (String(url).startsWith('/api/student/sync') && sessionGone) {
        throw Object.assign(new Error('Sessão encerrada.'), { status: 401, data: { sessionRevoked: true } })
      }
      return syncResponse({ timerRemaining: 600 })
    })
    let keystrokeCalls = 0
    apiMock.post.mockImplementation(async (url) => {
      if (url !== '/api/student/log-keystrokes') return { success: true }
      keystrokeCalls += 1
      if (keystrokeCalls === 1) throw Object.assign(new Error('Aplicação de prova não encontrada.'), { status: 404 })
      throw Object.assign(new Error('Sessão encerrada.'), { status: 401, data: { sessionRevoked: true } })
    })
    const router = renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(20) // 1 a 20: 404, descartado
    await waitFor(() => expect(keystrokeBatches()).toHaveLength(1))
    await act(async () => {})
    typeKeys(20) // 21 a 40: sai na hora, sem as 20 descartadas e sem esperar recuo
    await waitFor(() => expect(keystrokeBatches()).toHaveLength(2))
    expect(keystrokeBatches()[1].seqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 21))
    sessionGone = true
    await act(async () => {})
    vi.useFakeTimers()
    try {
      // A prova sai da tela: o resto vai uma vez com a saída e, recusado pela sessão, é
      // descartado (antes eram mais 5 tentativas com recuo).
      act(() => { router.unmountView() })
      expect(keystrokeBatches()).toHaveLength(3)
      expect(keystrokeBatches()[2].seqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 21))
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect(keystrokeBatches()).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  }, 15000)

  it('recuo do envio da digitação: dobra a cada falha seguida, de 2 s até 30 s, com variação de 0,8 a 1,2', () => {
    expect(keystrokeRetryDelay(1, () => 0.5)).toBe(2000)
    expect(keystrokeRetryDelay(2, () => 0.5)).toBe(4000)
    expect(keystrokeRetryDelay(3, () => 0.5)).toBe(8000)
    expect(keystrokeRetryDelay(4, () => 0.5)).toBe(16000)
    expect(keystrokeRetryDelay(5, () => 0.5)).toBe(30000)
    expect(keystrokeRetryDelay(50, () => 0.5)).toBe(30000)
    expect(keystrokeRetryDelay(1, () => 0)).toBe(1600)
    expect(keystrokeRetryDelay(1, () => 0.999999)).toBe(2400)
    expect(keystrokeRetryDelay(5, () => 0.999999)).toBe(36000)
  })

  it('com a rede caída, a digitação não vira um envio por tecla: o próximo envio espera o recuo e leva tudo, na ordem', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    let offline = true
    apiMock.post.mockImplementation(async (url) => {
      if (url !== '/api/student/log-keystrokes') return { success: true }
      if (offline) throw Object.assign(new Error('Sem conexão'), { status: 0, network: true })
      return { success: true }
    })
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    // Dez rajadas de 20 teclas, cada uma depois da falha da anterior: antes, cada rajada
    // fazia um envio na hora (a falha devolvia os eventos e a tecla seguinte reenviava).
    for (let round = 0; round < 10; round += 1) {
      typeKeys(20)
      await act(async () => {})
    }
    expect(keystrokeBatches()).toHaveLength(1)
    offline = false
    await waitFor(() => expect(keystrokeBatches().length).toBeGreaterThan(1), { timeout: 4000 })
    await waitFor(() => expect(keystrokeBatches().slice(1).flatMap((batch) => batch.seqs)).toHaveLength(200))
    expect(keystrokeBatches().slice(1).flatMap((batch) => batch.seqs)).toEqual(Array.from({ length: 200 }, (_, index) => index + 1))
  }, 15000)

  it('"Enviar prova" manda a digitação que está no buffer antes da entrega (H5b: depois dela a sessão pode acabar)', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    const order = []
    let releaseKeys
    const keysHeld = new Promise((resolve) => { releaseKeys = resolve })
    apiMock.post.mockImplementation(async (url) => {
      if (url === '/api/student/log-keystrokes') {
        order.push('keys:start')
        await keysHeld
        order.push('keys:done')
        return { success: true }
      }
      if (url === '/api/student/submit') {
        order.push('submit')
        return { success: true, gradePublished: false, answeredCount: 1 }
      }
      return { success: true }
    })
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(5) // abaixo do lote de 20: ficaria no buffer até a limpeza do efeito
    await user.click(screen.getByRole('button', { name: /Enviar prova \(/ }))
    await user.click(await screen.findByRole('button', { name: 'Enviar prova' }))
    await waitFor(() => expect(order).toContain('keys:start'))
    expect(order).not.toContain('submit')
    await act(async () => { releaseKeys() })
    await waitFor(() => expect(order).toContain('submit'))
    expect(order.indexOf('keys:done')).toBeLessThan(order.indexOf('submit'))
    expect(keystrokeBatches()[0].seqs).toEqual([1, 2, 3, 4, 5])
  }, 15000)

  it('"Enviar prova" espera o envio da digitação em andamento e manda todos os lotes que sobraram, em lotes de 500 (sobra do H5b, J2)', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    const order = []
    let releaseFirst
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve })
    let keyCalls = 0
    apiMock.post.mockImplementation(async (url, body) => {
      if (url === '/api/student/log-keystrokes') {
        keyCalls += 1
        const call = keyCalls
        order.push(`keys:${call}:start:${body.events.length}`)
        if (call === 1) await firstHeld
        order.push(`keys:${call}:done`)
        return { success: true }
      }
      if (url === '/api/student/submit') {
        order.push('submit')
        return { success: true, gradePublished: false, answeredCount: 1 }
      }
      return { success: true }
    })
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(20) // o 1.º lote sai e fica preso
    await waitFor(() => expect(keyCalls).toBe(1))
    typeKeys(1180) // ficam no buffer enquanto o 1.º envio não volta
    await user.click(screen.getByRole('button', { name: /Enviar prova \(/ }))
    await user.click(await screen.findByRole('button', { name: 'Enviar prova' }))
    // Antes, o "Enviar prova" mandava um lote de 500 junto com o que estava preso, esperava
    // só por ele e entregava; 680 teclas ficavam para depois da entrega.
    expect(keyCalls).toBe(1)
    expect(order).not.toContain('submit')
    await act(async () => { releaseFirst() })
    await waitFor(() => expect(order).toContain('submit'))
    const sent = keystrokeBatches()
    expect(sent.every((batch) => batch.seqs.length <= 500)).toBe(true)
    expect(sent.flatMap((batch) => batch.seqs)).toEqual(Array.from({ length: 1200 }, (_, index) => index + 1))
    const submitAt = order.indexOf('submit')
    for (let call = 1; call <= sent.length; call += 1) expect(order.indexOf(`keys:${call}:done`)).toBeLessThan(submitAt)
  }, 15000)

  it('"Enviar prova" não fica preso no envio da digitação: com a rede lenta, a entrega sai depois de no máximo 3 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
      apiMock.post.mockImplementation((url) => {
        if (url === '/api/student/log-keystrokes') return new Promise(() => {})
        if (url === '/api/student/submit') return Promise.resolve({ success: true, gradePublished: false, answeredCount: 1 })
        return Promise.resolve({ success: true })
      })
      renderRunner()
      enterFullscreen()
      await screen.findByRole('button', { name: /Dois/ })
      typeKeys(3)
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      await user.click(screen.getByRole('button', { name: /Enviar prova \(/ }))
      await user.click(await screen.findByRole('button', { name: 'Enviar prova' }))
      expect(postsTo('/api/student/submit')).toHaveLength(0)
      await act(async () => { vi.advanceTimersByTime(3100) })
      await waitFor(() => expect(postsTo('/api/student/submit')).toHaveLength(1))
    } finally {
      vi.useRealTimers()
    }
  }, 15000)

  it('Sair da prova com um envio da digitação em andamento: o resto sai na hora e nenhuma tecla se perde', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    let releaseFirst
    const first = new Promise((resolve) => { releaseFirst = resolve })
    let calls = 0
    apiMock.post.mockImplementation(async (url) => {
      if (url !== '/api/student/log-keystrokes') return { success: true }
      calls += 1
      if (calls === 1) await first
      return { success: true }
    })
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(20) // o primeiro lote fica pendurado
    typeKeys(10)
    expect(keystrokeBatches()).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Sair', exact: true }))
    await user.click(await screen.findByRole('button', { name: 'Salvar e sair' }))
    expect(await screen.findByText('Lista de provas')).toBeVisible()
    // Antes, o envio da saída voltava sem enviar (havia um em andamento) e a tela já
    // tinha saído quando ele terminava: as 10 últimas teclas se perdiam.
    expect(keystrokeBatches().flatMap((batch) => batch.seqs).sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1))
    await act(async () => { releaseFirst() })
    await act(async () => {})
    expect(keystrokeBatches()).toHaveLength(2)
  }, 15000)

  it('a prova sai da tela com mais de um lote no buffer: os lotes seguintes continuam saindo depois da desmontagem', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    const releases = []
    apiMock.post.mockImplementation((url) => {
      if (url !== '/api/student/log-keystrokes') return Promise.resolve({ success: true })
      return new Promise((resolve) => { releases.push(() => resolve({ success: true })) })
    })
    const router = renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(20) // pendurado
    typeKeys(1180)
    expect(keystrokeBatches()).toHaveLength(1)
    // Desmontagem (fim da sessão no meio, navegação que o roteador não segurou): o que
    // sobrou sai sem esperar o envio pendurado, 500 por vez.
    act(() => { router.unmountView() })
    expect(keystrokeBatches()).toHaveLength(2)
    expect(keystrokeBatches()[1].seqs[0]).toBe(21)
    expect(keystrokeBatches()[1].seqs).toHaveLength(500)
    // Antes, o encadeamento exigia a tela montada e as 680 restantes ficavam no buffer.
    for (let round = 0; round < 6 && releases.length; round += 1) {
      await act(async () => { releases.splice(0).forEach((release) => release()) })
      await act(async () => {})
    }
    const seqs = keystrokeBatches().flatMap((batch) => batch.seqs)
    expect(seqs).toHaveLength(1200)
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 1200 }, (_, index) => index + 1))
    keystrokeBatches().forEach((batch) => expect(batch.seqs.length).toBeLessThanOrEqual(500))
  }, 15000)

  it('depois que a prova sai da tela, sem rede: o resto tenta de novo com recuo, no máximo 5 vezes, e sem sessão não envia', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    apiMock.post.mockImplementation(async (url) => {
      if (url === '/api/student/log-keystrokes') throw Object.assign(new Error('Sem conexão'), { status: 0, network: true })
      return { success: true }
    })
    const router = renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(5)
    expect(keystrokeBatches()).toHaveLength(0)
    vi.useFakeTimers()
    try {
      act(() => { router.unmountView() })
      expect(keystrokeBatches()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      // O envio da saída e mais 5 tentativas, cada uma com as mesmas 5 teclas; depois desiste.
      expect(keystrokeBatches()).toHaveLength(6)
      keystrokeBatches().forEach((batch) => expect(batch.seqs).toEqual([1, 2, 3, 4, 5]))
    } finally {
      vi.useRealTimers()
    }

    cleanup()
    apiMock.post.mockClear()
    const again = renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(5)
    sessionMock.mockReturnValue(false)
    act(() => { again.unmountView() })
    await act(async () => {})
    expect(keystrokeBatches()).toHaveLength(0)
  }, 15000)

  it('lote do keepalive que falha com a página ainda aberta volta para o buffer e sai no envio seguinte', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    apiMock.post.mockImplementation(async (url, body, options) => {
      if (url === '/api/student/log-keystrokes' && options?.keepalive) throw Object.assign(new Error('Sem conexão'), { status: 0, network: true })
      return { success: true }
    })
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(5)
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    await act(async () => {})
    // Página voltou do cache do navegador (voltar/avançar): as 5 teclas não se perderam.
    act(() => { window.dispatchEvent(new Event('pageshow')) })
    await waitFor(() => expect(keystrokeBatches().filter((batch) => !batch.options?.keepalive)).toHaveLength(1), { timeout: 4000 })
    expect(keystrokeBatches().filter((batch) => !batch.options?.keepalive)[0].seqs).toEqual([1, 2, 3, 4, 5])
  }, 15000)

  it('na saída da página o lote com keepalive leva no máximo 500 teclas e cabe no limite do navegador', async () => {
    const base = { email: 'ana@escola.local', studentClass: '1DES', courseId: 'curso', examKey: EXAM, applicationId: 'app-1', attemptId: 'att-1' }
    const event = (seq, padding = '') => ({ seq, clientTs: 1_700_000_000_000 + seq, key: 'a', code: 'KeyA', mods: '', kind: 'char', question: null, blocked: false, suspicious: false, padding })
    const small = Array.from({ length: 900 }, (_, index) => event(index + 1))
    const smallBatch = keepaliveKeystrokeBatch(base, small)
    expect(smallBatch.length).toBeLessThanOrEqual(500)
    expect(new TextEncoder().encode(JSON.stringify({ ...base, events: smallBatch })).length).toBeLessThanOrEqual(KEYSTROKE_KEEPALIVE_MAX_BYTES)
    expect(smallBatch[0].seq).toBe(1)
    const large = Array.from({ length: 500 }, (_, index) => event(index + 1, 'x'.repeat(200)))
    const largeBatch = keepaliveKeystrokeBatch(base, large)
    expect(largeBatch.length).toBeGreaterThan(0)
    expect(largeBatch.length).toBeLessThan(500)
    expect(new TextEncoder().encode(JSON.stringify({ ...base, events: largeBatch })).length).toBeLessThanOrEqual(KEYSTROKE_KEEPALIVE_MAX_BYTES)
    expect(KEYSTROKE_KEEPALIVE_MAX_BYTES).toBe(48 * 1024)

    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    apiMock.post.mockImplementation((url) => (url === '/api/student/log-keystrokes' ? new Promise(() => {}) : Promise.resolve({ success: true })))
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(20) // fica pendurado: o resto espera no buffer
    typeKeys(880)
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    const keepalive = postsTo('/api/student/log-keystrokes').filter(([, , options]) => options?.keepalive === true)
    expect(keepalive).toHaveLength(1)
    expect(keepalive[0][1].events.length).toBeLessThanOrEqual(500)
    expect(keepalive[0][1].events[0].seq).toBe(21)
  }, 15000)

  it('com o servidor lento, o relógio de 4 s não dispara uma sincronização por cima da outra', async () => {
    vi.useFakeTimers()
    try {
      const pending = []
      apiMock.get.mockImplementation((url) => {
        if (!String(url).startsWith('/api/student/sync')) return Promise.resolve({})
        return new Promise((resolve) => { pending.push(resolve) })
      })
      renderRunner()
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      const syncCalls = () => apiMock.get.mock.calls.filter(([url]) => String(url).startsWith('/api/student/sync'))
      expect(syncCalls()).toHaveLength(1)
      expect(syncCalls()[0][1]).toEqual({ timeoutMs: 10000 })
      await act(async () => { await vi.advanceTimersByTimeAsync(4000 * 5) })
      expect(syncCalls()).toHaveLength(1)
      // Prova ainda não iniciada (sem a cópia cifrada, que depende do WebCrypto real).
      await act(async () => { pending[0](syncResponse({ startedAt: null })) })
      await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
      expect(syncCalls()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('[UC-LGPD-009] ExamRunner: registro do teclado conforme a aplicação', () => {
  function copyEvent(target = document) {
    const event = new Event('copy', { bubbles: true, cancelable: true })
    act(() => { target.dispatchEvent(event) })
    return event
  }
  function keystrokeEvents() {
    return postsTo('/api/student/log-keystrokes').flatMap(([, body]) => body.events)
  }

  it('aplicação sem o campo (padrão "eventos"): digitação comum não sai; atalhos e cópia saem, e o bloqueio continua', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    apiMock.post.mockResolvedValue({ success: true })
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(25)
    expect(keystrokeBatches()).toHaveLength(0)
    const ctrlC = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => { window.dispatchEvent(ctrlC) })
    expect(ctrlC.defaultPrevented).toBe(true)
    const copy = copyEvent()
    expect(copy.defaultPrevented).toBe(true)
    await waitFor(() => expect(keystrokeEvents().map((event) => event.kind)).toEqual(['shortcut', 'clipboard']))
    expect(keystrokeEvents().map((event) => event.seq)).toEqual([1, 2])
  })

  it('"eventos": caractere digitado com AltGr (Ctrl e Alt juntos, teclado ABNT2 no Windows) não é atalho e não sai', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    apiMock.post.mockResolvedValue({ success: true })
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    act(() => {
      for (let index = 0; index < 30; index += 1) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'KeyQ', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '°', code: 'KeyE', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))
      }
      // Com o estado AltGraph do navegador (o caso do Chrome no Windows).
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'AltGraph', code: 'AltRight', ctrlKey: true, altKey: true, modifierAltGraph: true, bubbles: true, cancelable: true }))
    })
    const ctrlC = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => { window.dispatchEvent(ctrlC) })
    expect(ctrlC.defaultPrevented).toBe(true)
    copyEvent()
    await waitFor(() => expect(keystrokeEvents().map((event) => event.kind)).toEqual(['shortcut', 'clipboard']))
    expect(keystrokeEvents()[0]).toMatchObject({ key: 'c', mods: 'Ctrl' })
  })

  it('"tudo": o caractere com AltGr vai como digitação (char, AltGr), não como atalho', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600, keystrokeMode: 'tudo' }))
    apiMock.post.mockResolvedValue({ success: true })
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    act(() => {
      for (let index = 0; index < 20; index += 1) window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'KeyQ', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))
    })
    await waitFor(() => expect(keystrokeEvents()).toHaveLength(20))
    expect(keystrokeEvents().every((event) => event.kind === 'char' && event.mods === 'AltGr' && event.suspicious === false)).toBe(true)
  })

  it('"nada": nenhuma tecla sai, mas copiar e imprimir continuam bloqueados', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600, keystrokeMode: 'nada' }))
    apiMock.post.mockResolvedValue({ success: true })
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    typeKeys(30)
    const print = new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => { window.dispatchEvent(print) })
    expect(print.defaultPrevented).toBe(true)
    expect(copyEvent().defaultPrevented).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(keystrokeBatches()).toHaveLength(0)
  })

  it('"tudo": o que se digita no "Reportar problema" nunca é registrado; nas questões, sim', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600, keystrokeMode: 'tudo' }))
    apiMock.post.mockResolvedValue({ success: true })
    renderRunner()
    enterFullscreen()
    await screen.findByRole('button', { name: /Dois/ })
    await user.click(screen.getByRole('button', { name: 'Reportar problema nesta questão' }))
    const detail = await screen.findByLabelText('Detalhe (opcional)')
    act(() => {
      for (let index = 0; index < 25; index += 1) detail.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true }))
      detail.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    expect(copyEvent(detail).defaultPrevented).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(keystrokeBatches()).toHaveLength(0)
    // Fora do campo, a tela da prova registra toda a digitação.
    typeKeys(20)
    await waitFor(() => expect(keystrokeEvents()).toHaveLength(20))
    expect(keystrokeEvents().every((event) => event.key === 'a' && event.kind === 'char')).toBe(true)
  })

  it('as instruções dizem o que é registrado e por quanto tempo', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ startedAt: null, keystrokeMode: 'eventos', proctoringRetentionDays: 180 }))
    renderRunner()
    const notice = await screen.findByTestId('keystroke-notice')
    expect(notice).toHaveTextContent('só os atalhos suspeitos (copiar, colar, recortar, menu do botão direito, troca de janela) são registrados')
    expect(notice).toHaveTextContent('O que você digita não é registrado.')
    expect(notice).toHaveTextContent('apagados 180 dias depois do encerramento da prova')
    expect(screen.queryByText(/a digitação são monitorados/)).not.toBeInTheDocument()
  })

  it('instruções de "tudo" sem prazo de guarda', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ startedAt: null, keystrokeMode: 'tudo' }))
    renderRunner()
    const notice = await screen.findByTestId('keystroke-notice')
    expect(notice).toHaveTextContent('as teclas digitadas na tela da prova')
    expect(notice).toHaveTextContent('"Reportar problema" não é registrado')
    expect(notice).toHaveTextContent('ficam guardados até a escola apagá-los')
  })

  it('instruções de "nada"', async () => {
    apiMock.get.mockResolvedValue(syncResponse({ startedAt: null, keystrokeMode: 'nada', proctoringRetentionDays: 30 }))
    renderRunner()
    const none = await screen.findByTestId('keystroke-notice')
    expect(none).toHaveTextContent('Nesta prova o teclado não é registrado.')
    expect(none).toHaveTextContent('As saídas da tela são apagadas 30 dias depois')
  })
})
