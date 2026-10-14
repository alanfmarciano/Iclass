import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, XCircle, Loader2, ArrowRight } from 'lucide-react'
import { Modal } from '../../components/ui/Modal'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { api } from '../../lib/api'

const STATUS_LABEL = {
  finished: { tone: 'success', text: 'Finalizada' },
  in_progress: { tone: 'warning', text: 'Em andamento' },
  not_started: { tone: 'neutral', text: 'Não iniciada' },
}

// Painel da prova corrente de um aluno: respostas + gabarito, correção ao vivo.
// Reaproveita /api/admin/monitor-review, que resolve tanto prova em andamento
// (state.answers) quanto finalizada (submission.gradedAnswers).
export function StudentAnswersModal({ open, onClose, student, className, courseId, examKey, applicationId, onOpenResults }) {
  const [review, setReview] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const timer = useRef(null)
  const statusRef = useRef(null) // último status carregado, lido pelo timer sem re-render

  useEffect(() => {
    if (!open || !student?.email || !className || !examKey) return undefined
    let alive = true
    let inFlight = false
    statusRef.current = null

    async function load(showSpinner) {
      if (inFlight) return
      inFlight = true
      if (showSpinner) setLoading(true)
      try {
        const params = new URLSearchParams({ studentEmail: student.email })
        if (courseId) params.set('courseId', courseId)
        if (applicationId) params.set('applicationId', applicationId)
        const data = await api.get(`/api/admin/monitor-review/${encodeURIComponent(className)}/${encodeURIComponent(examKey)}?${params.toString()}`)
        if (!alive) return
        statusRef.current = data?.status || null
        setReview(data)
        setError(null)
      } catch (e) {
        if (alive) setError(e.message || 'Não foi possível carregar as respostas.')
      } finally {
        inFlight = false
        if (alive && showSpinner) setLoading(false)
      }
    }

    load(true)
    // Atualiza em tempo real enquanto a prova não estiver finalizada.
    timer.current = setInterval(() => {
      if (statusRef.current !== 'finished') load(false)
    }, 6000)

    return () => {
      alive = false
      if (timer.current) clearInterval(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, student?.email, className, courseId, examKey, applicationId])

  if (!open) return null

  const statusMeta = STATUS_LABEL[review?.status] || STATUS_LABEL.not_started

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`${student?.name || review?.studentName || 'Aluno'} — respostas`}
      description={`${student?.email || review?.studentEmail || ''}${review?.assignedVersion ? ` · Versão ${review.assignedVersion}` : ''}`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Fechar</Button>
        {onOpenResults && <Button variant="secondary" icon={ArrowRight} onClick={onOpenResults}>Ver nos resultados</Button>}
      </>}
    >
      {loading && (
        <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-muted">
          <Loader2 size={24} className="animate-spin text-primary" />
          <p className="text-sm">Carregando a prova do aluno...</p>
        </div>
      )}

      {!loading && error && (
        <div className="border-y border-border py-6 text-center text-sm text-danger">{error}</div>
      )}

      {!loading && !error && review && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusMeta.tone} dot>{statusMeta.text}</Badge>
            <Badge tone="neutral">Progresso {review.answeredCount}/{review.totalCount}</Badge>
            {review.status !== 'not_started' && <Badge tone="success">{review.correctCount} certas</Badge>}
            {review.status !== 'not_started' && <Badge tone="danger">{Math.max(0, review.answeredCount - review.correctCount)} erradas</Badge>}
            {review.examCode && <span className="text-xs text-subtle">Código {review.examCode}</span>}
          </div>

          {(!review.questions || review.questions.length === 0) && (
            <div className="border-y border-border py-6 text-center text-sm text-muted">
              {review.hasSnapshot
                ? 'Este aluno ainda não respondeu nenhuma questão.'
                : 'Não há um snapshot desta versão para reconstruir as questões.'}
            </div>
          )}

          {review.questions?.map((question) => {
            const answered = question.answered
            const tone = !answered ? 'neutral' : question.isCorrect ? 'success' : 'danger'
            const circle = !answered
              ? 'bg-surface-2 text-subtle'
              : question.isCorrect ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
            return (
              <section key={`${question.questionNumber}-${question.position}`} className="border-t border-border py-4 first:border-t-0 first:pt-0">
                <div className="flex items-start gap-3">
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-bold ${circle}`}>{question.position}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                      <p className="font-medium leading-relaxed text-text">{question.text || `Questão ${question.position}`}</p>
                      <Badge tone={tone}>{!answered ? 'Não respondida' : question.isCorrect ? 'Correta' : 'Errada'}</Badge>
                    </div>

                    {question.alternatives?.length > 0 ? (
                      <div className="mt-3 divide-y divide-border border-y border-border">
                        {question.alternatives.map((alternative) => {
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
                              <span className="min-w-0 flex-1 text-sm text-text">{alternative.text}</span>
                              {alternative.selectedByStudent && (
                                <span className={`inline-flex items-center gap-1 text-xs font-semibold ${alternative.correct ? 'text-success' : 'text-danger'}`}>
                                  {alternative.correct ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                                  Resposta do aluno
                                </span>
                              )}
                              {alternative.correct && !alternative.selectedByStudent && (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-success">
                                  <CheckCircle2 size={14} /> Gabarito
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-4 text-sm">
                        <span className="text-muted">Aluno: <b className="font-mono text-text">{question.studentChoice || '—'}</b></span>
                        <span className="text-muted">Gabarito: <b className="font-mono text-success">{question.correctAnswer || '—'}</b></span>
                      </div>
                    )}

                    {!answered && <p className="mt-2 text-xs font-medium text-warning">Questão ainda não respondida.</p>}
                  </div>
                </div>
              </section>
            )
          })}
        </div>
      )}
    </Modal>
  )
}

export default StudentAnswersModal
