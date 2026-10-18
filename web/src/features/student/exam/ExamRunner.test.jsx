import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { examDraftStorageKey, importExamDraftKey, readExamDraft, writeExamDraft } from '../../../lib/examDrafts'

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
const toast = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../../../lib/api', () => ({ api: apiMock }))
vi.mock('../useStudent', () => ({ useStudent: () => ({ email: 'ana@escola.local', studentClass: '1DES', courseId: 'curso' }) }))
vi.mock('../../../context/ToastProvider', () => ({ useToast: () => toast }))

import ExamRunner from './ExamRunner'

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

function syncResponse({ timerRemaining = 600, answers = {}, attemptOutcome = null, startedAt = Date.now() - 1000, status = 'running', finishOutcome = null, localCopyKey, timeOver = false } = {}) {
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
    state: startedAt ? { attemptId: 'att-1', startedAt, timerRemaining, answers, assignedVersion: 'A', status: 'active' } : {},
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
  localStorage.clear()
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
