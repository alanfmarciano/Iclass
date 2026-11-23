import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mensagens do aluno (fase 3, C14 / P5-S7b, FUN-14; D8 a D15 do P5). Antes do C14 não havia
// tela: o sino levava a /aluno/mensagens?c=<id>, que caía no login.
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../context/AuthProvider', () => ({
  useAuth: () => ({
    auth: {
      role: 'student',
      email: 'alice@escola.local',
      activeClass: { name: '1DES', courseId: 'curso' },
      student: { name: 'Alice', classes: [{ name: '1DES', courseId: 'curso' }], courses: [{ id: 'curso', name: 'Curso' }] },
    },
  }),
}))

import MensagensPage from './MensagensPage'
import { resetMessageCountForTests } from '../../lib/messageCounter'

const NOW = Date.now()
const READ_NOTICE = 'O administrador da escola pode ler estas mensagens.'

function conversa(extra = {}) {
  return { id: 'conv_1', courseId: 'curso', studentClass: '1DES', assunto: 'Revisão da prova', instrutor: { nome: 'Prof. Alan' }, status: 'aberta', ultimaMensagemEm: NOW - 3600000, naoLidas: 1, arquivada: false, lidaAte: NOW - 7200000, ...extra }
}

let server
function resetServer() {
  server = {
    list: [conversa(), conversa({ id: 'conv_2', assunto: 'Atestado', instrutor: { nome: 'Prof. Bruna' }, status: 'encerrada', naoLidas: 0, ultimaMensagemEm: NOW - 86400000 * 3 })],
    archived: [],
    meta: { aviso: READ_NOTICE, avisoGuardadas: 'As mensagens ficam guardadas e não podem ser apagadas.', emProva: false, limites: { texto: 2000, assunto: 120 } },
    threads: {
      conv_1: {
        conversa: conversa(),
        mensagens: [
          { id: 'm1', autor: 'voce', nome: 'Você', texto: 'Posso pedir revisão?', criadaEm: NOW - 7200000 },
          { id: 'm2', autor: 'instrutor', nome: 'Prof. Alan', texto: '<script>alert(1)</script>\nOlhei a questão 4.', criadaEm: NOW - 3600000 },
        ],
      },
      conv_2: { conversa: conversa({ id: 'conv_2', assunto: 'Atestado', status: 'encerrada', naoLidas: 0, encerradaEm: NOW - 86400000 }), mensagens: [{ id: 'm9', autor: 'instrutor', nome: 'Prof. Bruna', texto: 'Resolvido.', criadaEm: NOW - 86400000 * 3 }] },
    },
    recipients: [{ ref: 'a'.repeat(32), nome: 'Prof. Alan', papel: 'Professor' }, { ref: 'b'.repeat(32), nome: 'Prof. Bruna', papel: 'Professor' }],
  }
  mocks.get.mockImplementation(async (url) => {
    const [path, query = ''] = String(url).split('?')
    const params = new URLSearchParams(query)
    if (path === '/api/student/conversations') {
      return { success: true, conversas: params.get('arquivadas') === '1' ? server.archived : server.list, naoLidas: 1, ...server.meta }
    }
    if (path === '/api/student/conversations/recipients') return { success: true, destinatarios: server.recipients }
    const match = /^\/api\/student\/conversations\/([^/]+)\/messages$/.exec(path)
    if (match) {
      const thread = server.threads[decodeURIComponent(match[1])]
      if (!thread) { const err = new Error('Conversa não encontrada.'); err.status = 404; err.data = { code: 'conversation_not_found' }; throw err }
      const depois = Number(params.get('depois') || 0)
      return { success: true, conversa: thread.conversa, mensagens: thread.mensagens.filter((m) => m.criadaEm > depois), temAnteriores: false, ...server.meta }
    }
    throw new Error(`GET inesperado ${url}`)
  })
  mocks.post.mockImplementation(async (url, body) => {
    if (url.endsWith('/read')) return { success: true, changed: true, lidaAte: body.ate }
    if (url === '/api/student/conversations/conv_1/messages') return { success: true, conversa: conversa({ naoLidas: 0, ultimaMensagemEm: NOW }), mensagem: { id: 'm3', autor: 'voce', nome: 'Você', texto: body.texto, criadaEm: NOW } }
    if (url === '/api/student/conversations') return { success: true, criada: true, conversa: conversa({ id: 'conv_novo', assunto: body.assunto, naoLidas: 0 }), mensagem: { id: 'mx', autor: 'voce', texto: body.texto, criadaEm: NOW } }
    if (url.endsWith('/archive')) return { success: true, changed: true, conversa: conversa({ arquivada: body.arquivada }) }
    throw new Error(`POST inesperado ${url}`)
  })
}

function Where() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname}{location.search}</p>
}

function renderAt(url = '/aluno/mensagens') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/aluno/mensagens" element={<><MensagensPage /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mocks.get.mockReset()
  mocks.post.mockReset()
  resetServer()
  resetMessageCountForTests()
})
afterEach(() => { cleanup() })

describe('[UC-MENSAGEM-006] Mensagens no portal do aluno', () => {
  it('lista as conversas da turma com o professor, o assunto, o selo "nova" e "Encerrada", e o aviso de que o administrador pode ler', async () => {
    renderAt()
    expect(await screen.findByText('Prof. Alan')).toBeInTheDocument()
    expect(mocks.get).toHaveBeenCalledWith('/api/student/conversations?courseId=curso&studentClass=1DES', undefined)
    expect(screen.getByText(READ_NOTICE)).toBeInTheDocument()
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]).getByText('Revisão da prova')).toBeInTheDocument()
    expect(within(rows[0]).getByText('1 mensagem nova')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Encerrada')).toBeInTheDocument()
    expect(within(rows[0]).getByRole('link')).toHaveAttribute('href', '/aluno/mensagens?c=conv_1')
  })

  it('abre pela ?c= do sino, mostra o texto como texto (sem HTML), marca como lida e envia a resposta', async () => {
    const user = userEvent.setup()
    renderAt('/aluno/mensagens?c=conv_1')
    expect(await screen.findByText(/Olhei a questão 4/)).toBeInTheDocument()
    // O <script> aparece escrito, não roda (React escapa; sem dangerouslySetInnerHTML).
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/student/conversations/conv_1/read', { ate: NOW - 3600000 }))
    expect(screen.getByText('As mensagens ficam guardadas e não podem ser apagadas.')).toBeInTheDocument()
    const field = screen.getByLabelText('Responder')
    expect(field).toHaveAttribute('maxLength', '2000')
    await user.type(field, '  Obrigada, professor!  ')
    await user.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(mocks.post).toHaveBeenCalledWith('/api/student/conversations/conv_1/messages', { texto: 'Obrigada, professor!' })
    expect(await screen.findByText('Obrigada, professor!')).toBeInTheDocument()
    expect(field).toHaveValue('')
  })

  it('Ctrl+Enter envia; texto só com espaços não vai ao servidor', async () => {
    const user = userEvent.setup()
    renderAt('/aluno/mensagens?c=conv_1')
    const field = await screen.findByLabelText('Responder')
    await user.type(field, '   ')
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled()
    await user.type(field, 'Oi{Control>}{Enter}{/Control}')
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/student/conversations/conv_1/messages', { texto: 'Oi' }))
  })

  it('durante a prova o campo dá lugar ao aviso (409 exam_in_progress no envio também)', async () => {
    const user = userEvent.setup()
    mocks.post.mockImplementation(async (url) => {
      if (url.endsWith('/read')) return { success: true, lidaAte: 1 }
      const err = new Error('Durante a prova, fale com o professor pelo botão da prova.')
      err.status = 409
      err.data = { code: 'exam_in_progress' }
      throw err
    })
    renderAt('/aluno/mensagens?c=conv_1')
    await user.type(await screen.findByLabelText('Responder'), 'Professor?')
    await user.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(await screen.findByText('Durante a prova, fale com o professor pelo botão da prova.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Responder')).not.toBeInTheDocument()
  })

  it('com a prova aberta na lista, "Nova mensagem" fica desligada e o aviso aparece', async () => {
    server.meta.emProva = true
    renderAt()
    expect(await screen.findAllByText('Durante a prova, fale com o professor pelo botão da prova.')).not.toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Nova mensagem' })).toBeDisabled()
  })

  it('conversa encerrada: lê, sem campo, com "O professor encerrou esta conversa. Você pode começar outra."', async () => {
    renderAt('/aluno/mensagens?c=conv_2')
    expect(await screen.findByText('Resolvido.')).toBeInTheDocument()
    expect(screen.getByText('O professor encerrou esta conversa. Você pode começar outra.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Responder')).not.toBeInTheDocument()
  })

  it('Nova mensagem: escolhe o professor pela lista (sem e-mail), assunto e texto, e abre a conversa criada', async () => {
    const user = userEvent.setup()
    renderAt()
    await user.click(await screen.findByRole('button', { name: 'Nova mensagem' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/aluno/mensagens?nova=1')
    const para = await screen.findByLabelText('Para')
    expect(within(para).getByRole('option', { name: 'Prof. Bruna (Professor)' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/@/)
    await user.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(await screen.findByText('Escolha o professor.')).toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalled()
    await user.selectOptions(para, 'b'.repeat(32))
    await user.type(screen.getByLabelText('Assunto (opcional)'), 'Trabalho')
    await user.type(screen.getByLabelText('Mensagem'), 'Posso entregar amanhã?')
    await user.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(mocks.post).toHaveBeenCalledWith('/api/student/conversations', { courseId: 'curso', studentClass: '1DES', destinatario: 'b'.repeat(32), assunto: 'Trabalho', texto: 'Posso entregar amanhã?' })
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/aluno/mensagens?c=conv_novo'))
  })

  it('professor que saiu da lista (400 invalid_recipient): pede para escolher de novo e recarrega a lista', async () => {
    const user = userEvent.setup()
    mocks.post.mockImplementation(async () => {
      const err = new Error('Escolha um professor da lista.')
      err.status = 400
      err.data = { code: 'invalid_recipient', field: 'destinatario' }
      throw err
    })
    renderAt('/aluno/mensagens?nova=1')
    await user.selectOptions(await screen.findByLabelText('Para'), 'a'.repeat(32))
    await user.type(screen.getByLabelText('Mensagem'), 'Oi')
    const before = mocks.get.mock.calls.filter(([url]) => url.includes('/recipients')).length
    await user.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(await screen.findByText('Escolha um professor da lista.')).toBeInTheDocument()
    await waitFor(() => expect(mocks.get.mock.calls.filter(([url]) => url.includes('/recipients')).length).toBeGreaterThan(before))
  })

  it('Arquivar tira a conversa da lista e volta para a lista', async () => {
    const user = userEvent.setup()
    renderAt('/aluno/mensagens?c=conv_1')
    await user.click(await screen.findByRole('button', { name: 'Arquivar' }))
    expect(mocks.post).toHaveBeenCalledWith('/api/student/conversations/conv_1/archive', { arquivada: true })
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/aluno\/mensagens$/))
  })

  it('conversa de outra turma ou de outro aluno (404): avisa e oferece voltar', async () => {
    renderAt('/aluno/mensagens?c=conv_x')
    expect(await screen.findByText('Conversa não encontrada. Ela pode ser de outra turma.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Voltar para as conversas' })).toBeInTheDocument()
  })

  it('com a conversa aberta, pergunta a cada 10 s só pelas novas (?depois=) e mostra a resposta sem recarregar', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderAt('/aluno/mensagens?c=conv_1')
      expect(await screen.findByText(/Olhei a questão 4/)).toBeInTheDocument()
      server.threads.conv_1.mensagens.push({ id: 'm5', autor: 'instrutor', nome: 'Prof. Alan', texto: 'Mais alguma dúvida?', criadaEm: NOW + 1000 })
      await act(async () => { await vi.advanceTimersByTimeAsync(10500) })
      expect(await screen.findByText('Mais alguma dúvida?')).toBeInTheDocument()
      expect(mocks.get).toHaveBeenCalledWith(`/api/student/conversations/conv_1/messages?depois=${NOW - 3600000}`, expect.objectContaining({ background: true }))
      await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/student/conversations/conv_1/read', { ate: NOW + 1000 }))
    } finally {
      vi.useRealTimers()
    }
  })
})
