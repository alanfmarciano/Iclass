import { describe, expect, it } from 'vitest'
import { TOUCH_CONTEXT_MENU_WINDOW_MS, isAnswerFieldContextMenu, isTouchContextMenu } from './keystrokePolicy'

// Ajuste 2 do A5: só o toque longo abre o menu dentro da resposta escrita; o botão
// direito do mouse e a tecla de menu continuam bloqueados e registrados.
describe('isTouchContextMenu', () => {
  it('confia no tipo do ponteiro do próprio evento', () => {
    expect(isTouchContextMenu({ pointerType: 'touch' })).toBe(true)
    expect(isTouchContextMenu({ pointerType: 'pen' })).toBe(true)
    expect(isTouchContextMenu({ pointerType: 'mouse', button: 2 })).toBe(false)
    // Tipo do evento vence o último ponteiro.
    expect(isTouchContextMenu({ pointerType: 'mouse' }, { type: 'touch', at: 1000 }, 1100)).toBe(false)
  })

  it('sem o tipo, usa sourceCapabilities.firesTouchEvents', () => {
    expect(isTouchContextMenu({ sourceCapabilities: { firesTouchEvents: true } })).toBe(true)
    expect(isTouchContextMenu({ sourceCapabilities: { firesTouchEvents: false } }, { type: 'touch', at: 1000 }, 1100)).toBe(false)
  })

  it('sem nada no evento, vale o último ponteiro se foi um toque há pouco', () => {
    expect(isTouchContextMenu({}, { type: 'touch', at: 1000 }, 1500)).toBe(true)
    expect(isTouchContextMenu({}, { type: 'touch', at: 1000 }, 1000 + TOUCH_CONTEXT_MENU_WINDOW_MS + 1)).toBe(false)
    expect(isTouchContextMenu({}, { type: 'mouse', at: 1000 }, 1100)).toBe(false)
    expect(isTouchContextMenu({}, null)).toBe(false)
    expect(isTouchContextMenu(null)).toBe(false)
  })
})

describe('isAnswerFieldContextMenu', () => {
  function field(html) {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    return host.querySelector('textarea, input, span')
  }

  it('toque longo na resposta escrita passa; o mouse e o toque fora dela não', () => {
    const essay = field('<div data-exam-answer><textarea></textarea></div>')
    const checkbox = field('<div data-exam-answer><input type="checkbox"></div>')
    const report = field('<textarea></textarea>')
    expect(isAnswerFieldContextMenu({ target: essay, pointerType: 'touch' })).toBe(true)
    expect(isAnswerFieldContextMenu({ target: essay, pointerType: 'mouse', button: 2 })).toBe(false)
    expect(isAnswerFieldContextMenu({ target: essay })).toBe(false)
    expect(isAnswerFieldContextMenu({ target: checkbox, pointerType: 'touch' })).toBe(false)
    expect(isAnswerFieldContextMenu({ target: report, pointerType: 'touch' })).toBe(false)
  })
})
