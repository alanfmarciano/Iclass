import { describe, expect, it } from 'vitest'
import { ONLINE_VERSIONS_MAX, buildExamVersions, examPrintHtml, liveCorrectionDraft, runningApplicationOf, snapshotsFromHistory } from './examTools'
import { editorQuestion, editorQuestionPayload } from './questionEditorModel'

describe('runningApplicationOf', () => {
  it('[UC-APLICACAO-001] acha a aplicação em andamento (sala de espera, rodando ou pausada) e ignora as demais', () => {
    expect(runningApplicationOf([{ id: 'a', status: 'finished' }, { id: 'b', status: 'prepared' }])).toBeNull()
    expect(runningApplicationOf([{ id: 'a', status: 'finished' }, { id: 'b', status: 'paused' }])?.id).toBe('b')
    expect(runningApplicationOf([{ id: 'c', status: 'waiting' }])?.id).toBe('c')
    expect(runningApplicationOf(null)).toBeNull()
  })
})

describe('liveCorrectionDraft', () => {
  it('[UC-APLICACAO-001] lista as alternativas na ordem original (A, B, C, D) mesmo vindas de uma versão embaralhada', () => {
    const draft = liveCorrectionDraft({
      text: 'Enunciado',
      correctAnswer: 'B',
      alternatives: [
        { letter: 'C', displayLetter: 'A', text: 'Terceira' },
        { letter: 'A', displayLetter: 'B', text: 'Primeira' },
        { letter: 'D', displayLetter: 'C', text: 'Quarta' },
        { letter: 'B', displayLetter: 'D', text: 'Segunda', isCorrect: true },
      ],
    })
    expect(draft.alternatives).toEqual([
      { letter: 'A', text: 'Primeira' },
      { letter: 'B', text: 'Segunda' },
      { letter: 'C', text: 'Terceira' },
      { letter: 'D', text: 'Quarta' },
    ])
    expect(draft.correctAnswer).toBe('B')
    expect(draft.text).toBe('Enunciado')
  })

  it('[UC-APLICACAO-001] sem correctAnswer usa a alternativa marcada como correta', () => {
    const draft = liveCorrectionDraft({ questionText: 'Q', alternatives: [{ letter: 'B', text: 'x', isCorrect: true }, { letter: 'A', text: 'y' }] })
    expect(draft.correctAnswer).toBe('B')
    expect(draft.alternatives.map((alternative) => alternative.letter)).toEqual(['A', 'B'])
  })
})

describe('editorQuestionPayload', () => {
  it('[UC-PROVA-004] salvar pela tela Provas mantém o tipo, os pontos e o gabarito dos tipos novos (agora editados no próprio editor)', () => {
    const numeric = { type: 'numeric', points: 2, text: 'Latência?', alternatives: [], correctAnswer: '', numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' }, review: 'auto', explanation: 'Média.' }
    expect(editorQuestionPayload(editorQuestion(numeric))).toEqual({
      type: 'numeric', points: 2, text: 'Latência?', numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' }, review: 'auto', explanation: 'Média.',
    })
    // Várias corretas: a lista de antes vira marca nas alternativas e volta igual.
    const multiple = editorQuestionPayload(editorQuestion({ type: 'multiple_answer', points: 3, text: 'Q', alternatives: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }, { letter: 'C', text: 'c' }], correctAnswers: ['A', 'C'], partialCredit: false }))
    expect(multiple).toMatchObject({ type: 'multiple_answer', points: 3, correctAnswers: ['A', 'C'], partialCredit: false })
    // Questão antiga (sem tipo) vai como "Uma correta" de 1 ponto, com a mesma letra.
    expect(editorQuestionPayload(editorQuestion({ text: 'x', alternatives: [{ letter: 'A', text: 'a', isCorrect: false }, { letter: 'B', text: 'b', isCorrect: true }], correctAnswer: 'B' })))
      .toEqual({ type: 'multiple_choice', points: 1, text: 'x', alternatives: [{ letter: 'A', text: 'a', isCorrect: false }, { letter: 'B', text: 'b', isCorrect: true }], correctAnswer: 'B', explanation: '' })
  })
})

const typedEvaluation = {
  title: 'Redes',
  questions: [
    { originalNumber: 1, type: 'multiple_choice', points: 1, text: 'Topologia?', alternatives: [{ letter: 'A', text: 'Estrela', isCorrect: true }, { letter: 'B', text: 'Anel', isCorrect: false }], correctAnswer: 'A' },
    { originalNumber: 2, type: 'multiple_answer', points: 2, text: 'Transporte?', alternatives: [{ letter: 'A', text: 'TCP', isCorrect: true }, { letter: 'B', text: 'IP', isCorrect: false }, { letter: 'C', text: 'UDP', isCorrect: true }], correctAnswers: ['A', 'C'], correctAnswer: '' },
    { originalNumber: 3, type: 'true_false', points: 1, text: 'O IPv4 tem **32 bits**.', alternatives: [{ letter: 'A', text: 'Verdadeiro', isCorrect: true }, { letter: 'B', text: 'Falso', isCorrect: false }], correctAnswer: 'A' },
    { originalNumber: 4, type: 'numeric', points: 1.5, text: 'Latência?', alternatives: [], correctAnswer: '', numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' } },
    { originalNumber: 5, type: 'short_answer', points: 1, text: 'Comando?', alternatives: [], correctAnswer: '', acceptedAnswers: ['ls', 'ls -l'] },
    { originalNumber: 6, type: 'essay', points: 3, text: 'Explique:\n\n```\n$ ping -c 1 host\n```', alternatives: [], correctAnswer: '', expectedAnswer: 'Rota até o destino.', rubric: [{ id: 'c1', nome: 'Conceito', pontos: 2 }, { id: 'c2', nome: 'Exemplo', pontos: 1 }] },
  ],
}

describe('versões e impressão com os tipos novos', () => {
  it('[UC-PROVA-004] a versão leva o tipo e os pontos; verdadeiro ou falso nunca embaralha; o gabarito tem as letras de várias corretas e nada nas questões sem alternativa', () => {
    expect(ONLINE_VERSIONS_MAX).toBe(4)
    for (let seed = 0; seed < 25; seed += 1) {
      const [version] = buildExamVersions(typedEvaluation, { shuffleQuestions: false, shuffleAnswers: true, versionCount: 1, seed })
      const tf = version.questions[2]
      expect(tf.type).toBe('true_false')
      expect(tf.alternatives.map((alt) => alt.text)).toEqual(['Verdadeiro', 'Falso'])
      expect(version.answerKey[3]).toBe('A')
      const multiple = version.questions[1]
      const expected = multiple.alternatives.filter((alt) => alt.isCorrect).map((alt) => alt.displayLetter).join('')
      expect(version.answerKey[2]).toBe(expected)
      expect(expected).toHaveLength(2)
      expect(version.answerKey[4]).toBeUndefined()
      expect(version.answerKey[6]).toBeUndefined()
      expect(version.questions[3]).toMatchObject({ type: 'numeric', points: 1.5, numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' } })
      expect(version.questions[5]).toMatchObject({ type: 'essay', points: 3, expectedAnswer: 'Rota até o destino.' })
    }
  })

  it('[UC-PROVA-004] a prova impressa tem espaço para a resposta escrita, Verdadeiro e Falso, pontos e Markdown; o cartão-resposta só tem as questões de escolha', () => {
    const versions = buildExamVersions(typedEvaluation, { shuffleQuestions: false, shuffleAnswers: false, versionCount: 1, seed: 1 })
    const page = examPrintHtml({ title: 'Prova <de> redes', snapshots: versions, answerKey: false })
    const doc = new DOMParser().parseFromString(page, 'text/html')
    const questions = [...doc.querySelectorAll('.question')]
    expect(questions).toHaveLength(6)
    // Pontos de cada questão e o total (a prova tem pontos diferentes de 1).
    expect(questions[1].querySelector('.pts').textContent).toBe('(2 pontos)')
    expect(questions[3].querySelector('.pts').textContent).toBe('(1,5 ponto)')
    expect(doc.querySelector('.meta').textContent).toContain('9,5 pontos')
    expect(doc.querySelector('.meta').textContent).toContain('Prova <de> redes')
    expect(questions[1].textContent).toContain('Marque todas as corretas.')
    // Markdown: negrito e bloco de código.
    expect(questions[2].querySelector('.md strong').textContent).toBe('32 bits')
    expect(questions[5].querySelector('.md pre code').textContent).toContain('$ ping -c 1 host')
    // Verdadeiro ou falso responde só no cartão-resposta (V ou F), como as outras de escolha:
    // nada de "( ) Verdadeiro ( ) Falso" na questão, para o aluno não responder em dois lugares.
    expect(questions[2].querySelector('.tf').textContent).toBe('Verdadeiro ou falso? Marque V ou F no cartão-resposta.')
    expect(questions[2].textContent).not.toMatch(/\(\s*\)/)
    expect(questions[3].querySelector('.answer-inline .blank')).not.toBeNull()
    expect(questions[3].textContent).toContain('ms')
    expect(questions[4].querySelectorAll('.answer-lines .line')).toHaveLength(2)
    expect(questions[5].querySelectorAll('.answer-lines .line')).toHaveLength(12)
    // Nenhuma questão escrita mostra o gabarito na folha do aluno.
    expect(page).not.toContain('Rota até o destino.')
    expect(page).not.toContain('ls -l')
    // Cartão-resposta: letras pelo número de alternativas, V e F, e "resposta escrita".
    const rows = [...doc.querySelectorAll('.bubble-row')]
    expect(rows.map((row) => [...row.querySelectorAll('.bubble')].map((bubble) => bubble.textContent).join(''))).toEqual(['AB', 'ABC', 'VF', '', '', ''])
    expect(rows[5].textContent).toContain('resposta escrita')
  })

  it('[UC-PROVA-004] o gabarito impresso pinta as corretas e descreve número, respostas aceitas e dissertativa com rubrica', () => {
    const versions = buildExamVersions(typedEvaluation, { shuffleQuestions: false, shuffleAnswers: false, versionCount: 1, seed: 1 })
    const doc = new DOMParser().parseFromString(examPrintHtml({ title: 'P', snapshots: versions, answerKey: true }), 'text/html')
    const rows = [...doc.querySelectorAll('.bubble-row')]
    expect(rows.map((row) => [...row.querySelectorAll('.bubble.filled')].map((bubble) => bubble.textContent).join(''))).toEqual(['A', 'AC', 'V', '', '', ''])
    const items = [...doc.querySelectorAll('.key-item')].map((item) => item.textContent)
    expect(items[1]).toContain('2. A, C')
    expect(items[2]).toContain('3. Verdadeiro')
    expect(items[3]).toContain('4. 3,5 ms (± 0,25)')
    expect(items[4]).toContain('5. "ls" ou "ls -l"')
    expect(items[5]).toContain('Dissertativa: correção pelo professor')
    expect(items[5]).toContain('Rota até o destino.')
    expect(items[5]).toContain('Conceito: 2 pontos')
  })

  it('[UC-PROVA-004] prova antiga (sem tipo, 1 ponto) imprime como antes, sem pontos, e o histórico antigo continua reimprimindo', () => {
    const legacy = { questions: [{ originalNumber: 1, text: 'Qual?', alternatives: [{ letter: 'A', text: 'x' }, { letter: 'B', text: 'y' }, { letter: 'C', text: 'z' }, { letter: 'D', text: 'w' }], correctAnswer: 'C' }] }
    const versions = buildExamVersions(legacy, { shuffleQuestions: false, shuffleAnswers: false, versionCount: 1, seed: 1 })
    expect(versions[0].answerKey).toEqual({ 1: 'C' })
    const doc = new DOMParser().parseFromString(examPrintHtml({ title: 'P', snapshots: versions, answerKey: false }), 'text/html')
    expect(doc.querySelector('.pts')).toBeNull()
    expect(doc.querySelector('.meta').textContent).not.toContain('ponto')
    expect([...doc.querySelectorAll('.alt')].map((alt) => alt.textContent.trim())).toEqual(['a)x', 'b)y', 'c)z', 'd)w'])
    // Rodada de ajuste 1 do A6: o cartão-resposta da prova de antes continua de A a E
    // (como era), mesmo com 4 alternativas.
    expect([...doc.querySelectorAll('.bubble-row')].map((row) => [...row.querySelectorAll('.bubble')].map((bubble) => bubble.textContent).join(''))).toEqual(['ABCDE'])
    const history = snapshotsFromHistory({ printSnapshot: [{ version: 'A', questions: [{ originalNumber: 1, text: 'Qual?', correctAnswer: 'C', alternatives: [{ letter: 'A', text: 'x' }, { letter: 'C', text: 'z', isCorrect: true }] }], answerKey: { 1: 'C' } }] })
    const key = new DOMParser().parseFromString(examPrintHtml({ title: 'P', snapshots: history, answerKey: true }), 'text/html')
    expect(key.querySelector('.key-item').textContent).toContain('1. C')
    // ... e o gabarito detalhado não ganha "(Uma correta)": só a letra e o enunciado.
    expect(key.querySelector('.key-item p').textContent.trim()).toBe('1. C')
    expect(key.querySelector('.kmeta')).toBeNull()
    expect([...key.querySelectorAll('.bubble-row')].map((row) => [...row.querySelectorAll('.bubble')].map((bubble) => bubble.textContent).join(''))).toEqual(['ABCDE'])
    expect(key.querySelector('.bubble.filled').textContent).toBe('C')
  })

  // Rodada de ajuste 1 do A6 (contrato printDocument): a prova impressa sai pelo
  // documento da escola, com o cabeçalho da escola em cada folha e o rodapé "Gerado por".
  it('[UC-PROVA-004] a prova impressa tem o cabeçalho da escola e o rodapé "Gerado por <nome> em <data>" em cada folha', () => {
    const versions = buildExamVersions(typedEvaluation, { shuffleQuestions: false, shuffleAnswers: false, versionCount: 2, seed: 1, codes: ['AB12', 'CD34'] })
    const page = examPrintHtml({
      title: 'Prova <de> redes',
      snapshots: versions,
      includeAnswerKey: true,
      escola: { nome: 'Escola Técnica <Centro>', endereco: 'Rua A, 10' },
      displayName: 'ETC',
      geradoEm: new Date(2026, 10, 22, 10, 5),
    })
    const doc = new DOMParser().parseFromString(page, 'text/html')
    expect(doc.title).toBe('Prova <de> redes')
    const sheets = [...doc.querySelectorAll('article.folha')]
    // Duas versões da prova e, depois, o gabarito de cada uma.
    expect(sheets).toHaveLength(4)
    expect(sheets.map((sheet) => sheet.querySelector('.doc-titulo h1').textContent)).toEqual(['AVALIAÇÃO', 'AVALIAÇÃO', 'GABARITO DO PROFESSOR', 'GABARITO DO PROFESSOR'])
    expect(sheets.map((sheet) => sheet.querySelector('.subtitulo').textContent)).toEqual(['Código AB12 - 22/11/2026', 'Código CD34 - 22/11/2026', 'Código AB12 - 22/11/2026', 'Código CD34 - 22/11/2026'])
    sheets.forEach((sheet) => {
      expect(sheet.querySelector('.cabecalho .nome-escola').textContent).toBe('Escola Técnica <Centro>')
      expect(sheet.querySelector('.rodape').textContent).toContain('Gerado por ETC em 22/11/2026 às 10:05')
    })
    expect(sheets[1].classList.contains('nova-folha')).toBe(true)
    expect(sheets[0].querySelector('.student')).not.toBeNull()
    expect(sheets[2].querySelector('.student')).toBeNull()
    expect(page).not.toContain('Gerado pelo IClass')
    expect(page).not.toContain('<Centro>')
    // A tabela do Markdown não pega o estilo das tabelas do documento (cabeçalho escuro).
    expect(page).toContain('.md thead th{background:#eef1f6')
  })
})
