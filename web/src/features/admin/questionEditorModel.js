// Questão no editor da tela Provas (fase 3, P3-S3: AVA-06, FUN-10, UXA-12; desenho P3,
// telas.professor "editor da avaliação"). Funções puras, sem React, para o editor
// (QuestionEditor.jsx), a tela Provas e os testes:
// - editorQuestion(fonte): a questão da avaliação (ou do banco) no formato do formulário,
//   com os campos de todos os tipos. Trocar o tipo não apaga nada: as alternativas, as
//   respostas aceitas, o valor numérico e a rubrica ficam guardados e voltam se o
//   professor voltar ao tipo de antes; só vai para o servidor o que é do tipo escolhido.
// - editorQuestionPayload(questão): o corpo do PUT/POST /api/admin/evaluation (os campos
//   do modelo único, backend/utils/questionModel.js).
// - questionProblems(questão): o que falta para o servidor aceitar, com as mesmas frases
//   do modelo ("informe pelo menos uma resposta aceita."). O servidor continua sendo quem
//   decide; a tela só avisa antes de enviar.
// - totalPoints(questões): a soma dos pontos da prova.
// Questão antiga sem type é "Uma correta" e sem points vale 1 ponto (D1 do P3).

export const QUESTION_TYPE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'multiple_choice', label: 'Uma correta', example: 'Ex.: "Qual protocolo usa a porta 80?" O aluno escolhe uma alternativa.' }),
  Object.freeze({ value: 'multiple_answer', label: 'Várias corretas', example: 'Ex.: "Marque os protocolos da camada de transporte." O aluno marca todas as certas.' }),
  Object.freeze({ value: 'true_false', label: 'Verdadeiro ou falso', example: 'Ex.: "O IPv4 tem 32 bits." O aluno responde Verdadeiro ou Falso.' }),
  Object.freeze({ value: 'numeric', label: 'Numérica', example: 'Ex.: "Quantos hosts cabem numa rede /26?" O aluno digita um número.' }),
  Object.freeze({ value: 'short_answer', label: 'Resposta curta', example: 'Ex.: "Qual comando lista os arquivos no Linux?" O aluno digita uma palavra ou frase curta.' }),
  Object.freeze({ value: 'essay', label: 'Dissertativa', example: 'Ex.: "Explique a diferença entre TCP e UDP." Você corrige depois, com a rubrica.' }),
])
const TYPES = QUESTION_TYPE_OPTIONS.map((option) => option.value)
const CHOICE_TYPES = new Set(['multiple_choice', 'multiple_answer', 'true_false'])

export const DIFFICULTY_OPTIONS = Object.freeze([
  Object.freeze({ value: '', label: 'Sem dificuldade' }),
  Object.freeze({ value: 'facil', label: 'Fácil' }),
  Object.freeze({ value: 'media', label: 'Média' }),
  Object.freeze({ value: 'dificil', label: 'Difícil' }),
])

// Os mesmos limites do modelo do servidor (questionModel.js LIMITS).
export const EDITOR_LIMITS = Object.freeze({
  text: 20000,
  alternative: 2000,
  explanation: 5000,
  expectedAnswer: 5000,
  acceptedAnswer: 300,
  acceptedAnswers: 20,
  unit: 20,
  rubricCriteria: 8,
  rubricName: 80,
  minAlternatives: 2,
  maxAlternatives: 8,
  minPoints: 0.1,
  maxPoints: 100,
  skills: 10,
  skill: 80,
  tags: 10,
  tag: 40,
})

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export function questionTypeLabel(type) {
  return QUESTION_TYPE_OPTIONS.find((option) => option.value === type)?.label || 'Uma correta'
}

export function isChoiceType(type) {
  return CHOICE_TYPES.has(type)
}

function typeOf(source) {
  const type = typeof source?.type === 'string' ? source.type.trim() : ''
  return TYPES.includes(type) ? type : 'multiple_choice'
}

// Número digitado com vírgula ou ponto ('2,5', '2.5'); null quando vazio; NaN quando não
// é número. Igual ao parseNumberInput do servidor.
export function parseDecimalInput(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN
  const text = String(raw).trim().replace(',', '.')
  if (!text) return null
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return NaN
  return Number(text)
}

// Número em decimal comum, sem arredondar e sem notação científica: 3.14159265 ->
// '3.14159265', 1e-7 -> '0.0000001', 1e21 -> '1000000000000000000000'. String(n) já é a
// forma mais curta que volta ao mesmo número; aqui só se desfaz o 'e'.
function plainDecimal(number) {
  const text = String(number)
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(text)
  if (!match) return text
  const [, sign, whole, fraction = '', exponentText] = match
  const digits = `${whole}${fraction}`
  const point = whole.length + Number(exponentText)
  const body = point <= 0
    ? `0.${'0'.repeat(-point)}${digits}`
    : (point >= digits.length ? `${digits}${'0'.repeat(point - digits.length)}` : `${digits.slice(0, point)}.${digits.slice(point)}`)
  return `${sign}${body.replace(/^0+(?=\d)/, '')}`
}

// 2.5 -> '2,5'; vazio para o que não é número. Não arredonda: o valor da numérica e a
// tolerância voltam ao editor exatamente como estão no servidor, e salvar de novo não
// muda nada (3,14159265 continua 3,14159265; 0,0000001 não vira 0).
export function formatDecimal(value) {
  if (value === undefined || value === null || value === '') return ''
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  return plainDecimal(number).replace('.', ',')
}

function roundPoints(value) {
  return Math.round(value * 100) / 100
}

function validPoints(value) {
  return Number.isFinite(value) && value >= EDITOR_LIMITS.minPoints && value <= EDITOR_LIMITS.maxPoints && Math.abs(roundPoints(value) - value) < 1e-9
}

// Pontos da questão do editor: o número digitado; vazio vale 1 (como no servidor); NaN
// quando não é um número válido.
export function editorPointsValue(question) {
  const value = parseDecimalInput(question?.points)
  if (value === null) return 1
  return validPoints(value) ? roundPoints(value) : NaN
}

// "1 ponto", "0,5 ponto", "2 pontos", "12,5 pontos".
export function formatPointsLabel(points) {
  const value = Number(points)
  if (!Number.isFinite(value)) return '—'
  return `${formatDecimal(roundPoints(value))} ${value < 2 ? 'ponto' : 'pontos'}`
}

// Soma dos pontos das questões (do editor ou da avaliação); a que tem pontos inválidos
// fica de fora da soma e é contada em invalid.
export function totalPoints(questions = []) {
  let total = 0
  let invalid = 0
  ;(Array.isArray(questions) ? questions : []).forEach((question) => {
    const value = question && Object.prototype.hasOwnProperty.call(question, 'uid')
      ? editorPointsValue(question)
      : (Number.isFinite(Number(question?.points)) && Number(question?.points) > 0 ? Number(question.points) : 1)
    if (Number.isFinite(value)) total += value
    else invalid += 1
  })
  return { total: roundPoints(total), invalid }
}

let uidCounter = 0
function nextUid() {
  uidCounter += 1
  return `q${Date.now().toString(36)}${uidCounter}`
}

function textOf(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function sourceAlternatives(source) {
  if (Array.isArray(source?.alternatives)) return source.alternatives
  if (source?.alternatives && typeof source.alternatives === 'object') {
    return Object.entries(source.alternatives).map(([letter, text]) => ({ letter, text }))
  }
  return []
}

function blankAlternatives() {
  return [0, 1, 2, 3].map((index) => ({ letter: LETTERS[index], text: '', isCorrect: index === 0 }))
}

function editorAlternatives(source, type) {
  const raw = sourceAlternatives(source)
  if (type === 'true_false' || raw.length < 2) return blankAlternatives()
  const requested = String(source?.correctAnswer || '').trim().toUpperCase()
  const requestedMany = new Set((Array.isArray(source?.correctAnswers) ? source.correctAnswers : []).map((letter) => String(letter || '').trim().toUpperCase()))
  return raw.map((alternative, index) => {
    const original = String(alternative?.letter || '').trim().toUpperCase()
    const marked = alternative?.isCorrect === true
      || (!!requested && original === requested)
      || (type === 'multiple_answer' && !!original && requestedMany.has(original))
    return { letter: LETTERS[index], text: textOf(typeof alternative === 'string' ? alternative : (alternative?.text ?? alternative?.label)), isCorrect: marked }
  })
}

function trueFalseAnswer(source) {
  const correct = String(source?.correctAnswer || '').trim().toUpperCase()
  if (correct === 'A' || correct === 'B') return correct
  const marked = sourceAlternatives(source).findIndex((alternative) => alternative?.isCorrect === true)
  return marked === 0 ? 'A' : marked === 1 ? 'B' : ''
}

function listOf(value) {
  return (Array.isArray(value) ? value : []).map(textOf).filter((item) => item.trim())
}

// Questão da avaliação ou do banco -> questão do formulário.
export function editorQuestion(source = {}) {
  const type = typeOf(source)
  const numeric = source?.numeric && typeof source.numeric === 'object' ? source.numeric : {}
  const accepted = listOf(source?.acceptedAnswers)
  const rubric = Array.isArray(source?.rubric) ? source.rubric : []
  const points = source?.points === undefined || source?.points === null || source?.points === ''
    ? '1'
    : (typeof source.points === 'number' ? formatDecimal(source.points) : String(source.points))
  return {
    uid: nextUid(),
    type,
    points,
    text: textOf(source?.text || source?.questionText),
    alternatives: editorAlternatives(source, type),
    partialCredit: source?.partialCredit !== false,
    trueFalse: type === 'true_false' ? trueFalseAnswer(source) : '',
    numeric: {
      value: formatDecimal(numeric.value),
      tolerance: numeric.tolerance === undefined || numeric.tolerance === null || Number(numeric.tolerance) === 0 ? '' : formatDecimal(numeric.tolerance),
      unit: textOf(numeric.unit),
    },
    review: source?.review === 'professor' ? 'professor' : 'auto',
    acceptedAnswers: accepted.length ? accepted : [''],
    expectedAnswer: textOf(source?.expectedAnswer),
    rubric: rubric.map((criterion) => ({
      id: typeof criterion?.id === 'string' ? criterion.id : '',
      nome: textOf(criterion?.nome ?? criterion?.name),
      pontos: typeof criterion?.pontos === 'number' ? formatDecimal(criterion.pontos) : textOf(criterion?.pontos ?? criterion?.points),
    })),
    explanation: textOf(source?.explanation),
    difficulty: ['facil', 'media', 'dificil'].includes(source?.difficulty) ? source.difficulty : '',
    skills: listOf(source?.skills).join(', '),
    tags: listOf(source?.tags).join(', '),
    bankKey: textOf(source?.bankKey),
  }
}

// Cópia para "Duplicar": mesma questão com outro uid (os ids da rubrica ficam).
export function duplicateEditorQuestion(question) {
  return {
    ...question,
    uid: nextUid(),
    alternatives: question.alternatives.map((alternative) => ({ ...alternative })),
    numeric: { ...question.numeric },
    acceptedAnswers: [...question.acceptedAnswers],
    rubric: question.rubric.map((criterion) => ({ ...criterion })),
  }
}

// 'a, b , ,c' -> ['a', 'b', 'c'] (sem repetir).
export function splitList(value) {
  const seen = new Set()
  return String(value || '').split(/[,;\n]/).map((item) => item.trim()).filter((item) => {
    const key = item.toLowerCase()
    if (!item || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function pointsForPayload(raw) {
  const value = parseDecimalInput(raw)
  if (value === null) return 1
  return Number.isFinite(value) ? value : String(raw)
}

function decimalForPayload(raw) {
  const value = parseDecimalInput(raw)
  if (value === null) return null
  return Number.isFinite(value) ? value : String(raw)
}

function relabel(alternatives) {
  return alternatives.map((alternative, index) => ({ letter: LETTERS[index], text: alternative.text, isCorrect: alternative.isCorrect === true }))
}

// Rubrica preenchida (critério totalmente vazio sai).
function filledRubric(question) {
  return (question.rubric || []).filter((criterion) => String(criterion.nome || '').trim() || String(criterion.pontos || '').trim())
}

// Questão do formulário -> corpo do PUT/POST /api/admin/evaluation.
export function editorQuestionPayload(question = {}) {
  const type = TYPES.includes(question.type) ? question.type : 'multiple_choice'
  const payload = { type, points: pointsForPayload(question.points), text: String(question.text || '') }
  if (type === 'multiple_choice' || type === 'multiple_answer') {
    const alternatives = relabel(Array.isArray(question.alternatives) ? question.alternatives : [])
    payload.alternatives = alternatives
    if (type === 'multiple_choice') {
      payload.correctAnswer = alternatives.find((alternative) => alternative.isCorrect)?.letter || ''
    } else {
      payload.correctAnswers = alternatives.filter((alternative) => alternative.isCorrect).map((alternative) => alternative.letter)
      payload.partialCredit = question.partialCredit !== false
    }
  } else if (type === 'true_false') {
    payload.correctAnswer = question.trueFalse === 'A' || question.trueFalse === 'B' ? question.trueFalse : ''
  } else if (type === 'numeric') {
    const unit = String(question.numeric?.unit || '').trim()
    payload.numeric = {
      value: decimalForPayload(question.numeric?.value),
      tolerance: decimalForPayload(question.numeric?.tolerance) ?? 0,
      ...(unit ? { unit } : {}),
    }
    payload.review = question.review === 'professor' ? 'professor' : 'auto'
  } else if (type === 'short_answer') {
    payload.acceptedAnswers = (question.acceptedAnswers || []).map((item) => String(item || '').trim()).filter(Boolean)
    payload.review = question.review === 'professor' ? 'professor' : 'auto'
  } else {
    payload.expectedAnswer = String(question.expectedAnswer || '').trim()
    const rubric = filledRubric(question)
    if (rubric.length) {
      payload.rubric = rubric.map((criterion) => ({
        ...(criterion.id ? { id: criterion.id } : {}),
        nome: String(criterion.nome || '').trim(),
        pontos: pointsForPayload(criterion.pontos),
      }))
    }
  }
  payload.explanation = String(question.explanation || '').trim()
  if (question.difficulty) payload.difficulty = question.difficulty
  const skills = splitList(question.skills)
  if (skills.length) payload.skills = skills
  const tags = splitList(question.tags)
  if (tags.length) payload.tags = tags
  if (question.bankKey) payload.bankKey = question.bankKey
  return payload
}

// Soma dos critérios da rubrica (os que têm pontos válidos).
export function rubricTotal(question) {
  return roundPoints(filledRubric(question).reduce((sum, criterion) => {
    const value = parseDecimalInput(criterion.pontos)
    return Number.isFinite(value) ? sum + value : sum
  }, 0))
}

// O que falta para o servidor aceitar a questão (as frases do questionModel.js, sem o
// "Questão N:"). Lista vazia = pode salvar.
export function questionProblems(question = {}) {
  const problems = []
  const type = TYPES.includes(question.type) ? question.type : 'multiple_choice'
  const points = editorPointsValue(question)
  if (!Number.isFinite(points)) problems.push('os pontos devem ficar entre 0,1 e 100, com até duas casas decimais.')
  const text = String(question.text || '').trim()
  if (!text) problems.push('informe o enunciado.')
  else if (text.length > EDITOR_LIMITS.text) problems.push('o enunciado aceita no máximo 20.000 caracteres.')
  if (type === 'multiple_choice' || type === 'multiple_answer') {
    const alternatives = Array.isArray(question.alternatives) ? question.alternatives : []
    if (alternatives.length < EDITOR_LIMITS.minAlternatives || alternatives.length > EDITOR_LIMITS.maxAlternatives) problems.push('a questão deve ter entre 2 e 8 alternativas.')
    else if (alternatives.some((alternative) => !String(alternative.text || '').trim())) problems.push('preencha todas as alternativas.')
    else if (alternatives.some((alternative) => String(alternative.text || '').trim().length > EDITOR_LIMITS.alternative)) problems.push('cada alternativa aceita no máximo 2.000 caracteres.')
    const marked = alternatives.filter((alternative) => alternative.isCorrect).length
    if (type === 'multiple_choice' && marked !== 1) problems.push('marque exatamente uma alternativa correta.')
    if (type === 'multiple_answer' && marked === 0) problems.push('marque pelo menos uma alternativa correta.')
  } else if (type === 'true_false') {
    if (question.trueFalse !== 'A' && question.trueFalse !== 'B') problems.push('marque se a afirmação é verdadeira ou falsa.')
  } else if (type === 'numeric') {
    const value = parseDecimalInput(question.numeric?.value)
    if (value === null || !Number.isFinite(value)) problems.push('informe o valor da resposta numérica.')
    const tolerance = parseDecimalInput(question.numeric?.tolerance)
    if (tolerance !== null && (!Number.isFinite(tolerance) || tolerance < 0)) problems.push('a tolerância deve ser um número maior ou igual a zero.')
    if (String(question.numeric?.unit || '').trim().length > EDITOR_LIMITS.unit) problems.push('a unidade aceita no máximo 20 caracteres.')
  } else if (type === 'short_answer') {
    const accepted = (question.acceptedAnswers || []).map((item) => String(item || '').trim()).filter(Boolean)
    if (!accepted.length) problems.push('informe pelo menos uma resposta aceita.')
    if (accepted.length > EDITOR_LIMITS.acceptedAnswers) problems.push('a questão aceita no máximo 20 respostas aceitas.')
    if (accepted.some((item) => item.length > EDITOR_LIMITS.acceptedAnswer)) problems.push('cada resposta aceita tem no máximo 300 caracteres.')
  } else {
    if (String(question.expectedAnswer || '').trim().length > EDITOR_LIMITS.expectedAnswer) problems.push('a resposta esperada aceita no máximo 5.000 caracteres.')
    const rubric = filledRubric(question)
    if (rubric.length > EDITOR_LIMITS.rubricCriteria) problems.push('a rubrica aceita no máximo 8 critérios.')
    rubric.forEach((criterion, index) => {
      if (!String(criterion.nome || '').trim()) problems.push(`dê um nome ao critério ${index + 1} da rubrica.`)
      else if (String(criterion.nome).trim().length > EDITOR_LIMITS.rubricName) problems.push(`o nome do critério ${index + 1} da rubrica aceita no máximo ${EDITOR_LIMITS.rubricName} caracteres.`)
      const value = parseDecimalInput(criterion.pontos)
      if (!Number.isFinite(value) || value <= 0 || value > EDITOR_LIMITS.maxPoints || Math.abs(roundPoints(value) - value) > 1e-9) {
        problems.push(`os pontos do critério ${index + 1} da rubrica devem ser maiores que zero, com até duas casas decimais.`)
      }
    })
    if (rubric.length && Number.isFinite(points) && Math.abs(rubricTotal(question) - points) > 0.005) {
      problems.push(`a soma dos critérios da rubrica (${formatDecimal(rubricTotal(question))}) precisa ser igual aos pontos da questão (${formatDecimal(points)}).`)
    }
  }
  if (String(question.explanation || '').trim().length > EDITOR_LIMITS.explanation) problems.push('a explicação aceita no máximo 5.000 caracteres.')
  const skills = splitList(question.skills)
  if (skills.some((item) => item.length > EDITOR_LIMITS.skill)) problems.push(`cada item de habilidades tem no máximo ${EDITOR_LIMITS.skill} caracteres.`)
  if (skills.length > EDITOR_LIMITS.skills) problems.push('habilidades aceita no máximo 10 itens.')
  const tags = splitList(question.tags)
  if (tags.some((item) => item.length > EDITOR_LIMITS.tag)) problems.push(`cada item de etiquetas tem no máximo ${EDITOR_LIMITS.tag} caracteres.`)
  if (tags.length > EDITOR_LIMITS.tags) problems.push('etiquetas aceita no máximo 10 itens.')
  return problems
}

// Primeiro problema da prova inteira, já com "Questão N:", ou null.
export function firstEvaluationProblem(questions = []) {
  for (let index = 0; index < questions.length; index += 1) {
    const [problem] = questionProblems(questions[index])
    if (problem) return { index, message: `Questão ${index + 1}: ${problem}` }
  }
  return null
}

// Resposta certa em texto, para a prévia e a impressão: 'B', 'A e C', 'Verdadeiro',
// '3,5 ms (± 0,25)', '"ls" ou "ls -l"', 'Correção pelo professor'. Recebe a questão do
// editor (uid) ou a da avaliação/versão (alternativas com isCorrect e displayLetter).
export function answerSummary(question) {
  if (!question) return ''
  const editing = Object.prototype.hasOwnProperty.call(question, 'uid')
  const payload = editing ? editorQuestionPayload(question) : question
  const type = typeOf(payload)
  const alternatives = Array.isArray(payload.alternatives) ? payload.alternatives : []
  const letterOf = (alternative) => String(alternative.displayLetter || alternative.letter || '').toUpperCase()
  const joinLetters = (letters) => (letters.length <= 1 ? letters.join('') : `${letters.slice(0, -1).join(', ')} e ${letters[letters.length - 1]}`)
  if (type === 'true_false') {
    const correct = editing
      ? payload.correctAnswer
      : String(alternatives.find((alternative) => alternative.isCorrect)?.letter || payload.correctAnswer || '').toUpperCase()
    return correct === 'A' ? 'Verdadeiro' : correct === 'B' ? 'Falso' : ''
  }
  if (type === 'multiple_choice' || type === 'multiple_answer') {
    const marked = alternatives.filter((alternative) => alternative.isCorrect)
    const letters = marked.length ? marked.map(letterOf) : (payload.correctAnswer ? [String(payload.correctAnswer).toUpperCase()] : [])
    return joinLetters(letters)
  }
  if (type === 'numeric') {
    const numeric = payload.numeric || {}
    if (numeric.value === null || numeric.value === undefined || numeric.value === '') return ''
    const tolerance = Number(numeric.tolerance) > 0 ? ` (± ${formatDecimal(numeric.tolerance)})` : ''
    return `${formatDecimal(numeric.value)}${numeric.unit ? ` ${numeric.unit}` : ''}${tolerance}`
  }
  if (type === 'short_answer') {
    return (payload.acceptedAnswers || []).filter(Boolean).map((item) => `"${item}"`).join(' ou ')
  }
  return 'Correção pelo professor'
}
