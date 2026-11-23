import { CheckCircle2, XCircle } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import QuestionMarkdown from '../exam/QuestionMarkdown'
import { QUESTION_TYPE_LABEL, answerStatus, isTextType, pointsLabel } from '../exam/answerView'
import { OriginalLetter, seenWithOriginal } from './reviewLetters'

// Uma questão da revisão do professor (fase 3, P3-S4b / A18: AVA-07), a mesma no Monitor
// (StudentAnswersModal, GET /api/admin/monitor-review) e na prova corrigida dos Resultados
// (GET /api/admin/submissions/:id/review). As duas rotas devolvem a questão com os campos
// de reviewAnswerFields (backend/routes/admin.js): type, answerText, answerKeyText,
// studentChoices, studentResponse, correctAnswersSeen, pointsEarned, pointsPossible,
// pending e annulled.
// Enunciado e alternativas passam por QuestionMarkdown (contrato C4): antes, a
// alternativa aparecia crua e '**negrito**' ou '`código`' mostravam os símbolos.
// Antes, as duas telas só sabiam de "uma correta": a dissertativa e a resposta curta
// apareciam como "Errada" sem o texto do aluno, a numérica sem o número digitado, e em
// "várias corretas" só uma alternativa aparecia como gabarito.
export function questionAnswered(question) {
  if (typeof question?.answered === 'boolean') return question.answered
  if (question?.studentChoice) return true
  if (Array.isArray(question?.studentChoices) && question.studentChoices.length) return true
  return question?.studentResponse !== null && question?.studentResponse !== undefined && String(question.studentResponse) !== ''
}

// Contagem do topo do Monitor: as questões que esperam o professor não são "erradas".
export function reviewCounts(questions) {
  const list = Array.isArray(questions) ? questions : []
  const answered = list.filter(questionAnswered)
  return {
    answered: answered.length,
    correct: answered.filter((q) => q.isCorrect === true).length,
    pending: answered.filter((q) => q.pending === true).length,
    wrong: answered.filter((q) => q.isCorrect !== true && q.pending !== true && q.annulled !== true).length,
  }
}

export function ReviewQuestionCard({ question, unansweredText = 'Questão não respondida.', correctLabel = 'Resposta correta' }) {
  const type = question?.type || 'multiple_choice'
  const answered = questionAnswered(question)
  const status = !answered && question?.annulled !== true && question?.pending !== true
    ? { tone: 'neutral', text: 'Não respondida' }
    : answerStatus(question)
  const circle = !answered
    ? 'bg-surface-2 text-subtle'
    : status.tone === 'success' ? 'bg-success-soft text-success'
      : status.tone === 'danger' ? 'bg-danger-soft text-danger'
        : status.tone === 'warning' ? 'bg-warning-soft text-warning'
          : 'bg-info-soft text-info'
  const points = pointsLabel(question?.pointsEarned, question?.pointsPossible)
  // Pontos ao lado do tipo, quando o selo ainda não diz: a prova antiga (uma correta, 1
  // ponto cada) fica como era.
  const showPoints = !!points && !status.text.includes(points) && (type !== 'multiple_choice' || Number(question?.pointsPossible) !== 1)
  const alternatives = Array.isArray(question?.alternatives) ? question.alternatives : []
  const textType = isTextType(type)
  return (
    <section className="border-t border-border py-4 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-3">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-bold ${circle}`}>{question.position}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
            <QuestionMarkdown text={question.text || `Questão ${question.position}`} className="min-w-0 font-medium leading-relaxed text-text" />
            <Badge tone={status.tone}>{status.text}</Badge>
          </div>
          {(type !== 'multiple_choice' || showPoints) && (
            <p className="mt-1 text-xs text-muted">
              {QUESTION_TYPE_LABEL[type] || QUESTION_TYPE_LABEL.multiple_choice}
              {showPoints ? ` · ${points}` : ''}
            </p>
          )}

          {!textType && alternatives.length > 0 && (
            <div className="mt-3 divide-y divide-border border-y border-border">
              {alternatives.map((alternative) => {
                const optionStyle = alternative.selectedByStudent && alternative.correct
                  ? 'bg-success-soft/40'
                  : alternative.selectedByStudent
                    ? 'bg-danger-soft/40'
                    : alternative.correct
                      ? 'bg-success-soft/25'
                      : ''
                return (
                  <div key={`${question.position}-${alternative.canonicalLetter || alternative.letter}`} className={`flex flex-wrap items-center gap-3 px-2 py-2.5 ${optionStyle}`}>
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-bold text-muted">{alternative.letter}</span>
                    <OriginalLetter seen={alternative.letter} original={alternative.canonicalLetter} />
                    {/* Alternativa em Markdown, como o aluno viu (contrato C4: só por QuestionMarkdown). */}
                    <QuestionMarkdown text={alternative.text} choice className="min-w-0 flex-1 break-words text-sm text-text" />
                    {alternative.selectedByStudent && (
                      <span className={`inline-flex items-center gap-1 text-xs font-semibold ${alternative.correct ? 'text-success' : 'text-danger'}`}>
                        {alternative.correct ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                        Resposta do aluno
                      </span>
                    )}
                    {alternative.correct && !alternative.selectedByStudent && (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-success">
                        <CheckCircle2 size={14} /> {correctLabel}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {!textType && alternatives.length === 0 && (
            <div className="mt-3 flex flex-wrap gap-4 text-sm">
              <span className="text-muted">Aluno: <b className="font-mono text-text">{type === 'multiple_answer' ? (question.answerText || '—') : seenWithOriginal(question.studentChoiceSeen, question.studentChoice)}</b></span>
              <span className="text-muted">Gabarito: <b className="font-mono text-success">{type === 'multiple_answer' && question.correctAnswersSeen?.length ? question.correctAnswersSeen.join(', ') : seenWithOriginal(question.correctAnswerSeen, question.correctAnswer)}</b></span>
            </div>
          )}

          {textType && (
            <div className="mt-3 space-y-2">
              <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
                <p className="text-xs font-semibold text-muted">Resposta do aluno</p>
                {answered
                  ? <p className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm text-text">{type === 'essay' ? question.studentResponse : (question.answerText || question.studentResponse)}</p>
                  : <p className="mt-1 text-sm text-muted">Em branco</p>}
              </div>
              {question.answerKeyText && (
                <p className="text-sm text-muted">Gabarito: <b className="font-medium text-success">{question.answerKeyText}</b></p>
              )}
            </div>
          )}

          {!answered && unansweredText && <p className="mt-2 text-xs font-medium text-warning">{unansweredText}</p>}
        </div>
      </div>
    </section>
  )
}

export default ReviewQuestionCard
