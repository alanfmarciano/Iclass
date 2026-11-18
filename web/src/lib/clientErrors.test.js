import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H9c (ENG-05): o erro de tela fora da prova chega ao servidor
// (POST /api/client-error), uma vez por mensagem e no máximo cinco por carga da página.
const apiMock = vi.hoisted(() => ({ post: vi.fn(), session: true }))
vi.mock('./api', () => ({
  api: { post: apiMock.post },
  hasActiveSession: () => apiMock.session,
}))

import { CLIENT_ERROR_MAX_PER_PAGE, reportClientError, resetClientErrorReportsForTests } from './clientErrors'

beforeEach(() => {
  apiMock.post.mockReset()
  apiMock.post.mockResolvedValue(null)
  apiMock.session = true
  resetClientErrorReportsForTests()
  window.history.replaceState(null, '', '/aluno/caderno?aba=2')
})

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('[UC-ERRO-002] reportClientError: aviso do erro de tela para o servidor', () => {
  it('envia área, mensagem sem endereços e caminho sem a query string, como consulta de fundo com prazo', () => {
    const error = new Error('Minified React error #31; visit https://reactjs.org/docs/error-decoder.html?invariant=31 for the full message')
    expect(reportClientError('aluno', error)).toBe(true)
    expect(apiMock.post).toHaveBeenCalledTimes(1)
    const [path, body, options] = apiMock.post.mock.calls[0]
    expect(path).toBe('/api/client-error')
    expect(body).toEqual(expect.objectContaining({ area: 'aluno', message: 'Minified React error #31', path: '/aluno/caderno' }))
    expect(JSON.stringify(body)).not.toMatch(/https?:/)
    expect(options).toEqual({ background: true, timeoutMs: 10000 })
  })

  it('a mesma mensagem não envia de novo, e a carga da página manda no máximo cinco avisos', () => {
    reportClientError('admin', new Error('Falhou A'))
    reportClientError('admin', new Error('Falhou A'))
    reportClientError('aluno', new Error('Falhou A'))
    expect(apiMock.post).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 10; index += 1) reportClientError('admin', new Error(`Outro erro ${index}`))
    expect(apiMock.post).toHaveBeenCalledTimes(CLIENT_ERROR_MAX_PER_PAGE)
    expect(CLIENT_ERROR_MAX_PER_PAGE).toBe(5)
  })

  it('sem sessão aberta ou com área fora da lista não envia nada', () => {
    apiMock.session = false
    expect(reportClientError('raiz', new Error('Na tela de login'))).toBe(false)
    apiMock.session = true
    expect(reportClientError('painel', new Error('Área errada'))).toBe(false)
    expect(apiMock.post).not.toHaveBeenCalled()
    // A mensagem não enviada continua podendo ir depois (ex.: depois do login).
    expect(reportClientError('raiz', new Error('Na tela de login'))).toBe(true)
  })

  it('falha do envio (servidor fora, 429) nunca vira erro na tela', async () => {
    const rejections = []
    const onRejection = (reason) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      apiMock.post.mockRejectedValue(Object.assign(new Error('Muitos avisos'), { status: 429 }))
      expect(reportClientError('admin', new Error('Erro qualquer'))).toBe(true)
      apiMock.post.mockImplementation(() => { throw new Error('quebrou ao montar o pedido') })
      expect(reportClientError('admin', new Error('Outro erro'))).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('caminho longo vai cortado em 200 caracteres e a mensagem em 300', () => {
    window.history.replaceState(null, '', `/${'a'.repeat(400)}`)
    reportClientError('admin', new Error('x'.repeat(1000)))
    const [, body] = apiMock.post.mock.calls[0]
    expect(body.path).toHaveLength(200)
    expect(body.message).toHaveLength(300)
  })
})
