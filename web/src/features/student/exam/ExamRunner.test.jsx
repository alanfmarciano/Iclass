import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExamRunner from './ExamRunner'

// Sigilo da prova (AVA-02, DES-X1): a tela da prova mostra só as questões da tentativa
// que o servidor entrega (sync/start-attempt) e avisa qual versão já tem, para o
// servidor não reenviar as questões a cada sincronização.

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('../../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../useStudent', () => ({
  useStudent: () => ({ email: 'ana@teste.local', studentClass: '1DES', courseId: 'curso_1' }),
}))
vi.mock('../../../context/ToastProvider', () => {
  const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }
  return { useToast: () => toast }
})

const attemptQuestions = [
  { originalNumber: 3, examNumber: 1, text: 'Questão da tentativa', alternatives: [{ letter: 'A', text: 'Primeira' }, { letter: 'B', text: 'Segunda' }] },
]

function config(extra = {}) {
  return {
    applicationId: 'app_1',
    status: 'running',
    onlineActive: true,
    startTime: Date.now() - 1000,
    durationMinutes: 30,
    requiresToken: false,
    maxAttempts: 1,
    ...extra,
  }
}

function syncResponse({ state, questions = null, questionsVersion = null, cfg = config() }) {
  return {
    success: true,
    onlineExamConfigs: { Avaliacao_X_1: cfg },
    state,
    questions,
    questionsVersion,
    messages: [],
    attemptsUsed: 0,
    maxAttempts: 1,
    applicationId: 'app_1',
    attemptId: 'attempt_1',
    tokenAccepted: true,
    questionReports: [],
  }
}

function simulateFullscreen() {
  let element = null
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element })
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: async () => { element = document.documentElement; document.dispatchEvent(new Event('fullscreenchange')) },
  })
  return () => { element = document.documentElement; document.dispatchEvent(new Event('fullscreenchange')) }
}

function renderRunner() {
  return render(
    <MemoryRouter initialEntries={['/aluno/prova/Avaliacao_X_1?applicationId=app_1']}>
      <Routes><Route path="/aluno/prova/:examKey" element={<ExamRunner />} /></Routes>
    </MemoryRouter>,
  )
}

describe('[UC-SIGILO-001] ExamRunner — questões da tentativa', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.post.mockResolvedValue({ success: true })
  })
  afterEach(() => {
    cleanup()
    delete document.fullscreenElement
    delete document.documentElement.requestFullscreen
  })

  it('mostra as questões entregues pela tentativa e ignora snapshots na configuração da turma', async () => {
    const enterFullscreen = simulateFullscreen()
    mocks.get.mockResolvedValue(syncResponse({
      state: { startedAt: Date.now() - 1000, assignedVersion: 'A', timerRemaining: 600, answers: {} },
      questions: attemptQuestions,
      questionsVersion: 'v1',
      // Servidor antigo mandava as versões na config; a tela não pode usá-las.
      cfg: config({ versionSnapshots: [{ version: 'A', questions: [{ originalNumber: 9, text: 'Questão vazada pela config', alternatives: [] }] }] }),
    }))
    renderRunner()
    await waitFor(() => expect(mocks.get).toHaveBeenCalled())
    act(() => enterFullscreen())

    expect(await screen.findByText('Questão da tentativa')).toBeInTheDocument()
    expect(screen.queryByText('Questão vazada pela config')).not.toBeInTheDocument()
    expect(mocks.get.mock.calls[0][0]).toMatch(/[?&]questionsVersion=$/)
  })

  it('recebe as questões ao iniciar a tentativa e informa a versão que já tem no próximo sync', async () => {
    simulateFullscreen()
    mocks.get.mockResolvedValue(syncResponse({ state: { startedAt: null, assignedVersion: 'A', answers: {} } }))
    mocks.post.mockImplementation(async (path) => (path.includes('/start-attempt')
      ? { success: true, attemptId: 'attempt_1', state: { startedAt: Date.now(), assignedVersion: 'A', timerRemaining: 1800 }, questions: attemptQuestions, questionsVersion: 'v-inicio' }
      : { success: true }))
    const user = userEvent.setup()
    renderRunner()

    await user.click(await screen.findByRole('checkbox'))
    expect(screen.queryByText('Questão da tentativa')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Iniciar prova/ }))

    expect(await screen.findByText('Questão da tentativa')).toBeInTheDocument()
    const startCall = mocks.post.mock.calls.find(([path]) => path.includes('/start-attempt'))
    expect(startCall[0]).toBe('/api/student/exam-applications/app_1/start-attempt')

    mocks.get.mockResolvedValue(syncResponse({ state: { startedAt: Date.now(), assignedVersion: 'A', timerRemaining: 1790, answers: {} }, questionsVersion: 'v-inicio' }))
    await waitFor(() => expect(mocks.get.mock.calls.some(([path]) => path.includes('questionsVersion=v-inicio'))).toBe(true), { timeout: 6000 })
    expect(screen.getByText('Questão da tentativa')).toBeInTheDocument()
  }, 10000)
})

describe('[UC-NOTAS-001] ExamRunner — nota no fim da prova', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    cleanup()
    delete document.fullscreenElement
    delete document.documentElement.requestFullscreen
  })

  it('nota publicada no fim da prova aparece com vírgula (antes 7.5)', async () => {
    const enterFullscreen = simulateFullscreen()
    mocks.get.mockResolvedValue(syncResponse({
      state: { startedAt: Date.now() - 1000, assignedVersion: 'A', timerRemaining: 600, answers: {} },
      questions: attemptQuestions,
      questionsVersion: 'v1',
    }))
    mocks.post.mockImplementation(async (path) => (path === '/api/student/submit' ? { success: true, gradePublished: true, score: 75 } : { success: true }))
    const user = userEvent.setup()
    renderRunner()
    await waitFor(() => expect(mocks.get).toHaveBeenCalled())
    act(() => enterFullscreen())
    await screen.findByText('Questão da tentativa')
    await user.click(screen.getByRole('button', { name: /Enviar prova \(/ }))
    await user.click(await screen.findByRole('button', { name: 'Enviar prova' }))
    expect(await screen.findByText('7,5')).toBeInTheDocument()
    expect(screen.queryByText('7.5')).not.toBeInTheDocument()
  })
})

