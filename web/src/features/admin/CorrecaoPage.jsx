import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBlocker, useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, EyeOff, Loader2, PenLine, RotateCcw, Save } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { EmptyState } from '../../components/ui/EmptyState'
import { Input } from '../../components/ui/Input'
import { PageHeader } from '../../components/ui/PageHeader'
import { Textarea } from '../../components/ui/Textarea'
import { useApi } from '../../hooks/useApi'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'
import { useAuth } from '../../context/AuthProvider'
import { useToast } from '../../context/ToastProvider'
import { api } from '../../lib/api'
import { fmtGrade } from '../../lib/grades'
import { ADMIN_PERMISSIONS, canWriteAdminPermission } from '../../lib/adminPermissions'
import QuestionMarkdown from '../exam/QuestionMarkdown'
import { QUESTION_TYPE_LABEL, isTextType, pointsLabel, possibleLabel } from '../exam/answerView'
import { GradeReasonDialog, isReasonRequiredError } from './GradeReasonDialog'
import { ReviewQueueList, ReviewRequestsBox } from './ReviewRequestsBox'
import {
  CORRECTION_LIMITS,
  correctionBody,
  draftPoints,
  hasRubric,
  initialDraft,
  itemChanged,
  missingQuestions,
  needsTeacher,
  pointsText,
  queueLabel,
  questionKey,
  validateDraft,
} from './correctionForm'

// Tela "Corrigir" (fase 3, P3-S4b / A18: AVA-07, UXA-17; D7 e D8 do desenho P3; API do
// A9 em backend/routes/adminCorrections.js). Endereço: /resultados/correcao, com
// ?examKey= (só uma prova da fila), ?applicationId= (só uma aplicação, o filtro de
// Resultados), ?submissionId= (abre esta entrega, mesmo fora da fila: a correção já
// concluída pode ser revista).
//
// - A fila (GET /api/admin/corrections) é a das entregas da turma que esperam o
//   professor, da mais antiga para a mais nova; "Anterior" e "Próxima" andam por ela.
// - "Corrigir sem ver o nome": a fila e a entrega mostram "Aluno N" (a ordem de envio),
//   para corrigir sem saber de quem é. Fica lembrado neste navegador. O número de cada
//   entrega não muda enquanto a tela está aberta, mesmo quando outra sai da fila.
// - Cada questão que espera o professor tem os pontos (ou a rubrica, que soma os
//   pontos), o comentário para o aluno e, quando há, a resposta esperada e a
//   explicação. A questão que o sistema corrigiu pelo gabarito mostra a conta dele e um
//   "Ajustar pontos", que pede o motivo (o servidor recusa sem ele); "Cancelar ajuste"
//   volta à conta do sistema antes de gravar.
// - Salvar guarda sem concluir; "Concluir correção" pede os pontos de todas as questões
//   que esperam o professor e mostra a nota antes e depois (a conta é do servidor).
// - Sair com mudanças não gravadas pede confirmação em qualquer caminho: Anterior e
//   Próxima, o filtro, o menu lateral, o sino, o voltar do navegador (useBlocker),
//   "Trocar curso ou turma" e o "Sair" do topo (guarda de saída do AuthProvider, porque
//   não mudam o endereço) e fechar ou recarregar a aba (beforeunload). Antes, só os
//   botões da própria tela.
// - Conflito (409 correction_conflict: outra aba gravou antes): aviso com "Recarregar".
// - Nota já publicada que muda: o GradeReasonDialog pede o motivo (reason_required).
// - Pedidos de revisão da nota (P3-S5 / A19): os abertos da turma ficam no topo, para
//   qualquer prova (também a de correção já concluída); a entrega mostra os pedidos dela
//   com o texto do aluno e o campo da resposta. Mudar a nota é pelos pontos (e Salvar)
//   antes de responder. A resposta digitada e não enviada também pede "Sair sem salvar?".
// - A Coordenação (só consulta) vê a correção sem os campos.
// - No celular de 375 px: uma coluna, campos de 44 px e a barra de Salvar/Concluir
//   presa ao pé da tela, sem rolagem para o lado.

const ANON_KEY = 'iclass.correcao.semNome'

function readAnonymous() {
  try { return window.localStorage.getItem(ANON_KEY) === '1' } catch { return false }
}

function writeAnonymous(value) {
  try { window.localStorage.setItem(ANON_KEY, value ? '1' : '0') } catch { /* sem armazenamento: só nesta visita */ }
}

const fmtWhen = (value) => {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''
}

// Nota da entrega (0 a 100 no servidor) na escala de 0 a 10, com vírgula.
const fmtScore = (score) => (score === null || score === undefined ? 'sem nota' : fmtGrade(score))

function automaticLabel(question) {
  const auto = question.automatico || {}
  if (question.annulled) return { tone: 'neutral', text: 'Anulada' }
  if (auto.pending) return { tone: 'warning', text: 'Aguardando correção' }
  const label = pointsLabel(auto.pointsEarned, auto.pointsPossible)
  if (auto.isCorrect === true) return { tone: 'success', text: `Correta · ${label}` }
  if (Number(auto.pointsEarned) > 0) return { tone: 'warning', text: `Parcial · ${label}` }
  return { tone: 'danger', text: `Errada · ${label}` }
}

function StudentAnswer({ question }) {
  const type = question.type || 'multiple_choice'
  if (isTextType(type)) {
    const text = type === 'essay' ? question.studentResponse : (question.answerText || question.studentResponse)
    return (
      <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
        <p className="text-xs font-semibold text-muted">Resposta do aluno</p>
        {text
          ? <p className="mt-1 max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-sm text-text">{text}</p>
          : <p className="mt-1 text-sm text-muted">Em branco</p>}
      </div>
    )
  }
  const chosen = new Set((type === 'multiple_answer' ? question.studentChoices : [question.answerText]).filter(Boolean).map((letter) => String(letter).toUpperCase()))
  const correct = new Set((type === 'multiple_answer' ? question.correctAnswersSeen : [question.correctAnswerSeen]).filter(Boolean).map((letter) => String(letter).toUpperCase()))
  const alternatives = Array.isArray(question.alternatives) ? question.alternatives : []
  if (!alternatives.length) {
    return <p className="text-sm text-muted">Resposta do aluno: <b className="text-text">{question.answerText || 'em branco'}</b></p>
  }
  return (
    <ul className="space-y-1.5">
      {alternatives.map((alternative) => {
        const letter = String(alternative.letter || '').toUpperCase()
        const isChosen = chosen.has(letter)
        const isRight = correct.has(letter)
        const box = isRight ? 'border-success bg-success-soft' : isChosen ? 'border-danger bg-danger-soft' : 'border-border bg-surface'
        return (
          <li key={letter} className={`flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm ${box}`}>
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-border bg-surface text-xs font-bold text-muted">{letter}</span>
            <QuestionMarkdown text={alternative.text} choice className="min-w-0 flex-1 pt-0.5 text-text" />
            {(isChosen || isRight) && (
              <span className={`basis-full pl-9 text-xs font-semibold ${isRight ? 'text-success' : 'text-danger'}`}>
                {isChosen && isRight ? 'Resposta do aluno · Gabarito' : isChosen ? 'Resposta do aluno' : 'Gabarito'}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function AnswerKey({ question }) {
  const parts = []
  if (question.expectedAnswer) parts.push(['Resposta esperada', question.expectedAnswer])
  if (question.type === 'numeric' && question.numeric && question.numeric.value !== undefined) {
    const tolerance = Number(question.numeric.tolerance) > 0 ? ` (± ${pointsText(question.numeric.tolerance)})` : ''
    parts.push(['Gabarito', `${pointsText(question.numeric.value)}${tolerance}${question.numeric.unit ? ` ${question.numeric.unit}` : ''}`])
  }
  if (question.type === 'short_answer' && Array.isArray(question.acceptedAnswers) && question.acceptedAnswers.length) {
    parts.push(['Respostas aceitas', question.acceptedAnswers.join(' · ')])
  }
  if (!parts.length && !question.explanation) return null
  return (
    <div className="space-y-2 rounded-lg border border-info/30 bg-info-soft px-3 py-2.5 text-sm">
      {parts.map(([label, text]) => (
        <div key={label}>
          <p className="text-xs font-semibold text-muted">{label}</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-text">{text}</p>
        </div>
      ))}
      {question.explanation && (
        <div>
          <p className="text-xs font-semibold text-muted">Explicação (o aluno vê com o gabarito liberado)</p>
          <QuestionMarkdown text={question.explanation} className="mt-0.5 text-text" />
        </div>
      )}
    </div>
  )
}

function QuestionGrading({ question, entry, initialEntry, errors, readOnly, onChange }) {
  const key = questionKey(question)
  const teacher = needsTeacher(question)
  const possible = Number(question.points ?? question.automatico?.pointsPossible ?? 1)
  const rubric = hasRubric(question) ? question.rubric : []
  const points = draftPoints(question, entry)
  const set = (patch) => onChange(key, { ...entry, ...patch })
  const auto = automaticLabel(question)
  const fieldError = (name) => errors[`itens.${key}.${name}`]

  if (question.annulled) {
    return <p className="text-sm text-muted">Questão anulada na aplicação: os pontos dela não mudam pela correção.</p>
  }

  if (readOnly) {
    const saved = question.item
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted">Pontos: <b className="text-text">{saved && saved.pontos !== undefined ? pointsLabel(saved.pontos, possible) : teacher ? 'ainda não lançados' : pointsLabel(question.automatico?.pointsEarned, possible)}</b></p>
        {saved?.comentario && <p className="whitespace-pre-wrap break-words text-text"><span className="text-muted">Comentário: </span>{saved.comentario}</p>}
        {saved?.motivo && <p className="text-muted">Motivo do ajuste: {saved.motivo}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {!teacher && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={auto.tone}>Sistema: {auto.text}</Badge>
          {!entry.ajustando && <Button size="sm" variant="secondary" className="h-11 sm:h-8" onClick={() => set({ ajustando: true, pontos: pointsText(question.automatico?.pointsEarned) })}>Ajustar pontos</Button>}
          {/* Ajuste ainda não gravado: volta à conta do sistema (o comentário fica). */}
          {entry.ajustando && !initialEntry?.ajustando && (
            <Button size="sm" variant="ghost" className="h-11 sm:h-8" onClick={() => set({ ajustando: false, pontos: initialEntry?.pontos ?? '', motivo: initialEntry?.motivo ?? '', rubrica: initialEntry?.rubrica || {} })}>Cancelar ajuste</Button>
          )}
        </div>
      )}
      {(teacher || entry.ajustando) && (
        <>
          {rubric.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-text">Rubrica</legend>
              {rubric.map((criterion) => (
                <div key={criterion.id} className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-start gap-3">
                  <label htmlFor={`rub-${key}-${criterion.id}`} className="pt-3 text-sm text-text">
                    {criterion.nome || criterion.id} <span className="text-muted">(até {possibleLabel(criterion.pontos)})</span>
                  </label>
                  <Input
                    id={`rub-${key}-${criterion.id}`}
                    inputMode="decimal"
                    value={entry.rubrica?.[criterion.id] ?? ''}
                    onChange={(event) => set({ rubrica: { ...(entry.rubrica || {}), [criterion.id]: event.target.value } })}
                    error={fieldError(`rubrica.${criterion.id}`)}
                    placeholder="0"
                  />
                </div>
              ))}
            </fieldset>
          )}
          <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-start gap-3">
            <label htmlFor={`pts-${key}`} className="pt-3 text-sm font-medium text-text">
              Pontos <span className="font-normal text-muted">(de 0 a {pointsText(possible)})</span>
            </label>
            <Input
              id={`pts-${key}`}
              inputMode="decimal"
              value={rubric.length > 0 && points !== null && !Number.isNaN(points) && Object.values(entry.rubrica || {}).some((value) => String(value).trim()) ? pointsText(points) : entry.pontos}
              readOnly={rubric.length > 0 && Object.values(entry.rubrica || {}).some((value) => String(value).trim())}
              onChange={(event) => set({ pontos: event.target.value })}
              error={fieldError('pontos')}
              placeholder="—"
            />
          </div>
          {!teacher && (
            <Input
              label="Motivo do ajuste (fica no histórico da nota)"
              value={entry.motivo}
              maxLength={CORRECTION_LIMITS.reasonMax}
              onChange={(event) => set({ motivo: event.target.value })}
              error={fieldError('motivo')}
            />
          )}
        </>
      )}
      <Textarea
        label="Comentário para o aluno (ele vê com o gabarito liberado)"
        value={entry.comentario}
        maxLength={CORRECTION_LIMITS.commentMax}
        counterFrom={CORRECTION_LIMITS.commentMax - 200}
        onChange={(event) => set({ comentario: event.target.value })}
        className="min-h-[72px]"
      />
    </div>
  )
}

export default function CorrecaoPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const { courseId, courseName, className } = useAdminWorkspace()
  const authCtx = useAuth()
  const auth = authCtx?.auth
  const setLeaveGuard = authCtx?.setLeaveGuard
  const canWrite = canWriteAdminPermission(auth, ADMIN_PERMISSIONS.PAGE_RESULTS)
  const examKey = params.get('examKey') || ''
  const applicationId = params.get('applicationId') || ''
  const submissionId = params.get('submissionId') || ''
  const contextQuery = new URLSearchParams({ courseId: courseId || '', studentClass: className || '' }).toString()
  const queueApi = useApi(courseId && className ? `/api/admin/corrections?${contextQuery}` : null, [courseId, className])
  const allPending = useMemo(() => (Array.isArray(queueApi.data?.pendentes) ? queueApi.data.pendentes : []), [queueApi.data])
  const reviewRows = useMemo(() => (Array.isArray(queueApi.data?.pedidosRevisao) ? queueApi.data.pedidosRevisao : [])
    .filter((row) => (!examKey || row.examKey === examKey) && (!applicationId || String(row.applicationId || '') === applicationId)), [queueApi.data, examKey, applicationId])
  const exams = useMemo(() => {
    const map = new Map()
    allPending.forEach((entry) => map.set(entry.examKey, { examKey: entry.examKey, prova: entry.prova || entry.examKey, count: (map.get(entry.examKey)?.count || 0) + 1 }))
    return [...map.values()]
  }, [allPending])
  const queue = useMemo(() => allPending.filter((entry) => (!examKey || entry.examKey === examKey)
    && (!applicationId || String(entry.applicationId || '') === applicationId)), [allPending, examKey, applicationId])
  const selectedId = submissionId || queue[0]?.submissionId || ''
  const position = queue.findIndex((entry) => String(entry.submissionId) === String(selectedId))

  const [anonymous, setAnonymous] = useState(readAnonymous)
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState('')
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [draft, setDraft] = useState({})
  const [initial, setInitial] = useState({})
  const [general, setGeneral] = useState('')
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(null)
  const [reasonFor, setReasonFor] = useState(null) // { concluir }
  // Resposta aos pedidos de revisão da entrega aberta: { [requestId]: texto }.
  const [replies, setReplies] = useState({})
  const [replyErrors, setReplyErrors] = useState({})
  const [replying, setReplying] = useState('')
  const loadRef = useRef(0)
  // Há mudanças não gravadas? Lido pelo useBlocker na hora da navegação; applyDetail zera
  // na hora (o endereço muda logo depois de concluir, antes de a tela redesenhar).
  const unsavedRef = useRef(false)
  // Número de cada entrega em "Corrigir sem ver o nome", fixo enquanto a tela está aberta.
  const anonNumbersRef = useRef(new Map())

  function applyDetail(data) {
    unsavedRef.current = false
    const start = initialDraft(data?.questoes)
    setDetail(data)
    setDraft(start)
    setInitial(start)
    setGeneral(String(data?.comentarioGeral || ''))
    setErrors({})
    setFormError('')
    setConflict(false)
    setReplies({})
    setReplyErrors({})
  }

  async function loadDetail(id) {
    const request = ++loadRef.current
    if (!id) { setDetail(null); return }
    setLoadingDetail(true)
    setDetailError('')
    try {
      const data = await api.get(`/api/admin/submissions/${encodeURIComponent(id)}/correction`)
      if (request !== loadRef.current) return
      applyDetail(data)
    } catch (error) {
      if (request !== loadRef.current) return
      setDetail(null)
      setDetailError(error?.message || 'Não foi possível abrir esta entrega.')
    } finally {
      if (request === loadRef.current) setLoadingDetail(false)
    }
  }

  useEffect(() => {
    setDone(null)
    loadDetail(selectedId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const questoes = useMemo(() => (Array.isArray(detail?.questoes) ? detail.questoes : []), [detail])
  const dirty = questoes.some((question) => itemChanged(draft[questionKey(question)], initial[questionKey(question)]))
    || general !== String(detail?.comentarioGeral || '')
  const missing = missingQuestions(questoes, draft)
  const teacherCount = questoes.filter((question) => needsTeacher(question) && !question.annulled).length
  const readOnly = !canWrite
  const replyDirty = Object.values(replies).some((text) => String(text || '').trim())
  unsavedRef.current = (dirty || replyDirty) && !readOnly

  // Qualquer troca de endereço (outra entrega, outra prova, o menu, o sino, o voltar do
  // navegador) com mudanças não gravadas para no diálogo "Sair sem salvar?".
  const blocker = useBlocker(useCallback(({ currentLocation, nextLocation }) => (
    unsavedRef.current
      && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search)
  ), []))
  // Saídas que não mudam o endereço ("Trocar curso ou turma" e o "Sair" do topo, que
  // limpam a turma ou a sessão no AuthProvider): a guarda de saída pergunta aqui antes.
  // outsideLeave guarda o "seguir" do AuthProvider enquanto o diálogo está aberto.
  const [outsideLeave, setOutsideLeave] = useState(null)
  useEffect(() => {
    if (typeof setLeaveGuard !== 'function') return undefined
    return setLeaveGuard((proceed) => {
      if (!unsavedRef.current) return false
      setOutsideLeave(() => proceed)
      return true
    })
  }, [setLeaveGuard])
  const leaving = blocker.state === 'blocked' || !!outsideLeave

  function stayHere() {
    if (blocker.state === 'blocked') blocker.reset()
    setOutsideLeave(null)
  }

  function leaveAnyway() {
    if (blocker.state === 'blocked') { blocker.proceed(); return }
    const proceed = outsideLeave
    setOutsideLeave(null)
    if (typeof proceed === 'function') proceed()
  }

  // Fechar ou recarregar a aba: o navegador pergunta (o texto é dele).
  useEffect(() => {
    if ((!dirty && !replyDirty) || readOnly) return undefined
    const warn = (event) => {
      event.preventDefault()
      event.returnValue = ''
      return ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, replyDirty, readOnly])

  function go(next) {
    if (typeof next === 'function') next()
    else setParams(next)
  }

  function selectSubmission(id) {
    const next = new URLSearchParams(params)
    if (id) next.set('submissionId', id)
    else next.delete('submissionId')
    go(next)
  }

  function selectExam(key) {
    const next = new URLSearchParams()
    if (key) next.set('examKey', key)
    go(next)
  }

  function toggleAnonymous(value) {
    setAnonymous(value)
    writeAnonymous(value)
  }

  function updateEntry(key, entry) {
    setDraft((current) => ({ ...current, [key]: entry }))
    setErrors((current) => {
      const next = { ...current }
      Object.keys(next).forEach((field) => { if (field.startsWith(`itens.${key}.`)) delete next[field] })
      return next
    })
  }

  async function send({ concluir = false, motivo = '' } = {}) {
    if (!detail || saving) return
    const found = validateDraft(questoes, draft)
    if (Object.keys(found).length) {
      setErrors(found)
      setFormError('Confira os campos marcados em vermelho.')
      return
    }
    if (concluir && missing.length) {
      setFormError(missing.length === 1 ? `Falta lançar os pontos da questão ${missing[0]}.` : `Falta lançar os pontos das questões ${missing.join(', ')}.`)
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const result = await api.post(`/api/admin/submissions/${encodeURIComponent(detail.submissionId)}/correction`, correctionBody({ questoes, draft, initial, versao: detail.versao, comentarioGeral: general, comentarioGeralInicial: detail.comentarioGeral || '', concluir, motivo }))
      setReasonFor(null)
      if (result?.unchanged) {
        toast?.success?.('Nada mudou desde a última gravação.')
        if (concluir) setDone({ before: detail.score, after: detail.score, published: detail.gradePublished === true })
        return
      }
      applyDetail({ ...detail, ...result, questoes: result.questoes || detail.questoes })
      if (concluir || (detail.situacao === 'pendente' && result.situacao === 'concluida')) {
        // A entrega sai da fila: o endereço fica com ela, para o resultado continuar à vista.
        if (!submissionId) {
          const next = new URLSearchParams(params)
          next.set('submissionId', String(detail.submissionId))
          setParams(next, { replace: true })
        }
        setDone({ before: result.scoreBefore, after: result.score, published: result.gradePublished === true })
        queueApi.refetch?.()
      } else {
        toast?.success?.(result.reaberta ? 'Correção salva. Ela voltou a aguardar: a nota sai quando você concluir de novo.' : 'Correção salva. Conclua quando terminar todas as questões.')
        if (result.reaberta) queueApi.refetch?.()
      }
    } catch (error) {
      const code = error?.data?.code
      const field = error?.data?.field
      if (code === 'correction_conflict') {
        setReasonFor(null)
        setConflict(true)
      } else if (isReasonRequiredError(error) && field === 'motivo') {
        if (reasonFor) throw error
        setReasonFor({ concluir })
      } else if (field && String(field).startsWith('itens.')) {
        setReasonFor(null)
        setErrors((current) => ({ ...current, [field]: error.message }))
        setFormError(error.message)
      } else {
        if (reasonFor) throw error
        setFormError(error?.message || 'Não foi possível gravar a correção.')
      }
    } finally {
      setSaving(false)
    }
  }

  // Responde o pedido de revisão aberto (POST .../review-requests/:id/answer). A nota já
  // foi mudada (ou não) pelos pontos; o servidor diz se mudou.
  async function answerReview(reviewRequest) {
    if (!detail || replying) return
    const text = String(replies[reviewRequest.id] || '').trim()
    if (!text) {
      setReplyErrors((current) => ({ ...current, [reviewRequest.id]: 'Escreva a resposta para o aluno.' }))
      return
    }
    setReplying(reviewRequest.id)
    setReplyErrors((current) => ({ ...current, [reviewRequest.id]: undefined }))
    try {
      const result = await api.post(`/api/admin/submissions/${encodeURIComponent(detail.submissionId)}/review-requests/${encodeURIComponent(reviewRequest.id)}/answer`, { resposta: text })
      setDetail((current) => (current && String(current.submissionId) === String(detail.submissionId) ? { ...current, pedidosRevisao: result.pedidosRevisao || current.pedidosRevisao } : current))
      setReplies((current) => { const next = { ...current }; delete next[reviewRequest.id]; return next })
      toast?.success?.(result?.pedido?.notaMudou ? 'Resposta enviada. O aluno vê a resposta e a nota nova.' : 'Resposta enviada. O aluno vê a resposta; a nota ficou como estava.')
      queueApi.refetch?.()
    } catch (error) {
      setReplyErrors((current) => ({ ...current, [reviewRequest.id]: error?.message || 'Não foi possível enviar a resposta.' }))
    } finally {
      setReplying('')
    }
  }

  const nextInQueue = () => {
    const rest = queue.filter((entry) => String(entry.submissionId) !== String(detail?.submissionId))
    const after = queue.slice(Math.max(position, 0) + 1).find((entry) => String(entry.submissionId) !== String(detail?.submissionId))
    return after || rest[0] || null
  }
  // "Aluno N" pela ordem de envio da primeira vez que a entrega apareceu na fila: concluir
  // uma não renumera as outras (antes, a próxima virava "Aluno 1" de novo).
  const anonNumbers = anonNumbersRef.current
  allPending.forEach((entry) => {
    const id = String(entry.submissionId)
    if (!anonNumbers.has(id)) anonNumbers.set(id, anonNumbers.size + 1)
  })
  const anonIndex = (id) => (anonNumbers.has(String(id)) ? anonNumbers.get(String(id)) - 1 : -1)
  const label = (entry) => queueLabel(entry, anonIndex(entry.submissionId), { anonymous })
  const detailIndex = anonIndex(detail?.submissionId ?? selectedId)
  const studentName = anonymous
    ? (detailIndex >= 0 ? `Aluno ${detailIndex + 1}` : 'Aluno')
    : (detail?.aluno?.name || detail?.aluno?.email || 'Aluno')

  return (
    <div className="mx-auto max-w-5xl space-y-5 pb-28">
      <PageHeader
        title="Corrigir provas"
        helpTopic="correcao"
        subtitle={`${courseName || courseId} · ${className} · ${queue.length === 1 ? '1 entrega aguardando' : `${queue.length} entregas aguardando`}${reviewRows.length ? ` · ${reviewRows.length === 1 ? '1 pedido de revisão' : `${reviewRows.length} pedidos de revisão`}` : ''}`}
      >
        <Button variant="ghost" icon={ArrowLeft} onClick={() => go(() => navigate('/resultados'))}>Resultados</Button>
      </PageHeader>

      {readOnly && (
        <p role="status" className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted">Você está vendo a correção só para consulta: quem lança os pontos é o professor da turma.</p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex w-full min-w-0 flex-col gap-1.5 sm:w-72">
          <span className="text-[13px] font-medium text-muted">Prova</span>
          <select aria-label="Prova" value={examKey} onChange={(event) => selectExam(event.target.value)} className="h-11 min-w-0 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text">
            <option value="">Todas as provas ({allPending.length})</option>
            {exams.map((exam) => <option key={exam.examKey} value={exam.examKey}>{exam.prova} ({exam.count})</option>)}
          </select>
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-text">
          <input type="checkbox" className="h-5 w-5" checked={anonymous} onChange={(event) => toggleAnonymous(event.target.checked)} />
          <EyeOff size={15} className="text-muted" aria-hidden /> Corrigir sem ver o nome
        </label>
        {applicationId && (
          <p className="flex min-h-11 flex-wrap items-center gap-2 text-sm text-muted">
            Só a aplicação escolhida em Resultados.
            <Button size="sm" variant="ghost" className="h-11 sm:h-8" onClick={() => selectExam(examKey)}>Ver todas</Button>
          </p>
        )}
      </div>

      <ReviewQueueList rows={reviewRows} selectedId={selectedId} anonymous={anonymous} onSelect={selectSubmission} />

      {queueApi.loading && !queueApi.data ? (
        <div className="flex min-h-40 items-center justify-center gap-3 text-muted"><Loader2 size={20} className="animate-spin text-primary" /> Carregando a fila...</div>
      ) : queueApi.error ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{queueApi.error.message || 'Não foi possível carregar a fila.'}</p>
      ) : !selectedId ? (
        <EmptyState icon={CheckCircle2} title="Nenhuma prova aguardando correção" description={reviewRows.length ? 'Toque num pedido de revisão acima para abrir a entrega e responder ao aluno.' : 'Quando um aluno entregar uma prova com questão dissertativa (ou outra que o sistema não corrige sozinho), ela aparece aqui.'} />
      ) : (
        <div className={`grid gap-5 ${queue.length > 0 ? 'lg:grid-cols-[15rem_minmax(0,1fr)]' : ''}`}>
          {queue.length > 0 && (
            <nav aria-label="Fila da correção" className="hidden lg:block">
              <ol className="space-y-1">
                {queue.map((entry) => {
                  const active = String(entry.submissionId) === String(selectedId)
                  return (
                    <li key={entry.submissionId}>
                      <button type="button" onClick={() => selectSubmission(entry.submissionId)} aria-current={active ? 'true' : undefined} className={`w-full rounded-lg px-3 py-2 text-left text-sm ${active ? 'bg-primary-soft font-semibold text-primary' : 'text-text hover:bg-surface-2'}`}>
                        <span className="block truncate">{label(entry)}</span>
                        <span className="block truncate text-xs font-normal text-muted">{entry.prova} · questão {entry.questoesPendentes?.join(', ')}</span>
                      </button>
                    </li>
                  )
                })}
              </ol>
            </nav>
          )}

          <section aria-label="Entrega" className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button size="sm" variant="secondary" className="h-11 sm:h-8" icon={ChevronLeft} disabled={position <= 0} onClick={() => selectSubmission(queue[position - 1]?.submissionId)}>Anterior</Button>
              <span className="text-sm text-muted">{position >= 0 ? `${position + 1} de ${queue.length}` : 'Fora da fila'}</span>
              <Button size="sm" variant="secondary" className="h-11 sm:h-8" disabled={position < 0 ? !queue.length : position >= queue.length - 1} onClick={() => selectSubmission(position < 0 ? queue[0]?.submissionId : queue[position + 1]?.submissionId)}>Próxima <ChevronRight size={16} aria-hidden /></Button>
            </div>

            {loadingDetail && <div className="flex min-h-40 items-center justify-center gap-3 text-muted"><Loader2 size={20} className="animate-spin text-primary" /> Abrindo a entrega...</div>}
            {!loadingDetail && detailError && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{detailError}</p>}

            {!loadingDetail && detail && (
              <>
                <header className="rounded-xl border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="break-words text-lg font-semibold text-text">{studentName}</h2>
                      <p className="break-words text-sm text-muted">{detail.prova} · tentativa {detail.attemptNumber || 1}{detail.enviadaEm ? ` · enviada em ${fmtWhen(detail.enviadaEm)}` : ''}</p>
                    </div>
                    <Badge tone={detail.situacao === 'concluida' ? 'success' : 'warning'}>{detail.situacao === 'concluida' ? 'Correção concluída' : 'Aguardando correção'}</Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted">
                    {detail.situacao === 'concluida' ? <>Nota: <b className="text-text">{fmtScore(detail.score)}</b>{detail.gradePublished ? ' · publicada para o aluno' : ' · ainda não publicada'}</> : <>{teacherCount === 1 ? '1 questão espera' : `${teacherCount} questões esperam`} a sua correção. A nota sai quando você concluir.</>}
                  </p>
                </header>

                <ReviewRequestsBox
                  requests={detail.pedidosRevisao}
                  questoes={questoes}
                  readOnly={readOnly}
                  replies={replies}
                  errors={replyErrors}
                  sending={replying}
                  onReplyChange={(id, text) => {
                    setReplies((current) => ({ ...current, [id]: text }))
                    setReplyErrors((current) => ({ ...current, [id]: undefined }))
                  }}
                  onAnswer={answerReview}
                />

                {done && (
                  <div role="status" className="rounded-xl border border-success/30 bg-success-soft p-4">
                    <p className="font-semibold text-text">Correção concluída.</p>
                    <p className="mt-1 text-sm text-text">Nota: {done.before !== done.after ? <>{fmtScore(done.before)} → </> : null}<b>{fmtScore(done.after)}</b>{done.published ? ' (o aluno já vê a nota nova).' : '. Publique em Resultados quando quiser que o aluno veja.'}</p>
                    {nextInQueue() && <Button size="sm" className="mt-3 h-11 sm:h-8" onClick={() => selectSubmission(nextInQueue().submissionId)}>Corrigir a próxima</Button>}
                  </div>
                )}

                {conflict && (
                  <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning-soft p-4 text-sm text-text">
                    <span className="flex items-start gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />Esta correção foi alterada em outra tela enquanto você corrigia. Recarregue para ver a versão atual (o que você digitou aqui não foi gravado).</span>
                    <Button size="sm" variant="secondary" className="h-11 sm:h-8" icon={RotateCcw} onClick={() => loadDetail(detail.submissionId)}>Recarregar</Button>
                  </div>
                )}

                <ol className="space-y-4">
                  {questoes.map((question) => {
                    const key = questionKey(question)
                    const teacher = needsTeacher(question)
                    return (
                      <li key={key} className={`rounded-xl border p-4 ${teacher ? 'border-warning/40 bg-surface' : 'border-border bg-surface'}`}>
                        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-muted">
                          <span className="grid h-6 w-6 place-items-center rounded-md border border-border bg-surface-2 text-text">{question.position}</span>
                          Questão {question.position} · {QUESTION_TYPE_LABEL[question.type] || QUESTION_TYPE_LABEL.multiple_choice} · vale {possibleLabel(question.points)}
                          {teacher && <Badge tone="warning">Para você corrigir</Badge>}
                        </div>
                        {question.text && <QuestionMarkdown text={question.text} className="mb-3 text-sm leading-relaxed text-text" />}
                        <div className="space-y-3">
                          <StudentAnswer question={question} />
                          <AnswerKey question={question} />
                          <QuestionGrading question={question} entry={draft[key] || {}} initialEntry={initial[key]} errors={errors} readOnly={readOnly} onChange={updateEntry} />
                        </div>
                      </li>
                    )
                  })}
                </ol>

                {readOnly ? (
                  detail.comentarioGeral ? <div className="rounded-xl border border-border bg-surface p-4 text-sm"><p className="text-xs font-semibold text-muted">Comentário geral</p><p className="mt-1 whitespace-pre-wrap break-words text-text">{detail.comentarioGeral}</p></div> : null
                ) : (
                  <Textarea
                    label="Comentário geral para o aluno (ele vê com a nota publicada)"
                    value={general}
                    maxLength={CORRECTION_LIMITS.generalMax}
                    counterFrom={CORRECTION_LIMITS.generalMax - 300}
                    onChange={(event) => setGeneral(event.target.value)}
                  />
                )}
              </>
            )}
          </section>
        </div>
      )}

      {!readOnly && detail && !loadingDetail && (
        <div className="sticky bottom-0 z-10 -mx-4 border-t border-border bg-surface px-4 py-3 shadow-[0_-6px_18px_rgba(0,0,0,0.08)] sm:mx-0 sm:rounded-xl sm:border">
          {formError && <p role="alert" className="mb-2 text-sm text-danger">{formError}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 text-sm text-muted">
              {missing.length ? (missing.length === 1 ? `Falta a questão ${missing[0]}` : `Faltam as questões ${missing.join(', ')}`) : (detail.situacao === 'concluida' ? (dirty ? 'Mudanças não salvas' : 'Correção concluída') : 'Todas as questões com pontos')}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" icon={Save} className="h-11" loading={saving} disabled={!dirty || saving} onClick={() => send()}>Salvar</Button>
              <Button icon={PenLine} className="h-11" loading={saving} disabled={saving || (detail.situacao === 'concluida' && !dirty)} onClick={() => send({ concluir: true })}>{detail.situacao === 'concluida' ? 'Salvar e manter concluída' : 'Concluir correção'}</Button>
            </div>
          </div>
        </div>
      )}

      <GradeReasonDialog
        open={!!reasonFor}
        onClose={() => setReasonFor(null)}
        reason="required"
        title="Mudar uma nota já publicada?"
        description="O aluno já vê esta nota. O motivo fica no histórico da nota e na auditoria."
        confirmLabel={reasonFor?.concluir ? 'Concluir correção' : 'Salvar'}
        onConfirm={(motivo) => send({ concluir: !!reasonFor?.concluir, motivo })}
      />

      <ConfirmDialog
        open={leaving}
        onClose={stayHere}
        title="Sair sem salvar?"
        message={dirty ? 'Os pontos e comentários que você digitou nesta entrega ainda não foram gravados.' : 'A resposta ao pedido de revisão que você digitou ainda não foi enviada.'}
        confirmLabel="Sair sem salvar"
        cancelLabel="Continuar corrigindo"
        tone="danger"
        onConfirm={leaveAnyway}
      />
    </div>
  )
}
