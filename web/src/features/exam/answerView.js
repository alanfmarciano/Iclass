// Leitura de uma questão corrigida nas telas (fase 3, P3-S4b / A18: AVA-07, UXA-17;
// contrato C3 do desenho P3). A conta da nota é do servidor (examScoring.js); aqui só o
// texto: tipo, pontos, situação da questão e a resposta do aluno em palavras.
//
// gradedAnswers[] (C3): { questionNumber, type, studentChoice (só escolha única),
// studentChoices (várias corretas), studentResponse (numérica, resposta curta e
// dissertativa), correctAnswer, correctAnswers, isCorrect (true | false | null quando
// aguarda o professor), pointsEarned, pointsPossible, pending, annulled }. A entrega de
// antes da fase 3 só tem studentChoice, correctAnswer e isCorrect: lê como "uma correta".

export const QUESTION_TYPE_LABEL = Object.freeze({
  multiple_choice: 'Uma correta',
  multiple_answer: 'Várias corretas',
  true_false: 'Verdadeiro ou falso',
  numeric: 'Numérica',
  short_answer: 'Resposta curta',
  essay: 'Dissertativa',
})

const TEXT_TYPES = new Set(['numeric', 'short_answer', 'essay'])

export function answerType(answer, question) {
  const type = answer?.type || question?.type
  return QUESTION_TYPE_LABEL[type] ? type : 'multiple_choice'
}

export function isTextType(type) {
  return TEXT_TYPES.has(type)
}

const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))

// Pontos com vírgula e até duas casas: 1,5 · 0,25 · 2.
export function fmtPoints(value) {
  if (!finite(value)) return ''
  return String(Math.round(Number(value) * 100) / 100).replace('.', ',')
}

// "1,5 de 2 pontos" · "1 de 1 ponto" · "" sem os dois números.
export function pointsLabel(earned, possible) {
  if (!finite(earned) || !finite(possible)) return ''
  return `${fmtPoints(earned)} de ${fmtPoints(possible)} ${Number(possible) === 1 ? 'ponto' : 'pontos'}`
}

// "2 pontos" · "1 ponto".
export function possibleLabel(possible) {
  if (!finite(possible)) return ''
  return `${fmtPoints(possible)} ${Number(possible) === 1 ? 'ponto' : 'pontos'}`
}

function joinLetters(letters) {
  const list = (letters || []).map((letter) => String(letter).toUpperCase()).filter(Boolean)
  if (list.length <= 1) return list.join('')
  return `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`
}

// Resposta do aluno em palavras: 'B', 'A e C', '3,5 ms', o texto da resposta curta ou
// 'Resposta escrita' (dissertativa; o texto aparece à parte). Em branco: blank.
export function studentAnswerText(answer, question, { blank = '' } = {}) {
  const type = answerType(answer, question)
  if (Array.isArray(answer?.studentChoices) && answer.studentChoices.length) return joinLetters(answer.studentChoices)
  const response = answer?.studentResponse
  if (response !== null && response !== undefined && String(response) !== '') {
    if (type === 'essay') return 'Resposta escrita'
    if (type === 'numeric') {
      const unit = String(question?.unit || question?.numeric?.unit || '').trim()
      const shown = String(response).trim().replace('.', ',')
      return unit ? `${shown} ${unit}` : shown
    }
    return String(response)
  }
  if (answer?.studentChoice) return String(answer.studentChoice).toUpperCase()
  return blank
}

export function hasStudentAnswer(answer) {
  return studentAnswerText(answer, null) !== ''
}

// Situação de uma questão na revisão: { tone, text }.
// - anulada: "Anulada";
// - aguardando o professor (a entrega toda ou a questão): "Aguardando correção";
// - certa ou errada quando o sistema corrigiu pelo gabarito;
// - corrigida pelo professor (isCorrect null, sem pendência): os pontos ("1,5 de 2 pontos");
// - sem os pontos (o aluno sem a nota publicada): "Corrigida pelo professor".
// Antes, a dissertativa aparecia sempre como "Errada".
export function answerStatus(answer, { awaiting = false } = {}) {
  if (answer?.annulled === true) return { tone: 'neutral', text: 'Anulada' }
  if (answer?.pending === true || (awaiting && typeof answer?.isCorrect !== 'boolean')) return { tone: 'warning', text: 'Aguardando correção' }
  // Dissertativa corrigida: os pontos, nunca "Errada" (é nota do professor, não gabarito).
  if (answer?.type === 'essay' && pointsLabel(answer?.pointsEarned, answer?.pointsPossible)) {
    const earned = Number(answer.pointsEarned)
    const possible = Number(answer.pointsPossible)
    const tone = possible > 0 && earned >= possible ? 'success' : earned > 0 ? 'info' : 'danger'
    return { tone, text: pointsLabel(earned, possible) }
  }
  if (typeof answer?.isCorrect === 'boolean') {
    const possible = Number(answer?.pointsPossible)
    const earned = Number(answer?.pointsEarned)
    // Várias corretas com crédito parcial: nem toda nem nada.
    if (!answer.isCorrect && finite(answer?.pointsEarned) && earned > 0 && possible > 0 && earned < possible) {
      return { tone: 'warning', text: `Parcial · ${pointsLabel(earned, possible)}` }
    }
    return answer.isCorrect ? { tone: 'success', text: 'Correta' } : { tone: 'danger', text: 'Errada' }
  }
  if (awaiting) return { tone: 'warning', text: 'Aguardando correção' }
  const label = pointsLabel(answer?.pointsEarned, answer?.pointsPossible)
  if (label) return { tone: 'info', text: label }
  return { tone: 'neutral', text: 'Corrigida pelo professor' }
}
