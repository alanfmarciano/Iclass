import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageComposer, MessageList, scrollParent } from './MessageThread'

// Rolagem da conversa (fase 3, C14 / P5-S7b, FUN-14; revisão do C14): o campo de escrita
// fica preso ao pé da tela (sticky) logo depois da lista. Rolar só até o fim da lista
// deixava a última mensagem por baixo do campo; a rolagem vai até o fim do rolador, onde o
// campo volta ao lugar dele, abaixo da última mensagem.
function message(id, autor, criadaEm) {
  return { id, autor, texto: `texto ${id}`, nome: autor === 'voce' ? '' : 'Paulo Professor', criadaEm }
}

function setup(initial) {
  const scrollTo = vi.fn()
  const metrics = { scrollHeight: 2000, clientHeight: 600, scrollTop: 0 }
  function Screen({ mensagens }) {
    return (
      <main data-testid="rolador" style={{ overflowY: 'auto' }}>
        <MessageList mensagens={mensagens} side="aluno" scrollKey="c1" />
        <MessageComposer value="" onChange={() => {}} onSend={() => {}} />
      </main>
    )
  }
  const view = render(<Screen mensagens={[]} />)
  const scroller = view.getByTestId('rolador')
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => metrics.clientHeight })
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => metrics.scrollTop, set: (value) => { metrics.scrollTop = value } })
  scroller.scrollTo = scrollTo
  const rerender = (mensagens) => view.rerender(<Screen mensagens={mensagens} />)
  if (initial.length) rerender(initial)
  return { view, scroller, scrollTo, metrics, rerender }
}

describe('[UC-MENSAGEM-006] rolagem da conversa com o campo preso ao pé', () => {
  afterEach(() => cleanup())

  it('o rolador é o ancestral com rolagem (o <main>), não a lista', () => {
    const { view, scroller } = setup([])
    expect(scrollParent(view.getByRole('list', { name: 'Mensagens da conversa' }))).toBe(scroller)
  })

  it('ao abrir, rola o rolador inteiro até o fim (inclui o campo), não só até o fim da lista', () => {
    const { rerender, scrollTo } = setup([])
    rerender([message('m1', 'instrutor', 1), message('m2', 'instrutor', 2)])
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2000, behavior: 'auto' })
  })

  it('mensagem nova do outro lado: rola se a pessoa estava no fim; não tira a pessoa de onde ela leu mais acima', () => {
    const first = [message('m1', 'instrutor', 1)]
    const { rerender, scrollTo, scroller, metrics } = setup(first)
    expect(scrollTo).toHaveBeenCalledTimes(1)

    // No fim (o que a rolagem automática deixou): a resposta do professor chega pela consulta.
    metrics.scrollTop = metrics.scrollHeight - metrics.clientHeight
    fireEvent.scroll(scroller)
    metrics.scrollHeight = 2300
    const second = [...first, message('m2', 'instrutor', 2)]
    rerender(second)
    expect(scrollTo).toHaveBeenCalledTimes(2)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2300, behavior: 'smooth' })

    // A pessoa subiu para ler as antigas: a próxima do professor não a puxa para baixo.
    metrics.scrollTop = 100
    fireEvent.scroll(scroller)
    const third = [...second, message('m3', 'instrutor', 3)]
    rerender(third)
    expect(scrollTo).toHaveBeenCalledTimes(2)

    // A própria mensagem enviada sempre aparece.
    rerender([...third, message('m4', 'voce', 4)])
    expect(scrollTo).toHaveBeenCalledTimes(3)
  })

  it('sem scrollTo (navegador antigo), usa scrollTop', () => {
    const { rerender, scroller, metrics } = setup([])
    scroller.scrollTo = undefined
    act(() => { rerender([message('m1', 'instrutor', 1)]) })
    expect(metrics.scrollTop).toBe(2000)
  })

  // Revisão do C14, rodada 2: o erro de envio (limite de 20 em 10 minutos, 409, sem rede)
  // e o contador a partir de 1.800 caracteres crescem o campo preso ao pé; sem rolar, ele
  // cobria a última mensagem.
  function setupComposer() {
    const scrollTo = vi.fn()
    const metrics = { scrollHeight: 2000, clientHeight: 600, scrollTop: 1400, formHeight: 150 }
    function Screen({ error, value = '' }) {
      return (
        <main data-testid="rolador" style={{ overflowY: 'auto' }}>
          <MessageList mensagens={[message('m1', 'instrutor', 1)]} side="aluno" scrollKey="c1" />
          <MessageComposer value={value} onChange={() => {}} onSend={() => {}} error={error} />
        </main>
      )
    }
    // O <form> mede a altura pelo offsetHeight (o jsdom não desenha): o protótipo devolve a
    // altura combinada para o formulário e 0 para o resto.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() { return this.classList?.contains('mensagens-composer') ? metrics.formHeight : 0 },
    })
    const view = render(<Screen />)
    const scroller = view.getByTestId('rolador')
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => metrics.clientHeight })
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => metrics.scrollTop, set: (value) => { metrics.scrollTop = value } })
    scroller.scrollTo = scrollTo
    const restore = () => { if (original) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original) }
    return { view, scrollTo, metrics, restore, rerender: (props) => view.rerender(<Screen {...props} />) }
  }

  it('no fim da conversa, o erro de envio que cresce o campo rola até o fim (a última mensagem não fica atrás dele)', () => {
    const { scrollTo, metrics, restore, rerender } = setupComposer()
    try {
      scrollTo.mockClear()
      metrics.formHeight = 188
      metrics.scrollHeight = 2038
      rerender({ error: 'Você mandou muitas mensagens em pouco tempo. Tente de novo em 10 minutos.' })
      expect(scrollTo).toHaveBeenCalledTimes(1)
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 2038, behavior: 'auto' })
      // O erro some (o campo diminui): nada a fazer.
      metrics.formHeight = 150
      metrics.scrollHeight = 2000
      rerender({ error: '' })
      expect(scrollTo).toHaveBeenCalledTimes(1)
    } finally { restore() }
  })

  it('quem subiu para ler as antigas não é puxado quando o campo cresce', () => {
    const { scrollTo, metrics, restore, rerender } = setupComposer()
    try {
      scrollTo.mockClear()
      metrics.scrollTop = 200
      metrics.formHeight = 170
      metrics.scrollHeight = 2020
      rerender({ value: 'x'.repeat(1800) })
      expect(scrollTo).not.toHaveBeenCalled()
    } finally { restore() }
  })
})
