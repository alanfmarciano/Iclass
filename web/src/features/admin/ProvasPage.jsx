import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowDown, ArrowLeft, ArrowUp, CheckCircle2, ChevronRight, ClipboardList, Copy, Edit3, FileText, Layers, LayoutGrid, Library, List, Lock, Pause, Play, Plus, Printer, RefreshCw, Search, Settings2, Shuffle, Square, Trash2, Unlock } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageState } from '../../components/ui/PageState'
import { Select } from '../../components/ui/Select'
import { Input } from '../../components/ui/Input'
import { Switch } from '../../components/ui/Switch'
import { PageHeader } from '../../components/ui/PageHeader'
import { ConfirmDialog, Modal } from '../../components/ui/Modal'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'
import { FinishApplicationModal } from './FinishApplicationModal'
import { ExamApplicationDetail } from './ExamApplicationDetail'
import '../../styles/provas-board.css'
import {
  buildExamVersions,
  getQuestionUsageMap,
  normalizeEvaluation,
  openPrintWindow,
  snapshotsFromHistory,
} from './examTools'

const EXAM_TOKEN_LENGTH = 5
const EXAM_TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DEFAULT_WAITING_ROOM_MINUTES = 10
const DEFAULT_MAX_ATTEMPTS = 1

function generateExamToken() {
  const values = new Uint8Array(EXAM_TOKEN_LENGTH)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(values)
  else values.forEach((_, index) => { values[index] = Math.floor(Math.random() * 256) })
  return Array.from(values, (value) => EXAM_TOKEN_ALPHABET[value % EXAM_TOKEN_ALPHABET.length]).join('')
}

function normalizeTokenInput(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, EXAM_TOKEN_LENGTH)
}

function parseMaxAttemptsInput(value) {
  if (value === '' || value === null || value === undefined) return { valid: true, value: null }
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10
    ? { valid: true, value: parsed }
    : { valid: false, value: null }
}

function parseWaitingRoomInput(value) {
  if (value === '' || value === null || value === undefined) return DEFAULT_WAITING_ROOM_MINUTES
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_WAITING_ROOM_MINUTES
}

const DEFAULT_FORM = {
  questionCount: 10,
  durationMinutes: 60,
  waitingRoomMinutes: DEFAULT_WAITING_ROOM_MINUTES,
  shuffleQuestions: true,
  shuffleAnswers: true,
  tokenEnabled: false,
  accessToken: generateExamToken(),
  maxAttempts: String(DEFAULT_MAX_ATTEMPTS),
  onlineVersions: 4,
  printVersions: 1,
  timerEnabled: true,
  timerMode: 'per_attempt',
}

function statusTone(status) {
  if (status === 'running') return 'success'
  if (status === 'waiting' || status === 'paused') return 'warning'
  if (status === 'finished') return 'info'
  return 'neutral'
}

// Rótulos/cores dos status para o painel de listagem (dashboard de provas).
const BOARD_STATUS = {
  running: { label: 'Em andamento', tone: 'success' },
  waiting: { label: 'Sala de espera', tone: 'warning' },
  paused: { label: 'Pausada', tone: 'warning' },
  prepared: { label: 'Preparada', tone: 'info' },
  finished: { label: 'Finalizada', tone: 'info' },
  none: { label: 'Não aplicada', tone: 'neutral' },
}
const BOARD_STATUS_FILTERS = ['running', 'waiting', 'paused', 'prepared', 'finished', 'none']
function examBoardStatus(cfg) {
  const s = cfg?.status
  return BOARD_STATUS[s] ? s : 'none'
}
// cor de referência por módulo, só para o visual do painel (ciclo determinístico).
const MODULE_ACCENTS = ['var(--primary)', 'var(--info)', 'var(--violet, #a78bfa)', 'var(--success)', 'var(--warning)']

function clampCount(value, max) {
  return Math.max(1, Math.min(Number(value) || 1, Math.max(1, max || 1)))
}

function historyLabel(entry, index) {
  return entry.label || (entry.type === 'impressa' ? `Impressa #${index + 1}` : `Online #${index + 1}`)
}

function editorQuestion(source = {}) {
  const rawAlternatives = Array.isArray(source.alternatives) && source.alternatives.length >= 2
    ? source.alternatives
    : [{ text: '', isCorrect: true }, { text: '', isCorrect: false }, { text: '', isCorrect: false }, { text: '', isCorrect: false }]
  const requestedCorrect = String(source.correctAnswer || '').toUpperCase()
  return {
    text: source.text || source.questionText || '',
    alternatives: rawAlternatives.map((alternative, index) => ({
      letter: String.fromCharCode(65 + index),
      text: typeof alternative === 'string' ? alternative : alternative.text || '',
      isCorrect: alternative?.isCorrect === true || (!!requestedCorrect && String(alternative?.letter || '').toUpperCase() === requestedCorrect),
    })),
  }
}

export default function ProvasPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const { courseId: activeCourseId, courseName, className: activeClassName } = useAdminWorkspace()
  const courses = useApi('/api/courses')
  const summaries = useApi('/api/admin/course-summaries')
  const classes = useApi(`/api/admin/classes?courseId=${encodeURIComponent(activeCourseId)}&studentClass=${encodeURIComponent(activeClassName)}`)
  const [courseId, setCourseId] = useState(activeCourseId)
  const [className, setClassName] = useState(activeClassName)
  const [examKey, setExamKey] = useState('')
  const [selectedModuleId, setSelectedModuleId] = useState('')
  const [structure, setStructure] = useState([])
  const [evaluation, setEvaluation] = useState(null)
  const [onlineConfig, setOnlineConfig] = useState(null)
  const [applications, setApplications] = useState([])
  const [history, setHistory] = useState([])
  const [viewApplication, setViewApplication] = useState(null)
  const [mode, setMode] = useState('online')
  const [deleteHistory, setDeleteHistory] = useState(null)
  const [applyHistory, setApplyHistory] = useState(null)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [excluded, setExcluded] = useState([])
  const [unusedOnly, setUnusedOnly] = useState(false)
  const [busy, setBusy] = useState(null)
  const [finishApplication, setFinishApplication] = useState(null)
  const [finishSummary, setFinishSummary] = useState(null)
  const [finishBusy, setFinishBusy] = useState(null)
  const [editor, setEditor] = useState(null)
  const [editorBusy, setEditorBusy] = useState(false)
  const [bankOpen, setBankOpen] = useState(false)
  const [bankQuestions, setBankQuestions] = useState([])
  const [bankEditor, setBankEditor] = useState(null)
  const [shuffleSeed, setShuffleSeed] = useState(() => Date.now())
  // ----- Painel de listagem (dashboard de provas) -----
  const [examStatusMap, setExamStatusMap] = useState({})
  const [boardModule, setBoardModule] = useState('todos')
  const [boardStatus, setBoardStatus] = useState('todas')
  const [boardQuery, setBoardQuery] = useState('')
  const [boardView, setBoardView] = useState('list')
  const [boardCollapsed, setBoardCollapsed] = useState({})

  const courseClasses = useMemo(() => (classes.data || []).filter((c) => !courseId || c.courseId === courseId), [classes.data, courseId])
  const visibleCourses = useMemo(() => (courses.data || []).filter((c) => !activeCourseId || c.id === activeCourseId), [courses.data, activeCourseId])
  const affectedClassNames = useMemo(() => {
    const course = (summaries.data || []).find((item) => String(item.id) === String(courseId))
    return (course?.classes || []).map((item) => item.name).filter(Boolean)
  }, [summaries.data, courseId])
  const modulesWithExams = useMemo(() => structure.map((mod, index) => {
    const moduleId = String(mod.id || mod.key || mod.title || mod.name || index)
    const moduleName = mod.name || mod.title || mod.id || `Modulo ${index + 1}`
    const moduleExams = (mod.units || mod.items || [])
      .filter((unit) => unit.avaliacaoKey)
      .map((unit) => ({
        key: unit.avaliacaoKey,
        name: unit.name || unit.title || unit.avaliacaoKey,
        moduleId,
        moduleName,
      }))
    return { id: moduleId, name: moduleName, exams: moduleExams }
  }).filter((mod) => mod.exams.length > 0), [structure])
  const activeModule = useMemo(() => modulesWithExams.find((mod) => mod.id === selectedModuleId) || modulesWithExams[0], [modulesWithExams, selectedModuleId])
  const filteredExams = activeModule?.exams || []
  const exams = useMemo(() => modulesWithExams.flatMap((mod) => mod.exams), [modulesWithExams])
  const boardStats = useMemo(() => {
    const by = { running: 0, waiting: 0, paused: 0, prepared: 0, finished: 0, none: 0 }
    exams.forEach((e) => { by[examBoardStatus(examStatusMap[e.key])] += 1 })
    return { total: exams.length, active: by.running + by.waiting + by.paused + by.prepared, finished: by.finished, none: by.none, by }
  }, [exams, examStatusMap])
  const boardModules = useMemo(() => {
    const q = boardQuery.trim().toLowerCase()
    return modulesWithExams.map((mod, index) => {
      const accent = MODULE_ACCENTS[index % MODULE_ACCENTS.length]
      const visibleExams = mod.exams.filter((e) => {
        const st = examBoardStatus(examStatusMap[e.key])
        const okMod = boardModule === 'todos' || mod.id === boardModule
        const okSt = boardStatus === 'todas' || st === boardStatus
        const okQ = !q || (e.name || '').toLowerCase().includes(q) || (e.key || '').toLowerCase().includes(q)
        return okMod && okSt && okQ
      })
      const appliedCount = mod.exams.filter((e) => examBoardStatus(examStatusMap[e.key]) === 'finished').length
      const code = (mod.exams[0]?.key || mod.name || '').split('_')[1] || (mod.name || 'MOD').slice(0, 5)
      return { ...mod, accent, code, appliedCount, visibleExams }
    })
  }, [modulesWithExams, examStatusMap, boardModule, boardStatus, boardQuery])
  const boardVisibleCount = useMemo(() => boardModules.reduce((sum, m) => sum + m.visibleExams.length, 0), [boardModules])
  const boardFiltering = boardModule !== 'todos' || boardStatus !== 'todas' || boardQuery.trim() !== ''
  const selectedCourse = useMemo(() => visibleCourses.find((c) => c.id === courseId), [visibleCourses, courseId])
  const selectedClass = useMemo(() => courseClasses.find((c) => c.name === className), [courseClasses, className])
  const selectedExam = useMemo(() => exams.find((e) => e.key === examKey), [exams, examKey])
  const activeApplication = useMemo(() => {
    const configuredId = onlineConfig?.applicationId
    return applications.find((item) => item.id === configuredId) || applications[0] || null
  }, [applications, onlineConfig])
  const normalizedEval = useMemo(() => evaluation ? normalizeEvaluation(evaluation) : null, [evaluation])
  const usage = useMemo(() => getQuestionUsageMap(history), [history])
  const effectiveExcluded = useMemo(() => {
    const set = new Set(excluded.map(Number))
    if (unusedOnly) {
      Object.keys(usage).forEach((number) => set.add(Number(number)))
    }
    return [...set]
  }, [excluded, unusedOnly, usage])
  const availableQuestions = useMemo(() => {
    if (!normalizedEval) return []
    const ex = new Set(effectiveExcluded.map(Number))
    return normalizedEval.questions.filter((q) => !ex.has(Number(q.originalNumber)))
  }, [normalizedEval, effectiveExcluded])
  const currentVersions = useMemo(() => {
    if (!normalizedEval) return []
    return buildExamVersions(normalizedEval, {
      questionCount: clampCount(form.questionCount, availableQuestions.length || normalizedEval.questions.length),
      excludedNumbers: effectiveExcluded,
      shuffleQuestions: form.shuffleQuestions,
      shuffleAnswers: form.shuffleAnswers,
      versionCount: mode === 'online' ? form.onlineVersions : form.printVersions,
      seed: shuffleSeed,
    })
  }, [normalizedEval, form, effectiveExcluded, availableQuestions.length, mode, shuffleSeed])
  const previewQuestions = currentVersions[0]?.questions || []

  async function loadStructure(nextCourseId) {
    if (!nextCourseId) {
      setStructure([])
      return
    }
    const r = await api.get(`/api/admin/courses/${encodeURIComponent(nextCourseId)}/structure?studentClass=${encodeURIComponent(activeClassName)}`)
    setStructure(r.structure || [])
  }

  async function loadExamState(nextExamKey = examKey) {
    if (!className || !courseId || !nextExamKey) {
      setOnlineConfig(null)
      return
    }
    const [evalRes, statusRes, historyRes, applicationsRes] = await Promise.all([
      api.get(`/api/admin/evaluation/${encodeURIComponent(nextExamKey)}`),
      api.get(`/api/status?studentClass=${encodeURIComponent(className)}&courseId=${encodeURIComponent(courseId)}`),
      api.get(`/api/admin/exam-history?studentClass=${encodeURIComponent(className)}&courseId=${encodeURIComponent(courseId)}&examKey=${encodeURIComponent(nextExamKey)}`),
      api.get(`/api/admin/exam-applications?studentClass=${encodeURIComponent(className)}&courseId=${encodeURIComponent(courseId)}&examKey=${encodeURIComponent(nextExamKey)}`),
    ])
    const ev = evalRes.evaluation || evalRes
    setEvaluation(ev)
    setExcluded([])
    setUnusedOnly(false)
    setForm((f) => ({ ...f, questionCount: clampCount(f.questionCount, ev.questions?.length || 1) }))
    setOnlineConfig((statusRes.onlineExamConfigs || {})[nextExamKey] || null)
    setHistory(historyRes.history || [])
    setApplications(applicationsRes.applications || [])
  }

  useEffect(() => {
    if (activeCourseId && courseId !== activeCourseId) setCourseId(activeCourseId)
    if (activeClassName && className !== activeClassName) setClassName(activeClassName)
  }, [activeCourseId, activeClassName, courseId, className])

  useEffect(() => {
    if (!courseId) return
    loadStructure(courseId).catch((e) => toast.error(e.message))
    setSelectedModuleId('')
    setExamKey('')
    setEvaluation(null)
    setOnlineConfig(null)
    setApplications([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId])

  useEffect(() => {
    if (modulesWithExams.length === 0) {
      if (selectedModuleId) setSelectedModuleId('')
      return
    }
    if (!modulesWithExams.some((mod) => mod.id === selectedModuleId)) {
      setSelectedModuleId(modulesWithExams[0].id)
    }
  }, [modulesWithExams, selectedModuleId])

  useEffect(() => {
    if (!examKey) return
    if (filteredExams.some((exam) => exam.key === examKey)) return
    setExamKey('')
    setEvaluation(null)
    setOnlineConfig(null)
    setApplications([])
    setHistory([])
  }, [filteredExams, examKey])

  useEffect(() => {
    if (activeClassName && className !== activeClassName) setClassName(activeClassName)
  }, [activeClassName, className])

  useEffect(() => {
    if (!examKey) return
    setShuffleSeed(Date.now())
    setForm((current) => ({ ...current, tokenEnabled: false, accessToken: generateExamToken() }))
    loadExamState(examKey).catch((e) => toast.error(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examKey, className, courseId])

  // Status de todas as provas da turma (para o painel de listagem). Só leitura, endpoint já existente.
  useEffect(() => {
    if (!courseId || !className) { setExamStatusMap({}); return }
    api.get(`/api/status?studentClass=${encodeURIComponent(className)}&courseId=${encodeURIComponent(courseId)}`)
      .then((r) => setExamStatusMap(r.onlineExamConfigs || {}))
      .catch(() => setExamStatusMap({}))
  }, [courseId, className, examKey])

  function toggleBoardModule(id) {
    setBoardCollapsed((current) => ({ ...current, [id]: !current[id] }))
  }
  function clearBoardFilters() {
    setBoardModule('todos'); setBoardStatus('todas'); setBoardQuery('')
  }
  function openExamFromBoard(moduleId, examKey) {
    setSelectedModuleId(moduleId)
    setExamKey(examKey)
  }

  function selectModule(moduleId) {
    setSelectedModuleId(moduleId)
    const nextModule = modulesWithExams.find((mod) => mod.id === moduleId)
    if (!nextModule?.exams.some((exam) => exam.key === examKey)) {
      setExamKey('')
      setEvaluation(null)
      setOnlineConfig(null)
      setApplications([])
      setHistory([])
    }
  }

  function toggleQuestion(number, include) {
    const n = Number(number)
    setExcluded((list) => include ? list.filter((item) => Number(item) !== n) : [...new Set([...list, n])])
  }

  async function addHistory(type, snapshots, extra = {}) {
    const questionNumbers = [...new Set(snapshots.flatMap((snapshot) => (snapshot.questions || []).map((q) => Number(q.originalNumber)).filter(Number.isFinite)))]
    if (questionNumbers.length === 0) throw new Error('Nenhuma questao selecionada')
    const existingOfType = history.filter((entry) => entry.type === type).length
    return api.post('/api/admin/exam-history/add', {
      studentClass: className,
      courseId,
      examKey,
      type,
      label: type === 'impressa' ? `Impressa #${existingOfType + 1}` : `Online #${existingOfType + 1}`,
      questionNumbers,
      examCode: snapshots[0]?.examCode || null,
      printSnapshot: snapshots,
      questionCount: questionNumbers.length,
      excludedQuestions: effectiveExcluded,
      shuffleQuestions: form.shuffleQuestions,
      shuffleAnswers: form.shuffleAnswers,
      durationMinutes: Number(form.durationMinutes) || 60,
      timerEnabled: form.timerEnabled !== false,
      waitingRoomMinutes: parseWaitingRoomInput(form.waitingRoomMinutes),
      accessToken: type === 'online' && form.tokenEnabled ? form.accessToken : null,
      ...extra,
    })
  }

  async function saveOnline(prepare) {
    if (!className || !courseId || !examKey || !normalizedEval) return toast.error('Selecione turma, curso e prova')
    if (currentVersions.length === 0) return toast.error('Esta avaliacao nao tem questoes')
    if (form.tokenEnabled && !/^[A-Z]{5}$/.test(form.accessToken)) return toast.error('O token deve ter exatamente 5 letras maiúsculas')
    const parsedMaxAttempts = parseMaxAttemptsInput(form.maxAttempts)
    if (!parsedMaxAttempts.valid) return toast.error('Tentativas deve ser um número entre 1 e 10.')
    setBusy(prepare ? 'prepare' : 'saveOnline')
    try {
      const saved = await addHistory('online', currentVersions, { questionCount: currentVersions[0].count, maxAttempts: parsedMaxAttempts.value })
      if (prepare) {
        const prepared = await api.post('/api/admin/exam-applications', {
          studentClass: className,
          courseId,
          examKey,
          historyId: saved.entry.id,
          applicationOptions: {
            onlineVersions: form.onlineVersions,
            durationMinutes: Number(form.durationMinutes) || 60,
            waitingRoomMinutes: parseWaitingRoomInput(form.waitingRoomMinutes),
            timerEnabled: form.timerEnabled !== false,
            timerMode: form.timerMode,
            tokenEnabled: form.tokenEnabled === true,
            accessToken: form.tokenEnabled ? form.accessToken : null,
            maxAttempts: parsedMaxAttempts.value,
          },
        })
        if (prepared.accessToken) sessionStorage.setItem(`exam-token:${prepared.application.id}`, prepared.accessToken)
        toast.success('Aplicação preparada. Inicie pelo monitor quando a turma estiver pronta.')
        await loadExamState()
        const params = new URLSearchParams({ courseId, className, examKey, applicationId: prepared.application.id })
        navigate(`/monitor?${params.toString()}`)
      } else {
        toast.success('Configuracao online salva no historico')
        await loadExamState()
      }
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function printAndRegister() {
    if (!className || !courseId || !examKey || currentVersions.length === 0) return toast.error('Monte uma prova antes de imprimir')
    setBusy('print')
    try {
      openPrintWindow({ title: evaluation?.title || examKey, snapshots: currentVersions, includeAnswerKey: true })
      await addHistory('impressa', currentVersions, { questionCount: currentVersions[0].count })
      toast.success('Prova impressa e gabarito gerados')
      await loadExamState()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }

  function openHistoryApplication(entry) {
    const availableVersions = Math.max(1, snapshotsFromHistory(entry).length)
    setApplyHistory({
      entry,
      availableVersions,
      onlineVersions: availableVersions,
      durationMinutes: Number(entry.durationMinutes) || 60,
      waitingRoomMinutes: 10,
      timerEnabled: entry.timerEnabled !== false,
      timerMode: entry.timerMode || 'per_attempt',
      tokenEnabled: false,
      accessToken: generateExamToken(),
      maxAttempts: Object.prototype.hasOwnProperty.call(entry, 'maxAttempts')
        ? (entry.maxAttempts == null ? '' : String(entry.maxAttempts))
        : String(DEFAULT_MAX_ATTEMPTS),
    })
  }

  async function prepareHistory() {
    if (!applyHistory?.entry) return
    if (applyHistory.tokenEnabled && !/^[A-Z]{5}$/.test(applyHistory.accessToken)) return toast.error('O token deve ter exatamente 5 letras maiúsculas')
    const parsedMaxAttempts = parseMaxAttemptsInput(applyHistory.maxAttempts)
    if (!parsedMaxAttempts.valid) return toast.error('Tentativas deve ser um número entre 1 e 10.')
    const durationMinutes = Math.max(1, Number(applyHistory.durationMinutes) || 60)
    const waitingRoomMinutes = parseWaitingRoomInput(applyHistory.waitingRoomMinutes)
    setBusy('applyHistory')
    try {
      const prepared = await api.post('/api/admin/exam-applications', {
        studentClass: className,
        courseId,
        examKey,
        historyId: applyHistory.entry.id,
        applicationOptions: {
          onlineVersions: Math.max(1, Math.min(applyHistory.availableVersions, Number(applyHistory.onlineVersions) || 1)),
          durationMinutes,
          waitingRoomMinutes,
          timerEnabled: applyHistory.timerEnabled !== false,
          timerMode: applyHistory.timerMode,
          tokenEnabled: applyHistory.tokenEnabled === true,
          accessToken: applyHistory.tokenEnabled ? applyHistory.accessToken : null,
          maxAttempts: parsedMaxAttempts.value,
        },
      })
      if (prepared.accessToken) sessionStorage.setItem(`exam-token:${prepared.application.id}`, prepared.accessToken)
      toast.success('Nova aplicação preparada. Abrindo o Monitor Online.')
      setApplyHistory(null)
      const params = new URLSearchParams({ courseId, className, examKey, applicationId: prepared.application.id })
      navigate(`/monitor?${params.toString()}`)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function blockPrepared() {
    try {
      if (activeApplication && !['finished', 'cancelled'].includes(activeApplication.status)) {
        const action = ['running', 'paused', 'waiting'].includes(activeApplication.status) ? 'finish' : 'cancel'
        if (action === 'finish') return openFinishDecision(activeApplication)
        await api.post(`/api/admin/exam-applications/${encodeURIComponent(activeApplication.id)}/control`, { action })
      } else {
        await api.post('/api/admin/release-item', { studentClass: className, courseId, itemKey: examKey, released: false })
      }
      toast.success('Prova bloqueada para a turma')
      await loadExamState()
    } catch (e) {
      toast.error(e.message)
    }
  }

  function reprintHistory(entry) {
    const snapshots = snapshotsFromHistory(entry)
    if (snapshots.length === 0) return toast.error('Historico sem snapshot para reimpressao')
    openPrintWindow({ title: evaluation?.title || examKey, snapshots, includeAnswerKey: true })
  }

  async function removeHistory() {
    try {
      await api.post('/api/admin/exam-history/delete', { studentClass: className, courseId, examKey, entryId: deleteHistory.id })
      toast.success('Historico removido')
      setDeleteHistory(null)
      loadExamState()
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function control(action, extra = {}) {
    if (!className || !courseId || !examKey) return
    setBusy(action)
    try {
      if (activeApplication) {
        await api.post(`/api/admin/exam-applications/${encodeURIComponent(activeApplication.id)}/control`, { action, ...extra })
      } else {
        await api.post('/api/admin/server-exam-control', { studentClass: className, courseId, examKey, action })
      }
      toast.success('Estado atualizado')
      await loadExamState()
      return true
    } catch (e) {
      toast.error(e.message)
      return false
    } finally {
      setBusy(null)
    }
  }

  async function openFinishDecision(application) {
    try {
      const response = await api.get(`/api/admin/exam-applications/${encodeURIComponent(application.id)}/finish-summary`)
      setFinishSummary(response.summary || {})
      setFinishApplication(application)
    } catch (error) {
      toast.error(error.message)
    }
  }

  async function finishSelected(inProgressPolicy) {
    setFinishBusy(inProgressPolicy)
    const completed = await control('finish', { inProgressPolicy })
    setFinishBusy(null)
    if (completed) {
      setFinishApplication(null)
      setFinishSummary(null)
    }
  }

  function openNewEditor() {
    if (!courseId || !activeModule) return toast.error('Selecione um curso e um módulo')
    setEditor({ key: null, moduleId: activeModule.id, title: '', theme: activeModule.name || '', rubric: '', scope: 'class', questions: [editorQuestion()] })
  }

  function openEvaluationEditor() {
    if (!evaluation || !examKey) return
    setEditor({
      key: examKey,
      moduleId: activeModule?.id || '',
      title: evaluation.title || '',
      theme: evaluation.theme || '',
      rubric: evaluation.rubric || '',
      scope: 'class',
      questions: (evaluation.questions || []).map(editorQuestion),
    })
  }

  function updateEditorQuestion(index, patch) {
    setEditor((current) => ({ ...current, questions: current.questions.map((question, questionIndex) => questionIndex === index ? { ...question, ...patch } : question) }))
  }

  function updateAlternative(questionIndex, alternativeIndex, patch) {
    setEditor((current) => ({
      ...current,
      questions: current.questions.map((question, index) => {
        if (index !== questionIndex) return question
        const alternatives = question.alternatives.map((alternative, altIndex) => {
          if (patch.isCorrect === true) return { ...alternative, isCorrect: altIndex === alternativeIndex }
          return altIndex === alternativeIndex ? { ...alternative, ...patch } : alternative
        })
        return { ...question, alternatives }
      }),
    }))
  }

  function addAlternative(questionIndex) {
    const question = editor.questions[questionIndex]
    if (question.alternatives.length >= 8) return toast.info('Máximo de 8 alternativas')
    updateEditorQuestion(questionIndex, { alternatives: [...question.alternatives, { letter: String.fromCharCode(65 + question.alternatives.length), text: '', isCorrect: false }] })
  }

  function removeAlternative(questionIndex, alternativeIndex) {
    const question = editor.questions[questionIndex]
    if (question.alternatives.length <= 2) return toast.info('A questão precisa de ao menos 2 alternativas')
    const removedWasCorrect = question.alternatives[alternativeIndex]?.isCorrect
    const alternatives = question.alternatives.filter((_, index) => index !== alternativeIndex).map((alternative, index) => ({ ...alternative, letter: String.fromCharCode(65 + index) }))
    if (removedWasCorrect) alternatives[0].isCorrect = true
    updateEditorQuestion(questionIndex, { alternatives })
  }

  function moveQuestion(index, direction) {
    const target = index + direction
    if (target < 0 || target >= editor.questions.length) return
    setEditor((current) => {
      const questions = [...current.questions]
      ;[questions[index], questions[target]] = [questions[target], questions[index]]
      return { ...current, questions }
    })
  }

  function duplicateQuestion(index) {
    setEditor((current) => {
      const questions = [...current.questions]
      questions.splice(index + 1, 0, editorQuestion(current.questions[index]))
      return { ...current, questions }
    })
  }

  function removeQuestion(index) {
    if (editor.questions.length <= 1) return toast.info('A prova precisa de ao menos uma questão')
    setEditor((current) => ({ ...current, questions: current.questions.filter((_, questionIndex) => questionIndex !== index) }))
  }

  function evaluationPayload() {
    return {
      title: editor.title,
      theme: editor.theme,
      rubric: editor.rubric,
      questions: editor.questions.map((question) => ({
        text: question.text,
        alternatives: question.alternatives,
        correctAnswer: question.alternatives.find((alternative) => alternative.isCorrect)?.letter || '',
      })),
    }
  }

  async function saveEvaluationEditor() {
    if (editor.scope === 'course') {
      const names = affectedClassNames.length ? affectedClassNames.join(', ') : 'todas as turmas do curso'
      if (!window.confirm(`Esta alteração substituirá esta prova em: ${names}. Deseja continuar?`)) return
    }
    setEditorBusy(true)
    try {
      const payload = { ...evaluationPayload(), courseId, studentClass: className, scope: editor.scope || 'class' }
      const response = editor.key
        ? await api.put(`/api/admin/evaluation/${encodeURIComponent(editor.key)}`, payload)
        : await api.post('/api/admin/evaluation', { ...payload, moduleId: editor.moduleId })
      const savedKey = response.key || editor.key
      toast.success(editor.key ? 'Prova atualizada' : 'Prova criada')
      setEditor(null)
      if (response.evaluation) setEvaluation(response.evaluation)
      await loadStructure(courseId)
      setSelectedModuleId(editor.moduleId)
      setExamKey(savedKey)
      if (editor.key) await loadExamState(savedKey)
    } catch (error) {
      toast.error(error.message)
    } finally {
      setEditorBusy(false)
    }
  }

  async function openQuestionBank() {
    try {
      const response = await api.get('/api/admin/question-bank')
      setBankQuestions(response.questions || [])
      setBankOpen(true)
    } catch (error) { toast.error(error.message) }
  }

  function addBankQuestion(question) {
    setEditor((current) => ({ ...current, questions: [...current.questions, editorQuestion(question)] }))
    toast.success('Questão adicionada à prova')
  }

  async function saveQuestionToBank(question) {
    try {
      const response = await api.post('/api/admin/question-bank/create', {
        category: editor.theme || activeModule?.name || 'Geral',
        questionText: question.text,
        alternatives: question.alternatives,
        correctAnswer: question.alternatives.find((alternative) => alternative.isCorrect)?.letter || '',
        sourceExamKey: editor.key || null,
      })
      setBankQuestions((items) => [...items, response.question])
      toast.success('Questão salva no banco')
    } catch (error) { toast.error(error.message) }
  }

  async function saveBankEditor() {
    try {
      const response = await api.post('/api/admin/question-bank/update', {
        key: bankEditor.key,
        category: bankEditor.category,
        questionText: bankEditor.questionText,
        alternatives: bankEditor.alternatives,
        correctAnswer: bankEditor.alternatives.find((alternative) => alternative.isCorrect)?.letter || '',
      })
      setBankQuestions((items) => items.map((item) => item.key === response.question.key ? response.question : item))
      setBankEditor(null)
      toast.success('Questão do banco atualizada')
    } catch (error) { toast.error(error.message) }
  }

  async function deleteBankQuestion(question) {
    if (!window.confirm(`Excluir a questão do banco: "${question.questionText}"?`)) return
    try {
      await api.post('/api/admin/question-bank/delete', { key: question.key })
      setBankQuestions((items) => items.filter((item) => item.key !== question.key))
      if (bankEditor?.key === question.key) setBankEditor(null)
      toast.success('Questão excluída do banco')
    } catch (error) { toast.error(error.message) }
  }

  const loading = courses.loading || classes.loading
  const error = courses.error || classes.error
  const selectedCount = previewQuestions.length
  const totalQuestions = normalizedEval?.questions?.length || 0
  const usedCount = Object.keys(usage).length

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {viewApplication ? (
        <ExamApplicationDetail
          entry={viewApplication}
          title={evaluation?.title || selectedExam?.name || examKey}
          subtitle={`${courseName || selectedCourse?.name || activeCourseId} · ${activeClassName}`}
          applyBusy={busy === 'applyHistory'}
          onBack={() => setViewApplication(null)}
          onReprint={() => reprintHistory(viewApplication)}
          onApplyOnline={() => openHistoryApplication(viewApplication)}
        />
      ) : (
      <>
      <PageHeader title="Provas" subtitle={`Monte e aplique avaliações · ${courseName || selectedCourse?.name || activeCourseId} · ${activeClassName}.`}>
        <Button variant="secondary" icon={Plus} onClick={openNewEditor} disabled={!courseId || !activeModule}>Nova prova</Button>
        <div className="grid grid-cols-3 gap-2 min-w-[360px]">
          <div className="rounded-lg border border-border bg-surface px-3 py-2">
            <p className="text-[11px] uppercase font-semibold text-subtle">Curso</p>
            <p className="text-sm font-semibold text-text truncate">{selectedCourse?.name || 'Não selecionado'}</p>
          </div>
          <div className="rounded-lg border border-border bg-surface px-3 py-2">
            <p className="text-[11px] uppercase font-semibold text-subtle">Turma</p>
            <p className="text-sm font-semibold text-text truncate">{selectedClass?.name || className || 'Não selecionada'}</p>
          </div>
          <div className="rounded-lg border border-border bg-surface px-3 py-2">
            <p className="text-[11px] uppercase font-semibold text-subtle">Status</p>
            <p className="text-sm font-semibold text-text truncate">{onlineConfig?.status || 'Não aplicada'}</p>
          </div>
        </div>
      </PageHeader>

      <PageState loading={loading} error={error} onRetry={() => { courses.refetch(); classes.refetch() }}>
        <Card>
          {!examKey && <CardHeader title="Escolha a prova" subtitle="Defina a turma e a avaliacao antes de montar a aplicacao" action={onlineConfig && <Badge tone={statusTone(onlineConfig.status)}>{onlineConfig.status || 'nao aplicada'}</Badge>} />}
          <CardBody className="space-y-4">
            {!examKey && (
              <div className="pvb">
                {!activeCourseId && (
                  <Select label="Curso" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                    <option value="">Selecione...</option>
                    {visibleCourses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                )}

                <div className="pvb-stats">
                  <div className="pvb-stat">
                    <div className="pvb-stat-top">
                      <span className="pvb-stat-label">Total de provas</span>
                      <span className="pvb-stat-ic" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}><ClipboardList size={16} /></span>
                    </div>
                    <div className="pvb-stat-num">{boardStats.total}</div>
                    <div className="pvb-stat-foot">{modulesWithExams.length} módulo{modulesWithExams.length === 1 ? '' : 's'} com avaliação</div>
                  </div>
                  <div className="pvb-stat">
                    <div className="pvb-stat-top">
                      <span className="pvb-stat-label">Ativas</span>
                      <span className="pvb-stat-ic" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}><Play size={16} /></span>
                    </div>
                    <div className="pvb-stat-num">{boardStats.active}</div>
                    <div className="pvb-stat-foot">Em andamento, sala de espera ou preparadas</div>
                  </div>
                  <div className="pvb-stat">
                    <div className="pvb-stat-top">
                      <span className="pvb-stat-label">Finalizadas</span>
                      <span className="pvb-stat-ic" style={{ background: 'var(--info-soft)', color: 'var(--info)' }}><CheckCircle2 size={16} /></span>
                    </div>
                    <div className="pvb-stat-num">{boardStats.finished}</div>
                    <div className="pvb-stat-foot">Aplicações encerradas e corrigidas</div>
                  </div>
                  <div className="pvb-stat">
                    <div className="pvb-stat-top">
                      <span className="pvb-stat-label">Não aplicadas</span>
                      <span className="pvb-stat-ic" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}><FileText size={16} /></span>
                    </div>
                    <div className="pvb-stat-num">{boardStats.none}</div>
                    <div className="pvb-stat-foot">Ainda sem aplicação nesta turma</div>
                  </div>
                </div>

                <div className="pvb-toolbar">
                  <div className="pvb-search">
                    <Search size={15} />
                    <input value={boardQuery} onChange={(e) => setBoardQuery(e.target.value)} placeholder="Buscar prova por nome ou código…" />
                  </div>
                  <div className="pvb-filter">
                    <span className="pvb-flabel">Módulo</span>
                    <button type="button" className={`pvb-chip ${boardModule === 'todos' ? 'active' : ''}`} onClick={() => setBoardModule('todos')}>Todos</button>
                    {modulesWithExams.map((mod, index) => (
                      <button key={mod.id} type="button" className={`pvb-chip ${boardModule === mod.id ? 'active' : ''}`} style={{ '--sc': MODULE_ACCENTS[index % MODULE_ACCENTS.length] }} onClick={() => setBoardModule(mod.id)}>
                        <span className="pvb-cdot" />{mod.name}<span className="pvb-count">{mod.exams.length}</span>
                      </button>
                    ))}
                  </div>
                  <div className="pvb-filter">
                    <span className="pvb-flabel">Status</span>
                    <button type="button" className={`pvb-chip ${boardStatus === 'todas' ? 'active' : ''}`} onClick={() => setBoardStatus('todas')}>Todas</button>
                    {BOARD_STATUS_FILTERS.map((st) => (
                      <button key={st} type="button" className={`pvb-chip ${boardStatus === st ? 'active' : ''}`} style={{ '--sc': `var(--${BOARD_STATUS[st].tone === 'neutral' ? 'text-muted' : BOARD_STATUS[st].tone})` }} onClick={() => setBoardStatus(st)}>
                        <span className="pvb-cdot" />{BOARD_STATUS[st].label}<span className="pvb-count">{boardStats.by[st]}</span>
                      </button>
                    ))}
                  </div>
                  <div className="pvb-view">
                    <button type="button" className={boardView === 'list' ? 'active' : ''} title="Lista" aria-label="Visão em lista" onClick={() => setBoardView('list')}><List size={16} /></button>
                    <button type="button" className={boardView === 'grid' ? 'active' : ''} title="Grade" aria-label="Visão em grade" onClick={() => setBoardView('grid')}><LayoutGrid size={16} /></button>
                  </div>
                </div>

                <div className="pvb-resultmeta">
                  <b>{boardVisibleCount}</b> prova{boardVisibleCount === 1 ? '' : 's'} {boardFiltering ? 'após filtros' : 'no total'}
                  {boardFiltering && <> · <button type="button" className="underline hover:text-text" onClick={clearBoardFilters}>limpar filtros</button></>}
                </div>

                {!courseId && <div className="pvb-empty"><h4>Selecione um curso</h4><p>Escolha um curso para ver as provas.</p></div>}
                {courseId && modulesWithExams.length === 0 && <div className="pvb-empty"><h4>Nenhuma avaliação encontrada</h4><p>Não há módulos com avaliação na estrutura deste curso.</p></div>}
                {courseId && modulesWithExams.length > 0 && (
                  <div className={`pvb-board ${boardView}`}>
                    {boardModules.map((mod) => {
                      if (mod.visibleExams.length === 0) return null
                      const collapsed = !!boardCollapsed[mod.id]
                      return (
                        <section key={mod.id} className={`pvb-mod ${collapsed ? 'collapsed' : ''}`} style={{ '--mc': mod.accent }}>
                          <button type="button" className="pvb-mod-head" onClick={() => toggleBoardModule(mod.id)} aria-expanded={!collapsed}>
                            <span className="pvb-mbadge">{(mod.code || mod.name || 'MOD').slice(0, 2).toUpperCase()}</span>
                            <span className="pvb-mtitle">
                              <span className="pvb-mname">{mod.name}</span>
                              <span className="pvb-msub">{mod.code} · {mod.exams.length} prova{mod.exams.length === 1 ? '' : 's'}</span>
                            </span>
                            <span className="pvb-msummary">
                              <span className="pvb-mstat"><span className="pvb-mv">{mod.appliedCount}/{mod.exams.length}</span><span className="pvb-mk">Finalizadas</span></span>
                              <span className="pvb-mcount">{mod.exams.length} prova{mod.exams.length === 1 ? '' : 's'}</span>
                              <span className="pvb-chev"><ChevronRight size={18} /></span>
                            </span>
                          </button>
                          <div className="pvb-mod-body">
                            {mod.visibleExams.map((e) => {
                              const meta = BOARD_STATUS[examBoardStatus(examStatusMap[e.key])]
                              return (
                                <button key={e.key} type="button" className="pvb-exam" onClick={() => openExamFromBoard(mod.id, e.key)} title="Abrir para montar e aplicar">
                                  <span className="min-w-0">
                                    <span className="pvb-ename" style={{ display: 'block' }}>{e.name}</span>
                                    <span className="pvb-ecode">{e.key}</span>
                                  </span>
                                  <span className={`pvb-st ${meta.tone}`}><span className="pvb-sdot" />{meta.label}</span>
                                  <span className="pvb-emeta"><ChevronRight size={16} /></span>
                                </button>
                              )
                            })}
                          </div>
                        </section>
                      )
                    })}
                    {boardVisibleCount === 0 && <div className="pvb-empty"><h4>Nenhuma prova encontrada</h4><p>Ajuste a busca ou os filtros de módulo/status.</p></div>}
                  </div>
                )}
              </div>
            )}

            {examKey && (
              <button type="button" onClick={() => { setExamKey(''); setEvaluation(null); setOnlineConfig(null); setHistory([]); setViewApplication(null) }} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-text mb-1"><ArrowLeft size={16} />Voltar para provas</button>
            )}

            {examKey && evaluation ? (
              <>
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_260px] gap-3 border-t border-border pt-4">
                  <div>
                    <p className="text-xs uppercase font-semibold text-subtle">Avaliacao selecionada</p>
                    <h2 className="text-lg font-bold text-text mt-1">{evaluation.title || selectedExam?.name || examKey}</h2>
                    <div className="mt-2"><Button size="sm" variant="secondary" icon={Edit3} onClick={openEvaluationEditor}>Editar conteúdo</Button></div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge tone="info">{selectedCount}/{totalQuestions} questoes</Badge>
                      <Badge tone={usedCount > 0 ? 'warning' : 'neutral'}>{usedCount} ja usadas</Badge>
                      <Badge tone="neutral">{mode === 'online' ? `${form.onlineVersions} versoes online` : `${form.printVersions} versoes impressas`}</Badge>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setMode('online')}
                      className={`rounded-lg border p-3 text-left transition ${mode === 'online' ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-text hover:bg-surface-2'}`}
                    >
                      <Play size={18} />
                      <span className="block mt-2 text-sm font-semibold">Online</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode('print')}
                      className={`rounded-lg border p-3 text-left transition ${mode === 'print' ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-text hover:bg-surface-2'}`}
                    >
                      <Printer size={18} />
                      <span className="block mt-2 text-sm font-semibold">Impressa</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-4">
                  <div className="space-y-4">
                    <Card className="p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <span className="w-8 h-8 grid place-items-center rounded-md bg-surface-2 text-muted"><Settings2 size={17} /></span>
                        <div>
                          <h3 className="text-sm font-bold text-text">Montagem</h3>
                          <p className="text-xs text-muted">Quantidade, tempo e embaralhamento</p>
                        </div>
                      </div>
                      <Input label="Quantidade de questoes" type="number" min="1" max={availableQuestions.length || 1} value={form.questionCount} onChange={(e) => setForm({ ...form, questionCount: e.target.value })} helper={`${availableQuestions.length} disponiveis`} />
                      {mode === 'online' ? (
                        <div className="grid grid-cols-2 gap-3">
                          <Input label="Versoes online" type="number" min="1" max="5" value={form.onlineVersions} onChange={(e) => setForm({ ...form, onlineVersions: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })} />
                          <Input label="Duracao (min)" type="number" min="1" value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })} />
                          <Input label="Sala de espera (min)" type="number" min="0" value={form.waitingRoomMinutes} onChange={(e) => setForm({ ...form, waitingRoomMinutes: e.target.value })} helper="Padrão: 10 minutos." />
                          <Select label="Início do cronômetro" value={form.timerMode} onChange={(e) => setForm({ ...form, timerMode: e.target.value })}>
                            <option value="per_attempt">Quando cada aluno iniciar</option>
                            <option value="collective">Junto com a turma</option>
                          </Select>
                          <div className="col-span-2">
                            <Input label="Tentativas permitidas" type="number" min="1" max="10" step="1" placeholder="Ilimitadas" value={form.maxAttempts} onChange={(e) => setForm({ ...form, maxAttempts: e.target.value })} helper="Padrão: 1 tentativa. Deixe em branco para não limitar." />
                          </div>
                          {form.tokenEnabled && <div className="col-span-2 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                            <Input
                              label="Token de acesso"
                              value={form.accessToken}
                              maxLength={EXAM_TOKEN_LENGTH}
                              autoComplete="off"
                              spellCheck={false}
                              className="font-mono text-base font-semibold tracking-[0.2em]"
                              helper="5 letras maiúsculas"
                              onChange={(e) => setForm({ ...form, accessToken: normalizeTokenInput(e.target.value) })}
                            />
                            <Button type="button" variant="secondary" icon={RefreshCw} onClick={() => setForm({ ...form, accessToken: generateExamToken() })}>Novo</Button>
                          </div>}
                        </div>
                      ) : (
                        <Input label="Versoes impressas" type="number" min="1" max="10" value={form.printVersions} onChange={(e) => setForm({ ...form, printVersions: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} helper="Cada versao recebe codigo proprio." />
                      )}
                      <div className="grid grid-cols-1 gap-2">
                        <Switch label="Embaralhar questoes" checked={form.shuffleQuestions} onChange={(v) => setForm({ ...form, shuffleQuestions: v })} />
                        <Switch label="Embaralhar alternativas" checked={form.shuffleAnswers} onChange={(v) => setForm({ ...form, shuffleAnswers: v })} />
                        {mode === 'online' && <Switch label="Cronometro ativo" checked={form.timerEnabled} onChange={(v) => setForm({ ...form, timerEnabled: v })} />}
                        {mode === 'online' && <Switch label="Exigir token de acesso" checked={form.tokenEnabled} onChange={(v) => setForm({ ...form, tokenEnabled: v, accessToken: form.accessToken || generateExamToken() })} />}
                        <Switch label="Usar apenas questoes ineditas" checked={unusedOnly} onChange={setUnusedOnly} />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" icon={Shuffle} onClick={() => setShuffleSeed((seed) => seed + 1)}>Sortear novamente</Button>
                      </div>
                    </Card>

                    {mode === 'online' ? (
                      <Card className="p-4 space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="w-8 h-8 grid place-items-center rounded-md bg-success-soft text-success"><CheckCircle2 size={17} /></span>
                          <div>
                            <h3 className="text-sm font-bold text-text">Aplicacao online</h3>
                            <p className="text-xs text-muted">Salvar, preparar e depois iniciar pelo monitor</p>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button icon={FileText} loading={busy === 'saveOnline'} onClick={() => saveOnline(false)}>Salvar online</Button>
                          <Button icon={Play} loading={busy === 'prepare'} onClick={() => saveOnline(true)}>Preparar e abrir monitor</Button>
                        </div>
                        <p className="text-xs text-warning">Preparar ainda não libera a prova. No monitor, clique em “Iniciar prova e avisar alunos” ou abra a sala de espera.</p>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="secondary" icon={Pause} loading={busy === 'paused'} onClick={() => control('paused')}>Pausar</Button>
                          <Button size="sm" variant="secondary" icon={Play} loading={busy === 'running'} onClick={() => control('running')}>Retomar</Button>
                          <Button size="sm" variant="destructive" icon={Square} loading={busy === 'finished'} onClick={() => openFinishDecision(activeApplication)}>Finalizar</Button>
                          <Button size="sm" variant="secondary" icon={Lock} onClick={blockPrepared}>Bloquear</Button>
                        </div>
                      </Card>
                    ) : (
                      <Card className="p-4 space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="w-8 h-8 grid place-items-center rounded-md bg-info-soft text-info"><Printer size={17} /></span>
                          <div>
                            <h3 className="text-sm font-bold text-text">Aplicacao impressa</h3>
                            <p className="text-xs text-muted">Gerar prova e gabarito</p>
                          </div>
                        </div>
                        <Button icon={Printer} loading={busy === 'print'} onClick={printAndRegister}>Gerar prova + gabarito</Button>
                        <p className="text-xs text-subtle mt-2">A aplicacao impressa sera salva no historico para reimpressao e correcao por versao.</p>
                      </Card>
                    )}
                  </div>

                  <Card>
                    <CardHeader title="Previa da prova" subtitle={`Versao ${currentVersions[0]?.version || 'A'} - ${selectedCount} questoes`} action={<Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => loadExamState()}>Atualizar</Button>} />
                    <CardBody className="space-y-3">
                      {previewQuestions.map((q, index) => {
                        const usages = usage[q.originalNumber] || []
                        return (
                          <div key={`${q.originalNumber}-${index}`} className={`rounded-lg border p-3 ${usages.length ? 'border-warning/40 bg-warning/5' : 'border-border'}`}>
                            <div className="flex items-start gap-3">
                              <span className="w-7 h-7 shrink-0 grid place-items-center rounded-md bg-primary-soft text-primary text-sm font-bold">{index + 1}</span>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-text">{q.text}</p>
                                {usages.length > 0 && <p className="text-xs text-warning mt-1">Ja usada: {usages.map((u) => u.label).join(', ')}</p>}
                              </div>
                              <Button size="sm" variant="ghost" icon={Trash2} onClick={() => toggleQuestion(q.originalNumber, false)}>Remover</Button>
                            </div>
                            <div className="mt-3 grid gap-1 pl-10">
                              {(q.alternatives || []).map((alt) => (
                                <div key={alt.displayLetter || alt.letter} className={`text-xs rounded-md border px-2 py-1 ${alt.isCorrect ? 'border-success/50 bg-success-soft text-success' : 'border-border text-muted'}`}>
                                  <b>{alt.displayLetter || alt.letter})</b> {alt.text} {alt.isCorrect ? ' - correta' : ''}
                                </div>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                      {previewQuestions.length === 0 && <EmptyState icon={ClipboardList} title="Nenhuma questao selecionada" description="Ajuste filtros ou quantidade para montar a prova." />}
                      {excluded.length > 0 && (
                        <div className="border-t border-border pt-3">
                          <p className="text-xs font-semibold text-muted mb-2">Removidas manualmente</p>
                          <div className="flex flex-wrap gap-2">
                            {excluded.map((number) => (
                              <Button key={number} size="sm" variant="secondary" icon={Unlock} onClick={() => toggleQuestion(number, true)}>Q{number}</Button>
                            ))}
                          </div>
                        </div>
                      )}
                    </CardBody>
                  </Card>
                </div>

                <Card>
                  <CardHeader title="Aplicacoes anteriores" subtitle="Preparacoes salvas, reimpressoes e questoes ja usadas" action={<Badge tone="neutral">{history.length}</Badge>} />
                  <CardBody className="space-y-2">
                    {history.map((entry, index) => {
                      const prepared = onlineConfig?.activeHistoryId === entry.id
                      const qList = (entry.questionNumbers || []).join(', ')
                      return (
                        <div key={entry.id} className={`rounded-lg border p-3 flex flex-wrap items-center gap-3 ${prepared ? 'border-primary/50 bg-primary-soft/20' : 'border-border'}`}>
                          <button type="button" onClick={() => setViewApplication(entry)} className="flex-1 min-w-[220px] flex items-center gap-2 text-left group rounded-md -m-1 p-1 transition hover:bg-surface-2" title="Ver prova aplicada e versoes">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-text group-hover:text-primary transition">{historyLabel(entry, index)} {prepared ? <span className="text-primary">- preparada</span> : ''}</p>
                              <p className="text-xs text-subtle">{entry.questionCount || entry.questionNumbers?.length || 0} questoes - {entry.durationMinutes || '-'} min - Q: {qList || '-'}</p>
                            </div>
                            <ChevronRight size={16} className="text-subtle group-hover:text-primary shrink-0 transition" />
                          </button>
                          <Badge tone={entry.type === 'impressa' ? 'info' : 'neutral'}>{entry.type || 'online'}</Badge>
                          <Button size="sm" variant="secondary" icon={Printer} onClick={() => reprintHistory(entry)}>{entry.type === 'impressa' ? 'Reimprimir' : 'Imprimir'}</Button>
                          <Button size="sm" icon={Play} onClick={() => openHistoryApplication(entry)}>Aplicar online</Button>
                          {prepared && <Button size="sm" variant="secondary" icon={Lock} onClick={blockPrepared}>Bloquear</Button>}
                          <button className="text-subtle hover:text-danger" onClick={() => setDeleteHistory(entry)} aria-label="Excluir historico"><Trash2 size={16} /></button>
                        </div>
                      )
                    })}
                    {history.length === 0 && <p className="text-sm text-muted">Nenhuma aplicacao registrada para esta turma.</p>}
                  </CardBody>
                </Card>
              </>
            ) : examKey ? (
              <p className="text-sm text-muted pt-2">Carregando avaliacao...</p>
            ) : null}
          </CardBody>
        </Card>
      </PageState>
      </>
      )}

      <Modal
        open={!!editor}
        onClose={() => !editorBusy && setEditor(null)}
        title={editor?.key ? 'Editar prova' : 'Criar nova prova'}
        description={editor?.key || `Módulo: ${activeModule?.name || '-'}`}
        size="xl"
        footer={<>
          <Button variant="ghost" onClick={() => setEditor(null)} disabled={editorBusy}>Cancelar</Button>
          <Button icon={CheckCircle2} loading={editorBusy} onClick={saveEvaluationEditor}>Salvar prova</Button>
        </>}
      >
        {editor && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Input label="Título da prova" value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} />
              <Input label="Tema" value={editor.theme} onChange={(event) => setEditor({ ...editor, theme: event.target.value })} />
              <Select label="Aplicar alterações em" value={editor.scope || 'class'} onChange={(event) => setEditor({ ...editor, scope: event.target.value })}>
                <option value="class">Somente esta turma ({className})</option>
                <option value="course">Todas as turmas do curso</option>
              </Select>
              <p className="self-end pb-2 text-xs text-muted">O curso inteiro substitui apenas esta prova nas turmas listadas na confirmação.</p>
              <label className="md:col-span-2 text-sm text-text">
                <span className="mb-1 block text-xs font-medium text-muted">Instruções para a prova</span>
                <textarea value={editor.rubric} onChange={(event) => setEditor({ ...editor, rubric: event.target.value })} rows="3" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text" placeholder="Orientações, materiais permitidos e critérios." />
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
              <div><h3 className="font-semibold text-text">Questões</h3><p className="text-xs text-muted">{editor.questions.length} questão(ões)</p></div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon={Library} onClick={openQuestionBank}>Banco de questões</Button>
                <Button size="sm" icon={Plus} onClick={() => setEditor((current) => ({ ...current, questions: [...current.questions, editorQuestion()] }))}>Adicionar questão</Button>
              </div>
            </div>
            <div className="space-y-4">
              {editor.questions.map((question, questionIndex) => (
                <Card key={questionIndex} className="p-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="info">Questão {questionIndex + 1}</Badge>
                    <div className="flex-1" />
                    <Button size="sm" variant="ghost" icon={ArrowUp} onClick={() => moveQuestion(questionIndex, -1)} disabled={questionIndex === 0}>Subir</Button>
                    <Button size="sm" variant="ghost" icon={ArrowDown} onClick={() => moveQuestion(questionIndex, 1)} disabled={questionIndex === editor.questions.length - 1}>Descer</Button>
                    <Button size="sm" variant="ghost" icon={Copy} onClick={() => duplicateQuestion(questionIndex)}>Duplicar</Button>
                    <Button size="sm" variant="ghost" icon={Library} onClick={() => saveQuestionToBank(question)}>Salvar no banco</Button>
                    <Button size="sm" variant="ghost" icon={Trash2} onClick={() => removeQuestion(questionIndex)}>Excluir</Button>
                  </div>
                  <textarea value={question.text} onChange={(event) => updateEditorQuestion(questionIndex, { text: event.target.value })} rows="3" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text" placeholder="Texto da questão" />
                  <div className="space-y-2">
                    {question.alternatives.map((alternative, alternativeIndex) => (
                      <div key={alternativeIndex} className={`flex items-center gap-2 rounded-lg border p-2 ${alternative.isCorrect ? 'border-success/60 bg-success-soft/30' : 'border-border'}`}>
                        <input type="radio" name={`correct-${questionIndex}`} checked={alternative.isCorrect} onChange={() => updateAlternative(questionIndex, alternativeIndex, { isCorrect: true })} aria-label={`Marcar alternativa ${alternative.letter} como correta`} />
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-bold text-muted">{alternative.letter}</span>
                        <input value={alternative.text} onChange={(event) => updateAlternative(questionIndex, alternativeIndex, { text: event.target.value })} className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-3 text-sm text-text" placeholder={`Alternativa ${alternative.letter}`} />
                        <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Excluir alternativa ${alternative.letter}`} onClick={() => removeAlternative(questionIndex, alternativeIndex)} />
                      </div>
                    ))}
                    <Button size="sm" variant="secondary" icon={Plus} onClick={() => addAlternative(questionIndex)}>Adicionar alternativa</Button>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={bankOpen} onClose={() => { setBankOpen(false); setBankEditor(null) }} title="Banco de questões" description="Importe uma questão ou edite o acervo reutilizável." size="lg">
        {bankEditor ? (
          <div className="space-y-3">
            <Input label="Categoria" value={bankEditor.category || ''} onChange={(event) => setBankEditor({ ...bankEditor, category: event.target.value })} />
            <textarea value={bankEditor.questionText || ''} onChange={(event) => setBankEditor({ ...bankEditor, questionText: event.target.value })} rows="3" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text" />
            {(bankEditor.alternatives || []).map((alternative, index) => (
              <div key={index} className="flex items-center gap-2">
                <input type="radio" name="bank-correct" checked={alternative.isCorrect === true || alternative.letter === bankEditor.correctAnswer} onChange={() => setBankEditor({ ...bankEditor, correctAnswer: alternative.letter, alternatives: bankEditor.alternatives.map((item, itemIndex) => ({ ...item, isCorrect: itemIndex === index })) })} />
                <span className="w-6 text-xs font-bold text-muted">{alternative.letter}</span>
                <input value={alternative.text || ''} onChange={(event) => setBankEditor({ ...bankEditor, alternatives: bankEditor.alternatives.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item) })} className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-sm text-text" />
              </div>
            ))}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setBankEditor(null)}>Voltar</Button><Button onClick={saveBankEditor}>Salvar alterações</Button></div>
          </div>
        ) : (
          <div className="space-y-2 max-h-[65vh] overflow-auto">
            {bankQuestions.map((question) => (
              <div key={question.key} className="rounded-lg border border-border p-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1"><p className="text-sm font-medium text-text">{question.questionText}</p><p className="mt-1 text-xs text-subtle">{question.category || 'Geral'} · resposta {question.correctAnswer || '-'}</p></div>
                  <Button size="sm" variant="secondary" icon={Edit3} onClick={() => setBankEditor({ ...question, alternatives: (question.alternatives || []).map((item) => ({ ...item })) })}>Editar</Button>
                  <Button size="sm" icon={Plus} onClick={() => addBankQuestion(question)}>Adicionar</Button>
                  <Button size="sm" variant="ghost" icon={Trash2} aria-label="Excluir questão do banco" onClick={() => deleteBankQuestion(question)} />
                </div>
              </div>
            ))}
            {bankQuestions.length === 0 && <EmptyState icon={Library} title="Banco vazio" description="Use “Salvar no banco” em uma questão da prova para iniciar o acervo." />}
          </div>
        )}
      </Modal>

      <Modal
        open={!!applyHistory}
        onClose={() => busy !== 'applyHistory' && setApplyHistory(null)}
        title="Aplicar prova novamente"
        description="As questões salvas serão mantidas. Configure esta nova aplicação."
        footer={<>
          <Button variant="ghost" onClick={() => setApplyHistory(null)} disabled={busy === 'applyHistory'}>Cancelar</Button>
          <Button icon={Play} loading={busy === 'applyHistory'} onClick={prepareHistory}>Aplicar prova</Button>
        </>}
      >
        {applyHistory && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-surface-2/60 p-3">
              <p className="text-sm font-semibold text-text">{applyHistory.entry.label || 'Aplicação salva'}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge tone="neutral">{applyHistory.entry.questionCount || applyHistory.entry.questionNumbers?.length || 0} questões fixas</Badge>
                <Badge tone="info">{applyHistory.availableVersions} {applyHistory.availableVersions === 1 ? 'versão disponível' : 'versões disponíveis'}</Badge>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input label="Versões online" type="number" min="1" max={applyHistory.availableVersions} value={applyHistory.onlineVersions} onChange={(e) => setApplyHistory({ ...applyHistory, onlineVersions: Math.max(1, Math.min(applyHistory.availableVersions, Number(e.target.value) || 1)) })} />
              <Input label="Duração (min)" type="number" min="1" value={applyHistory.durationMinutes} onChange={(e) => setApplyHistory({ ...applyHistory, durationMinutes: e.target.value })} />
              <Input label="Sala de espera (min)" type="number" min="0" value={applyHistory.waitingRoomMinutes} helper="Padrão: 10 minutos" onChange={(e) => setApplyHistory({ ...applyHistory, waitingRoomMinutes: e.target.value })} />
              <Select label="Início do cronômetro" value={applyHistory.timerMode} onChange={(e) => setApplyHistory({ ...applyHistory, timerMode: e.target.value })}>
                <option value="per_attempt">Quando cada aluno iniciar</option>
                <option value="collective">Junto com a turma</option>
              </Select>
              <div className="sm:col-span-2">
                <Input label="Tentativas permitidas" type="number" min="1" max="10" step="1" placeholder="Ilimitadas" value={applyHistory.maxAttempts} onChange={(e) => setApplyHistory({ ...applyHistory, maxAttempts: e.target.value })} helper="Padrão: 1 tentativa. Deixe em branco para não limitar." />
              </div>
              {applyHistory.tokenEnabled && <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                <Input label="Token de acesso" value={applyHistory.accessToken} maxLength={5} autoComplete="off" spellCheck={false} className="font-mono text-base font-semibold tracking-[0.2em]" helper="Obrigatório · 5 letras" onChange={(e) => setApplyHistory({ ...applyHistory, accessToken: normalizeTokenInput(e.target.value) })} />
                <Button type="button" variant="secondary" icon={RefreshCw} aria-label="Gerar novo token" onClick={() => setApplyHistory({ ...applyHistory, accessToken: generateExamToken() })}>Novo</Button>
              </div>}
            </div>

            <div className="rounded-lg border border-border p-3">
              <div className="space-y-3">
                <Switch label="Cronômetro ativo" checked={applyHistory.timerEnabled} onChange={(value) => setApplyHistory({ ...applyHistory, timerEnabled: value })} />
                <Switch label="Exigir token de acesso" checked={applyHistory.tokenEnabled} onChange={(value) => setApplyHistory({ ...applyHistory, tokenEnabled: value, accessToken: applyHistory.accessToken || generateExamToken() })} />
              </div>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog open={!!deleteHistory} onClose={() => setDeleteHistory(null)} onConfirm={removeHistory} danger title="Excluir historico?" description={deleteHistory?.label || deleteHistory?.id} confirmLabel="Excluir" />
      <FinishApplicationModal
        open={!!finishApplication}
        onClose={() => setFinishApplication(null)}
        summary={finishSummary}
        busy={finishBusy}
        onSubmit={() => finishSelected('submit')}
        onDiscard={() => finishSelected('discard')}
      />
    </div>
  )
}
