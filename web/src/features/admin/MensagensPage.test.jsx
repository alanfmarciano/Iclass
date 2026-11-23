import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mensagens no painel (fase 3, C14 / P5-S7b, FUN-14; D8 a D15 do P5 e resposta do Alan à
// pergunta 4: o administrador lê, com registro). Antes do C14 não havia /mensagens: o item
// "mensagens" do sino levava a uma rota que não existia.
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), auth: null }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))

import MensagensPage, { adminConversationsPath, classOptionsFromSummaries } from './MensagensPage'
import { resetMessageCountForTests } from '../../lib/messageCounter'

const NOW = Date.now()
const READ_NOTICE = 'O administrador da escola pode ler estas mensagens.'
const PROFESSOR = {
  role: 'professor', email: 'prof@escola.local', name: 'Paulo Professor',
  effectivePermissions: ['page.messages', 'page.students'],
  activeWorkspace: { courseId: 'curso', className: '1DES' },
}
const ADMIN = {
  role: 'admin', email: 'admin@escola.local', name: 'Direção',
  effectivePermissions: ['page.messages', 'page.students', 'messages.readAll'],
  activeWorkspace: { courseId: 'curso', className: '1DES' },
}

function row(extra = {}) {
  return {
    id: 'conv_1', courseId: 'curso', curso: 'Desenvolvimento', studentClass: '1DES', assunto: 'Revisão da prova', status: 'aberta',
    aluno: { nome: 'Álvaro Souza', email: 'alvaro@escola.local', matricula: '2026001', studentId: 'alu_0123456789abcdef', ativo: true },
    instrutor: { nome: 'Paulo Professor', email: 'prof@escola.local' }, participante: true,
    ultimaMensagemEm: NOW - 3600000, naoLidas: 1, lidaAte: NOW - 7200000, ...extra,
  }
}

let server
function resetServer() {
  server = {
    rows: [row(), row({ id: 'conv_2', assunto: 'Atestado', aluno: { nome: 'Bruna Lima', matricula: '2026002', studentId: 'alu_1111111111111111', ativo: true }, naoLidas: 0, ultimaMensagemEm: NOW - 86400000 })],
    others: [row({ id: 'conv_x', assunto: '', textoOculto: true, participante: false, naoLidas: 0, aluno: { nome: 'Carla Mendes', matricula: '2026003', ativo: true }, instrutor: { nome: 'Rita Professora' } })],
    threads: {
      conv_1: { conversa: row(), mensagens: [
        { id: 'm1', autor: 'aluno', voce: false, nome: 'Álvaro Souza', texto: 'Posso pedir revisão?', criadaEm: NOW - 3600000 },
      ] },
      conv_x: { conversa: row({ id: 'conv_x', assunto: 'Notas', participante: false, aluno: { nome: 'Carla Mendes', ativo: true }, instrutor: { nome: 'Rita Professora' } }), mensagens: [
        { id: 'x1', autor: 'aluno', voce: false, nome: 'Carla Mendes', texto: 'Oi, professora.', criadaEm: NOW - 7200000 },
        { id: 'x2', autor: 'instrutor', voce: false, nome: 'Rita Professora', texto: 'Oi, Carla.', criadaEm: NOW - 3600000 },
      ] },
      conv_off: { conversa: row({ id: 'conv_off', aluno: { nome: 'Dora Antiga', ativo: false }, naoLidas: 0 }), mensagens: [{ id: 'o1', autor: 'aluno', voce: false, texto: 'Tchau.', criadaEm: NOW - 3600000 }] },
    },
    opened: new Set(),
    students: [
      { id: 'alu_0123456789abcdef', email: 'alvaro@escola.local', name: 'Álvaro Souza', matricula: '2026001', status: 'Ativo' },
      { id: 'alu_2222222222222222', email: 'eva@escola.local', name: 'Eva Rocha', matricula: '2026005', status: 'Ativo' },
      { email: 'saiu@escola.local', name: 'Fábio Saiu', status: 'Transferido' },
    ],
    students2: [
      { id: 'alu_3333333333333333', email: 'gil@escola.local', name: 'Gil Neves', matricula: '2026010', status: 'Ativo' },
    ],
    // As turmas do escopo da conta (a mesma lista do seletor de curso).
    summaries: [
      { id: 'curso', name: 'Desenvolvimento', classes: [{ name: '1DES' }, { name: '2DES' }] },
      { id: 'velho', name: 'Curso apagado', deleted: true, classes: [{ name: '9X' }] },
    ],
  }
  mocks.get.mockImplementation(async (url) => {
    const [path, query = ''] = String(url).split('?')
    const params = new URLSearchParams(query)
    if (path === '/api/admin/conversations') {
      const all = params.get('todas') === '1' ? [...server.rows, ...server.others] : server.rows
      const status = params.get('status')
      return { success: true, conversas: all.filter((item) => !status || item.status === status), aviso: READ_NOTICE, limites: { texto: 2000, assunto: 120, motivo: 200 }, podeLerTodas: mocks.auth.role === 'admin' }
    }
    if (path === '/api/admin/students') return params.get('studentClass') === '2DES' ? server.students2 : server.students
    if (path === '/api/admin/course-summaries') return server.summaries
    const match = /^\/api\/admin\/conversations\/([^/]+)\/messages$/.exec(path)
    if (match) {
      const id = decodeURIComponent(match[1])
      const thread = server.threads[id]
      if (!thread) { const err = new Error('Conversa não encontrada.'); err.status = 404; err.data = { code: 'conversation_not_found' }; throw err }
      if (thread.conversa.participante === false && !server.opened.has(id)) {
        const err = new Error('Confirme a leitura.'); err.status = 403; err.data = { code: 'admin_open_required' }; throw err
      }
      const depois = Number(params.get('depois') || 0)
      return { success: true, conversa: thread.conversa, mensagens: thread.mensagens.filter((m) => m.criadaEm > depois), temAnteriores: false, leituraAdministrativa: thread.conversa.participante === false, aviso: READ_NOTICE }
    }
    throw new Error(`GET inesperado ${url}`)
  })
  mocks.post.mockImplementation(async (url, body) => {
    if (url.endsWith('/read')) return { success: true, changed: true, lidaAte: body.ate }
    if (url === '/api/admin/conversations/conv_1/messages') return { success: true, conversa: row({ naoLidas: 0, ultimaMensagemEm: NOW }), mensagem: { id: 'm2', autor: 'instrutor', voce: true, nome: 'Paulo Professor', texto: body.texto, criadaEm: NOW } }
    if (url === '/api/admin/conversations/conv_1/close') return { success: true, conversa: row({ status: 'encerrada', encerradaEm: NOW, motivoEncerramento: body.motivo, naoLidas: 0 }) }
    if (url === '/api/admin/conversations/conv_1/reopen') return { success: true, conversa: row({ status: 'aberta', naoLidas: 0 }) }
    if (url === '/api/admin/conversations/conv_x/admin-open') { server.opened.add('conv_x'); return { success: true } }
    if (url === '/api/admin/conversations') {
      server.threads.conv_novo = { conversa: row({ id: 'conv_novo', assunto: body.assunto, aluno: { nome: 'Eva Rocha', ativo: true }, naoLidas: 0 }), mensagens: [{ id: 'n1', autor: 'instrutor', voce: true, texto: body.texto, criadaEm: NOW }] }
      return { success: true, criada: true, conversa: server.threads.conv_novo.conversa }
    }
    throw new Error(`POST inesperado ${url}`)
  })
}

function Where() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname}{location.search}</p>
}

function renderAt(url = '/mensagens') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/mensagens" element={<><MensagensPage /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mocks.get.mockReset()
  mocks.post.mockReset()
  mocks.auth = PROFESSOR
  resetServer()
  resetMessageCountForTests()
})
afterEach(() => { cleanup() })

describe('[UC-MENSAGEM-006] Mensagens no painel', () => {
  it('endereço da lista: a turma do painel, todas as minhas turmas ou a escola inteira', () => {
    expect(adminConversationsPath({ courseId: 'c 1', className: '1A', scope: 'turma', status: 'aberta' })).toBe('/api/admin/conversations?courseId=c+1&studentClass=1A&status=aberta')
    expect(adminConversationsPath({ courseId: '', className: '', scope: 'turma', status: 'aberta' })).toBeNull()
    expect(adminConversationsPath({ scope: 'minhas', status: '' })).toBe('/api/admin/conversations')
    expect(adminConversationsPath({ scope: 'escola', status: 'encerrada' })).toBe('/api/admin/conversations?todas=1&status=encerrada')
  })

  it('lista as abertas da turma com nome, matrícula, assunto e "nova"; filtros e busca sem acento', async () => {
    const user = userEvent.setup()
    renderAt()
    expect(await screen.findByText('Álvaro Souza')).toBeInTheDocument()
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/conversations?courseId=curso&studentClass=1DES&status=aberta', undefined)
    expect(screen.getByText(READ_NOTICE)).toBeInTheDocument()
    const first = screen.getAllByRole('listitem')[0]
    expect(within(first).getByText(/Matrícula 2026001/)).toBeInTheDocument()
    expect(within(first).getByText('1 mensagem nova')).toBeInTheDocument()
    expect(within(first).getByRole('link')).toHaveAttribute('href', '/mensagens?c=conv_1')
    // Professor não tem "Todas da escola".
    expect(screen.queryByRole('option', { name: 'Todas da escola' })).toBeNull()

    await user.type(screen.getByLabelText('Buscar'), 'alvaro')
    expect(screen.getByText('Álvaro Souza')).toBeInTheDocument()
    expect(screen.queryByText('Bruna Lima')).toBeNull()
    await user.clear(screen.getByLabelText('Buscar'))

    await user.click(screen.getByRole('button', { name: 'Encerradas' }))
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/conversations?courseId=curso&studentClass=1DES&status=encerrada', undefined))
    await user.selectOptions(screen.getByLabelText('Turmas'), 'minhas')
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/conversations?status=encerrada', undefined))
  })

  it('abre a conversa, marca como lida e responde', async () => {
    const user = userEvent.setup()
    renderAt('/mensagens?c=conv_1')
    expect(await screen.findByText('Posso pedir revisão?')).toBeInTheDocument()
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/conversations/conv_1/read', { ate: NOW - 3600000 }))
    expect(screen.getByRole('link', { name: 'Ver ficha' })).toHaveAttribute('href', '/alunos/alu_0123456789abcdef')
    await user.type(screen.getByLabelText('Responder'), 'Pode, sim.')
    await user.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/conversations/conv_1/messages', { texto: 'Pode, sim.' })
    expect(await screen.findByText('Pode, sim.')).toBeInTheDocument()
  })

  it('Encerrar conversa pede o motivo opcional no diálogo do sistema (sem window.confirm) e Reabrir volta', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm')
    renderAt('/mensagens?c=conv_1')
    await user.click(await screen.findByRole('button', { name: 'Encerrar conversa' }))
    const dialog = await screen.findByRole('dialog')
    const reason = within(dialog).getByLabelText('Motivo (opcional)')
    expect(reason).toHaveAttribute('maxLength', '200')
    await user.type(reason, 'Assunto resolvido')
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar conversa' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/conversations/conv_1/close', { motivo: 'Assunto resolvido' }))
    expect(await screen.findByText('Motivo: Assunto resolvido')).toBeInTheDocument()
    expect(screen.getByText(/o aluno lê, mas não responde/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reabrir' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/conversations/conv_1/reopen', {}))
    expect(await screen.findByRole('button', { name: 'Encerrar conversa' })).toBeInTheDocument()
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('administrador: "Todas da escola" mostra a conversa de outro professor sem o assunto; abrir pede "Ler como administrador", fica só lendo e não marca leitura', async () => {
    mocks.auth = ADMIN
    const user = userEvent.setup()
    renderAt()
    await screen.findByText('Álvaro Souza')
    await user.selectOptions(screen.getByLabelText('Turmas'), 'escola')
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/conversations?todas=1&status=aberta', undefined))
    const other = (await screen.findByText('Carla Mendes')).closest('li')
    expect(within(other).getByText('Assunto visível depois de abrir')).toBeInTheDocument()
    expect(within(other).getByText(/com Rita Professora/)).toBeInTheDocument()
    expect(screen.getByText(/Abrir uma delas fica registrado na Auditoria/)).toBeInTheDocument()

    await user.click(within(other).getByRole('link'))
    expect(screen.getByTestId('where')).toHaveTextContent('/mensagens?c=conv_x')
    expect(await screen.findByText('Conversa de outro professor')).toBeInTheDocument()
    expect(screen.queryByText('Oi, Carla.')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Ler como administrador' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Ler como administrador' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/conversations/conv_x/admin-open', {}))
    expect(await screen.findByText('Oi, Carla.')).toBeInTheDocument()
    expect(screen.getByText(/Você está lendo uma conversa de outro professor/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Responder')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Encerrar conversa' })).toBeNull()
    expect(mocks.post).not.toHaveBeenCalledWith('/api/admin/conversations/conv_x/read', expect.anything())
  })

  it('aluno com cadastro encerrado: só consulta, sem campo de resposta nem Reabrir', async () => {
    renderAt('/mensagens?c=conv_off')
    expect(await screen.findByText('Tchau.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Responder')).toBeNull()
    expect(screen.getByText(/cadastro/i, { selector: 'span' })).toBeInTheDocument()
  })

  it('Nova conversa: só alunos ativos da turma, enviada pelo id do aluno, e abre a conversa criada', async () => {
    const user = userEvent.setup()
    renderAt()
    await user.click(await screen.findByRole('button', { name: 'Nova conversa' }))
    const dialog = await screen.findByRole('dialog')
    // A turma começa na do painel, e dá para trocar por outra do escopo.
    expect(await within(dialog).findByLabelText('Turma')).toHaveValue('curso::1DES')
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/students?courseId=curso&studentClass=1DES', undefined))
    const select = await within(dialog).findByLabelText('Aluno')
    expect(within(select).queryByRole('option', { name: /Fábio/ })).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Enviar' }))
    expect(within(dialog).getByText('Escolha o aluno.')).toBeInTheDocument()
    expect(within(dialog).getByText('Escreva a mensagem.')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Buscar aluno'), 'eva')
    await user.selectOptions(select, 'alu_2222222222222222')
    await user.type(within(dialog).getByLabelText('Assunto (opcional)'), 'Projeto')
    await user.type(within(dialog).getByLabelText('Mensagem'), 'Oi, Eva.')
    await user.click(within(dialog).getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/conversations', { courseId: 'curso', studentClass: '1DES', studentId: 'alu_2222222222222222', assunto: 'Projeto', texto: 'Oi, Eva.' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/mensagens?c=conv_novo'))
    expect(await screen.findByText('Oi, Eva.')).toBeInTheDocument()
  })

  it('sem page.students (ou só leitura) não há "Nova conversa"', async () => {
    mocks.auth = { ...PROFESSOR, effectivePermissions: ['page.messages'] }
    renderAt()
    await screen.findByText('Álvaro Souza')
    expect(screen.queryByRole('button', { name: 'Nova conversa' })).toBeNull()
  })

  it('turmas da Nova conversa: as do escopo, sem curso apagado, por nome', () => {
    expect(classOptionsFromSummaries(server.summaries).map((option) => [option.key, option.label])).toEqual([
      ['curso::1DES', 'Desenvolvimento · 1DES'], ['curso::2DES', 'Desenvolvimento · 2DES'],
    ])
    expect(classOptionsFromSummaries(null)).toEqual([])
  })

  it('Nova conversa: trocar a turma lista os alunos dela e envia com ela', async () => {
    const user = userEvent.setup()
    renderAt()
    await user.click(await screen.findByRole('button', { name: 'Nova conversa' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('option', { name: /Eva Rocha/ })
    await user.selectOptions(within(dialog).getByLabelText('Turma'), 'curso::2DES')
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/students?courseId=curso&studentClass=2DES', undefined))
    await within(dialog).findByRole('option', { name: /Gil Neves/ })
    expect(within(dialog).queryByRole('option', { name: /Eva Rocha/ })).toBeNull()
    await user.selectOptions(within(dialog).getByLabelText('Aluno'), 'alu_3333333333333333')
    await user.type(within(dialog).getByLabelText('Mensagem'), 'Oi, Gil.')
    await user.click(within(dialog).getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/conversations', { courseId: 'curso', studentClass: '2DES', studentId: 'alu_3333333333333333', assunto: '', texto: 'Oi, Gil.' }))
  })

  it('sem turma escolhida no painel (modo instituição): lista de todas as minhas turmas, sem "Esta turma"; Nova conversa pede a turma', async () => {
    mocks.auth = { ...ADMIN, activeWorkspace: null }
    const user = userEvent.setup()
    renderAt()
    expect(await screen.findByText('Álvaro Souza')).toBeInTheDocument()
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/conversations?status=aberta', undefined)
    const scopes = screen.getByLabelText('Turmas')
    expect(scopes).toHaveValue('minhas')
    expect(within(scopes).queryByRole('option', { name: /Esta turma/ })).toBeNull()
    expect(within(scopes).getByRole('option', { name: 'Todas da escola' })).toBeInTheDocument()
    await user.selectOptions(scopes, 'escola')
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/conversations?todas=1&status=aberta', undefined))

    await user.click(screen.getByRole('button', { name: 'Nova conversa' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByLabelText('Turma')).toHaveValue('')
    expect(within(dialog).queryByLabelText('Aluno')).toBeNull()
    await user.type(within(dialog).getByLabelText('Mensagem'), 'Oi.')
    await user.click(within(dialog).getByRole('button', { name: 'Enviar' }))
    expect(within(dialog).getByText('Escolha a turma.')).toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalledWith('/api/admin/conversations', expect.anything())
    await user.selectOptions(within(dialog).getByLabelText('Turma'), 'curso::1DES')
    expect(await within(dialog).findByLabelText('Aluno')).toBeInTheDocument()
  })

  it('modo instituição com uma turma só no acesso: ela já vem escolhida; a conversa abre sem "Ver ficha" (a ficha é da tela de uma turma)', async () => {
    mocks.auth = { ...PROFESSOR, activeWorkspace: null }
    server.summaries = [{ id: 'curso', name: 'Desenvolvimento', classes: [{ name: '1DES' }] }]
    const user = userEvent.setup()
    renderAt()
    await user.click(await screen.findByRole('button', { name: 'Nova conversa' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByLabelText('Turma')).toHaveValue('curso::1DES'))
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    cleanup()
    renderAt('/mensagens?c=conv_1')
    expect(await screen.findByText('Posso pedir revisão?')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Ver ficha' })).toBeNull()
  })
})
