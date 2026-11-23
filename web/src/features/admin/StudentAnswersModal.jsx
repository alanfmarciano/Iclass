import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, ArrowRight } from 'lucide-react'
import { Modal } from '../../components/ui/Modal'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { api } from '../../lib/api'
import { usePolling } from '../../hooks/usePolling'
import { displayEmail } from '../../lib/studentProfile'
import { reviewLettersNote } from './reviewLetters'
import { ReviewQuestionCard, reviewCounts } from './ReviewQuestionCard'

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
  const [finished, setFinished] = useState(false) // prova finalizada: para de atualizar
  // Pedido atual (aluno, turma, prova e aplicação): a resposta de um pedido anterior
  // (modal reaberto para outro aluno) não vale mais.
  const target = open && student?.email && className && examKey
    ? `${student.email}|${className}|${courseId || ''}|${examKey}|${applicationId || ''}`
    : ''
  const targetRef = useRef(target)
  targetRef.current = target
  const loadingRef = useRef(0) // consultas em voo: a periódica não sai junto com outra

  const load = useCallback(async (showSpinner, requestOptions = undefined) => {
    if (!target) return true
    const requested = target
    if (showSpinner) setLoading(true)
    loadingRef.current += 1
    try {
      const params = new URLSearchParams({ studentEmail: student.email })
      if (courseId) params.set('courseId', courseId)
      if (applicationId) params.set('applicationId', applicationId)
      const data = await api.get(`/api/admin/monitor-review/${encodeURIComponent(className)}/${encodeURIComponent(examKey)}?${params.toString()}`, requestOptions)
      if (targetRef.current !== requested) return true
      setFinished(data?.status === 'finished')
      setReview(data)
      setError(null)
      return true
    } catch (e) {
      if (targetRef.current === requested) setError(e.message || 'Não foi possível carregar as respostas.')
      return false
    } finally {
      loadingRef.current -= 1
      if (showSpinner && targetRef.current === requested) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  useEffect(() => {
    setFinished(false)
    if (target) load(true)
  }, [target, load])
  // Atualiza em tempo real (a cada 6 s, uma consulta por vez, só com a aba à vista)
  // enquanto a prova não estiver finalizada.
  usePolling((requestOptions) => (loadingRef.current ? true : load(false, requestOptions)), { intervalMs: 6000, enabled: !!target && !finished, immediate: false })

  if (!open) return null

  const statusMeta = STATUS_LABEL[review?.status] || STATUS_LABEL.not_started
  // Erradas: as respondidas que não estão certas nem esperam o professor (antes a
  // dissertativa contava como errada).
  const counts = reviewCounts(review?.questions)

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`${student?.name || review?.studentName || 'Aluno'} — respostas`}
      description={`${displayEmail(student?.email || review?.studentEmail || '')}${review?.assignedVersion ? ` · Versão ${review.assignedVersion}` : ''}`}
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
            {review.status !== 'not_started' && <Badge tone="success">{counts.correct} certas</Badge>}
            {review.status !== 'not_started' && <Badge tone="danger">{counts.wrong} erradas</Badge>}
            {review.status !== 'not_started' && counts.pending > 0 && <Badge tone="warning">{counts.pending} {counts.pending === 1 ? 'aguarda' : 'aguardam'} correção</Badge>}
            {review.examCode && <span className="text-xs text-subtle">Código {review.examCode}</span>}
          </div>
          {reviewLettersNote(review.alternativeLabels) && <p className="text-xs text-subtle">{reviewLettersNote(review.alternativeLabels)}</p>}

          {(!review.questions || review.questions.length === 0) && (
            <div className="border-y border-border py-6 text-center text-sm text-muted">
              {review.drawPending
                ? 'As questões deste aluno são sorteadas quando ele começar a prova.'
                : review.hasSnapshot
                  ? 'Este aluno ainda não respondeu nenhuma questão.'
                  : 'Não há um snapshot desta versão para reconstruir as questões.'}
            </div>
          )}

          {review.questions?.map((question) => (
            <ReviewQuestionCard key={`${question.questionNumber}-${question.position}`} question={question} unansweredText="Questão ainda não respondida." correctLabel="Gabarito" />
          ))}
        </div>
      )}
    </Modal>
  )
}

export default StudentAnswersModal
