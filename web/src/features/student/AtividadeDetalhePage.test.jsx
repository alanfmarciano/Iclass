import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AtividadeDetalhePage, { CANCELLED_MESSAGE, CHECK_TIMEOUT_MS, SLOW_HINT_MS, STALL_MS, STALLED_MESSAGE } from './AtividadeDetalhePage'

// Fase 3, C9 (P1-g; FUN-01, D8, D9 e D12 do P1): a atividade no portal do aluno, com o
// envio pelo celular. Antes do C9 o portal não tinha input type=file nem rota de atividade.

const MB = 1024 * 1024
const TZ = 'America/Sao_Paulo'
const NOW = Date.UTC(2026, 10, 22, 15, 0) // 22/11 12:00 em São Paulo
const DUE = Date.UTC(2026, 10, 25, 2, 0) // 24/11 23:00 em São Paulo

const mocks = vi.hoisted(() => ({
  detail: null,
  refetch: null,
  setData: null,
  get: null,
  upload: null,
  download: null,
  resize: null,
  print: null,
  openWin: null,
}))

vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', name: 'Ana Lima', displayName: 'Ana Lima', studentClass: '1DES', courseId: 'DES', courses: [{ id: 'DES', name: 'Desenvolvimento' }] }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (url) => ({ data: url && url.includes('/api/student/assignments/') ? mocks.detail : null, loading: false, error: null, refetch: mocks.refetch, setData: mocks.setData }),
}))
vi.mock('../../context/BrandingProvider', () => ({ useBranding: () => ({ branding: { displayName: 'Escola Técnica Modelo', schoolName: 'Escola Técnica Modelo' } }) }))
vi.mock('../../lib/api', () => ({
  api: { get: (...args) => mocks.get(...args) },
  uploadWithProgress: (...args) => mocks.upload(...args),
  downloadFile: (...args) => mocks.download(...args),
}))
vi.mock('../../lib/imageResize', async (importOriginal) => ({ ...(await importOriginal()), resizeImage: (...args) => mocks.resize(...args) }))
vi.mock('../../lib/printDocument', async (importOriginal) => ({
  ...(await importOriginal()),
  openPrintWindow: (...args) => mocks.openWin(...args),
  printDocument: (...args) => mocks.print(...args),
}))

function version(n, extra = {}) {
  return {
    n,
    requestAt: Date.UTC(2026, 10, 20, 17, 32),
    receivedAt: Date.UTC(2026, 10, 20, 17, 32),
    late: false,
    lateMs: 0,
    text: '',
    link: '',
    files: [{ id: `f_${n}`, name: `relatorio-v${n}.pdf`, size: 2 * MB, mime: 'application/pdf', ext: '.pdf', comprovante: '0A1B2C3D' }],
    bytes: 2 * MB,
    comprovante: `CODV${n}AAA`,
    ...extra,
  }
}

function detail(overrides = {}) {
  return {
    success: true,
    assignment: {
      id: 'asg_1',
      title: 'Relatório da prática',
      instructions: 'Envie o **relatório** em PDF.',
      materiais: [{ id: 'lib_1', name: 'Modelo do relatório', url: '/uploads/modelo.pdf?access=t' }],
      opensAt: null,
      dueAt: DUE,
      closeAt: null,
      prazoIndividual: false,
      latePolicy: { mode: 'aceitar' },
      regraAtraso: 'Depois do prazo, a entrega é aceita e fica marcada como atrasada.',
    },
    aceita: {
      resposta: { files: true, text: true, link: false },
      tipos: ['PDF', 'Imagem (foto)'],
      extensoes: ['.pdf', '.jpg', '.jpeg', '.png'],
      accept: 'image/*,application/pdf,.pdf,.jpg,.jpeg,.png',
      maxFiles: 2,
      maxSizeMb: 5,
      maxTotalMb: 8,
      textMax: 10000,
      linkMax: 500,
    },
    aceitaEnvio: true,
    motivo: '',
    atrasoAgora: false,
    turmaEncerrada: false,
    situacao: 'a_fazer',
    situacaoTexto: 'A fazer',
    minhaEntrega: null,
    devolucao: null,
    refazer: null,
    serverNow: NOW,
    timezone: TZ,
    ...overrides,
  }
}

function file(name, size, type) {
  const f = new File(['conteudo'], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/aluno/atividades/asg_1']}>
      <Routes><Route path="/aluno/atividades/:id" element={<AtividadeDetalhePage />} /></Routes>
    </MemoryRouter>,
  )
}

function choose(...files) {
  const input = document.getElementById('atividade-arquivos')
  fireEvent.change(input, { target: { files } })
}

beforeEach(() => {
  mocks.detail = detail()
  mocks.refetch = vi.fn(async () => true)
  mocks.setData = vi.fn((value) => { mocks.detail = value })
  mocks.get = vi.fn(async () => mocks.detail)
  mocks.upload = vi.fn()
  mocks.download = vi.fn(async () => 'x')
  mocks.resize = vi.fn(async () => null)
  mocks.print = vi.fn(() => true)
  mocks.openWin = vi.fn(() => ({}))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('atividade do aluno: o que enviar', () => {
  it('mostra instruções, materiais, tipos e limites, a regra de atraso e o prazo no relógio da escola', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: 'Relatório da prática' })).toBeInTheDocument()
    expect(screen.getByText('A fazer')).toBeInTheDocument()
    // C9 ajuste 2: com menos de três dias, o aluno vê também as horas.
    expect(screen.getByText('Prazo: ter., 24/11 às 23:00 (faltam 2 dias e 11 horas)')).toBeInTheDocument()
    expect(screen.getAllByText('Depois do prazo, a entrega é aceita e fica marcada como atrasada.').length).toBeGreaterThan(0)
    expect(screen.getByText('Hora no computador do professor: 12:00', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('relatório').tagName).toBe('STRONG')
    expect(screen.getByRole('link', { name: /Modelo do relatório/ })).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText('Tipos aceitos: PDF, Imagem (foto).')).toBeInTheDocument()
    expect(screen.getByText('Até 2 arquivos de até 5 MB cada (até 8 MB por envio).')).toBeInTheDocument()
    expect(screen.getByText('Responda com arquivo ou texto.')).toBeInTheDocument()
    // FUN-01: o portal do aluno tem input type=file, com o accept da tarefa (abre câmera e galeria).
    const input = screen.getByLabelText('Escolher arquivo ou tirar foto')
    expect(input).toHaveAttribute('type', 'file')
    expect(input).toHaveAttribute('accept', 'image/*,application/pdf,.pdf,.jpg,.jpeg,.png')
    expect(input).toHaveAttribute('multiple')
    expect(screen.getByLabelText('Resposta em texto')).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Link/)).not.toBeInTheDocument()
  })

  it('sem aceitar envio, mostra o motivo do servidor e nenhum formulário', () => {
    mocks.detail = detail({ aceitaEnvio: false, motivo: 'O prazo desta tarefa terminou. O envio não é mais aceito.', situacao: 'encerrada_sem_envio', situacaoTexto: 'Encerrada sem envio' })
    renderPage()
    expect(screen.getByText('O prazo desta tarefa terminou. O envio não é mais aceito.')).toBeInTheDocument()
    expect(document.getElementById('atividade-arquivos')).toBeNull()
  })
})

describe('atividade do aluno: escolher e enviar', () => {
  it('lista os escolhidos com nome, tamanho e Remover; recusa antes de enviar com a frase do servidor', async () => {
    renderPage()
    choose(file('relatorio.pdf', 2 * MB, 'application/pdf'), file('virus.exe', 10, 'application/octet-stream'))
    const chosen = await screen.findByRole('list', { name: 'Arquivos escolhidos' })
    expect(within(chosen).getByText('relatorio.pdf')).toBeInTheDocument()
    expect(within(chosen).getByText('2,0 MB')).toBeInTheDocument()
    expect(within(chosen).getByText('O arquivo "virus.exe" não pode ser enviado: arquivos executáveis (.exe) são sempre recusados.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(mocks.upload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remover virus.exe' }))
    expect(within(chosen).queryByText('virus.exe')).not.toBeInTheDocument()
    // Três arquivos numa tarefa de dois: avisa e não envia.
    choose(file('b.pdf', MB, 'application/pdf'), file('c.pdf', MB, 'application/pdf'))
    expect(await screen.findByText('Envie no máximo 2 arquivo(s) por vez nesta tarefa.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('envio vazio avisa sem mandar nada', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(screen.getByRole('alert')).toHaveTextContent('O envio está vazio. Envie um arquivo ou a resposta em texto.')
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('envia com a barra de progresso e mostra o comprovante com o foco nele', async () => {
    let finish
    mocks.upload = vi.fn((path, form, options) => {
      options.onProgress({ loaded: 40, total: 100, percent: 40 })
      return new Promise((resolve) => { finish = resolve })
    })
    renderPage()
    choose(file('relatorio.pdf', 2 * MB, 'application/pdf'))
    fireEvent.change(screen.getByLabelText('Resposta em texto'), { target: { value: 'Segue o relatório.' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar' }))
    const bar = await screen.findByRole('progressbar', { name: 'Envio dos arquivos' })
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    expect(screen.getByText('Enviando… não feche esta página.')).toBeInTheDocument()
    const [path, form] = mocks.upload.mock.calls[0]
    expect(path).toBe('/api/student/assignments/asg_1/submit')
    expect(form.getAll('files').map((f) => f.name)).toEqual(['relatorio.pdf'])
    expect(form.get('text')).toBe('Segue o relatório.')
    expect(form.get('link')).toBeNull()
    await act(async () => { finish({ success: true, version: version(1) }) })
    const receipt = await screen.findByText('Envio recebido.')
    expect(screen.getByText('Recebido às 14:32 de 20/11 — versão 1 — 1 arquivo (2,0 MB) — código CODV1AAA')).toBeInTheDocument()
    expect(receipt.closest('[role="status"]')).toHaveFocus()
    expect(mocks.refetch).toHaveBeenCalled()
    expect(screen.queryByRole('list', { name: 'Arquivos escolhidos' })).not.toBeInTheDocument()
    // Imprimir comprovante: pelo printDocument, com a escola e o código.
    fireEvent.click(within(receipt.closest('[role="status"]')).getByRole('button', { name: 'Imprimir comprovante' }))
    expect(mocks.openWin).toHaveBeenCalled()
    const [doc] = mocks.print.mock.calls[0]
    expect(doc.titulo).toBe('Comprovante de entrega')
    expect(doc.displayName).toBe('Escola Técnica Modelo')
    expect(JSON.stringify(doc.secoes)).toContain('CODV1AAA')
  })

  it('rede caiu: mostra a mensagem e "Tentar de novo" manda os mesmos arquivos', async () => {
    const networkError = Object.assign(new Error('Sem conexão com o servidor do IClass. Confira a rede e tente de novo.'), { status: 0, network: true })
    mocks.upload = vi.fn().mockRejectedValueOnce(networkError).mockResolvedValueOnce({ success: true, version: version(1) })
    renderPage()
    choose(file('relatorio.pdf', 2 * MB, 'application/pdf'))
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar' }))
    expect(await screen.findByText('Sem conexão com o servidor do IClass. Confira a rede e tente de novo.')).toBeInTheDocument()
    // Conferiu se o envio tinha chegado antes de oferecer de novo.
    expect(mocks.refetch).toHaveBeenCalled()
    expect(screen.getByText('relatorio.pdf')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await screen.findByText('Envio recebido.')
    // Antes de mandar de novo, perguntou ao servidor se o envio tinha chegado (não tinha).
    // A conferência tem prazo (com a rede parada, a tela não fica presa em "Conferindo…").
    expect(mocks.get).toHaveBeenCalledWith('/api/student/assignments/asg_1?courseId=DES&studentClass=1DES', { timeoutMs: CHECK_TIMEOUT_MS })
    expect(mocks.upload).toHaveBeenCalledTimes(2)
    expect(mocks.upload.mock.calls[1][1].getAll('files').map((f) => f.name)).toEqual(['relatorio.pdf'])
    // O mesmo identificador nas duas tentativas (o servidor não cria versão repetida).
    const first = mocks.upload.mock.calls[0][2].headers['x-envio-id']
    expect(first).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(mocks.upload.mock.calls[1][2].headers['x-envio-id']).toBe(first)
  })

  it('C9 ajuste 1: "Tentar de novo" com a rede ainda fora não manda de novo; quando volta, acha a versão que chegou', async () => {
    const networkError = Object.assign(new Error('Sem conexão com o servidor do IClass. Confira a rede e tente de novo.'), { status: 0, network: true })
    mocks.upload = vi.fn().mockRejectedValueOnce(networkError)
    mocks.get = vi.fn().mockRejectedValueOnce(networkError)
    renderPage()
    choose(file('relatorio.pdf', 2 * MB, 'application/pdf'))
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar' }))
    await screen.findByText('Sem conexão com o servidor do IClass. Confira a rede e tente de novo.')
    const envioId = mocks.upload.mock.calls[0][2].headers['x-envio-id']
    // A rede continua fora: a conferência falha e nada é enviado de novo.
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument()
    expect(screen.getByText('Sem conexão com o servidor do IClass. Confira a rede e tente de novo.')).toBeInTheDocument()
    expect(mocks.upload).toHaveBeenCalledTimes(1)
    expect(screen.getByText('relatorio.pdf')).toBeInTheDocument()
    // A rede volta: o envio tinha chegado (a versão com o mesmo identificador).
    mocks.get = vi.fn(async () => detail({ situacao: 'enviada', situacaoTexto: 'Enviada', minhaEntrega: { status: 'enviada', versoes: [version(1, { envioId })], entregaEmMaos: null } }))
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    const recovered = await screen.findByText('O seu envio chegou ao professor.')
    expect(mocks.upload).toHaveBeenCalledTimes(1)
    expect(within(recovered.closest('[role="status"]')).getByText('Recebido às 14:32 de 20/11 — versão 1 — 1 arquivo (2,0 MB) — código CODV1AAA')).toBeInTheDocument()
    expect(mocks.setData).toHaveBeenCalled()
    expect(screen.queryByRole('list', { name: 'Arquivos escolhidos' })).not.toBeInTheDocument()
  })

  it('C9 ajuste 2: rede parada sem cair: o envio leva stallMs e o cancelamento, e o "parou" vira "Tentar de novo" com os mesmos arquivos', async () => {
    const stalled = Object.assign(new Error('O servidor do IClass demorou demais para responder. Confira se ele está ligado e tente de novo.'), { status: 0, timeout: true, stalled: true })
    mocks.upload = vi.fn().mockRejectedValueOnce(stalled).mockResolvedValueOnce({ success: true, version: version(1) })
    renderPage()
    choose(file('relatorio.pdf', 2 * MB, 'application/pdf'))
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar' }))
    expect(await screen.findByText(STALLED_MESSAGE)).toBeInTheDocument()
    const options = mocks.upload.mock.calls[0][2]
    expect(options.stallMs).toBe(STALL_MS)
    expect(STALL_MS).toBeGreaterThanOrEqual(30000)
    expect(STALL_MS).toBeLessThanOrEqual(60000)
    expect(options.signal).toBeInstanceOf(AbortSignal)
    // A consulta logo depois do erro também tem prazo.
    expect(mocks.refetch).toHaveBeenCalledWith(true, { timeoutMs: CHECK_TIMEOUT_MS })
    expect(screen.getByText('relatorio.pdf')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await screen.findByText('Envio recebido.')
    // Conferiu antes de mandar de novo, com o mesmo identificador.
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(mocks.upload.mock.calls[1][2].headers['x-envio-id']).toBe(options.headers['x-envio-id'])
  })

  it('C9 ajuste 2: "Cancelar envio" interrompe na hora, mantém a escolha e o "Tentar de novo" confere antes de mandar', async () => {
    mocks.upload = vi.fn()
      .mockImplementationOnce((path, form, options) => new Promise((resolve, reject) => {
        options.onProgress({ loaded: 33, total: 100, percent: 33 })
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Pedido cancelado.'), { name: 'AbortError', aborted: true, status: 0 })))
      }))
      .mockResolvedValueOnce({ success: true, version: version(1) })
    // A rede continua parada: a consulta de conferência não responde. O aviso e o "Tentar
    // de novo" não esperam por ela.
    mocks.refetch = vi.fn(() => new Promise(() => {}))
    renderPage()
    choose(file('relatorio.pdf', 2 * MB, 'application/pdf'))
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar' }))
    await screen.findByRole('progressbar', { name: 'Envio dos arquivos' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar envio' }))
    expect(await screen.findByText(CANCELLED_MESSAGE)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancelar envio' })).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByText('relatorio.pdf')).toBeInTheDocument()
    // O pedido cancelado pode ter chegado: confere pelo identificador antes de mandar.
    expect(mocks.refetch).toHaveBeenCalledWith(true, { timeoutMs: CHECK_TIMEOUT_MS })
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await screen.findByText('Envio recebido.')
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(mocks.upload).toHaveBeenCalledTimes(2)
    expect(mocks.upload.mock.calls[1][2].headers['x-envio-id']).toBe(mocks.upload.mock.calls[0][2].headers['x-envio-id'])
  })

  it('C9 ajuste 2: parado há alguns segundos avisa que a rede está lenta; o 100% não diz que o professor já recebeu', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    try {
      let progress
      mocks.upload = vi.fn((path, form, options) => { progress = options.onProgress; return new Promise(() => {}) })
      renderPage()
      choose(file('relatorio.pdf', 2 * MB, 'application/pdf'))
      fireEvent.click(await screen.findByRole('button', { name: 'Enviar' }))
      await screen.findByRole('progressbar', { name: 'Envio dos arquivos' })
      expect(screen.getByRole('button', { name: 'Cancelar envio' })).toBeInTheDocument()
      await act(async () => { vi.advanceTimersByTime(SLOW_HINT_MS - 2000) })
      expect(screen.queryByText(/A rede está lenta/)).not.toBeInTheDocument()
      await act(async () => { vi.advanceTimersByTime(3000) })
      expect(screen.getByText('A rede está lenta. Você pode esperar ou tocar em Cancelar envio: os arquivos escolhidos continuam aqui.')).toBeInTheDocument()
      // Subiu mais um pedaço: o aviso sai.
      await act(async () => { progress({ loaded: 100, total: 100, percent: 100 }) })
      expect(screen.queryByText(/A rede está lenta/)).not.toBeInTheDocument()
      expect(screen.getByText('Os arquivos saíram deste aparelho. Esperando o computador do professor confirmar que recebeu…')).toBeInTheDocument()
      expect(screen.queryByText(/Arquivos enviados/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('C9 ajuste 1: o servidor responde "repetido" (o envio tinha chegado): mostra o comprovante dessa versão', async () => {
    const networkError = Object.assign(new Error('Sem conexão com o servidor do IClass. Confira a rede e tente de novo.'), { status: 0, network: true })
    mocks.upload = vi.fn().mockRejectedValueOnce(networkError).mockResolvedValueOnce({ success: true, repetido: true, version: version(1) })
    renderPage()
    choose(file('relatorio.pdf', 2 * MB, 'application/pdf'))
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar' }))
    await screen.findByText('Sem conexão com o servidor do IClass. Confira a rede e tente de novo.')
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    expect(await screen.findByText('O seu envio chegou ao professor.')).toBeInTheDocument()
    expect(mocks.upload).toHaveBeenCalledTimes(2)
  })

  it('C9 ajuste 1: mudar a escolha depois do erro é outro envio (identificador novo, sem conferência)', async () => {
    const networkError = Object.assign(new Error('Sem conexão com o servidor do IClass. Confira a rede e tente de novo.'), { status: 0, network: true })
    mocks.upload = vi.fn().mockRejectedValueOnce(networkError).mockResolvedValueOnce({ success: true, version: version(1) })
    renderPage()
    choose(file('relatorio.pdf', 2 * MB, 'application/pdf'))
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar' }))
    await screen.findByText('Sem conexão com o servidor do IClass. Confira a rede e tente de novo.')
    fireEvent.change(screen.getByLabelText('Resposta em texto'), { target: { value: 'Faltou dizer isto.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await screen.findByText('Envio recebido.')
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.upload.mock.calls[1][2].headers['x-envio-id']).not.toBe(mocks.upload.mock.calls[0][2].headers['x-envio-id'])
  })

  it('a resposta se perdeu mas a versão chegou: mostra o comprovante dela em vez de pedir de novo', async () => {
    const networkError = Object.assign(new Error('Sem conexão com o servidor do IClass. Confira a rede e tente de novo.'), { status: 0, network: true })
    mocks.upload = vi.fn().mockRejectedValueOnce(networkError)
    mocks.refetch = vi.fn(async () => {
      const envioId = mocks.upload.mock.calls[0][2].headers['x-envio-id']
      mocks.detail = detail({ situacao: 'enviada', situacaoTexto: 'Enviada', minhaEntrega: { status: 'enviada', versoes: [version(1, { envioId })], entregaEmMaos: null } })
      return true
    })
    renderPage()
    choose(file('relatorio.pdf', 2 * MB, 'application/pdf'))
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar' }))
    expect(await screen.findByText('O seu envio chegou ao professor.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Arquivos escolhidos' })).not.toBeInTheDocument()
  })

  it('503 de gravação (retryable) também oferece "Tentar de novo"; recusa do servidor (413) não', async () => {
    mocks.upload = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Não foi possível gravar agora. Tente de novo em instantes.'), { status: 503, retryable: true }))
      .mockRejectedValueOnce(Object.assign(new Error('O envio passa do limite de 8 MB por envio.'), { status: 413, data: { code: 'submission_too_large' } }))
    renderPage()
    choose(file('relatorio.pdf', 2 * MB, 'application/pdf'))
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar' }))
    expect(await screen.findByText('Não foi possível gravar agora. Tente de novo em instantes.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    expect(await screen.findByText('O envio passa do limite de 8 MB por envio.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeInTheDocument()
  })

  it('foto acima de 3 MB vai reduzida, com o aviso e "Enviar original" quando a original cabe no limite', async () => {
    const reduced = file('IMG_0001-reduzida.jpg', 1 * MB, 'image/jpeg')
    mocks.resize = vi.fn(async () => ({ file: reduced, width: 2560, height: 1920, originalSize: 4 * MB }))
    mocks.upload = vi.fn(async () => ({ success: true, version: version(1) }))
    renderPage()
    choose(file('IMG_0001.jpg', 4 * MB, 'image/jpeg'))
    expect(await screen.findByText('Foto reduzida para enviar mais rápido (4,0 MB para 1,0 MB).')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Enviar original' }))
    expect(screen.getByText('Vai a foto original (4,0 MB).')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Usar a foto reduzida' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await screen.findByText('Envio recebido.')
    expect(mocks.upload.mock.calls[0][1].getAll('files').map((f) => f.name)).toEqual(['IMG_0001-reduzida.jpg'])
  })

  it('foto original maior que o limite da tarefa: só a reduzida, sem "Enviar original"', async () => {
    mocks.resize = vi.fn(async () => ({ file: file('IMG.jpg', 2 * MB, 'image/jpeg'), width: 2560, height: 1920, originalSize: 7 * MB }))
    renderPage()
    choose(file('IMG.jpg', 7 * MB, 'image/jpeg'))
    expect(await screen.findByText('Foto reduzida para enviar mais rápido (7,0 MB para 2,0 MB).')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Enviar original' })).not.toBeInTheDocument()
  })

  it('depois do prazo avisa "Você está enviando com atraso" antes de enviar', () => {
    mocks.detail = detail({ assignment: { ...detail().assignment, dueAt: NOW - 60 * 60 * 1000 }, situacao: 'atrasada', situacaoTexto: 'Atrasada', atrasoAgora: true })
    renderPage()
    expect(screen.getByText(/Você está enviando com atraso\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enviar com atraso' })).toBeInTheDocument()
  })
})

describe('atividade do aluno: versões e devolução', () => {
  it('devolvida: nota final em destaque, desconto, comentário e as versões com Baixar', async () => {
    mocks.detail = detail({
      aceitaEnvio: false,
      motivo: 'Esta tarefa já foi corrigida e devolvida. Para mandar outra versão, fale com o professor.',
      situacao: 'devolvida',
      situacaoTexto: 'Devolvida',
      minhaEntrega: { status: 'devolvida', versoes: [version(1), version(2, { late: true, lateMs: 2 * 24 * 60 * 60 * 1000, text: 'Texto <b>livre</b>', link: 'https://github.com/ana/projeto' })], entregaEmMaos: null },
      devolucao: { nota: 85, desconto: 20, notaFinal: 68, comentario: 'Bom trabalho.\nRevise a conclusão.', versaoCorrigida: 2, devolvidaEm: NOW },
    })
    renderPage()
    expect(screen.getByText('Devolvida pelo professor')).toBeInTheDocument()
    expect(screen.getByText('6,8')).toBeInTheDocument()
    expect(screen.getByText('Nota: 8,5')).toBeInTheDocument()
    expect(screen.getByText('Desconto por atraso: -20%')).toBeInTheDocument()
    expect(screen.getByText(/Revise a conclusão/)).toBeInTheDocument()
    // Sem formulário e sem repetir o motivo (a devolução já explica).
    expect(document.getElementById('atividade-arquivos')).toBeNull()
    expect(screen.queryByText(/já foi corrigida e devolvida/)).not.toBeInTheDocument()
    const versions = screen.getByRole('heading', { name: 'Versões enviadas (2)' }).closest('section')
    const items = within(versions).getAllByRole('listitem').filter((item) => item.querySelector('h3'))
    expect(within(items[0]).getByText('Versão 2')).toBeInTheDocument()
    expect(within(items[0]).getByText('Com atraso de 2 dias')).toBeInTheDocument()
    // Texto do aluno é texto (o <b> não vira negrito) e o link abre em outra aba.
    expect(within(items[0]).getByText('Texto <b>livre</b>')).toBeInTheDocument()
    expect(within(items[0]).getByRole('link', { name: 'Abrir' })).toHaveAttribute('rel', 'noopener noreferrer')
    fireEvent.click(within(items[1]).getByRole('button', { name: 'Baixar relatorio-v1.pdf' }))
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith('/api/student/assignments/asg_1/files/f_1', 'relatorio-v1.pdf'))
  })

  it('refazer: mostra o novo prazo e o comentário, e o envio reaberto', () => {
    mocks.detail = detail({
      situacao: 'refazer',
      situacaoTexto: 'Refazer até 24/11 às 23:00',
      minhaEntrega: { status: 'refazer', versoes: [version(1)], entregaEmMaos: null },
      refazer: { ate: DUE, encerramento: null, comentario: 'Faltou a tabela de medições.', pedidoEm: NOW },
    })
    renderPage()
    expect(screen.getByText('O professor pediu para refazer')).toBeInTheDocument()
    expect(screen.getByText('Envie a nova versão até ter., 24/11 às 23:00.')).toBeInTheDocument()
    expect(screen.getByText('Faltou a tabela de medições.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Enviar nova versão' })).toBeInTheDocument()
  })

  it('C9 ajuste 1: refazer com o prazo novo vencido diz que terminou, sem "Refazer até" no selo', () => {
    mocks.detail = detail({
      situacao: 'refazer',
      situacaoTexto: 'Refazer até 21/11 às 23:00',
      aceitaEnvio: false,
      motivo: 'O prazo desta tarefa terminou e ela não aceita envio atrasado. Fale com o professor.',
      minhaEntrega: { status: 'refazer', versoes: [version(1)], entregaEmMaos: null },
      refazer: { ate: Date.UTC(2026, 10, 22, 2, 0), encerramento: null, comentario: 'Faltou a tabela.', pedidoEm: NOW },
    })
    renderPage()
    expect(screen.getByText('Prazo para refazer encerrado')).toBeInTheDocument()
    expect(screen.queryByText('Refazer até 21/11 às 23:00')).not.toBeInTheDocument()
    expect(screen.getByText('O prazo para enviar a nova versão terminou em sáb., 21/11 às 23:00.')).toBeInTheDocument()
    expect(document.getElementById('atividade-arquivos')).toBeNull()
  })

  it('C9 ajuste 2: títulos das instruções descem de nível (só um <h1> na página, o da atividade)', () => {
    mocks.detail = detail()
    mocks.detail.assignment.instructions = '# Parte 1\n\nFaça isto.\n\n## Passo a passo\n\nDepois aquilo.'
    const { container } = renderPage()
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(container.querySelector('h1')).toHaveTextContent('Relatório da prática')
    const part = screen.getByRole('heading', { name: 'Parte 1' })
    expect(part.tagName).toBe('H3')
    expect(part).toHaveClass('prose-nivel-1')
    expect(screen.getByRole('heading', { name: 'Passo a passo' }).tagName).toBe('H4')
  })

  it('C9 ajuste 1: mostra o módulo e a unidade da atividade', () => {
    mocks.detail = detail()
    mocks.detail.assignment.unidade = 'Módulo 1 · Redes locais'
    renderPage()
    expect(screen.getByText('Módulo 1 · Redes locais')).toBeInTheDocument()
  })
})
