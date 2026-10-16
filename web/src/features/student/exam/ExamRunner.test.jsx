import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { examDraftKey, readExamDraft, writeExamDraft } from '../../../lib/examDrafts'

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
const toast = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../../../lib/api', () => ({ api: apiMock }))
vi.mock('../useStudent', () => ({ useStudent: () => ({ email: 'ana@escola.local', studentClass: '1DES', courseId: 'curso' }) }))
vi.mock('../../../context/ToastProvider', () => ({ useToast: () => toast }))

import ExamRunner from './ExamRunner'

const EXAM = 'Avaliacao_Ciclo'
const DRAFT_KEY = examDraftKey({ email: 'ana@escola.local', applicationId: 'app-1', examKey: EXAM })

function syncResponse({ timerRemaining = 600, answers = {}, attemptOutcome = null, startedAt = Date.now() - 1000 } = {}) {
  return {
    success: true,
    onlineExamConfigs: {
      [EXAM]: {
        applicationId: 'app-1',
        status: 'running',
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
    state: startedAt ? { attemptId: 'att-1', startedAt, timerRemaining, answers, assignedVersion: 'A', status: 'active' } : {},
    attemptsUsed: attemptOutcome ? 1 : 0,
    maxAttempts: 1,
    messages: [],
    questionReports: [],
    attemptOutcome,
  }
}

function renderRunner() {
  return render(
    <MemoryRouter initialEntries={[`/aluno/prova/${EXAM}?applicationId=app-1`]}>
      <Routes>
        <Route path="/aluno/prova/:examKey" element={<ExamRunner />} />
      </Routes>
    </MemoryRouter>
  )
}

// jsdom não tem tela cheia: simula o navegador já em tela cheia.
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
  Object.values(toast).forEach((fn) => fn.mockReset())
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  delete document.fullscreenElement
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

    const calls = postsTo('/api/student/submit')
    expect(calls).toHaveLength(2)
    calls.forEach(([, body]) => expect(body).toMatchObject({ auto: true, attemptId: 'att-1', answers: { 1: 'A' }, examConfigVersion: 'v1' }))
    expect(readExamDraft(DRAFT_KEY)).toBeNull()
  }, 15000)

  it('manda junto com a sincronização as respostas que mudaram desde o último salvamento (CONF-X4)', async () => {
    const user = userEvent.setup()
    apiMock.get.mockResolvedValue(syncResponse({ timerRemaining: 600 }))
    renderRunner()
    enterFullscreen()
    await user.click(await screen.findByRole('button', { name: /Três/ }))
    expect(readExamDraft(DRAFT_KEY)).toMatchObject({ attemptId: 'att-1', answers: { 1: 'B' }, saved: false })

    await waitFor(() => expect(postsTo('/api/student/autosave-progress').length).toBeGreaterThan(0), { timeout: 6000 })
    const [, body] = postsTo('/api/student/autosave-progress')[0]
    expect(body).toMatchObject({ attemptId: 'att-1', answers: { 1: 'B' } })
    await waitFor(() => expect(readExamDraft(DRAFT_KEY)?.saved).toBe(true))
  }, 15000)

  it('ao recarregar restaura da cópia local o que o servidor ainda não tinha e salva (AVA-11)', async () => {
    writeExamDraft(DRAFT_KEY, { attemptId: 'att-1', answers: { 1: 'C' }, saved: false })
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

  it('tentativa entregue pelo servidor no fim do tempo: reenvia o que só este navegador tinha e mostra a entrega (UXA-01)', async () => {
    writeExamDraft(DRAFT_KEY, { attemptId: 'att-1', answers: { 1: 'A' }, saved: false })
    apiMock.get.mockResolvedValue(syncResponse({
      startedAt: null,
      attemptOutcome: { attemptId: 'att-1', finalizedByServer: true, source: 'deadline_server_auto_submit', answeredCount: 0 },
    }))
    apiMock.post.mockImplementation(async (url) => (url === '/api/student/submit'
      ? { success: true, replacedServerFinalization: true, answeredCount: 1, lateBySeconds: 95 }
      : { success: true }))
    renderRunner()

    expect(await screen.findByText('Prova enviada!')).toBeVisible()
    expect(apiMock.get.mock.calls[0][0]).toContain('attemptId=att-1')
    expect(postsTo('/api/student/submit')[0][1]).toMatchObject({ auto: true, attemptId: 'att-1', answers: { 1: 'A' } })
    expect(screen.getByText(/95 s depois do fim do tempo/)).toBeVisible()
    expect(readExamDraft(DRAFT_KEY)).toBeNull()
  })

  it('sem respostas pendentes, só informa que o servidor entregou no fim do tempo', async () => {
    writeExamDraft(DRAFT_KEY, { attemptId: 'att-1', answers: { 1: 'A' }, saved: true })
    apiMock.get.mockResolvedValue(syncResponse({
      startedAt: null,
      attemptOutcome: { attemptId: 'att-1', finalizedByServer: true, source: 'deadline_server_auto_submit', answeredCount: 1 },
    }))
    renderRunner()
    expect(await screen.findByText('Tempo esgotado: prova entregue')).toBeVisible()
    expect(postsTo('/api/student/submit')).toHaveLength(0)
  })
})
