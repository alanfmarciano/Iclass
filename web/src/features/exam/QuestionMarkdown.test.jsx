import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import QuestionMarkdown, { questionMarkdownHtml } from './QuestionMarkdown'
import { markdownToHtml } from '../../lib/contentMarkdown'

// Texto da questão de prova em Markdown (fase 3, P3-S2: UXA-12; contrato C4 do P3).
afterEach(() => {
  cleanup()
  localStorage.clear()
})

function rendered(text, props = {}) {
  const { container } = render(<QuestionMarkdown text={text} {...props} />)
  return container.querySelector('.question-md')
}

describe('[UC-PROVA-004] QuestionMarkdown: enunciado, alternativa e explicação em Markdown', () => {
  it('código cercado vira <pre><code> com rolagem pelo teclado, e a quebra de linha do texto fica', () => {
    const root = rendered('Leia o comando:\nsegunda linha\n\n```\n$ ping -c 4 192.168.0.1\n```')
    const code = root.querySelector('pre > code')
    expect(code.textContent).toContain('$ ping -c 4 192.168.0.1')
    expect(root.querySelector('pre')).toHaveAttribute('tabindex', '0')
    expect(root.querySelector('p').innerHTML).toContain('<br>')
  })

  it('tabela ganha um contêiner com rolagem própria', () => {
    const root = rendered('| Máscara | Hosts |\n| --- | --- |\n| /24 | 254 |\n| /30 | 2 |')
    const wrapper = root.querySelector('.question-md-table')
    expect(wrapper).not.toBeNull()
    expect(wrapper.querySelector('table')).not.toBeNull()
    expect(wrapper).toHaveAttribute('role', 'region')
    expect(screen.getByRole('region', { name: /Tabela/ })).toBeVisible()
    expect(root.querySelectorAll('td')).toHaveLength(4)
  })

  it('<script>, onerror e javascript: somem', () => {
    const html = questionMarkdownHtml('<script>alert(1)</script><img src=x onerror="alert(2)"> [clique](javascript:alert(3)) <iframe src="https://x"></iframe>')
    // Escritos no texto, viram texto (escapados): nenhum elemento nem atributo perigoso.
    expect(html).not.toMatch(/<script|<img|<iframe|href=["']?javascript:/i)
    const root = document.createElement('div')
    root.innerHTML = html
    expect(root.querySelector('script, img, iframe, [onerror]')).toBeNull()
    expect(root.querySelector('a')).not.toHaveAttribute('href')
  })

  it('imagem de /uploads ganha ?access= com a sessão do aluno e cabe na largura (classe da questão)', () => {
    localStorage.setItem('iclass-v3-auth', JSON.stringify({ role: 'student', sessionToken: 'sessao-do-aluno' }))
    const root = rendered('Observe:\n\n![rede da sala](/uploads/rede.png)')
    const img = root.querySelector('img')
    expect(img.getAttribute('src')).toBe('/uploads/rede.png?access=sessao-do-aluno')
    expect(img.getAttribute('alt')).toBe('rede da sala')
    expect(root).toHaveClass('question-md')
  })

  it('tocar na imagem abre a imagem grande numa janela do IClass; Fechar volta', async () => {
    const user = userEvent.setup()
    rendered('![diagrama](/uploads/diagrama.png)')
    await user.click(screen.getByRole('button', { name: 'diagrama' }))
    expect(screen.getByRole('dialog', { name: 'Imagem da questão' })).toBeVisible()
    expect(screen.getByRole('dialog').querySelector('img').getAttribute('src')).toContain('/uploads/diagrama.png')
    await user.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('sem zoom (alternativa dentro de um botão), a imagem não abre janela', async () => {
    const user = userEvent.setup()
    const root = rendered('![a](/uploads/a.png)', { zoom: false })
    expect(root.querySelector('img')).not.toHaveAttribute('data-zoomable')
    await user.click(root.querySelector('img'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('na prova (links desligados) o link vira texto e não tira o aluno da prova', () => {
    const root = rendered('Veja [a documentação](https://exemplo.com/doc).', { links: false })
    const anchor = root.querySelector('a')
    expect(anchor).not.toHaveAttribute('href')
    expect(anchor.textContent).toBe('a documentação')
    expect(rendered('[doc](https://exemplo.com)').querySelector('a')).toHaveAttribute('href', 'https://exemplo.com')
  })

  it('texto antigo sem Markdown aparece como antes (sem tags a mais)', () => {
    const root = rendered('Qual é a capital do Brasil?')
    expect(root.textContent.trim()).toBe('Qual é a capital do Brasil?')
    expect(root.querySelectorAll('p')).toHaveLength(1)
  })

  // Rodada de ajuste do A5: o HTML cru do texto era interpretado e sumia ('<p>' deixava a
  // alternativa vazia; 'Lista<String>' virava 'Lista') e '2*3*4' perdia os asteriscos.
  it('HTML escrito no texto aparece literal: alternativa "<p>" não fica vazia, "Lista<String>" fica inteiro', () => {
    expect(rendered('<p>').textContent.trim()).toBe('<p>')
    cleanup()
    expect(rendered('Lista<String> em Java').textContent.trim()).toBe('Lista<String> em Java')
    cleanup()
    expect(rendered('Qual tag cria um parágrafo em HTML: <p> ou <div>?').textContent.trim())
      .toBe('Qual tag cria um parágrafo em HTML: <p> ou <div>?')
    cleanup()
    expect(rendered('Use a tag <br> para quebrar a linha.').textContent.trim()).toBe('Use a tag <br> para quebrar a linha.')
    cleanup()
    expect(rendered('#include <stdio.h>').textContent.trim()).toBe('#include <stdio.h>')
    cleanup()
    const root = rendered('<table><tr><td>1</td></tr></table>\n<b>forte</b> <img src="/uploads/x.png">')
    expect(root.querySelector('table, b, img')).toBeNull()
    expect(root.textContent).toContain('<table><tr><td>1</td></tr></table>')
    expect(root.textContent).toContain('<b>forte</b> <img src="/uploads/x.png">')
  })

  it('HTML perigoso escrito no texto vira texto, sem elemento nem atributo', () => {
    const root = rendered('<img src=x onerror="alert(2)"> <a href="javascript:alert(1)">x</a>\n<script>\nalert(3)\n</script>')
    expect(root.querySelector('img, a, script')).toBeNull()
    expect(root.textContent).toContain('<img src=x onerror="alert(2)">')
    expect(root.textContent).toContain('<script>')
  })

  it('asterisco entre números ou letras não vira ênfase; negrito e itálico do Markdown continuam', () => {
    expect(rendered('Quanto é 2*3*4?').textContent.trim()).toBe('Quanto é 2*3*4?')
    cleanup()
    expect(rendered('Em Python, x**2 + y**2 e 5*x + 3*y').textContent.trim()).toBe('Em Python, x**2 + y**2 e 5*x + 3*y')
    cleanup()
    expect(rendered('SELECT * FROM Produtos').textContent.trim()).toBe('SELECT * FROM Produtos')
    cleanup()
    const root = rendered('**negrito**, *itálico* e `<p>` em código')
    expect(root.querySelector('strong').textContent).toBe('negrito')
    expect(root.querySelector('em').textContent).toBe('itálico')
    expect(root.querySelector('code').textContent).toBe('<p>')
  })

  it('as apostilas seguem o Markdown padrão (o conversor das questões não muda o leitor)', () => {
    expect(markdownToHtml('2*3*4')).toContain('<em>3</em>')
    expect(markdownToHtml('linha um\nlinha dois')).not.toContain('<br>')
    expect(markdownToHtml('<b>x</b>')).toContain('<b>x</b>')
  })
})
