import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H8a-2 (SEG-08, OPS-12, SEG-09, decisão P4): no primeiro acesso, o portal pede
// no lugar da página só o que falta (data de nascimento, responsável do menor e o aceite
// dos documentos publicados). Política 'ciência': falha ao consultar não prende o aluno.
const state = vi.hoisted(() => ({
  auth: {}, logout: vi.fn(), nav: vi.fn(), apiGet: vi.fn(), apiPost: vi.fn(), toast: { success: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ api: { get: state.apiGet, post: state.apiPost } }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: state.auth, logout: state.logout }) }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => state.toast }))
vi.mock('react-router-dom', () => ({ useNavigate: () => state.nav }))

import { StudentPrivacyGate, STATUS_TIMEOUT_MS, notePublishedLegalVersion, resetPrivacyGateCache } from './StudentPrivacyGate'

const NOT_REQUIRED = { success: true, required: false, termsPending: false, privacyPending: false, birthDateMissing: false, guardianMissing: false, documents: {} }
const TERMS = { documentId: 'termos_v2', version: 2, title: 'Termos de Uso', publishedAt: '2026-11-10T12:00:00.000Z', markdown: '# Termos\n\nTexto **publicado** pela escola.' }
const PRIVACY = { documentId: 'privacidade_v1', version: 1, title: 'Política de Privacidade', publishedAt: '2026-11-10T12:00:00.000Z', markdown: 'Política da escola.' }

beforeEach(() => {
  resetPrivacyGateCache()
  state.auth = { role: 'student', email: 'ana@escola.local', activeClass: { courseId: 'c1' } }
  state.apiGet.mockReset()
  state.apiPost.mockReset()
  state.logout.mockReset()
  state.nav.mockReset()
  state.toast.success.mockReset()
})
afterEach(() => { cleanup() })

const renderGate = () => render(<StudentPrivacyGate><p>Início do aluno</p></StudentPrivacyGate>)

describe('[UC-LGPD-007] primeiro acesso no portal do aluno', () => {
  it('nada pendente: a página aparece, e a consulta leva o curso da turma', async () => {
    state.apiGet.mockResolvedValue(NOT_REQUIRED)
    renderGate()
    expect(await screen.findByText('Início do aluno')).toBeInTheDocument()
    // Com o teto próprio de 8 s (decisões §12, sobra do H8a-2).
    expect(state.apiGet).toHaveBeenCalledWith('/api/student/privacy/status?courseId=c1', { timeoutMs: 8000 })
  })

  it('falha ao consultar não prende o aluno (política ciência)', async () => {
    state.apiGet.mockRejectedValue(new Error('Sem conexão'))
    renderGate()
    expect(await screen.findByText('Início do aluno')).toBeInTheDocument()
  })

  it('o resultado fica guardado: a página remontada não consulta de novo', async () => {
    state.apiGet.mockResolvedValue(NOT_REQUIRED)
    renderGate()
    await screen.findByText('Início do aluno')
    cleanup()
    renderGate()
    expect(screen.getByText('Início do aluno')).toBeInTheDocument()
    expect(state.apiGet).toHaveBeenCalledTimes(1)
  })

  it('sem data de nascimento: pede a data; adulto não vê o responsável; Continuar grava e libera', async () => {
    state.apiGet.mockResolvedValue({ ...NOT_REQUIRED, required: true, birthDateMissing: true, isMinor: false, guardianInformed: false })
    state.apiPost.mockResolvedValue(NOT_REQUIRED)
    const user = userEvent.setup()
    renderGate()
    expect(await screen.findByRole('heading', { name: 'Antes de continuar' })).toBeInTheDocument()
    expect(screen.queryByText('Início do aluno')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(screen.getByText('Informe a data de nascimento.')).toBeInTheDocument()
    expect(state.apiPost).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Data de nascimento'), { target: { value: '2001-04-20' } })
    expect(screen.queryByLabelText('Nome do responsável')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(state.apiPost).toHaveBeenCalledWith('/api/student/privacy/accept', { courseId: 'c1', birthDate: '2001-04-20' })
    expect(await screen.findByText('Início do aluno')).toBeInTheDocument()
    expect(state.toast.success).toHaveBeenCalled()
  })

  it('data de menor de 18 anos: o responsável aparece e é obrigatório', async () => {
    state.apiGet.mockResolvedValue({ ...NOT_REQUIRED, required: true, birthDateMissing: true, isMinor: false, guardianInformed: false })
    state.apiPost.mockResolvedValue(NOT_REQUIRED)
    const user = userEvent.setup()
    renderGate()
    await screen.findByRole('heading', { name: 'Antes de continuar' })
    const year = new Date().getFullYear() - 14
    fireEvent.change(screen.getByLabelText('Data de nascimento'), { target: { value: `${year}-02-01` } })
    expect(screen.getByLabelText('Nome do responsável')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(screen.getAllByText('Para menores de 18 anos, informe o nome e um telefone ou e-mail do responsável.').length).toBeGreaterThan(1)
    expect(state.apiPost).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Nome do responsável'), 'Maria Souza')
    await user.type(screen.getByLabelText('E-mail do responsável'), 'maria@exemplo.com')
    await user.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(state.apiPost).toHaveBeenCalledWith('/api/student/privacy/accept', {
      courseId: 'c1', birthDate: `${year}-02-01`, guardian: { name: 'Maria Souza', phone: '', email: 'maria@exemplo.com', parentesco: '' },
    })
  })

  it('documentos publicados: mostra o texto, o link para outra aba e pede o aceite com o id da versão', async () => {
    state.apiGet.mockResolvedValue({ ...NOT_REQUIRED, required: true, termsPending: true, privacyPending: true, documents: { terms: TERMS, privacy: PRIVACY } })
    state.apiPost.mockResolvedValue(NOT_REQUIRED)
    const user = userEvent.setup()
    renderGate()
    expect(await screen.findByText(/A escola publicou os documentos/)).toBeInTheDocument()
    expect(screen.getByText(/Versão 2, publicada em 10\/11\/2026/)).toBeInTheDocument()
    expect(screen.getByText('publicado').tagName).toBe('STRONG')
    const links = screen.getAllByRole('link', { name: /Abrir em outra aba/ })
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/termos?courseId=c1', '/privacidade?courseId=c1'])
    expect(links[0]).toHaveAttribute('target', '_blank')
    expect(screen.queryByLabelText('Data de nascimento')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(screen.getByText('Marque a caixa de leitura e aceite para continuar.')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Li e aceito os Termos de Uso e li a Política de Privacidade.' }))
    await user.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(state.apiPost).toHaveBeenCalledWith('/api/student/privacy/accept', { courseId: 'c1', termsDocumentId: 'termos_v2', privacyDocumentId: 'privacidade_v1' })
    expect(await screen.findByText('Início do aluno')).toBeInTheDocument()
  })

  it('versão nova publicada com a tela aberta (409): mostra a nova versão e desmarca o aceite', async () => {
    state.apiGet.mockResolvedValue({ ...NOT_REQUIRED, required: true, termsPending: true, documents: { terms: TERMS } })
    const terms3 = { ...TERMS, documentId: 'termos_v3', version: 3 }
    state.apiPost.mockRejectedValueOnce(Object.assign(new Error('x'), {
      status: 409,
      data: { error: 'Os documentos foram atualizados. Leia a nova versão e marque o aceite de novo.', status: { ...NOT_REQUIRED, required: true, termsPending: true, documents: { terms: terms3 } } },
    }))
    state.apiPost.mockResolvedValueOnce(NOT_REQUIRED)
    const user = userEvent.setup()
    renderGate()
    await user.click(await screen.findByRole('checkbox', { name: 'Li e aceito os Termos de Uso.' }))
    await user.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(await screen.findByText('Os documentos foram atualizados. Leia a nova versão e marque o aceite de novo.')).toBeInTheDocument()
    expect(screen.getByText(/Versão 3, publicada/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(state.apiPost).toHaveBeenLastCalledWith('/api/student/privacy/accept', { courseId: 'c1', termsDocumentId: 'termos_v3' })
  })

  it('Sair encerra a sessão e volta ao login', async () => {
    state.apiGet.mockResolvedValue({ ...NOT_REQUIRED, required: true, birthDateMissing: true })
    const user = userEvent.setup()
    renderGate()
    await user.click(await screen.findByRole('button', { name: 'Sair' }))
    expect(state.logout).toHaveBeenCalledOnce()
    expect(state.nav).toHaveBeenCalledWith('/login')
  })

  it('menor já com data e sem responsável: só o responsável é pedido', async () => {
    state.apiGet.mockResolvedValue({ ...NOT_REQUIRED, required: true, isMinor: true, guardianMissing: true })
    state.apiPost.mockResolvedValue(NOT_REQUIRED)
    const user = userEvent.setup()
    renderGate()
    await user.type(await screen.findByLabelText('Nome do responsável'), 'João Lima')
    await user.type(screen.getByLabelText('Telefone do responsável'), '(11) 97777-6666')
    expect(screen.queryByLabelText('Data de nascimento')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Continuar' }))
    await waitFor(() => expect(state.apiPost).toHaveBeenCalledWith('/api/student/privacy/accept', {
      courseId: 'c1', guardian: { name: 'João Lima', phone: '(11) 97777-6666', email: '', parentesco: '' },
    }))
  })

  // Decisões §12 (sobras do H8a-2). Antes: a guarda de 10 min seguia valendo depois de a
  // escola publicar outra versão dos documentos, e a consulta pendurada deixava o portal em
  // "Carregando" para sempre.
  it('outra versão publicada (vinda do sino) derruba a guarda e o portão consulta de novo', async () => {
    const accepted = { ...NOT_REQUIRED, documents: { terms: { documentId: 'termos_v1' }, privacy: { documentId: 'privacidade_v1' } } }
    state.apiGet.mockResolvedValueOnce(accepted)
    renderGate()
    await screen.findByText('Início do aluno')
    // Mesma versão, ou de outra conta: nada muda.
    notePublishedLegalVersion('ana@escola.local', 'termos_v1|privacidade_v1')
    notePublishedLegalVersion('outra@escola.local', 'termos_v2|privacidade_v1')
    expect(state.apiGet).toHaveBeenCalledTimes(1)
    state.apiGet.mockResolvedValueOnce({ ...NOT_REQUIRED, required: true, termsPending: true, documents: { terms: TERMS, privacy: { documentId: 'privacidade_v1' } } })
    notePublishedLegalVersion('ana@escola.local', 'termos_v2|privacidade_v1')
    expect(await screen.findByRole('heading', { name: 'Antes de continuar' })).toBeInTheDocument()
    expect(state.apiGet).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Li e aceito os Termos de Uso.')).toBeInTheDocument()
  })

  it('consulta pendurada: passados 8 s o portal abre, e a próxima navegação pergunta de novo', async () => {
    vi.useFakeTimers()
    try {
      state.apiGet.mockReturnValueOnce(new Promise(() => {}))
      renderGate()
      expect(screen.queryByText('Início do aluno')).toBeNull()
      await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS - 100)
      expect(screen.queryByText('Início do aluno')).toBeNull()
      await vi.advanceTimersByTimeAsync(200)
      expect(screen.getByText('Início do aluno')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
    cleanup()
    state.apiGet.mockResolvedValueOnce({ ...NOT_REQUIRED, required: true, birthDateMissing: true, isMinor: false })
    renderGate()
    expect(await screen.findByRole('heading', { name: 'Antes de continuar' })).toBeInTheDocument()
    expect(state.apiGet).toHaveBeenCalledTimes(2)
  })
})
