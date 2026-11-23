import { describe, expect, it } from 'vitest'
import { HELP_DOCS, anchorFromHash, loadHelpDoc, parseHelpDocument, slugify, stripComments, visibleSections } from './helpDocs'
import { helpMarkdownToHtml } from './HelpArticle'
import instrutor from './conteudo/instrutor.md?raw'
import aluno from './conteudo/aluno.md?raw'

// Ajuda (fase 3, A1 / P6-S9: OPS-13): os cinco textos da D20, os temas com âncora estável
// e a regra de "tema sem texto não aparece".
describe('[UC-AJUDA-001] textos da ajuda', () => {
  it('são os cinco da D20 mais as Novidades, cada um carregado sob demanda', async () => {
    expect(HELP_DOCS.map((doc) => doc.id)).toEqual(['instrutor', 'aluno', 'instalacao-e-rede', 'perguntas-frequentes', 'problemas', 'novidades'])
    for (const entry of HELP_DOCS) {
      const doc = await loadHelpDoc(entry.id)
      expect(doc.titulo, entry.id).toBeTruthy()
      expect(doc.secoes.length, entry.id).toBeGreaterThan(0)
    }
    await expect(loadHelpDoc('nao-existe')).rejects.toThrow('Este assunto da ajuda não existe.')
  })

  it('o manual do professor tem o título e a âncora de cada tema da fase 3 e das telas com o botão "?", na ordem do menu', () => {
    const ids = parseHelpDocument(instrutor).secoes.map((section) => section.id)
    const expected = ['primeiros-passos', 'dashboard', 'provas', 'banco-de-questoes', 'monitor', 'tarefas', 'resultados', 'correcao', 'materiais', 'grupos', 'chamada', 'diario', 'calendario', 'mensagens', 'responsaveis', 'relatorios', 'turmas', 'periodo-letivo', 'certificados', 'importar-alunos', 'contas', 'minha-conta', 'sistema']
    expected.forEach((id) => expect(ids, id).toContain(id))
    // Na ordem do menu: Provas antes do Monitor, Chamada antes de Mensagens, Sistema perto do fim.
    const order = expected.map((id) => ids.indexOf(id))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('[UC-PROVA-005] corrigir o gabarito: a aplicação preparada se prepara de novo por "Preparar e abrir monitor", não pelo "Aplicar online" da preparação', () => {
    const provas = parseHelpDocument(instrutor).secoes.find((section) => section.id === 'provas')
    const paragraph = provas.corpo.split('\n').find((line) => line.startsWith('**Corrigir o gabarito depois da prova.**'))
    expect(paragraph).toBeTruthy()
    // O "Aplicar online" da preparação reaplica o gabarito guardado nela (o errado).
    expect(paragraph).toContain('prepare de novo por **Preparar e abrir monitor**')
    expect(paragraph).not.toContain('prepare de novo pelo **Aplicar online**')
    // A preparação é de cada turma: a aplicação de outra turma nunca é contada pela prévia.
    expect(paragraph).not.toContain('outra turma, por exemplo')
  })

  it('a ajuda do aluno começa pelos temas de quem não consegue entrar e tem os temas do portal', () => {
    const doc = parseHelpDocument(aluno)
    const ids = doc.secoes.map((section) => section.id)
    expect(ids.slice(0, 4)).toEqual(['endereco', 'esqueci-a-senha', 'troca-de-senha', 'prova-e-conexao'])
    ;['atividades', 'mensagens', 'busca', 'frequencia', 'certificados', 'provas'].forEach((id) => expect(ids).toContain(id))
    const visible = visibleSections(doc).map((section) => section.id)
    expect(visible).toEqual(expect.arrayContaining(['endereco', 'esqueci-a-senha', 'troca-de-senha', 'prova-e-conexao', 'conexao-segura']))
    // Atividades ganhou texto na fase 3 C9 e Mensagens no C14; Busca ainda é só o comentário.
    expect(visible).toContain('atividades')
    expect(visible).toContain('mensagens')
    expect(visible).not.toContain('busca')
  })

  it('lê título, abertura e temas; tema sem texto (só comentário) fica escondido; ## dentro de código não abre tema', () => {
    const doc = parseHelpDocument([
      '# Manual',
      'Abertura.',
      '<!-- recado para quem escreve -->',
      '## Provas {#provas}',
      'Texto das provas.',
      '```',
      '## isto é código',
      '```',
      '### Detalhe',
      '## Tarefas {#tarefas}',
      '<!-- P1 escreve aqui -->',
      '## Não publicado',
      '- item',
      '## Provas {#provas}',
      'Repetida.',
    ].join('\r\n'))
    expect(doc.titulo).toBe('Manual')
    expect(doc.intro).toBe('Abertura.')
    expect(doc.secoes.map((section) => [section.id, section.titulo])).toEqual([
      ['provas', 'Provas'], ['tarefas', 'Tarefas'], ['nao-publicado', 'Não publicado'], ['provas-2', 'Provas'],
    ])
    expect(doc.secoes[0].corpo).toContain('## isto é código')
    expect(doc.secoes[0].corpo).toContain('### Detalhe')
    expect(doc.secoes[1].corpo).toBe('')
    expect(visibleSections(doc).map((section) => section.id)).toEqual(['provas', 'nao-publicado', 'provas-2'])
    expect(slugify('3.0.0 · 18/11/2026')).toBe('3-0-0-18-11-2026')
    expect(stripComments('a<!-- x\ny -->b')).toBe('ab')
  })

  it('o Markdown da ajuda sai limpo (sem script nem on*) e com os títulos descendo de nível', () => {
    const html = helpMarkdownToHtml('### Título\n\n<script>alert(1)</script><img src="x" onerror="alert(1)">\n\n[Sistema](/sistema)', 1)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).toContain('<h4')
    expect(html).toContain('href="/sistema"')
  })
})

describe('[UC-AJUDA-001] âncora da URL', () => {
  it('decodifica o hash e ignora o malformado em vez de lançar URIError', () => {
    expect(anchorFromHash('#monitor')).toBe('monitor')
    expect(anchorFromHash('monitor')).toBe('monitor')
    expect(anchorFromHash('#esqueci%20a%20senha')).toBe('esqueci a senha')
    expect(anchorFromHash('')).toBe('')
    expect(anchorFromHash(undefined)).toBe('')
    expect(anchorFromHash('#%E0%A4%A')).toBe('')
    expect(anchorFromHash('#%')).toBe('')
  })
})
