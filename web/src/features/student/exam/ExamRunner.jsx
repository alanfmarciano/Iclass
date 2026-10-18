import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { ShieldAlert, Clock, LockKeyhole, CheckCircle2, ArrowLeft, Send, AlertTriangle, Loader2, History, Trash2, Play } from 'lucide-react'
import { Card } from '../../../components/ui/Card'
import { Button } from '../../../components/ui/Button'
import { Input } from '../../../components/ui/Input'
import { Select } from '../../../components/ui/Select'
import { Textarea } from '../../../components/ui/Textarea'
import { Badge } from '../../../components/ui/Badge'
import { ConfirmDialog, Modal } from '../../../components/ui/Modal'
import { api } from '../../../lib/api'
import { useStudent } from '../useStudent'
import { useToast } from '../../../context/ToastProvider'
import { normQuestion, fmtTime } from './examUtils'
import { fmtGrade } from '../../../lib/grades'

const SYNC_MS = 4000
const AUTOSAVE_MS = 15000
const KEYSTROKE_FLUSH_MS = 2000
const KEYSTROKE_FLUSH_SIZE = 20

// Combinações bloqueadas dentro da prova (fluxos de cópia/busca/impressão/devtools/Lens).
// Retorna a razão se a combinação for suspeita/bloqueável, senão null.
function classifyCombo(e) {
  const k = (e.key || '').toLowerCase()
  const ctrl = e.ctrlKey, alt = e.altKey, meta = e.metaKey, shift = e.shiftKey
  if ((ctrl || meta) && ['c', 'x'].includes(k)) return { block: true, reason: 'copiar_recortar' }
  if ((ctrl || meta) && k === 'v') return { block: false, reason: 'colar' }
  if ((ctrl || meta) && ['f', 'p', 's'].includes(k)) return { block: true, reason: 'buscar_imprimir_salvar' }
  if ((ctrl || meta) && shift && ['i', 'j', 'c'].includes(k)) return { block: true, reason: 'devtools' }
  if (k === 'f12') return { block: true, reason: 'devtools' }
  if (alt && k === 'g') return { block: true, reason: 'assistente_ia' } // atalho candidato do Gemini (validar)
  if (meta) return { block: false, reason: 'tecla_sistema' } // Win/Meta: registrar (não bloqueável)
  if (ctrl || alt) return { block: false, reason: 'atalho' } // qualquer outro atalho com modificador
  return null
}

function modsOf(e) {
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean).join('+')
}

export default function ExamRunner() {
  const { examKey } = useParams()
  const [searchParams] = useSearchParams()
  const applicationId = searchParams.get('applicationId') || ''
  const nav = useNavigate()
  const { email, studentClass, courseId } = useStudent()
  const toast = useToast()

  const [phase, setPhase] = useState('loading')
  const [cfg, setCfg] = useState(null)
  const [questions, setQuestions] = useState([])
  const [answers, setAnswers] = useState({})
  const [assignedVersion, setAssignedVersion] = useState('A')
  const [examConfigVersion, setExamConfigVersion] = useState(null)
  const [examTitle, setExamTitle] = useState('')
  const [remaining, setRemaining] = useState(null)
  const [waitingRemaining, setWaitingRemaining] = useState(null)
  const [tokenInput, setTokenInput] = useState('')
  const [tokenOk, setTokenOk] = useState(false)
  const [result, setResult] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [fatal, setFatal] = useState(null)
  const [instructorMessage, setInstructorMessage] = useState(null)
  const [messageHistory, setMessageHistory] = useState([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [saveState, setSaveState] = useState({ status: 'idle', at: null })
  const [attemptLimit, setAttemptLimit] = useState(null)
  const [attemptId, setAttemptId] = useState(null)
  const [extraMinutes, setExtraMinutes] = useState(0) // tempo adicional de acessibilidade
  const [instructionsAccepted, setInstructionsAccepted] = useState(false)
  const [submitConfirm, setSubmitConfirm] = useState(false)
  const [exitConfirm, setExitConfirm] = useState(false)
  const [reportedQuestions, setReportedQuestions] = useState(() => new Set())
  const [reportQuestion, setReportQuestion] = useState(null)
  const [reportForm, setReportForm] = useState({ reason: 'sem_resposta_correta', text: '' })
  const [reportBusy, setReportBusy] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const answersRef = useRef(answers)
  const submittedRef = useRef(false)
  const timeoutHandledRef = useRef(false)
  const keyBufferRef = useRef([])
  const keySeqRef = useRef(0)
  // Impressão digital das questões já recebidas: o servidor só reenvia quando mudam.
  const questionsVersionRef = useRef('')
  answersRef.current = answers

  // As questões chegam só da tentativa iniciada (sync ou start-attempt), nunca da config da turma.
  const applyAttemptQuestions = useCallback((payload) => {
    if (!payload || !Array.isArray(payload.questions)) return
    setQuestions(payload.questions.map(normQuestion))
    questionsVersionRef.current = payload.questionsVersion || ''
  }, [])

  const qs = (v = '') => `email=${encodeURIComponent(email)}&studentClass=${encodeURIComponent(studentClass)}&courseId=${encodeURIComponent(courseId)}&examKey=${encodeURIComponent(examKey)}&applicationId=${encodeURIComponent(applicationId)}${v}`
  const submit = useCallback(async (auto = false) => {
    if (submittedRef.current) return
    submittedRef.current = true
    setSubmitting(true)
    try {
      const r = await api.post('/api/student/submit', {
        email,
        studentClass,
        courseId,
        examKey,
        applicationId,
        attemptId,
        answers: answersRef.current,
        examConfigVersion,
        auto,
      })
      setResult(r)
      setSubmitConfirm(false)
      setPhase('done')
      if (auto) toast.info('Tempo esgotado - prova enviada automaticamente.')
      else toast.success('Prova enviada!')
    } catch (e) {
      submittedRef.current = false
      if (e.status === 403 && e.data?.attemptsExhausted) {
        setAttemptLimit(Number(e.data.maxAttempts) || null)
        setPhase('exhausted')
      } else {
        toast.error(e.message || 'Falha ao enviar a prova')
      }
    } finally {
      setSubmitting(false)
    }
    // eslint-disable-next-line
  }, [email, studentClass, courseId, examKey, applicationId, attemptId, examConfigVersion, toast])

  const flushKeystrokes = useCallback((useBeacon = false) => {
    const events = keyBufferRef.current
    if (!events.length) return
    keyBufferRef.current = []
    const payload = { email, studentClass, courseId, examKey, applicationId, attemptId, events }
    if (useBeacon && navigator.sendBeacon) {
      try {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
        navigator.sendBeacon('/api/student/log-keystrokes', blob)
        return
      } catch (err) { /* cai no fetch abaixo */ }
    }
    api.post('/api/student/log-keystrokes', payload).catch(() => {
      // Reenvia no próximo flush se falhar (não perde a cauda).
      keyBufferRef.current = events.concat(keyBufferRef.current)
    })
  }, [email, studentClass, courseId, examKey, applicationId, attemptId])

  const enterFullscreen = useCallback(async () => {
    try {
      const el = document.documentElement
      if (el.requestFullscreen) await el.requestFullscreen()
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen()
      return true
    } catch (err) {
      return false
    }
  }, [])

  // Captura do histórico de digitação + bloqueio de atalhos perigosos (só na fase ativa).
  useEffect(() => {
    if (phase !== 'active') return
    const onKeyDown = (e) => {
      const cls = classifyCombo(e)
      const isChar = e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey
      if (cls && cls.block) e.preventDefault()
      keyBufferRef.current.push({
        seq: ++keySeqRef.current,
        clientTs: Date.now(),
        key: e.key,
        code: e.code,
        mods: modsOf(e),
        kind: cls ? 'shortcut' : (isChar ? 'char' : 'key'),
        question: null,
        blocked: !!(cls && cls.block),
        suspicious: !!cls,
      })
      if (keyBufferRef.current.length >= KEYSTROKE_FLUSH_SIZE) flushKeystrokes()
    }
    const onCopy = (e) => {
      e.preventDefault()
      keyBufferRef.current.push({ seq: ++keySeqRef.current, clientTs: Date.now(), key: 'copy', code: 'copy', mods: '', kind: 'clipboard', question: null, blocked: true, suspicious: true })
      flushKeystrokes()
    }
    const onCut = onCopy
    const onContext = (e) => {
      e.preventDefault()
      keyBufferRef.current.push({ seq: ++keySeqRef.current, clientTs: Date.now(), key: 'contextmenu', code: 'contextmenu', mods: '', kind: 'contextmenu', question: null, blocked: true, suspicious: true })
      flushKeystrokes()
    }
    window.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('copy', onCopy, true)
    document.addEventListener('cut', onCut, true)
    document.addEventListener('contextmenu', onContext, true)
    const flushTimer = setInterval(() => flushKeystrokes(), KEYSTROKE_FLUSH_MS)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('copy', onCopy, true)
      document.removeEventListener('cut', onCut, true)
      document.removeEventListener('contextmenu', onContext, true)
      clearInterval(flushTimer)
      flushKeystrokes()
    }
  }, [phase, flushKeystrokes])

  // Detecção de saída de tela cheia → pausa (mesmo fluxo do blur, com desbloqueio pelo professor).
  useEffect(() => {
    const onFsChange = () => {
      const active = !!document.fullscreenElement
      setIsFullscreen(active)
      if (!active && phase === 'active') {
        flushKeystrokes()
        api.post('/api/student/log-activity', { email, studentClass, courseId, examKey, applicationId, attemptId, eventType: 'fullscreen_exit', details: 'Saiu do modo tela cheia da prova' }).catch(() => {})
        setPhase('paused')
      }
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [phase, email, studentClass, courseId, examKey, applicationId, attemptId, flushKeystrokes])

  useEffect(() => {
    if (phase !== 'active') return
    const report = (eventType, details) => {
      api.post('/api/student/log-activity', { email, studentClass, courseId, examKey, applicationId, attemptId, eventType, details }).catch(() => {})
      setPhase('paused')
    }
    const onBlur = () => report('tab_blur', 'Janela perdeu o foco')
    const onVis = () => { if (document.hidden) report('tab_blur', 'Aba oculta') }
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [phase, email, studentClass, courseId, examKey, applicationId, attemptId])

  useEffect(() => {
    if (phase !== 'active') return
    const onBeforeUnload = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    const onPageHide = () => {
      flushKeystrokes(true)
      api.post('/api/student/autosave-progress', { email, studentClass, courseId, examKey, applicationId, attemptId, answers: answersRef.current }).catch(() => {})
      api.post('/api/student/log-activity', { email, studentClass, courseId, examKey, applicationId, attemptId, eventType: 'exam_left', details: 'Página da prova foi fechada ou recarregada' }).catch(() => {})
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [phase, email, studentClass, courseId, examKey, applicationId, attemptId])

  useEffect(() => {
    if (phase !== 'active') return
    const id = setInterval(() => {
      setSaveState((current) => ({ ...current, status: 'saving' }))
      api.post('/api/student/autosave-progress', { email, studentClass, courseId, examKey, applicationId, attemptId, answers: answersRef.current })
        .then(() => setSaveState({ status: 'saved', at: new Date() }))
        .catch(() => setSaveState((current) => ({ ...current, status: 'error' })))
    }, AUTOSAVE_MS)
    return () => clearInterval(id)
  }, [phase, email, studentClass, courseId, examKey, applicationId, attemptId])

  useEffect(() => {
    if (phase !== 'active' || remaining == null) return
    if (remaining <= 0) {
      if (timeoutHandledRef.current) return
      timeoutHandledRef.current = true
      submit(true)
      return
    }
    timeoutHandledRef.current = false
    const id = setInterval(() => setRemaining((r) => (r == null ? r : r - 1)), 1000)
    return () => clearInterval(id)
  }, [phase, remaining, submit])

  const sync = useCallback(async () => {
    try {
      const r = await api.get(`/api/student/sync?${qs(`&questionsVersion=${encodeURIComponent(questionsVersionRef.current)}`)}`)
      const c = (r.onlineExamConfigs || {})[examKey]
      if (!c) {
        setFatal('Esta prova não está mais disponível para sua turma.')
        setPhase('error')
        return
      }
      setCfg(c)
      setExamConfigVersion(r.examConfigVersion || null)
      if (r.attemptId) setAttemptId(r.attemptId)
      setExtraMinutes(Number(r.accessibilityExtraMinutes) || 0)
      if (r.examTitle) setExamTitle(r.examTitle)
      if (r.tokenAccepted === true) setTokenOk(true)

      const st = r.state || {}
      if (st.assignedVersion) setAssignedVersion(st.assignedVersion)
      if (st.answers && Object.keys(st.answers).length && Object.keys(answersRef.current).length === 0) setAnswers(st.answers)

      applyAttemptQuestions(r)

      if (Array.isArray(r.messages)) {
        const nextMessage = r.messages.find((m) => m && m.messageText)
        if (nextMessage && !instructorMessage) setInstructorMessage(nextMessage)
      }
      if (Array.isArray(r.questionReports)) {
        setReportedQuestions(new Set(r.questionReports.map((report) => Number(report.questionNumber)).filter(Number.isFinite)))
      }

      if (submittedRef.current) return
      if (['finished', 'cancelled'].includes(c.status)) {
        if (r.finishOutcome === 'submitted') {
          submittedRef.current = true
          setResult({ gradePublished: false, submittedByInstructor: true })
          setPhase('done')
        } else {
          setFatal(r.finishOutcome === 'discarded'
            ? 'A aplicação foi encerrada e o professor desconsiderou as tentativas que estavam em andamento.'
            : 'Esta aplicação foi encerrada pelo professor.')
          setPhase('error')
        }
        return
      }
      const resolvedMaxAttempts = Number(r.maxAttempts ?? c.maxAttempts)
      const attemptsUsed = Number(r.attemptsUsed || 0)
      if (Number.isInteger(resolvedMaxAttempts) && resolvedMaxAttempts >= 1 && attemptsUsed >= resolvedMaxAttempts) {
        setAttemptLimit(resolvedMaxAttempts)
        setRemaining(null)
        setWaitingRemaining(null)
        setPhase('exhausted')
        return
      }
      if (st.focusLocked === true) {
        setPhase('paused')
        return
      }
      if (c.status === 'paused') {
        setPhase('server_paused')
        return
      }
      if (c.requiresToken && !tokenOk && r.tokenAccepted !== true) {
        setWaitingRemaining(null)
        setPhase('token')
        return
      }
      const startsAt = Number(c.startTime)
      if (c.status === 'waiting' && startsAt > Date.now()) {
        setWaitingRemaining(Math.max(0, Math.ceil((startsAt - Date.now()) / 1000)))
        setPhase('waiting')
        return
      }
      if (!st.startedAt) {
        setWaitingRemaining(null)
        setPhase('instructions')
        return
      }

      setWaitingRemaining(null)
      if (Number.isFinite(Number(st.timerRemaining))) {
        setRemaining(Math.max(0, Number(st.timerRemaining)))
      } else {
        setRemaining(null)
      }
      setPhase((p) => (['paused', 'server_paused', 'loading', 'waiting', 'token', 'instructions'].includes(p) ? 'active' : p))
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        setFatal(e.message)
        setPhase('error')
      }
    }
    // eslint-disable-next-line
  }, [examKey, applicationId, tokenOk, instructorMessage])

  async function closeInstructorMessage() {
    const message = instructorMessage
    setInstructorMessage(null)
    if (message?.id) {
      await api.post('/api/student/acknowledge-message', { email, messageId: message.id }).catch(() => {})
      loadMessageHistory()
    }
  }

  async function loadMessageHistory() {
    if (!email || !studentClass) return
    try {
      const params = new URLSearchParams({ email, studentClass, courseId, examKey, applicationId })
      const r = await api.get(`/api/student/message-history?${params.toString()}`)
      setMessageHistory(r.messages || [])
    } catch {
      setMessageHistory([])
    }
  }

  async function openMessageHistory() {
    await loadMessageHistory()
    setHistoryOpen(true)
  }

  async function deleteMessageHistory(messageId = null) {
    try {
      await api.post('/api/student/message-history/delete', { email, messageId, studentClass, courseId, examKey, applicationId })
      toast.success(messageId ? 'Mensagem removida do histórico' : 'Histórico limpo')
      loadMessageHistory()
    } catch (e) {
      toast.error(e.message)
    }
  }

  useEffect(() => {
    sync()
    const id = setInterval(sync, SYNC_MS)
    return () => clearInterval(id)
  }, [sync])

  useEffect(() => {
    if (phase !== 'waiting' || waitingRemaining == null) return
    const id = setInterval(() => setWaitingRemaining((value) => value == null ? value : Math.max(0, value - 1)), 1000)
    return () => clearInterval(id)
  }, [phase, waitingRemaining == null])

  useEffect(() => {
    if (phase === 'waiting' && waitingRemaining === 0) sync()
  }, [phase, waitingRemaining, sync])

  async function validateToken() {
    try {
      const r = await api.post('/api/student/validate-exam-token', { email, studentClass, courseId, examKey, applicationId, attemptId, token: tokenInput })
      if (r.valid) {
        setTokenOk(true)
        if (r.attemptId) setAttemptId(r.attemptId)
        toast.success('Token válido')
        sync()
      } else {
        toast.error('Token incorreto')
      }
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function startAttempt() {
    if (!applicationId || !instructionsAccepted) return
    // Entra em tela cheia usando o gesto do clique (requisito do requestFullscreen).
    await enterFullscreen()
    try {
      const response = await api.post(`/api/student/exam-applications/${encodeURIComponent(applicationId)}/start-attempt`, {})
      setAttemptId(response.attemptId)
      setExamConfigVersion(response.examConfigVersion || examConfigVersion)
      if (response.state?.assignedVersion) setAssignedVersion(response.state.assignedVersion)
      if (Number.isFinite(Number(response.state?.timerRemaining))) setRemaining(Number(response.state.timerRemaining))
      applyAttemptQuestions(response)
      setPhase('active')
      toast.success('Tentativa iniciada')
    } catch (error) {
      toast.error(error.message)
    }
  }

  // Reentra em tela cheia por gesto do aluno após liberação do professor.
  async function resumeFullscreen() {
    const ok = await enterFullscreen()
    if (ok) sync()
  }

  async function leaveExam() {
    setExitConfirm(false)
    await api.post('/api/student/autosave-progress', { email, studentClass, courseId, examKey, applicationId, attemptId, answers: answersRef.current }).catch(() => {})
    await api.post('/api/student/log-activity', { email, studentClass, courseId, examKey, applicationId, attemptId, eventType: 'exam_left', details: 'Aluno saiu usando o botão da prova' }).catch(() => {})
    nav('/aluno/provas')
  }

  function openQuestionReport(question) {
    if (reportedQuestions.has(Number(question.number))) {
      toast.info('Você já reportou esta questão.')
      return
    }
    setReportForm({ reason: 'sem_resposta_correta', text: '' })
    setReportQuestion(question)
  }

  async function submitQuestionReport() {
    if (!reportQuestion) return
    setReportBusy(true)
    try {
      await api.post('/api/student/report-question', {
        applicationId,
        attemptId,
        questionNumber: reportQuestion.number,
        reason: reportForm.reason,
        text: reportForm.text,
      })
      setReportedQuestions((current) => new Set([...current, Number(reportQuestion.number)]))
      setReportQuestion(null)
      toast.success('O professor foi notificado.')
    } catch (error) {
      if (error.data?.alreadyReported) {
        setReportedQuestions((current) => new Set([...current, Number(reportQuestion.number)]))
        setReportQuestion(null)
        toast.info('Você já reportou esta questão.')
      } else {
        toast.error(error.message)
      }
    } finally {
      setReportBusy(false)
    }
  }

  const answeredCount = Object.keys(answers).length
  const instructorMessageOverlay = instructorMessage && (
    <div className="fixed inset-0 z-[10000] grid place-items-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface shadow-lg p-6 text-center">
        <div className="w-14 h-14 mx-auto grid place-items-center rounded-full bg-primary-soft text-primary mb-3"><AlertTriangle size={26} /></div>
        <h2 className="text-xl font-bold text-text">Mensagem do instrutor</h2>
        <p className="text-sm text-muted mt-3 whitespace-pre-wrap">{instructorMessage.messageText}</p>
        <Button className="mt-5" onClick={closeInstructorMessage}>Entendi</Button>
      </div>
    </div>
  )
  const messageHistoryButton = (
    <Button className="fixed bottom-4 left-4 z-[9000]" size="sm" variant="secondary" icon={History} onClick={openMessageHistory}>Mensagens</Button>
  )
  const messageHistoryModal = (
    <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="Histórico de mensagens" description={examTitle || examKey.replace(/_/g, ' ')}>
      <div className="space-y-3">
        <div className="flex justify-end">
          <Button size="sm" variant="secondary" icon={Trash2} onClick={() => deleteMessageHistory(null)} disabled={messageHistory.length === 0}>Limpar histórico</Button>
        </div>
        <div className="space-y-2 max-h-[420px] overflow-auto">
          {messageHistory.map((m) => (
            <div key={m.id} className="rounded-lg border border-border p-3">
              <p className="text-sm text-text whitespace-pre-wrap">{m.messageText}</p>
              <p className="text-xs text-subtle mt-1">{m.createdAt ? new Date(m.createdAt).toLocaleString('pt-BR') : new Date(Number(m.timestamp || Date.now())).toLocaleString('pt-BR')}</p>
              <div className="mt-2 flex justify-end">
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => deleteMessageHistory(m.id)}>Excluir</Button>
              </div>
            </div>
          ))}
          {messageHistory.length === 0 && <p className="text-sm text-muted text-center py-6">Nenhuma mensagem no histórico.</p>}
        </div>
      </div>
    </Modal>
  )
  const withInstructorMessage = (content) => <>{content}{messageHistoryButton}{messageHistoryModal}{instructorMessageOverlay}</>

  if (phase === 'loading') return withInstructorMessage(
    <Center>
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
      <p className="text-muted mt-3">Carregando prova...</p>
    </Center>
  )

  if (phase === 'error') return withInstructorMessage(
    <Center>
      <div className="w-14 h-14 grid place-items-center rounded-full bg-danger-soft text-danger mb-3"><AlertTriangle size={26} /></div>
      <h2 className="text-lg font-semibold text-text">Não foi possível abrir a prova</h2>
      <p className="text-sm text-muted mt-1 max-w-sm text-center">{fatal}</p>
      <Button className="mt-4" variant="secondary" icon={ArrowLeft} onClick={() => nav('/aluno/provas')}>Voltar</Button>
    </Center>
  )

  if (phase === 'exhausted') return withInstructorMessage(
    <Center>
      <div className="w-14 h-14 grid place-items-center rounded-full bg-warning-soft text-warning mb-3"><ShieldAlert size={26} /></div>
      <h2 className="text-lg font-semibold text-text">Tentativas esgotadas</h2>
      <p className="text-sm text-muted mt-1 max-w-sm text-center">Você já usou todas as {attemptLimit || cfg?.maxAttempts} tentativas desta prova. Procure o professor se acredita que houve um engano.</p>
      <Button className="mt-4" variant="secondary" icon={ArrowLeft} onClick={() => nav('/aluno/provas')}>Voltar às provas</Button>
    </Center>
  )

  if (phase === 'done') return withInstructorMessage(
    <Center>
      <div className="w-16 h-16 grid place-items-center rounded-full bg-success-soft text-success mb-3"><CheckCircle2 size={32} /></div>
      <h2 className="text-xl font-bold text-text">{result?.submittedByInstructor ? 'Respostas salvas e entregues' : 'Prova enviada!'}</h2>
      {result?.gradePublished === true
        ? <p className="text-4xl font-bold text-text tabular-nums mt-3">{fmtGrade(result.score)}</p>
        : <p className="text-sm text-muted mt-3">{result?.submittedByInstructor ? 'O professor encerrou a aplicação e salvou o que você havia respondido.' : 'Sua nota será exibida depois da publicação pelo professor.'}</p>}
      <Button className="mt-5" onClick={() => nav('/aluno')}>Voltar ao início</Button>
    </Center>
  )

  if (phase === 'token') return withInstructorMessage(
    <Center>
      <div className="w-14 h-14 grid place-items-center rounded-full bg-primary-soft text-primary mb-3"><LockKeyhole size={26} /></div>
      <h2 className="text-lg font-semibold text-text">Token de acesso</h2>
      <p className="text-sm text-muted mt-1 mb-4 text-center max-w-xs">Digite o token informado pelo instrutor para entrar na prova.</p>
      <div className="flex gap-2">
        <Input id="tok" value={tokenInput} maxLength={5} autoComplete="off" spellCheck={false} onChange={(e) => setTokenInput(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5))} placeholder="ABCDE" className="font-mono w-40 text-center tracking-[0.2em]" />
        <Button onClick={validateToken} disabled={tokenInput.length !== 5}>Validar</Button>
      </div>
      <Button className="mt-6" variant="ghost" icon={ArrowLeft} onClick={() => nav('/aluno/provas')}>Voltar às provas</Button>
    </Center>
  )

  if (phase === 'instructions') return withInstructorMessage(
    <Center>
      <Card className="w-full max-w-xl p-6">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 grid place-items-center rounded-full bg-primary-soft text-primary shrink-0"><ShieldAlert size={24} /></div>
          <div>
            <h2 className="text-xl font-bold text-text">Instruções da prova</h2>
            {examTitle && <p className="mt-0.5 text-sm font-medium text-text">{examTitle}</p>}
            <p className="text-sm text-muted mt-1">Leia antes de iniciar. O cronômetro só começa depois da sua confirmação.</p>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-lg border border-border p-3"><p className="text-xs text-subtle">Duração</p><p className="font-semibold text-text">{cfg?.durationMinutes || '-'} min</p>{extraMinutes > 0 && <p className="text-xs font-medium text-success">+{extraMinutes} min de tempo adicional</p>}</div>
          <div className="rounded-lg border border-border p-3"><p className="text-xs text-subtle">Cronômetro</p><p className="font-semibold text-text">{cfg?.timerMode === 'per_attempt' ? 'Ao iniciar' : 'Coletivo'}</p></div>
          <div className="rounded-lg border border-border p-3"><p className="text-xs text-subtle">Tentativas</p><p className="font-semibold text-text">{cfg?.maxAttempts || 'Sem limite'}</p></div>
        </div>
        <ul className="mt-5 space-y-2 text-sm text-muted list-disc pl-5">
          <li>Suas respostas são salvas automaticamente durante a prova.</li>
          <li>A prova roda em <strong>tela cheia</strong>. Sair da tela cheia, da aba ou da janela é registrado e bloqueia a prova até a liberação do professor.</li>
          <li>Durante a prova, os atalhos de teclado e a digitação são monitorados para garantir a integridade da avaliação.</li>
          <li>Se você sair, poderá retornar à mesma tentativa enquanto houver tempo e a aplicação estiver aberta.</li>
          <li>Revise as respostas antes de confirmar o envio final.</li>
        </ul>
        <label className="mt-5 flex items-start gap-3 rounded-lg border border-border p-3 text-sm text-text cursor-pointer">
          <input type="checkbox" className="mt-0.5" checked={instructionsAccepted} onChange={(event) => setInstructionsAccepted(event.target.checked)} />
          <span>Li as instruções e estou pronto para iniciar esta tentativa.</span>
        </label>
        <div className="mt-5 flex justify-between gap-3">
          <Button variant="ghost" icon={ArrowLeft} onClick={() => nav('/aluno/provas')}>Voltar</Button>
          <Button icon={Play} disabled={!instructionsAccepted} onClick={startAttempt}>Iniciar prova</Button>
        </div>
      </Card>
    </Center>
  )

  if (phase === 'waiting') return withInstructorMessage(
    <Center>
      <div className="w-14 h-14 grid place-items-center rounded-full bg-info-soft text-info mb-3"><Clock size={26} /></div>
      <h2 className="text-lg font-semibold text-text">Sala de espera</h2>
      <p className="text-sm text-muted mt-1 text-center max-w-sm">A prova será liberada automaticamente quando o tempo terminar.</p>
      {waitingRemaining != null ? (
        <div className="mt-5 text-center" aria-live="polite">
          <p className="font-mono text-5xl font-bold tabular-nums text-text">{fmtTime(waitingRemaining)}</p>
          <p className="mt-2 text-xs uppercase tracking-wider text-subtle">tempo para liberação</p>
        </div>
      ) : (
        <Badge tone="info" className="mt-4">Aguardando o instrutor</Badge>
      )}
      <Button className="mt-6" variant="ghost" icon={ArrowLeft} onClick={() => nav('/aluno/provas')}>Sair da sala</Button>
    </Center>
  )

  if (phase === 'server_paused') return withInstructorMessage(
    <Center>
      <div className="w-14 h-14 grid place-items-center rounded-full bg-warning-soft text-warning mb-3"><Clock size={26} /></div>
      <h2 className="text-lg font-semibold text-text">Aplicação pausada pelo professor</h2>
      <p className="text-sm text-muted mt-2 text-center max-w-sm">Suas respostas continuam salvas. Aguarde o professor retomar a aplicação.</p>
      <div className="mt-4 flex items-center gap-2 text-warning"><Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">Aguardando retomada...</span></div>
      <Button className="mt-6" variant="secondary" icon={ArrowLeft} onClick={() => nav('/aluno/provas')}>Sair e voltar depois</Button>
    </Center>
  )

  if (phase === 'paused') return withInstructorMessage(
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-bg/95 backdrop-blur-sm p-4">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 grid place-items-center rounded-full bg-danger-soft text-danger mb-4 mx-auto"><ShieldAlert size={32} /></div>
        <h2 className="text-xl font-bold text-text">Prova pausada</h2>
        <p className="text-sm text-muted mt-2">Detectamos que você saiu da tela cheia, da aba ou da janela da prova. Por segurança, a prova foi pausada e o instrutor foi notificado.</p>
        <p className="text-sm text-muted mt-2">Aguarde a liberação do instrutor para continuar. Suas respostas foram salvas.</p>
        <div className="mt-4 flex items-center justify-center gap-2 text-warning"><Loader2 className="w-4 h-4 animate-spin" /> <span className="text-sm">Aguardando liberação...</span></div>
        <Button className="mt-6" variant="secondary" icon={ArrowLeft} onClick={() => nav('/aluno/provas')}>Sair e voltar às provas</Button>
      </div>
    </div>
  )

  if (phase === 'active' && !isFullscreen) return withInstructorMessage(
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-bg/95 backdrop-blur-sm p-4">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 grid place-items-center rounded-full bg-warning-soft text-warning mb-4 mx-auto"><ShieldAlert size={32} /></div>
        <h2 className="text-xl font-bold text-text">Tela cheia obrigatória</h2>
        <p className="text-sm text-muted mt-2">Esta prova roda em modo tela cheia por segurança. As questões só aparecem enquanto você estiver em tela cheia.</p>
        <Button className="mt-6" icon={Play} onClick={resumeFullscreen}>Voltar à tela cheia</Button>
        <div className="mt-4"><Button variant="ghost" icon={ArrowLeft} onClick={() => setExitConfirm(true)}>Sair da prova</Button></div>
      </div>
      <ConfirmDialog
        open={exitConfirm}
        onClose={() => setExitConfirm(false)}
        onConfirm={leaveExam}
        title="Sair da prova agora?"
        description="Suas respostas serão salvas e você poderá voltar à mesma tentativa enquanto a aplicação estiver aberta e ainda houver tempo."
        confirmLabel="Salvar e sair"
      />
    </div>
  )

  return (
    <div className="max-w-3xl mx-auto">
      {instructorMessageOverlay}
      {messageHistoryModal}
      <ConfirmDialog
        open={submitConfirm}
        onClose={() => setSubmitConfirm(false)}
        onConfirm={() => submit(false)}
        title="Enviar a prova?"
        description={`Você respondeu ${answeredCount} de ${questions.length} questões. Depois do envio esta tentativa será encerrada.`}
        confirmLabel="Enviar prova"
      />
      <ConfirmDialog
        open={exitConfirm}
        onClose={() => setExitConfirm(false)}
        onConfirm={leaveExam}
        title="Sair da prova agora?"
        description="Suas respostas serão salvas e você poderá voltar à mesma tentativa enquanto a aplicação estiver aberta e ainda houver tempo."
        confirmLabel="Salvar e sair"
      />
      <Modal
        open={!!reportQuestion}
        onClose={() => !reportBusy && setReportQuestion(null)}
        title={`Reportar problema na questão ${reportQuestion?.number || ''}`}
        description="A contestação aparecerá imediatamente no monitor do professor."
        footer={<>
          <Button variant="ghost" onClick={() => setReportQuestion(null)} disabled={reportBusy}>Cancelar</Button>
          <Button icon={Send} onClick={submitQuestionReport} loading={reportBusy}>Enviar para o professor</Button>
        </>}
      >
        <div className="space-y-4">
          <Select label="Qual é o problema?" value={reportForm.reason} onChange={(event) => setReportForm((current) => ({ ...current, reason: event.target.value }))}>
            <option value="sem_resposta_correta">Nenhuma resposta parece correta</option>
            <option value="duas_corretas">Há mais de uma resposta correta</option>
            <option value="enunciado_confuso">Enunciado confuso</option>
            <option value="erro_digitacao">Erro de digitação</option>
            <option value="outro">Outro</option>
          </Select>
          <Textarea
            label="Detalhe (opcional)"
            value={reportForm.text}
            maxLength={300}
            rows={4}
            onChange={(event) => setReportForm((current) => ({ ...current, text: event.target.value }))}
          />
          <p className="-mt-3 text-xs text-subtle">{reportForm.text.length}/300 caracteres</p>
        </div>
      </Modal>
      <div className="sticky top-0 z-10 -mx-4 md:-mx-6 px-4 md:px-6 py-3 bg-surface/95 backdrop-blur border-b border-border flex items-center gap-3">
        <div>
          <h1 className="text-base font-bold text-text">{examTitle || examKey.replace(/_/g, ' ')}</h1>
          <p className="text-xs text-subtle">{answeredCount}/{questions.length} respondidas</p>
          <p className={`text-[11px] ${saveState.status === 'error' ? 'text-danger' : 'text-subtle'}`} aria-live="polite">
            {saveState.status === 'saving' && 'Salvando respostas...'}
            {saveState.status === 'saved' && `Salvo às ${saveState.at?.toLocaleTimeString('pt-BR')}`}
            {saveState.status === 'error' && 'Falha no último salvamento'}
          </p>
        </div>
        <div className="flex-1" />
        {remaining != null && (
          <div className={`flex items-center gap-1.5 font-mono font-bold ${remaining < 60 ? 'text-danger' : 'text-text'}`}><Clock size={16} /> {fmtTime(remaining)}</div>
        )}
        <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => setExitConfirm(true)}>Sair</Button>
        <Button size="sm" variant="secondary" icon={History} onClick={openMessageHistory}>Mensagens</Button>
        <Button size="sm" icon={Send} loading={submitting} onClick={() => setSubmitConfirm(true)}>Enviar</Button>
      </div>

      <div className="py-5 space-y-4">
        {questions.map((q, i) => (
          <Card key={q.number} className={`p-5 ${(cfg?.annulledQuestions || []).some((item) => Number(item.questionNumber) === Number(q.number)) ? 'border-warning/60 bg-warning-soft/10' : ''}`}>
            <div className="flex items-start gap-2 mb-3">
              <span className="w-7 h-7 shrink-0 grid place-items-center rounded-md bg-primary-soft text-primary text-sm font-bold">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  {q.isAdditional && <Badge tone="info">Questão adicional</Badge>}
                  {(cfg?.annulledQuestions || []).some((item) => Number(item.questionNumber) === Number(q.number)) && <Badge tone="warning">Questão anulada</Badge>}
                </div>
                <p className="text-text font-medium">{q.text}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                icon={AlertTriangle}
                className={reportedQuestions.has(Number(q.number)) ? 'text-warning' : 'text-subtle'}
                aria-label="Reportar problema nesta questão"
                title={reportedQuestions.has(Number(q.number)) ? 'Problema reportado' : 'Reportar problema'}
                onClick={() => openQuestionReport(q)}
              >
                {reportedQuestions.has(Number(q.number)) ? 'Reportada' : 'Reportar'}
              </Button>
            </div>
            <div className="space-y-2 pl-9">
              {q.alternatives.map((alt) => {
                const sel = answers[q.number] === alt.letter
                return (
                  <button
                    key={alt.letter}
                    disabled={(cfg?.annulledQuestions || []).some((item) => Number(item.questionNumber) === Number(q.number))}
                    onClick={() => setAnswers((a) => ({ ...a, [q.number]: alt.letter }))}
                    className={`w-full text-left flex items-center gap-3 p-3 rounded-lg border transition disabled:cursor-not-allowed disabled:opacity-60 ${sel ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-2'}`}
                  >
                    <span className={`w-6 h-6 shrink-0 grid place-items-center rounded-full text-xs font-bold ${sel ? 'bg-primary text-primary-fg' : 'bg-surface-2 text-muted'}`}>{alt.letter}</span>
                    <span className="text-sm text-text">{alt.text}</span>
                  </button>
                )
              })}
            </div>
          </Card>
        ))}
        {questions.length === 0 && <Card className="p-8 text-center text-muted">As questões aparecerão quando a prova iniciar.</Card>}
      </div>

      <div className="pb-8 flex justify-end">
        <Button icon={Send} loading={submitting} onClick={() => setSubmitConfirm(true)}>Enviar prova ({answeredCount}/{questions.length})</Button>
      </div>
    </div>
  )
}

function Center({ children }) {
  return <div className="min-h-[70vh] flex flex-col items-center justify-center">{children}</div>
}
