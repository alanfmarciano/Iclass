import { describe, expect, it } from 'vitest'
import { firstMarkFrom, htmlRoot, markTerm, splitSections, unmarkTerm } from './contentText'
import { apostilaSections } from './searchIndex'

// Fase 3, C16 (P5-S2): a Busca e o leitor contam as seções e marcam o termo do mesmo jeito.
describe('[UC-BUSCA-003] texto da apostila para a busca e o leitor', () => {
  it('cada título (h1 a h4) começa uma seção; o texto antes do primeiro fica na seção 0', () => {
    const sections = apostilaSections('Abertura sem título.\n\n# Um\n\nTexto *um*.\n\n- item a\n- item b\n\n## Dois\n\n| A | B |\n|---|---|\n| x | y |\n\n##### Nota\n\nainda dois', 'Unidade')
    expect(sections).toEqual([
      { secao: 0, title: 'Unidade', text: 'Abertura sem título.' },
      { secao: 1, title: 'Um', text: 'Texto um. item a item b' },
      { secao: 2, title: 'Dois', text: 'A B x y Nota ainda dois' },
    ])
  })

  it('título dentro de um bloco de HTML conta na mesma ordem do leitor', () => {
    const root = htmlRoot('<div><h2>Dentro</h2><p>texto</p></div><h3>Fora</h3><p>mais</p>')
    expect(splitSections(root).map((section) => [section.secao, section.title])).toEqual([[1, 'Dentro'], [2, 'Fora']])
  })

  it('marca o termo em nós de texto, sem juntar parágrafos, e desfaz sem mudar o texto', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>Rede no começo</p><h1>Título</h1><p>fim da re</p><p>de seguinte e <b>Ação</b> da <i>re</i>de</p>'
    document.body.appendChild(root)
    const before = root.innerHTML
    const marks = markTerm(root, 'rede acao')
    expect(marks.map((mark) => mark.textContent)).toEqual(['Rede', 'Ação', 're', 'de'])
    expect(marks.every((mark) => mark.tagName === 'MARK' && mark.className === 'busca-marca')).toBe(true)
    expect(firstMarkFrom(root, marks, 1).textContent).toBe('Ação')
    expect(firstMarkFrom(root, marks, 0).textContent).toBe('Rede')
    expect(firstMarkFrom(root, marks, 9).textContent).toBe('Rede')
    unmarkTerm(marks)
    expect(root.querySelectorAll('mark')).toHaveLength(0)
    expect(root.innerHTML).toBe(before)
    root.remove()
  })
})
