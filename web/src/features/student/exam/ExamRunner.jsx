import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams, useBlocker } from 'react-router-dom'
import { ShieldAlert, Clock, LockKeyhole, CheckCircle2, ArrowLeft, Send, AlertTriangle, Loader2, History, Trash2, Play, Info } from 'lucide-react'
import { Card } from '../../../components/ui/Card'
import { Button } from '../../../components/ui/Button'
import { Input } from '../../../components/ui/Input'
import { Select } from '../../../components/ui/Select'
import { Textarea } from '../../../components/ui/Textarea'
import { Badge } from '../../../components/ui/Badge'
import { ConfirmDialog, Modal } from '../../../components/ui/Modal'
import { api, hasActiveSession } from '../../../lib/api'
import { useStudent } from '../useStudent'
import { useToast } from '../../../context/ToastProvider'
import { pickSnapshot, normQuestion, fmtTime, fullscreenElement, fullscreenSupported } from './examUtils'
import { autoSubmitRetryDelay, classifyAutoSubmitError, countAnswered, wait } from './examAutoSubmit'
import {
  clearExamDraft,
  clearExamDraftsForApplication,
  clearOtherExamDrafts,
  findExamDraftAttempt,
  importExamDraftKey,
  readExamDraft,
  sameExamAnswers,
  writeExamDraft,
} from '../../../lib/examDrafts'

// A cada sincronização (4 s) as respostas que mudaram desde o último salvamento vão
// junto para o servidor: encerrar a aplicação ou perder a rede custa poucos segundos.
const SYNC_MS = 4000
const KEYSTROKE_FLUSH_MS = 2000
const KEYSTROKE_FLUSH_SIZE = 20
// Identificador opaco da alternativa (AVA-05); uma letra avulsa vem de páginas antigas.
const ANSWER_ID_PATTERN = /^[0-9A-Z]{13}$/

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
  const [leavingBusy, setLeavingBusy] = useState(false)
  const [reportedQuestions, setReportedQuestions] = useState(() => new Set())
  const [reportQuestion, setReportQuestion] = useState(null)
  const [reportForm, setReportForm] = useState({ reason: 'sem_resposta_correta', text: '' })
  const [reportBusy, setReportBusy] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(() => !!fullscreenElement())
  // Aparelho sem tela cheia para a página (iPhone): a prova abre sem exigir tela cheia,
  // com aviso ao aluno e registro no Monitor (UXA-02). Foco e aba seguem monitorados.
  const [noFullscreen] = useState(() => !fullscreenSupported())
  const [timeupInfo, setTimeupInfo] = useState(null)
  const answersRef = useRef(answers)
  const submittedRef = useRef(false)
  const keyBufferRef = useRef([])
  const keySeqRef = useRef(0)
  const phaseRef = useRef(phase)
  const attemptIdRef = useRef(attemptId)
  const examConfigVersionRef = useRef(examConfigVersion)
  const lastSavedRef = useRef(null) // respostas que o servidor já confirmou
  const savingRef = useRef(false)
  const loadedAttemptRef = useRef(null)
  const timeupRef = useRef(null) // respostas congeladas no fim do tempo, até a entrega
  const mountedRef = useRef(true)
  const saveRef = useRef(null)
  const startTimeUpRef = useRef(null)
  // Cópia local cifrada (AVA-11): a chave da tentativa fica só em memória.
  const draftCryptoRef = useRef(null) // { attemptId, rawKey, cryptoKey }
  const draftReadyRef = useRef(null) // tentativa cuja cópia anterior já foi lida
  const leavingRef = useRef(false) // saída confirmada pelo aluno: a navegação segue
  const blockedActionRef = useRef(null) // POP (voltar do navegador) ou PUSH/REPLACE (link)
  const unsupportedLoggedRef = useRef(null) // tentativa já registrada como sem tela cheia
  answersRef.current = answers
  phaseRef.current = phase
  attemptIdRef.current = attemptId
  examConfigVersionRef.current = examConfigVersion
  // Dados do registro de saída feito na desmontagem (sem acesso ao render seguinte).
  const exitContextRef = useRef(null)
  exitContextRef.current = { email, studentClass, courseId, examKey, applicationId }

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Chave da cópia local da tentativa: importada uma vez e mantida só em memória.
  const ensureDraftKey = useCallback(async (forAttemptId, rawKey) => {
    const current = draftCryptoRef.current
    if (current && current.attemptId === forAttemptId && (!rawKey || current.rawKey === rawKey)) return current.cryptoKey
    if (!forAttemptId || !rawKey) return null
    const cryptoKey = await importExamDraftKey(rawKey)
    draftCryptoRef.current = cryptoKey ? { attemptId: forAttemptId, rawKey, cryptoKey } : null
    return cryptoKey
  }, [])

  // Grava a cópia cifrada da tentativa (sem chave ou sem WebCrypto, não grava nada).
  const saveLocalCopy = useCallback((forAttemptId, answersToSave, saved) => {
    const current = draftCryptoRef.current
    if (!forAttemptId || !current || current.attemptId !== forAttemptId) return
    if (draftReadyRef.current !== forAttemptId) return // a cópia anterior ainda não foi lida
    writeExamDraft({ attemptId: forAttemptId, applicationId, cryptoKey: current.cryptoKey, answers: answersToSave, saved }).catch(() => {})
  }, [applicationId])

  // Primeira leitura de uma tentativa (abertura, recarga ou início): as respostas do
  // servidor mais o que só a cópia local tinha, que vai no próximo salvamento. As cópias
  // de outras tentativas ou alunos neste aparelho são apagadas.
  const loadAttemptAnswers = useCallback(async (forAttemptId, rawKey, serverAnswers) => {
    loadedAttemptRef.current = forAttemptId
    lastSavedRef.current = serverAnswers
    const cryptoKey = await ensureDraftKey(forAttemptId, rawKey)
    const draft = cryptoKey ? await readExamDraft({ attemptId: forAttemptId, cryptoKey }) : null
    clearOtherExamDrafts(forAttemptId)
    draftReadyRef.current = forAttemptId
    if (!mountedRef.current || loadedAttemptRef.current !== forAttemptId) return
    const restored = draft && draft.saved === false ? { ...serverAnswers, ...draft.answers } : serverAnswers
    setAnswers((current) => ({ ...restored, ...current }))
  }, [ensureDraftKey])

  // Entrega confirmada (pelo aluno, pelo fim do tempo, pelo servidor ou pelo professor).
  const finishDelivered = useCallback((delivered) => {
    const deliveredAttemptId = timeupRef.current?.attemptId || attemptIdRef.current
    timeupRef.current = null
    submittedRef.current = true
    if (deliveredAttemptId) clearExamDraft(deliveredAttemptId)
    clearExamDraftsForApplication(applicationId)
    draftCryptoRef.current = null
    draftReadyRef.current = null
    setResult(delivered)
    setSubmitConfirm(false)
    setTimeupInfo(null)
    setPhase('done')
  }, [applicationId])

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
      finishDelivered({ ...r, auto })
      if (auto) toast.info('Tempo esgotado - prova enviada automaticamente.')
      else toast.success('Prova enviada!')
    } catch (e) {
      submittedRef.current = false
      if (e.status === 403 && e.data?.attemptsExhausted) {
        setAttemptLimit(Number(e.data.maxAttempts) || null)
        setPhase('exhausted')
      } else if (e.status === 408 && e.data?.finalizedByServer) {
        finishDelivered({ finalizedByServer: true, answeredCount: e.data.answeredCount, gradePublished: false })
      } else {
        toast.error(e.message || 'Falha ao enviar a prova')
      }
    } finally {
      setSubmitting(false)
    }
    // eslint-disable-next-line
  }, [email, studentClass, courseId, examKey, applicationId, attemptId, examConfigVersion, toast, finishDelivered])

  // Salva as respostas que mudaram desde o último salvamento confirmado. keepalive:
  // usado ao sair/recarregar/esconder a aba, a requisição sobrevive à página.
  const saveAnswersIfDirty = useCallback(async ({ keepalive = false } = {}) => {
    const currentAttemptId = attemptIdRef.current
    if (!currentAttemptId || timeupRef.current || submittedRef.current) return
    if (!['active', 'paused', 'server_paused'].includes(phaseRef.current)) return
    const snapshot = answersRef.current
    if (lastSavedRef.current ? sameExamAnswers(lastSavedRef.current, snapshot) : countAnswered(snapshot) === 0) return
    if (savingRef.current && !keepalive) return
    savingRef.current = true
    if (!keepalive) setSaveState((current) => ({ ...current, status: 'saving' }))
    try {
      await api.post('/api/student/autosave-progress', { email, studentClass, courseId, examKey, applicationId, attemptId: currentAttemptId, answers: snapshot }, keepalive ? { keepalive: true } : undefined)
      lastSavedRef.current = snapshot
      saveLocalCopy(currentAttemptId, answersRef.current, sameExamAnswers(snapshot, answersRef.current))
      if (!keepalive) setSaveState({ status: 'saved', at: new Date() })
    } catch (e) {
      if (!keepalive) setSaveState((current) => ({ ...current, status: 'error' }))
      // O servidor já considera o tempo esgotado: entrega o que está na tela agora.
      if (e.status === 408 && phaseRef.current === 'active') startTimeUpRef.current?.()
    } finally {
      savingRef.current = false
    }
  }, [email, studentClass, courseId, examKey, applicationId, saveLocalCopy])
  saveRef.current = saveAnswersIfDirty

  // Fim do tempo: congela as respostas no zero e envia até o servidor confirmar.
  const runAutoSubmit = useCallback(async () => {
    let retry = 0
    while (mountedRef.current && timeupRef.current) {
      const frozen = timeupRef.current
      try {
        const r = await api.post('/api/student/submit', {
          email,
          studentClass,
          courseId,
          examKey,
          applicationId,
          attemptId: frozen.attemptId,
          answers: frozen.answers,
          examConfigVersion: frozen.examConfigVersion,
          auto: true,
        })
        if (!mountedRef.current) return
        finishDelivered({ ...r, auto: true, answeredCount: r?.answeredCount ?? countAnswered(frozen.answers) })
        toast.info('Tempo esgotado - prova enviada automaticamente.')
        return
      } catch (e) {
        if (!mountedRef.current) return
        const kind = classifyAutoSubmitError(e)
        if (kind === 'retry') {
          const delay = autoSubmitRetryDelay(retry)
          retry += 1
          setTimeupInfo({ retrying: true, attempt: retry, nextRetryMs: delay })
          await wait(delay)
          continue
        }
        if (kind === 'finalized') {
          finishDelivered({ finalizedByServer: true, answeredCount: e.data?.answeredCount, gradePublished: false })
          return
        }
        if (kind === 'locked' || kind === 'paused') {
          timeupRef.current = null
          submittedRef.current = false
          setTimeupInfo(null)
          setPhase(kind === 'locked' ? 'paused' : 'server_paused')
          return
        }
        // Erro definitivo: não insiste. O servidor entrega as respostas salvas no fim
        // da tolerância e a próxima sincronização mostra a entrega.
        timeupRef.current = { ...frozen, failed: true }
        setTimeupInfo({ failed: true, message: e.message || 'Falha ao enviar a prova.' })
        return
      }
    }
  }, [email, studentClass, courseId, examKey, applicationId, finishDelivered, toast])

  const startTimeUp = useCallback((override = {}) => {
    if (timeupRef.current || submittedRef.current) return
    const frozen = {
      attemptId: override.attemptId || attemptIdRef.current,
      answers: { ...(override.answers || answersRef.current) },
      examConfigVersion: override.examConfigVersion ?? examConfigVersionRef.current,
    }
    if (!frozen.attemptId) return
    timeupRef.current = frozen
    submittedRef.current = true
    saveLocalCopy(frozen.attemptId, frozen.answers, false)
    setTimeupInfo({ retrying: false, attempt: 0 })
    setPhase('timeup')
    runAutoSubmit()
  }, [saveLocalCopy, runAutoSubmit])
  startTimeUpRef.current = startTimeUp

  const flushKeystrokes = useCallback((useBeacon = false) => {
    const events = keyBufferRef.current
    if (!events.length) return
    keyBufferRef.current = []
    const payload = { email, studentClass, courseId, examKey, applicationId, attemptId, events }
    if (useBeacon) {
      // Saída da página: fetch com keepalive leva o token de sessão (o sendBeacon não
      // levava e o servidor recusava com 401).
      api.post('/api/student/log-keystrokes', payload, { keepalive: true }).catch(() => {})
      return
    }
    api.post('/api/student/log-keystrokes', payload).catch(() => {
      // Reenvia no próximo flush se falhar (não perde a cauda).
      keyBufferRef.current = events.concat(keyBufferRef.current)
    })
  }, [email, studentClass, courseId, examKey, applicationId, attemptId])

  // Pede a tela cheia e diz se a página ficou em tela cheia. Sem a API (iPhone) ou com a
  // tela cheia proibida, retorna false: antes retornava true sem nada acontecer (UXA-02).
  const enterFullscreen = useCallback(async () => {
    if (fullscreenElement()) return true
    if (!fullscreenSupported()) return false
    try {
      const el = document.documentElement
      if (typeof el.requestFullscreen === 'function') await el.requestFullscreen()
      else await el.webkitRequestFullscreen()
    } catch (err) {
      return false
    }
    return !!fullscreenElement()
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
      const active = !!fullscreenElement()
      setIsFullscreen(active)
      if (!active && phase === 'active') {
        flushKeystrokes()
        api.post('/api/student/log-activity', { email, studentClass, courseId, examKey, applicationId, attemptId, eventType: 'fullscreen_exit', details: 'Saiu do modo tela cheia da prova' }).catch(() => {})
        setPhase('paused')
      }
    }
    // O Safari do iPad antigo só emite o evento com prefixo.
    document.addEventListener('fullscreenchange', onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      document.removeEventListener('webkitfullscreenchange', onFsChange)
    }
  }, [phase, email, studentClass, courseId, examKey, applicationId, attemptId, flushKeystrokes])

  // Aparelho sem tela cheia: registra uma vez por tentativa para o professor (Monitor).
  // Não pausa a prova; perder o foco ou esconder a aba continua pausando.
  useEffect(() => {
    if (!noFullscreen || phase !== 'active' || !attemptId) return
    if (unsupportedLoggedRef.current === attemptId) return
    unsupportedLoggedRef.current = attemptId
    api.post('/api/student/log-activity', { email, studentClass, courseId, examKey, applicationId, attemptId, eventType: 'fullscreen_unsupported', details: 'Dispositivo sem tela cheia: a prova seguiu sem ela' }).catch(() => {})
  }, [noFullscreen, phase, email, studentClass, courseId, examKey, applicationId, attemptId])

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
      api.post('/api/student/log-activity', { email, studentClass, courseId, examKey, applicationId, attemptId, eventType: 'exam_left', details: 'Página da prova foi fechada ou recarregada' }, { keepalive: true }).catch(() => {})
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [phase, email, studentClass, courseId, examKey, applicationId, attemptId])

  // Ao sair, recarregar ou esconder a aba, as respostas pendentes vão com keepalive.
  useEffect(() => {
    if (!['active', 'paused', 'server_paused'].includes(phase)) return
    const flush = () => {
      flushKeystrokes(true)
      saveRef.current?.({ keepalive: true })
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [phase, flushKeystrokes])

  // Cópia local cifrada das respostas (sobrevive à queda da rede e à recarga da página).
  useEffect(() => {
    if (phase !== 'active' || !attemptId || timeupRef.current) return
    saveLocalCopy(attemptId, answers, !!lastSavedRef.current && sameExamAnswers(lastSavedRef.current, answers))
  }, [answers, attemptId, phase, saveLocalCopy])

  useEffect(() => {
    if (phase !== 'active' || remaining == null) return
    if (remaining <= 0) {
      startTimeUp()
      return
    }
    const id = setInterval(() => setRemaining((r) => (r == null ? r : r - 1)), 1000)
    return () => clearInterval(id)
  }, [phase, remaining, startTimeUp])

  const sync = useCallback(async () => {
    try {
      await saveRef.current?.()
      const knownAttemptId = timeupRef.current?.attemptId || attemptIdRef.current || findExamDraftAttempt(applicationId) || ''
      const r = await api.get(`/api/student/sync?${qs(`&attemptId=${encodeURIComponent(knownAttemptId)}`)}`)
      const c = (r.onlineExamConfigs || {})[examKey]
      if (!c) {
        setFatal('Esta prova não está mais disponível para sua turma.')
        setPhase('error')
        return
      }
      setCfg(c)
      setExamConfigVersion(r.examConfigVersion || null)
      setExtraMinutes(Number(r.accessibilityExtraMinutes) || 0)
      if (r.examTitle) setExamTitle(r.examTitle)
      if (r.tokenAccepted === true) setTokenOk(true)

      // A tentativa que este navegador conhece já virou entrega (fim do tempo no
      // servidor, professor ou outra aba). Se esta página tem respostas que o servidor
      // não tinha, elas ainda vão como envio automático dentro da tolerância. Depois de
      // recarregar, a cópia local de uma tentativa finalizada não é mais legível (a
      // chave sumiu com ela) e é apagada.
      const outcome = r.attemptOutcome
      if (outcome && knownAttemptId && outcome.attemptId === knownAttemptId && phaseRef.current !== 'done') {
        if (timeupRef.current && !timeupRef.current.failed) return
        const unsaved = loadedAttemptRef.current === outcome.attemptId
          && !!lastSavedRef.current
          && !sameExamAnswers(lastSavedRef.current, answersRef.current)
        if (outcome.finalizedByServer && unsaved && !timeupRef.current) {
          startTimeUpRef.current?.({ attemptId: outcome.attemptId, answers: answersRef.current })
          return
        }
        finishDelivered({
          gradePublished: false,
          finalizedByServer: outcome.finalizedByServer === true,
          submittedByInstructor: outcome.source === 'instructor_finish',
          answeredCount: outcome.answeredCount,
          lateBySeconds: outcome.lateBySeconds,
        })
        return
      }
      if (r.attemptId && !timeupRef.current) setAttemptId(r.attemptId)

      const st = r.state || {}
      if (st.assignedVersion) setAssignedVersion(st.assignedVersion)
      const stateAttemptId = r.attemptId || st.attemptId || null
      if (st.startedAt && stateAttemptId && !timeupRef.current) {
        const serverAnswers = st.answers || {}
        if (loadedAttemptRef.current !== stateAttemptId) {
          await loadAttemptAnswers(stateAttemptId, r.localCopyKey, serverAnswers)
        } else {
          // Letra avulsa de uma cópia ou página antiga já confirmada pelo servidor: troca
          // pelo identificador que o servidor devolveu, para a alternativa ficar marcada.
          const confirmed = lastSavedRef.current || {}
          const legacy = Object.entries(answersRef.current)
            .filter(([number, value]) => !ANSWER_ID_PATTERN.test(String(value)) && confirmed[number] === value && serverAnswers[number])
          if (legacy.length) {
            setAnswers((current) => {
              const next = { ...current }
              legacy.forEach(([number, value]) => { if (next[number] === value) next[number] = serverAnswers[number] })
              return next
            })
          }
          lastSavedRef.current = serverAnswers
        }
      } else if (!st.startedAt && !timeupRef.current) {
        // Nenhuma tentativa em andamento nesta aplicação: cópia guardada aqui é velha.
        clearExamDraftsForApplication(applicationId)
      }

      const snap = pickSnapshot(c, st.assignedVersion)
      if (snap && Array.isArray(snap.questions)) setQuestions(snap.questions.map(normQuestion))

      if (Array.isArray(r.messages)) {
        const nextMessage = r.messages.find((m) => m && m.messageText)
        if (nextMessage && !instructorMessage) setInstructorMessage(nextMessage)
      }
      if (Array.isArray(r.questionReports)) {
        setReportedQuestions(new Set(r.questionReports.map((report) => Number(report.questionNumber)).filter(Number.isFinite)))
      }

      if (submittedRef.current) return
      if (['finished', 'cancelled'].includes(c.status)) {
        if (r.finishOutcome === 'submitted' || r.finishOutcome === 'delivered') {
          // Salva pelo professor ao encerrar, ou entrega do próprio aluno que conta.
          const delivered = r.attemptOutcome
          finishDelivered({
            gradePublished: false,
            submittedByInstructor: delivered ? delivered.source === 'instructor_finish' : r.finishOutcome === 'submitted',
            finalizedByServer: delivered?.finalizedByServer === true,
            answeredCount: delivered?.answeredCount ?? null,
            lateBySeconds: delivered?.lateBySeconds || 0,
          })
        } else {
          clearExamDraftsForApplication(applicationId)
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
      if (r.timeOver && !st.startedAt) {
        setFatal('O tempo desta aplicação já terminou. Procure o professor se precisar de uma nova oportunidade.')
        setPhase('error')
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
      attemptIdRef.current = response.attemptId
      setAttemptId(response.attemptId)
      setExamConfigVersion(response.examConfigVersion || examConfigVersion)
      if (response.state?.assignedVersion) setAssignedVersion(response.state.assignedVersion)
      if (Number.isFinite(Number(response.state?.timerRemaining))) setRemaining(Number(response.state.timerRemaining))
      await loadAttemptAnswers(response.attemptId, response.localCopyKey, response.state?.answers || {})
      setPhase('active')
      // A prova começa da primeira questão (a página das instruções podia estar rolada).
      document.querySelector('main')?.scrollTo?.(0, 0)
      toast.success('Tentativa iniciada')
    } catch (error) {
      if (error.data?.timeOver) {
        // O cronômetro coletivo acabou enquanto o aluno lia as instruções.
        setFatal('O tempo desta aplicação já terminou. Procure o professor se precisar de uma nova oportunidade.')
        setPhase('error')
        return
      }
      if (error.data?.attemptFinalized) {
        const delivered = error.data.attemptOutcome || {}
        finishDelivered({ gradePublished: false, finalizedByServer: true, answeredCount: delivered.answeredCount ?? null, lateBySeconds: delivered.lateBySeconds || 0 })
        return
      }
      toast.error(error.message)
    }
  }

  // Reentra em tela cheia por gesto do aluno após liberação do professor.
  async function resumeFullscreen() {
    const ok = await enterFullscreen()
    setIsFullscreen(!!fullscreenElement())
    if (ok) sync()
  }

  // Saída da prova em andamento (AVA-12, UXA-X1): qualquer caminho para fora da rota
  // (botão Sair, voltar do navegador, link) passa pela confirmação. A saída salva as
  // respostas e fica registrada no Monitor (exam_left, que bloqueia a prova até o
  // professor liberar, como já fazia o botão Sair). Ao voltar, a tentativa é a mesma.
  const blocker = useBlocker(useCallback(({ currentLocation, nextLocation, historyAction }) => {
    if (leavingRef.current || submittedRef.current || phaseRef.current !== 'active') return false
    if (currentLocation.pathname === nextLocation.pathname && currentLocation.search === nextLocation.search) return false
    // Sessão encerrada (logout, revogação): o portal manda para o login sem perguntar.
    // Vale pelo fim da sessão, não pelo destino: com a sessão aberta, a entrada do login
    // no histórico (lista do botão voltar) é uma saída como outra qualquer.
    if (!hasActiveSession()) return false
    blockedActionRef.current = historyAction
    return true
  }, []))
  const blockerRef = useRef(blocker)
  blockerRef.current = blocker
  const navigationBlocked = blocker.state === 'blocked'

  // Navegação bloqueada e a prova deixou de estar em andamento (pausa, entrega): libera.
  useEffect(() => {
    if (navigationBlocked && phase !== 'active' && !leavingRef.current) blockerRef.current.reset()
  }, [navigationBlocked, phase])

  async function leaveAttempt(details) {
    if (leavingRef.current) return false
    leavingRef.current = true
    setLeavingBusy(true)
    await saveAnswersIfDirty()
    flushKeystrokes()
    await api.post('/api/student/log-activity', { email, studentClass, courseId, examKey, applicationId, attemptId, eventType: 'exam_left', details }).catch(() => {})
    if (mountedRef.current) {
      setLeavingBusy(false)
      setExitConfirm(false)
    }
    return true
  }

  async function leaveExam() {
    if (blockerRef.current.state === 'blocked') {
      const viaBack = blockedActionRef.current === 'POP'
      if (!await leaveAttempt(viaBack ? 'Saiu da prova pelo botão voltar do navegador' : 'Saiu da prova por um link do portal')) return
      if (blockerRef.current.state === 'blocked') blockerRef.current.proceed()
      return
    }
    if (!await leaveAttempt('Aluno saiu usando o botão da prova')) return
    nav('/aluno/provas')
  }

  function stayInExam() {
    setExitConfirm(false)
    if (blockerRef.current.state === 'blocked') blockerRef.current.reset()
  }

  // Saída pelas telas de pausa: salva antes o que ainda não chegou ao servidor.
  async function leaveToExamList() {
    leavingRef.current = true
    await saveAnswersIfDirty()
    nav('/aluno/provas')
  }

  // Desmontagem com a prova em andamento sem saída confirmada: as respostas que ainda
  // não chegaram ao servidor vão com keepalive (a digitação sai na limpeza do efeito de
  // captura). Com a sessão aberta, é uma saída da prova que escapou da confirmação
  // (navegação que o roteador não conseguiu segurar): fica registrada no Monitor e a
  // prova trava até o professor liberar, como na saída confirmada. No logout não há
  // registro (a sessão acabou) e em manutenção o servidor recusa as chamadas do aluno.
  useEffect(() => () => {
    if (leavingRef.current || submittedRef.current || phaseRef.current !== 'active') return
    saveRef.current?.({ keepalive: true })
    if (!hasActiveSession()) return
    const ctx = exitContextRef.current
    api.post('/api/student/log-activity', { ...ctx, attemptId: attemptIdRef.current, eventType: 'exam_left', details: 'Saiu da prova pela navegação' }, { keepalive: true }).catch(() => {})
  }, [])

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
  // Confirmação de saída: botão Sair da prova, voltar do navegador ou link (AVA-12).
  const exitDialog = (
    <Modal
      open={exitConfirm || navigationBlocked}
      onClose={() => !leavingBusy && stayInExam()}
      title="Sair da prova agora?"
      description="Suas respostas serão salvas e a saída fica registrada para o professor."
      footer={<>
        <Button variant="ghost" onClick={stayInExam} disabled={leavingBusy}>Continuar na prova</Button>
        <Button onClick={leaveExam} loading={leavingBusy}>Salvar e sair</Button>
      </>}
    >
      {navigationBlocked && (
        <p className="text-sm text-text mb-2">{blockedActionRef.current === 'POP' ? 'Você usou o botão voltar do navegador.' : 'Você tentou abrir outra página do portal.'}</p>
      )}
      <p className="text-sm text-muted">A prova fica bloqueada até o professor liberar. Depois disso, você volta à mesma tentativa enquanto a aplicação estiver aberta e ainda houver tempo.</p>
    </Modal>
  )

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
      <h2 className="text-xl font-bold text-text">{result?.submittedByInstructor ? 'Respostas salvas e entregues' : result?.finalizedByServer ? 'Tempo esgotado: prova entregue' : 'Prova enviada!'}</h2>
      {result?.gradePublished === true
        ? <p className="text-4xl font-bold text-text tabular-nums mt-3">{(Number(result.score) / 10).toFixed(1)}</p>
        : <p className="text-sm text-muted mt-3 max-w-sm text-center">{result?.submittedByInstructor
          ? 'O professor encerrou a aplicação e salvou o que você havia respondido.'
          : result?.finalizedByServer
            ? 'O tempo acabou e as respostas salvas no servidor foram entregues automaticamente. Sua nota será exibida depois da publicação pelo professor.'
            : `${result?.auto ? 'O tempo acabou e suas respostas foram enviadas automaticamente. ' : ''}Sua nota será exibida depois da publicação pelo professor.`}</p>}
      {Number.isFinite(Number(result?.answeredCount)) && result?.answeredCount !== null && (
        <p className="text-sm text-text mt-2">{Number(result.answeredCount) === 1 ? '1 resposta registrada.' : `${Number(result.answeredCount)} respostas registradas.`}</p>
      )}
      {Number(result?.lateBySeconds) > 0 && (
        <p className="text-xs text-warning mt-1 max-w-sm text-center">O envio chegou {Number(result.lateBySeconds)} s depois do fim do tempo. O professor verá esse atraso.</p>
      )}
      <Button className="mt-5" onClick={() => nav('/aluno')}>Voltar ao início</Button>
    </Center>
  )

  if (phase === 'timeup') return withInstructorMessage(
    <Center>
      <div className="w-14 h-14 grid place-items-center rounded-full bg-warning-soft text-warning mb-3"><Clock size={26} /></div>
      <h2 className="text-lg font-semibold text-text">Tempo esgotado</h2>
      <p className="text-sm text-muted mt-1 max-w-sm text-center">Suas respostas foram registradas no fim do tempo e estão sendo enviadas. Não feche esta página.</p>
      <div className="mt-4 max-w-sm text-center" role="status" aria-live="polite">
        {timeupInfo?.failed ? (
          <>
            <p className="text-sm text-danger">{timeupInfo.message} As respostas salvas no servidor serão entregues automaticamente.</p>
            <Button className="mt-4" variant="secondary" icon={ArrowLeft} onClick={() => nav('/aluno/provas')}>Voltar às provas</Button>
          </>
        ) : timeupInfo?.retrying ? (
          <p className="text-sm text-warning">Sem conexão com o servidor. Nova tentativa de envio em {Math.max(1, Math.ceil(Number(timeupInfo.nextRetryMs || 0) / 1000))} s.</p>
        ) : (
          <p className="flex items-center justify-center gap-2 text-sm text-muted"><Loader2 className="w-4 h-4 animate-spin" /> Enviando respostas...</p>
        )}
      </div>
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
          {noFullscreen
            ? <li>Este aparelho não permite <strong>tela cheia</strong>: a prova abre sem ela e o professor é avisado. Sair da aba ou da janela é registrado e bloqueia a prova até a liberação do professor.</li>
            : <li>A prova roda em <strong>tela cheia</strong>. Sair da tela cheia, da aba ou da janela é registrado e bloqueia a prova até a liberação do professor.</li>}
          <li>Durante a prova, os atalhos de teclado e a digitação são monitorados para garantir a integridade da avaliação.</li>
          <li>Durante a prova, o menu do portal fica indisponível. Sair da prova (pelo botão Sair ou pelo voltar do navegador) pede confirmação, fica registrado para o professor e bloqueia a prova até a liberação dele.</li>
          <li>Depois de sair, você retorna à mesma tentativa, com as respostas salvas, enquanto houver tempo e a aplicação estiver aberta.</li>
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
      <Button className="mt-6" variant="secondary" icon={ArrowLeft} onClick={leaveToExamList}>Sair e voltar depois</Button>
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
        <Button className="mt-6" variant="secondary" icon={ArrowLeft} onClick={leaveToExamList}>Sair e voltar às provas</Button>
      </div>
    </div>
  )

  if (phase === 'active' && !isFullscreen && !noFullscreen) return withInstructorMessage(
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-bg/95 backdrop-blur-sm p-4">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 grid place-items-center rounded-full bg-warning-soft text-warning mb-4 mx-auto"><ShieldAlert size={32} /></div>
        <h2 className="text-xl font-bold text-text">Tela cheia obrigatória</h2>
        <p className="text-sm text-muted mt-2">Esta prova roda em modo tela cheia por segurança. As questões só aparecem enquanto você estiver em tela cheia.</p>
        <Button className="mt-6" icon={Play} onClick={resumeFullscreen}>Voltar à tela cheia</Button>
        <div className="mt-4"><Button variant="ghost" icon={ArrowLeft} onClick={() => setExitConfirm(true)}>Sair da prova</Button></div>
      </div>
      {exitDialog}
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
      {exitDialog}
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
      {/* Cabeçalho que cabe no celular e com zoom de 200% a 400% (UXA-03, ACS-16). Abaixo
          de 640 px são duas linhas: título e cronômetro em cima, contagem e botões embaixo
          (o título ganha a largura dos botões e nada passa por baixo do cronômetro, nem em
          320 px); Sair e Mensagens viram só ícone e o Enviar fica sempre visível. A partir
          de 640 px, título e contagem à esquerda, cronômetro e botões à direita. */}
      <div className="sticky top-0 z-10 -mx-4 md:-mx-6 px-3 sm:px-4 md:px-6 py-2 sm:py-3 bg-surface/95 backdrop-blur border-b border-border">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 sm:gap-x-3 gap-y-1 sm:gap-y-0">
          <div className={`min-w-0 row-start-1 col-start-1 sm:col-span-1 ${remaining != null ? 'col-span-2' : 'col-span-3'}`}>
            <h1 className="truncate sm:whitespace-normal sm:line-clamp-2 text-sm sm:text-base font-bold text-text" title={examTitle || examKey.replace(/_/g, ' ')}>{examTitle || examKey.replace(/_/g, ' ')}</h1>
          </div>
          <div className="min-w-0 row-start-2 col-start-1 flex flex-wrap items-baseline gap-x-2">
            <p className="text-xs text-subtle">{answeredCount}/{questions.length} respondidas</p>
            <p className={`text-[11px] ${saveState.status === 'error' ? 'text-danger' : 'text-subtle'}`} aria-live="polite">
              {saveState.status === 'saving' && 'Salvando respostas...'}
              {saveState.status === 'saved' && `Salvo às ${saveState.at?.toLocaleTimeString('pt-BR')}`}
              {saveState.status === 'error' && 'Falha no último salvamento'}
            </p>
          </div>
          {remaining != null && (
            <div className={`row-start-1 col-start-3 sm:col-start-2 sm:row-span-2 justify-self-end flex items-center gap-1 font-mono text-sm sm:text-base font-bold tabular-nums ${remaining < 60 ? 'text-danger' : 'text-text'}`} title="Tempo restante"><Clock size={16} aria-hidden="true" /> {fmtTime(remaining)}</div>
          )}
          <div className="row-start-2 col-start-2 col-span-2 sm:row-start-1 sm:row-span-2 sm:col-start-3 sm:col-span-1 justify-self-end flex shrink-0 items-center gap-1 sm:gap-2">
            <Button size="sm" variant="ghost" icon={ArrowLeft} className="px-2 sm:px-3" aria-label="Sair" title="Sair da prova" onClick={() => setExitConfirm(true)}><span className="hidden sm:inline">Sair</span></Button>
            <Button size="sm" variant="secondary" icon={History} className="px-2 sm:px-3" aria-label="Mensagens" title="Mensagens do professor" onClick={openMessageHistory}><span className="hidden sm:inline">Mensagens</span></Button>
            <Button size="sm" icon={Send} className="px-2.5 sm:px-3" loading={submitting} onClick={() => setSubmitConfirm(true)}>Enviar</Button>
          </div>
        </div>
        {noFullscreen && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-subtle"><Info size={12} aria-hidden="true" className="shrink-0" /> Este aparelho não permite tela cheia. A prova segue normalmente e o professor foi avisado.</p>
        )}
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
                className={`shrink-0 px-2 sm:px-3 ${reportedQuestions.has(Number(q.number)) ? 'text-warning' : 'text-subtle'}`}
                aria-label={reportedQuestions.has(Number(q.number)) ? 'Problema já reportado nesta questão' : 'Reportar problema nesta questão'}
                title={reportedQuestions.has(Number(q.number)) ? 'Problema reportado' : 'Reportar problema'}
                onClick={() => openQuestionReport(q)}
              >
                <span className="hidden sm:inline">{reportedQuestions.has(Number(q.number)) ? 'Reportada' : 'Reportar'}</span>
              </Button>
            </div>
            <div className="space-y-2 pl-9">
              {/* O aluno vê a letra da posição (A, B, C... nesta versão) e a resposta guarda o
                  identificador da alternativa; a letra original nunca chega aqui (AVA-05). */}
              {q.alternatives.map((alt) => {
                const sel = answers[q.number] === alt.id
                return (
                  <button
                    key={alt.id}
                    type="button"
                    aria-pressed={sel}
                    disabled={(remaining != null && remaining <= 0) || (cfg?.annulledQuestions || []).some((item) => Number(item.questionNumber) === Number(q.number))}
                    onClick={() => setAnswers((a) => ({ ...a, [q.number]: alt.id }))}
                    className={`w-full text-left flex items-center gap-3 p-3 rounded-lg border transition disabled:cursor-not-allowed disabled:opacity-60 ${sel ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-2'}`}
                  >
                    <span className={`w-6 h-6 shrink-0 grid place-items-center rounded-full text-xs font-bold ${sel ? 'bg-primary text-primary-fg' : 'bg-surface-2 text-muted'}`}>{alt.label}</span>
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
