import { afterEach, describe, expect, it, vi } from 'vitest'
import { escapeHtml, formatGeneratedAt, html, openPrintWindow, printDocument, printDocumentHtml, safeImageUrl, schoolFromBranding, trustedHtml } from './printDocument'

const ATTACK = '<img src=x onerror="alert(1)">'

function parse(markup) {
  return new DOMParser().parseFromString(markup, 'text/html')
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

// Fase 3, C0a (contrato C5 do P4): documento impresso único, com o cabeçalho da escola, o
// rodapé do white-label e todo texto escapado.
describe('[UC-IMPRESSAO-001] printDocument: cabeçalho da escola, rodapé do white-label e escape', () => {
  it('texto vindo do banco nunca vira HTML (título, escola, seções, tabela, pares e assinaturas)', () => {
    const markup = printDocumentHtml({
      titulo: `Boletim ${ATTACK}`,
      subtitulo: ATTACK,
      escola: { nome: `Escola ${ATTACK}`, razaoSocial: ATTACK, registro: ATTACK, endereco: ATTACK, contato: ATTACK },
      displayName: `Inst ${ATTACK}`,
      rodapeEsquerda: ATTACK,
      secoes: [
        { titulo: ATTACK, texto: ATTACK, paragrafos: [ATTACK], pares: [[ATTACK, ATTACK]], tabela: { colunas: [ATTACK], linhas: [[ATTACK]] }, assinaturas: [ATTACK], observacao: ATTACK, html: ATTACK },
      ],
    })
    const doc = parse(markup)
    expect(doc.querySelectorAll('img')).toHaveLength(0)
    expect(doc.querySelector('[onerror]')).toBeNull()
    expect(markup).not.toContain('<img src=x')
    expect(doc.title).toBe(`Boletim ${ATTACK}`)
    expect(doc.body.textContent).toContain(ATTACK)
    // html sem trustedHtml é texto comum.
    expect(doc.querySelectorAll('section p').length).toBeGreaterThan(0)
  })

  it('HTML só entra montado por html`` (valores escapados) ou trustedHtml', () => {
    const name = '<b>Ana</b>'
    const markup = printDocumentHtml({ titulo: 'Bilhete', secoes: [{ html: html`<p class="destaque">Aluno: <strong>${name}</strong></p>` }, trustedHtml('<div class="canhoto">Recebi</div>')] })
    const doc = parse(markup)
    expect(doc.querySelector('p.destaque strong').textContent).toBe('<b>Ana</b>')
    expect(doc.querySelector('p.destaque b')).toBeNull()
    expect(doc.querySelector('.canhoto').textContent).toBe('Recebi')
    expect(escapeHtml(`"'&<>`)).toBe('&quot;&#39;&amp;&lt;&gt;')
    expect(escapeHtml(null)).toBe('')
  })

  it('rodapé "Gerado por <nome da instituição> em <data>", nunca "Gerado pelo IClass" fixo', () => {
    const markup = printDocumentHtml({ titulo: 'Diário', displayName: 'Escola Técnica Alfa', geradoEm: new Date(2026, 10, 18, 9, 5), secoes: [] })
    const footer = parse(markup).querySelector('footer.rodape')
    expect(footer.textContent).toContain('Gerado por Escola Técnica Alfa em 18/11/2026 às 09:05')
    expect(markup).not.toMatch(/Gerado pelo IClass/)
    expect(formatGeneratedAt(Date.UTC(2026, 10, 18, 13, 0), 'America/Sao_Paulo')).toBe('18/11/2026 às 10:00')
    expect(formatGeneratedAt(Date.UTC(2026, 10, 18, 13, 0), 'Fuso/Inexistente')).toMatch(/^\d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}$/)
  })

  it('@page A4 em retrato ou paisagem; uma folha por item com o cabeçalho e o rodapé em cada uma', () => {
    expect(printDocumentHtml({ titulo: 'A' })).toContain('@page{size:A4 portrait')
    const markup = printDocumentHtml({
      titulo: 'Comunicado', orientacao: 'paisagem', displayName: 'Alfa', escola: { nome: 'Escola Alfa' },
      folhas: [{ titulo: 'Ana', secoes: [{ texto: 'Folha da Ana' }] }, { titulo: 'Bruno', secoes: [{ texto: 'Folha do Bruno' }] }],
    })
    expect(markup).toContain('@page{size:A4 landscape')
    const doc = parse(markup)
    const sheets = doc.querySelectorAll('article.folha')
    expect(sheets).toHaveLength(2)
    expect(sheets[1].classList.contains('nova-folha')).toBe(true)
    expect([...sheets].map((sheet) => sheet.querySelector('h1').textContent)).toEqual(['Ana', 'Bruno'])
    expect([...sheets].every((sheet) => sheet.querySelector('.nome-escola').textContent === 'Escola Alfa' && /Gerado por Alfa/.test(sheet.querySelector('footer').textContent))).toBe(true)
  })

  it('tabela com colunas alinhadas e linha de vazio; pares em tabela de rótulo e valor', () => {
    const doc = parse(printDocumentHtml({ titulo: 'T', secoes: [
      { titulo: 'Faltas', tabela: { colunas: ['Aluno', 'Faltas'], linhas: [['Ana', 3]], alinhar: [null, 'direita'] } },
      { tabela: { colunas: ['Aluno'], linhas: [], vazio: 'Nenhum aluno.' } },
      { pares: [['Turma', '1DES'], ['Frequência', null]] },
    ] }))
    expect(doc.querySelector('td.num').textContent).toBe('3')
    expect(doc.querySelector('td.empty').textContent).toBe('Nenhum aluno.')
    expect([...doc.querySelectorAll('table.pares td')].map((td) => td.textContent)).toEqual(['1DES', '—'])
  })

  it('logo da escola só com endereço seguro; schoolFromBranding lê a identidade efetiva', () => {
    expect(safeImageUrl('javascript:alert(1)')).toBe('')
    expect(safeImageUrl('//outro.site/logo.png')).toBe('')
    expect(safeImageUrl('/uploads/logo.png')).toBe('/uploads/logo.png')
    expect(safeImageUrl('https://escola.local/logo.png')).toBe('https://escola.local/logo.png')
    expect(safeImageUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    const school = schoolFromBranding({ displayName: 'Alfa', schoolName: 'Escola Alfa', logoLightUrl: '/uploads/logo.png', institution: { tradeName: 'ETE Alfa', legalName: 'Escola Técnica Alfa Ltda', registrationId: '12.345.678/0001-90', address: 'Rua A, 10', cityState: 'Recife/PE', zip: '50000-000', phone: '(81) 3333-0000', email: 'contato@alfa.local' } })
    expect(school).toEqual({ nome: 'ETE Alfa', razaoSocial: 'Escola Técnica Alfa Ltda', registro: '12.345.678/0001-90', endereco: 'Rua A, 10 · Recife/PE · CEP 50000-000', contato: '(81) 3333-0000 · contato@alfa.local', logoUrl: '/uploads/logo.png' })
    const doc = parse(printDocumentHtml({ titulo: 'T', escola: school }))
    expect(doc.querySelector('img.logo').getAttribute('src')).toBe('/uploads/logo.png')
    expect(doc.querySelector('.cabecalho').textContent).toContain('CNPJ / registro 12.345.678/0001-90')
    expect(parse(printDocumentHtml({ titulo: 'T', escola: { logoUrl: 'javascript:alert(1)' } })).querySelector('img')).toBeNull()
    expect(schoolFromBranding(null).nome).toBe('')
  })

  it('printDocument escreve na janela aberta no clique e imprime uma vez; janela bloqueada devolve false', () => {
    vi.useFakeTimers()
    const written = []
    const listeners = {}
    const win = {
      closed: false,
      focus: vi.fn(),
      print: vi.fn(),
      addEventListener: (name, fn) => { listeners[name] = fn },
      document: { readyState: 'loading', open: vi.fn(), write: (text) => written.push(text), close: vi.fn() },
    }
    expect(printDocument({ titulo: 'Diário', displayName: 'Alfa' }, win)).toBe(true)
    expect(written.join('')).toContain('Gerado por Alfa')
    listeners.load()
    vi.advanceTimersByTime(3000)
    expect(win.print).toHaveBeenCalledTimes(1)
    expect(printDocument({ titulo: 'X' }, { closed: true })).toBe(false)
    vi.spyOn(window, 'open').mockReturnValue(null)
    expect(printDocument({ titulo: 'X' })).toBe(false)
    expect(openPrintWindow()).toBeNull()
  })
})
