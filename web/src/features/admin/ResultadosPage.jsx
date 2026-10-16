import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, BarChart3, BookOpen, CheckCircle2, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Download, Eye, EyeOff, FilePlus2, FileStack, Info, Layers3, Loader2, RotateCcw, Target, Trash2, TrendingUp, XCircle } from 'lucide-react'
import '../../styles/resultados-board.css'
import { DataTable } from '../../components/ui/Table'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Modal, ConfirmDialog } from '../../components/ui/Modal'
import { PageState } from '../../components/ui/PageState'
import { PageHeader } from '../../components/ui/PageHeader'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { printBoletim } from './boletimPrint'
import { useToast } from '../../context/ToastProvider'
import { normalizeEvaluation, snapshotsFromHistory } from './examTools'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'
import { deliveryLabel } from './attemptDelivery'

function useCountUp(value, durationMs = 900) {
  const [display, setDisplay] = useState(0)
  useEffect(() => {
    const target = Number(value) || 0
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(target)
      return
    }
    let raf = 0
    const start = performance.now()
    const tick = (now) => {
      const t = Math.min(1, (now - start) / durationMs)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(target * eased)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, durationMs])
  return display
}

const EMPTY_MANUAL = {
  mode: 'quick',
  studentEmail: '',
  className: '',
  courseId: '',
  examKey: '',
  score: '',
  correctCount: '',
  totalCount: '',
  type: 'impressa',
  snapshotId: '',
  answers: {},
}

const RESULT_POLICIES = [
  { value: 'highest', label: 'Melhor nota' },
  { value: 'latest', label: 'Última tentativa' },
  { value: 'average', label: 'Média das consideradas' },
  { value: 'selected', label: 'Tentativa escolhida' },
]

const MODULE_ACCENTS = ['#d9776b', '#6fa294', '#6f88b0', '#c6a35b', '#9b7fa6', '#c07c9e']

// Rótulo curto da política para a linha compacta.
const POLICY_SHORT = { highest: 'Maior nota', latest: 'Última', average: 'Média', selected: 'Escolhida' }

// Faixa de cor da nota (escala 0-100) — gradação quente "Brasa", não arco-íris.
const gradeBandClass = (score) => {
  const g = Number(score) / 10
  if (!Number.isFinite(g)) return 'rb-gmuted'
  return g >= 9 ? 'rb-g9' : g >= 7 ? 'rb-g7' : g >= 6 ? 'rb-g6' : 'rb-g0'
}

// Estado de uma tentativa dentro do grupo (fonte: campos enriquecidos do backend).
// 'count' = compõe a nota · 'off' = desconsiderada (arquivada) · 'disc' = ativa mas a regra não usa.
const attemptState = (s) => (s.resultStatus === 'archived' ? 'off' : (s.countsTowardResult === true ? 'count' : 'disc'))
const STATE_LABEL = { count: 'Compõe a nota', disc: 'Descartada', off: 'Desconsiderada' }
const fmtNota = (s) => (Number(s) / 10).toFixed(1).replace('.', ',')

// Explica em uma linha como a nota da prova foi formada, conforme a política.
function formulaText(policy, attempts) {
  const counts = attempts.filter((a) => a.countsTowardResult === true && a.resultStatus !== 'archived')
  if (policy === 'average') {
    const parts = counts.map((a) => fmtNota(a.score)).join(' + ')
    const avg = counts.length ? counts.reduce((s, a) => s + Number(a.score), 0) / counts.length : 0
    return `Média das consideradas — (${parts}) ÷ ${counts.length} = ${fmtNota(avg)}.`
  }
  if (policy === 'latest') return 'Última tentativa — vale a entrega mais recente entre as que contam.'
  if (policy === 'selected') return 'Tentativa escolhida — o professor fixou qual tentativa vale.'
  return 'Maior nota — entre as tentativas que contam, vale a maior.'
}

function ResultPageFrame({ title, subtitle, backLabel, onBack, action = null, children }) {
  return (
    <section className="space-y-5">
      <header>
        <button
          type="button"
          onClick={onBack}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted transition hover:text-text"
        >
          <ArrowLeft size={16} />
          {backLabel}
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold text-text">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          </div>
          {action}
        </div>
      </header>
      <div>{children}</div>
    </section>
  )
}

function resultForAttempts(attempts) {
  const considered = attempts.filter((item) => item.resultStatus !== 'archived' && Number.isFinite(Number(item.score)))
  const policy = attempts.find((item) => item.aggregationPolicy)?.aggregationPolicy || 'highest'
  if (considered.length === 0) return { policy, score: null }
  if (policy === 'average') return { policy, score: considered.reduce((sum, item) => sum + Number(item.score), 0) / considered.length }
  if (policy === 'latest') return { policy, score: Number([...considered].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0].score) }
  if (policy === 'selected') {
    const picked = considered.find((item) => item.selectedForResult || item.countsTowardResult) || considered[0]
    return { policy, score: Number(picked.score) }
  }
  return { policy, score: Math.max(...considered.map((item) => Number(item.score))) }
}

// Chave de grupo alinhada ao backend (attemptGroupKey): inclui o e-mail para
// não misturar tentativas legadas de alunos diferentes na mesma turma/prova.
function attemptGroupKey(item) {
  const email = String(item.student?.email || item.studentEmail || item.email || '').trim().toLowerCase()
  const course = String(item.student?.courseId || item.courseId || '')
  const klass = String(item.student?.studentClass || item.studentClass || '')
  const scope = item.applicationId ? `application:${item.applicationId}` : `legacy-exam:${String(item.examKey || '')}`
  return `${email}::${course}::${klass}::${scope}`
}

// Nota consolidada por grupo. Prefere o valor já calculado pelo backend
// (consolidatedScore); só recalcula localmente para registros legados sem o campo.
function consolidatedScores(submissions) {
  const groups = new Map()
  submissions.forEach((item) => {
    const key = attemptGroupKey(item)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  })
  return [...groups.values()].map((attempts) => {
    const enriched = attempts.find((a) => a.consolidatedScore != null)
    return enriched != null ? Number(enriched.consolidatedScore) : resultForAttempts(attempts).score
  }).filter(Number.isFinite)
}

function studentInClass(student, className) {
  if (!className) return true
  if (student.studentClass === className) return true
  return (student.classes || []).some((cls) => (typeof cls === 'string' ? cls : cls?.name) === className)
}

function snapshotOptions(history) {
  const items = []
  ;(history || []).forEach((entry, entryIndex) => {
    snapshotsFromHistory(entry).forEach((snapshot, snapshotIndex) => {
      items.push({
        id: `${entry.id || entryIndex}:${snapshotIndex}`,
        entry,
        snapshot,
        label: `${entry.type === 'impressa' ? 'Impressa' : 'Online'} ${entry.label || `#${entryIndex + 1}`} - ${snapshot.version || 'A'} - codigo ${snapshot.examCode || '-'}`,
      })
    })
  })
  return items
}

export default function ResultadosPage() {
  const navigate = useNavigate()
  const { studentId = '', submissionId = '' } = useParams()
  const { courseId: activeCourseId, courseName, className: activeClassName } = useAdminWorkspace()
  // Boletim consolidado (provas + frequência) do aluno, pela caixa de impressão.
  async function openBoletim(email) {
    try {
      const report = await api.get(`/api/admin/student/report?email=${encodeURIComponent(email)}&courseId=${encodeURIComponent(activeCourseId || '')}`)
      if (!printBoletim(report)) toast.error('O navegador bloqueou a janela de impressão. Libere pop-ups para este site.')
    } catch (e) { toast.error(e.message) }
  }
  const contextQuery = new URLSearchParams({ courseId: activeCourseId, studentClass: activeClassName }).toString()
  const { data, loading, error, refetch } = useApi(`/api/admin/submissions?${contextQuery}`)
  const { data: students } = useApi(`/api/admin/students?${contextQuery}`)
  const { data: classes } = useApi(`/api/admin/classes?${contextQuery}`)
  const { data: applicationsData } = useApi(`/api/admin/exam-applications?${contextQuery}`)
  const [del, setDel] = useState(null)
  const [detail, setDetail] = useState(null)
  const [review, setReview] = useState(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [manual, setManual] = useState(EMPTY_MANUAL)
  const [structure, setStructure] = useState([])
  const [courseStructure, setCourseStructure] = useState([])
  const [evaluation, setEvaluation] = useState(null)
  const [history, setHistory] = useState([])
  const [loadingManual, setLoadingManual] = useState(false)
  const [filterClass] = useState(activeClassName)
  const [filterExam, setFilterExam] = useState('')
  const [filterApplication, setFilterApplication] = useState('')
  const [resultActionId, setResultActionId] = useState(null)
  const [openModules, setOpenModules] = useState(() => new Set())
  const [openExams, setOpenExams] = useState(() => new Set())
  const toast = useToast()

  const courseClasses = useMemo(() => (classes || []).filter((c) => c.courseId === activeCourseId && c.name === activeClassName), [classes, activeCourseId, activeClassName])
  const courseClassNames = useMemo(() => new Set(courseClasses.map((c) => c.name)), [courseClasses])
  const rows = (data || []).map((s, i) => ({
    id: s.id || i,
    ...s,
    studentName: s.studentName || s.student?.name || '',
    studentEmail: s.studentEmail || s.student?.email || s.email || '',
    studentClass: s.studentClass || s.student?.studentClass || '',
  })).filter((s) => !activeCourseId || s.courseId === activeCourseId || courseClassNames.has(s.studentClass))
  const examOptions = useMemo(() => [...new Set(rows.map((r) => r.examKey).filter(Boolean))], [data, activeCourseId, courseClassNames])
  const applicationById = useMemo(() => new Map((applicationsData?.applications || []).map((application) => [application.id, application])), [applicationsData])
  const applicationOptions = useMemo(() => (applicationsData?.applications || []).filter((application) =>
    (!activeCourseId || application.courseId === activeCourseId)
    && (!filterClass || application.studentClass === filterClass)
    && (!filterExam || application.examKey === filterExam)), [applicationsData, activeCourseId, filterClass, filterExam])
  const filteredRows = useMemo(() => rows.filter((r) =>
    (!filterClass || r.studentClass === filterClass)
    && (!filterExam || r.examKey === filterExam)
    && (!filterApplication || r.applicationId === filterApplication)), [data, activeCourseId, courseClassNames, filterClass, filterExam, filterApplication])
  const examMeta = useMemo(() => {
    const map = new Map()
    ;(courseStructure || []).forEach((module, moduleIndex) => {
      const moduleName = module.name || module.title || `Módulo ${moduleIndex + 1}`
      const moduleId = String(module.id || module.key || moduleName)
      ;(module.units || module.items || []).forEach((unit) => {
        if (!unit.avaliacaoKey) return
        map.set(unit.avaliacaoKey, {
          moduleId,
          moduleName,
          moduleIndex,
          examName: unit.name || unit.title || unit.avaliacaoKey,
        })
      })
    })
    return map
  }, [courseStructure])
  const studentRows = useMemo(() => {
    const grouped = new Map()
    filteredRows.forEach((submission) => {
      const email = String(submission.studentEmail || submission.student?.email || '').trim().toLowerCase()
      const key = email || `sem-email-${submission.studentName || submission.id}`
      if (!grouped.has(key)) {
        grouped.set(key, {
          id: key,
          studentEmail: email,
          studentName: submission.studentName || submission.student?.name || email || 'Aluno',
          studentClass: submission.studentClass || submission.student?.studentClass || '-',
          submissions: [],
        })
      }
      grouped.get(key).submissions.push(submission)
    })
    return [...grouped.values()].map((student) => {
      const scores = consolidatedScores(student.submissions)
      const modules = new Set(student.submissions.map((item) => examMeta.get(item.examKey)?.moduleId || 'outros'))
      return {
        ...student,
        average: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
        submissionCount: student.submissions.length,
        moduleCount: modules.size,
        publishedCount: student.submissions.filter((item) => item.gradePublished === true).length,
      }
    }).sort((a, b) => a.studentName.localeCompare(b.studentName, 'pt-BR'))
  }, [filteredRows, examMeta])
  const routeStudentId = useMemo(() => {
    try { return decodeURIComponent(studentId).trim().toLowerCase() } catch { return String(studentId).trim().toLowerCase() }
  }, [studentId])
  const selectedStudent = useMemo(() => {
    if (!routeStudentId) return null
    return studentRows.find((student) => String(student.id || '').toLowerCase() === routeStudentId
      || String(student.studentEmail || '').toLowerCase() === routeStudentId) || null
  }, [studentRows, routeStudentId])
  const selectedStudentPath = selectedStudent
    ? `/resultados/aluno/${encodeURIComponent(selectedStudent.studentEmail || selectedStudent.id)}`
    : '/resultados'
  const routeSubmission = useMemo(() => {
    if (!submissionId || !selectedStudent) return null
    return selectedStudent.submissions.find((submission) => String(submission.id) === String(submissionId)) || null
  }, [selectedStudent, submissionId])
  const selectedStudentModules = useMemo(() => {
    if (!selectedStudent) return []
    const grouped = new Map()
    selectedStudent.submissions.forEach((submission) => {
      const meta = examMeta.get(submission.examKey) || { moduleId: 'outros', moduleName: 'Outras avaliações', moduleIndex: 999, examName: submission.examKey }
      if (!grouped.has(meta.moduleId)) grouped.set(meta.moduleId, { ...meta, submissions: [] })
      grouped.get(meta.moduleId).submissions.push({ ...submission, examName: meta.examName })
    })
    return [...grouped.values()].map((module) => {
      const counters = {}
      const submissions = [...module.submissions]
        .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0))
        .map((submission) => {
          const scopeKey = submission.applicationId || submission.examKey
          counters[scopeKey] = (counters[scopeKey] || 0) + 1
          return { ...submission, displayAttempt: submission.attemptNumber || counters[scopeKey] }
        })
        .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
      const exams = new Map()
      submissions.forEach((submission) => {
        const scopeKey = submission.applicationId || `legacy:${submission.examKey}`
        if (!exams.has(scopeKey)) exams.set(scopeKey, {
          scopeKey,
          examKey: submission.examKey,
          examName: submission.examName,
          applicationId: submission.applicationId || null,
          application: applicationById.get(submission.applicationId) || null,
          attempts: [],
        })
        exams.get(scopeKey).attempts.push(submission)
      })
      const examGroups = [...exams.values()].map((exam) => {
        const enriched = exam.attempts.find((a) => a.consolidatedScore != null)
        const fallback = resultForAttempts(exam.attempts)
        const policy = exam.attempts.find((a) => a.aggregationPolicy)?.aggregationPolicy || fallback.policy
        const score = enriched != null ? Number(enriched.consolidatedScore) : fallback.score
        return { ...exam, policy, score }
      })
      // Linhagem: agrupa as aplicações da MESMA prova (mesmo examKey) sob um tronco.
      const provasMap = new Map()
      examGroups.forEach((ex) => {
        const key = ex.examKey || ex.scopeKey
        if (!provasMap.has(key)) provasMap.set(key, { examKey: ex.examKey, examName: ex.examName, applications: [] })
        provasMap.get(key).applications.push(ex)
      })
      const appTime = (ex) => Number(new Date(ex.application?.createdAt || ex.attempts[0]?.timestamp || 0))
      const provas = [...provasMap.values()].map((p) => ({
        ...p,
        applications: p.applications.slice().sort((a, b) => appTime(b) - appTime(a)),
      }))
      const scores = examGroups.map((exam) => exam.score).filter(Number.isFinite)
      return { ...module, submissions, examGroups, provas, average: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null }
    }).sort((a, b) => a.moduleIndex - b.moduleIndex || a.moduleName.localeCompare(b.moduleName, 'pt-BR'))
  }, [selectedStudent, examMeta, applicationById])
  const analytics = useMemo(() => {
    const scores = consolidatedScores(filteredRows)
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
    const approved = scores.filter((x) => x >= 60).length
    const buckets = [0, 0, 0, 0]
    scores.forEach((x) => { const i = x < 50 ? 0 : x < 70 ? 1 : x < 90 ? 2 : 3; buckets[i]++ })
    return { avg: avg / 10, aprov: scores.length ? Math.round((approved / scores.length) * 100) : 0, count: filteredRows.length, buckets, maxBucket: Math.max(1, ...buckets) }
  }, [filteredRows])
  const avgCount = useCountUp(analytics.avg)
  const aprovCount = useCountUp(analytics.aprov)
  const countCount = useCountUp(analytics.count)
  const selectedClass = courseClasses.find((c) => c.name === manual.className && (!manual.courseId || c.courseId === manual.courseId))
  const classStudents = (students || []).filter((student) => {
    if (!studentInClass(student, manual.className)) return false
    if (!activeCourseId || manual.className) return true
    const raw = student.classes && student.classes.length ? student.classes : (student.studentClass ? [student.studentClass] : [])
    return raw.map((cls) => typeof cls === 'string' ? cls : cls?.name).some((name) => courseClassNames.has(name))
  })
  const examsFromStructure = structure.flatMap((mod) => (mod.units || mod.items || [])
    .filter((unit) => unit.avaliacaoKey)
    .map((unit) => ({ key: unit.avaliacaoKey, label: `${mod.name || mod.title || mod.id} - ${unit.name || unit.title || unit.avaliacaoKey}` })))
  const fallbackExams = [...new Set(rows.map((r) => r.examKey).filter(Boolean))].map((key) => ({ key, label: key }))
  const exams = examsFromStructure.length > 0 ? examsFromStructure : fallbackExams
  const normalizedEval = useMemo(() => evaluation ? normalizeEvaluation(evaluation) : null, [evaluation])
  const snapshots = useMemo(() => snapshotOptions(history), [history])
  const selectedSnapshot = snapshots.find((item) => item.id === manual.snapshotId)?.snapshot || null
  const cardRows = selectedSnapshot
    ? selectedSnapshot.questions.map((q, index) => ({ key: `pos-${index + 1}`, title: `Questão ${index + 1}`, question: q, letters: (q.alternatives || []).map((alt) => alt.displayLetter || alt.letter).filter(Boolean) }))
    : (normalizedEval?.questions || []).map((q) => ({ key: `orig-${q.originalNumber}`, title: `Questão ${q.originalNumber}`, question: q, letters: (q.alternatives || []).map((alt) => alt.letter).filter(Boolean) }))

  useEffect(() => {
    if (!activeCourseId) {
      setCourseStructure([])
      return
    }
    let active = true
    api.get(`/api/admin/courses/${encodeURIComponent(activeCourseId)}/structure?studentClass=${encodeURIComponent(activeClassName)}`)
      .then((response) => active && setCourseStructure(response.structure || []))
      .catch(() => active && setCourseStructure([]))
    return () => { active = false }
  }, [activeCourseId, activeClassName])

  useEffect(() => {
    const main = document.querySelector('main')
    if (main) main.scrollTo({ top: 0, behavior: 'auto' })
  }, [studentId, submissionId])

  useEffect(() => {
    if (!submissionId) {
      setDetail(null)
      setReview(null)
      setReviewLoading(false)
      return
    }
    if (routeSubmission) loadSubmissionReview(routeSubmission)
  }, [submissionId, routeSubmission])

  useEffect(() => {
    if (!manual.courseId) {
      setStructure([])
      return
    }
    api.get(`/api/admin/courses/${encodeURIComponent(manual.courseId)}/structure?studentClass=${encodeURIComponent(activeClassName)}`)
      .then((r) => setStructure(r.structure || []))
      .catch(() => setStructure([]))
  }, [manual.courseId])

  useEffect(() => {
    if (!manual.examKey) {
      setEvaluation(null)
      setHistory([])
      return
    }
    let active = true
    setLoadingManual(true)
    Promise.all([
      api.get(`/api/admin/evaluation/${encodeURIComponent(manual.examKey)}`).catch(() => null),
      manual.className
        ? api.get(`/api/admin/exam-history?studentClass=${encodeURIComponent(manual.className)}&courseId=${encodeURIComponent(manual.courseId)}&examKey=${encodeURIComponent(manual.examKey)}`).catch(() => ({ history: [] }))
        : Promise.resolve({ history: [] }),
    ]).then(([ev, hist]) => {
      if (!active) return
      setEvaluation(ev?.evaluation || ev)
      setHistory(hist?.history || [])
      setManual((m) => ({ ...m, answers: {}, snapshotId: '' }))
    }).finally(() => active && setLoadingManual(false))
    return () => { active = false }
  }, [manual.examKey, manual.className, manual.courseId])

  function openManual() {
    setManual({ ...EMPTY_MANUAL, courseId: activeCourseId, className: activeClassName })
    setManualOpen(true)
  }

  function updateClass(className) {
    const cls = courseClasses.find((c) => c.name === className)
    setManual({ ...manual, className, courseId: cls?.courseId || '', studentEmail: '', examKey: '', answers: {}, snapshotId: '' })
  }

  function updateAnswer(rowKey, letter) {
    setManual((m) => ({ ...m, answers: { ...m.answers, [rowKey]: letter } }))
  }

  async function remove() {
    try {
      await api.post('/api/admin/submissions/delete', {
        id: del.id,
        studentEmail: del.studentEmail || del.email || del.student?.email,
        examKey: del.examKey,
      })
      toast.success('Registro excluido')
      setDel(null)
      if (submissionId) navigate(selectedStudentPath)
      else await refetch()
    } catch (e) { toast.error(e.message) }
  }

  async function controlAttempt(submission, action, policy) {
    setResultActionId(`${submission.id}:${action}`)
    try {
      await api.post('/api/admin/submissions/result-control', { submissionId: submission.id, action, policy })
      toast.success(action === 'archive' ? 'Tentativa desconsiderada' : action === 'restore' ? 'Tentativa reconsiderada' : action === 'select' ? 'Tentativa escolhida para a nota' : 'Regra de cálculo atualizada')
      await refetch()
    } catch (error) {
      toast.error(error.message || 'Não foi possível atualizar a tentativa')
    } finally {
      setResultActionId(null)
    }
  }

  async function createManual() {
    if (!manual.studentEmail || !manual.examKey) return toast.error('Informe aluno e prova')
    try {
      if (manual.mode === 'card') {
        const answers = {}
        const questionNumbers = []
        let blanks = 0
        if (selectedSnapshot) {
          selectedSnapshot.questions.forEach((question, index) => {
            questionNumbers.push(Number(question.originalNumber))
            const picked = manual.answers[`pos-${index + 1}`]
            if (!picked) { blanks++; return }
            const alt = (question.alternatives || []).find((item) => String(item.displayLetter || item.letter).toUpperCase() === String(picked).toUpperCase())
            if (alt?.letter) answers[question.originalNumber] = alt.letter
          })
        } else {
          ;(normalizedEval?.questions || []).forEach((question) => {
            questionNumbers.push(Number(question.originalNumber))
            const picked = manual.answers[`orig-${question.originalNumber}`]
            if (!picked) { blanks++; return }
            answers[question.originalNumber] = picked
          })
        }
        if (Object.keys(answers).length === 0) return toast.error('Marque ao menos uma resposta')
        if (blanks > 0 && !window.confirm(`${blanks} questao(oes) em branco serao contadas como erradas. Continuar?`)) return
        await api.post('/api/admin/submissions/create', {
          studentEmail: manual.studentEmail,
          examKey: manual.examKey,
          type: 'impressa',
          answers,
          questionNumbers,
        })
      } else {
        await api.post('/api/admin/submissions/create', {
          studentEmail: manual.studentEmail,
          examKey: manual.examKey,
          type: manual.type || 'impressa',
          score: manual.score === '' ? undefined : Number(manual.score),
          correctCount: manual.correctCount === '' ? undefined : Number(manual.correctCount),
          totalCount: manual.totalCount === '' ? undefined : Number(manual.totalCount),
        })
      }
      toast.success('Nota lancada')
      setManualOpen(false)
      refetch()
    } catch (e) { toast.error(e.message) }
  }

  async function publishGrades(items, published) {
    const ids = items.map((item) => item.id).filter((id) => id !== undefined && id !== null)
    if (ids.length === 0) return toast.error('Nenhuma nota selecionada')
    if (!window.confirm(`${published ? 'Publicar' : 'Ocultar'} ${ids.length} nota(s) para os alunos?`)) return
    try {
      await api.post('/api/admin/submissions/publish', { ids, published })
      toast.success(published ? 'Notas publicadas' : 'Notas ocultadas')
      if (submissionId) navigate(selectedStudentPath)
      else {
        setDetail(null)
        setReview(null)
        await refetch()
      }
    } catch (e) { toast.error(e.message) }
  }

  function exportCsv(row) {
    const studentClass = row.studentClass || row.student?.studentClass
    if (!studentClass || !row.examKey) return toast.error('Registro sem turma/prova para exportar')
    const query = row.applicationId ? `?applicationId=${encodeURIComponent(row.applicationId)}` : ''
    window.open(`/api/admin/export-grades/${encodeURIComponent(studentClass)}/${encodeURIComponent(row.examKey)}${query}`, '_blank')
  }

  async function loadSubmissionReview(submission) {
    setDetail(submission)
    setReview(null)
    if (!submission?.id) return
    setReviewLoading(true)
    try {
      setReview(await api.get(`/api/admin/submissions/${encodeURIComponent(submission.id)}/review`))
    } catch (error) {
      toast.error(error.message || 'Não foi possível montar a prova corrigida')
    } finally {
      setReviewLoading(false)
    }
  }

  function openSubmissionReview(submission) {
    if (!selectedStudent || !submission?.id) return
    navigate(`${selectedStudentPath}/prova/${encodeURIComponent(submission.id)}`)
  }

  function openStudentResults(student) {
    const identifier = student?.studentEmail || student?.id
    if (!identifier) return
    navigate(`/resultados/aluno/${encodeURIComponent(identifier)}`)
  }

  function toggleModule(id) {
    setOpenModules((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleExam(key) {
    setOpenExams((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Renderiza uma prova/aplicação como linha compacta que expande.
  // leading = { type: 'exam' } (prova avulsa) ou { type: 'app', n } (ramo de aplicação).
  function renderExamRow(exam, leading) {
    const examOpen = openExams.has(exam.scopeKey)
    const attempts = exam.attempts
    const policy = exam.policy || 'highest'
    const busy = !!resultActionId
    const isApp = leading?.type === 'app'
    const unitLabel = isApp ? 'aplicação' : 'prova'
    const appDate = exam.application?.createdAt
      ? new Date(exam.application.createdAt).toLocaleDateString('pt-BR')
      : (attempts[0]?.timestamp ? new Date(attempts[0].timestamp).toLocaleDateString('pt-BR') : 'Data indisponível')
    const rowName = isApp ? appDate : (exam.examName || exam.examKey)
    const rowMeta = `${exam.applicationId ? `${exam.applicationId.slice(0, 12)} · ` : 'Registro legado · '}${attempts.length} ${attempts.length === 1 ? 'tentativa' : 'tentativas'}`
    return (
      <div className={`rb-prova ${examOpen ? 'open' : ''}`}>
        <button type="button" className="rb-row" onClick={() => toggleExam(exam.scopeKey)} aria-expanded={examOpen}>
          {isApp
            ? <span className="rb-apnum">Aplic. {leading.n}</span>
            : <span className="rb-pic"><RotateCcw size={16} /></span>}
          <span className="rb-pt">
            <span className="n">{rowName}</span>
            <span className="m">{rowMeta}</span>
          </span>
          <span className="rb-mini">
            {attempts.map((a) => {
              const st = attemptState(a)
              return <span key={a.id} className={`rb-mc ${st}`}><span className="d" /><span className="g">{Number.isFinite(Number(a.score)) ? fmtNota(a.score) : '-'}</span></span>
            })}
          </span>
          <span className="rb-rule">Regra: <b>{POLICY_SHORT[policy] || 'Maior nota'}</b></span>
          <span className={`rb-fg ${gradeBandClass(exam.score)}`}>{exam.score == null ? '-' : fmtNota(exam.score)}</span>
          <span className="rb-chev"><ChevronDown size={17} /></span>
        </button>
        {examOpen && (
        <div className="rb-detail">
          <div className="rb-dtop">
            <span className="rb-dlabel">Composição da nota</span>
            <span className="rb-polsel">
              <span className="rb-pollab">Regra</span>
              <select className="rb-sel" value={policy} disabled={busy} onClick={(e) => e.stopPropagation()} onChange={(event) => controlAttempt(attempts[0], 'policy', event.target.value)} aria-label={`Regra de cálculo de ${exam.examName || exam.examKey}`}>
                {RESULT_POLICIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </span>
          </div>
          <div className="rb-pbody">
            <div className="rb-atts">
              {attempts.map((submission) => {
                const st = attemptState(submission)
                const archived = st === 'off'
                return (
                  <div key={submission.id} className={`rb-att ${st}`}>
                    <span className="rb-abar" aria-hidden />
                    <div className="rb-al">
                      <div className="top">
                        <span className="rb-tn">Tentativa {submission.displayAttempt}</span>
                        <span className={`rb-tag ${st}`}>{STATE_LABEL[st]}</span>
                      </div>
                      <div className="meta">{submission.timestamp ? new Date(submission.timestamp).toLocaleString('pt-BR') : 'Data não registrada'} · {submission.type || 'online'} · Versão {submission.assignedVersion || '-'} · {submission.gradePublished === true ? 'Publicada' : 'Em revisão'}{deliveryLabel(submission) ? ` · ${deliveryLabel(submission)}` : ''}</div>
                    </div>
                    <span className={`rb-as ${gradeBandClass(submission.score)}`}>{Number.isFinite(Number(submission.score)) ? fmtNota(submission.score) : '-'}</span>
                    <div className="rb-acts">
                      {!archived && (
                        <button type="button" className="rb-btn pri" disabled={busy} title="Fixar esta tentativa como a nota" onClick={() => controlAttempt(submission, 'select')}><Target size={13} /><span>Usar esta nota</span></button>
                      )}
                      <button type="button" className="rb-btn" title="Ver a prova corrigida" onClick={() => openSubmissionReview(submission)}><Eye size={13} /><span>Ver prova</span></button>
                      {archived
                        ? <button type="button" className="rb-btn ok" disabled={busy} title="Voltar a tentativa ao cálculo" onClick={() => controlAttempt(submission, 'restore')}><RotateCcw size={13} /><span>Reconsiderar</span></button>
                        : <button type="button" className="rb-btn warn" disabled={busy} title="Tirar a tentativa do cálculo (não apaga)" onClick={() => controlAttempt(submission, 'archive')}><EyeOff size={13} /><span>Desconsiderar</span></button>}
                    </div>
                  </div>
                )
              })}
            </div>
            <span className="rb-arrow"><ArrowRight size={20} /></span>
            <div className="rb-result">
              <span className={`rn ${gradeBandClass(exam.score)}`}>{exam.score == null ? '-' : fmtNota(exam.score)}</span>
              <span className="rl">Nota da {unitLabel}<br />{POLICY_SHORT[policy] || 'Maior nota'}</span>
            </div>
          </div>
          <div className="rb-formula">
            <span className="ic"><Info size={13} /></span>
            <p><b>Como esta nota foi calculada:</b> {formulaText(policy, attempts)}</p>
          </div>
        </div>
        )}
      </div>
    )
  }

  const studentColumns = [
    { key: 'studentName', label: 'Aluno', render: (student) => (
      <button type="button" onClick={(event) => { event.stopPropagation(); openStudentResults(student) }} className="group flex items-center gap-3 text-left">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-bold text-primary ring-1 ring-transparent transition-transform group-hover:scale-105 group-hover:ring-primary">
          {(student.studentName || '?').split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase()}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-semibold text-text group-hover:text-primary">{student.studentName || student.studentEmail}</span>
          <span className="block truncate text-xs text-subtle">{student.studentEmail}</span>
        </span>
      </button>
    ) },
    { key: 'studentClass', label: 'Turma', render: (student) => student.studentClass || '-' },
    { key: 'submissionCount', label: 'Provas realizadas', render: (student) => <span className="font-semibold tabular-nums text-text">{student.submissionCount}</span> },
    { key: 'moduleCount', label: 'Módulos avaliados', render: (student) => <span className="inline-flex items-center gap-1.5 text-muted"><Layers3 size={14} />{student.moduleCount}</span> },
    { key: 'average', label: 'Média', render: (student) => {
      const score = Number(student.average)
      const tone = score >= 60 ? 'success' : score >= 40 ? 'warning' : 'danger'
      const color = score >= 60 ? 'var(--success)' : score >= 40 ? 'var(--warning)' : 'var(--danger)'
      return (
        <div className="flex flex-col gap-1.5">
          <Badge tone={tone} className="w-fit tabular-nums">{Number.isFinite(score) ? (score / 10).toFixed(1) : '-'}</Badge>
          {Number.isFinite(score) && (
            <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-2">
              <div className="meter-fill h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, score))}%`, background: color }} />
            </div>
          )}
        </div>
      )
    } },
    { key: 'publishedCount', label: 'Notas publicadas', render: (student) => <span className="text-muted">{student.publishedCount}/{student.submissionCount}</span> },
    { key: 'open', label: '', sortable: false, render: () => <ChevronRight size={17} className="text-subtle" /> },
  ]

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {!studentId && !submissionId && <>
      <PageHeader title="Resultados" subtitle={`${courseName || activeCourseId} · ${activeClassName} · ${studentRows.length} alunos · ${filteredRows.length} entregas`}>
        <Button variant="secondary" icon={Eye} onClick={() => publishGrades(filteredRows.filter((row) => row.gradePublished !== true), true)}>Publicar notas</Button>
        <Button variant="secondary" icon={EyeOff} onClick={() => publishGrades(filteredRows.filter((row) => row.gradePublished === true), false)}>Ocultar notas</Button>
        <Button icon={FilePlus2} onClick={openManual}>Lançar nota</Button>
      </PageHeader>

      <div className="flex gap-2 flex-wrap">
        <div className="flex h-[38px] items-center rounded-md border border-border bg-surface-2 px-3 text-sm font-semibold text-text">Turma {activeClassName}</div>
        <select value={filterExam} onChange={(e) => { setFilterExam(e.target.value); setFilterApplication('') }} className="text-sm bg-surface border border-border rounded-md px-3 h-[38px] text-text">
          <option value="">Todas as provas</option>
          {examOptions.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select value={filterApplication} onChange={(e) => setFilterApplication(e.target.value)} className="text-sm bg-surface border border-border rounded-md px-3 h-[38px] text-text">
          <option value="">Todas as aplicações</option>
          {applicationOptions.map((application) => (
            <option key={application.id} value={application.id}>
              {application.examKey} · {application.studentClass} · {new Date(application.createdAt).toLocaleString('pt-BR')}
            </option>
          ))}
        </select>
      </div>

      <div className="stagger-grid grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="premium-card rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"><TrendingUp size={18} /></span>
            <span className="text-xs font-medium text-muted">Média geral</span>
          </div>
          <p className="mt-3 text-3xl font-semibold tabular-nums text-text">{analytics.count ? avgCount.toFixed(1).replace('.', ',') : '-'}</p>
          <p className="mt-1 text-[11px] text-subtle">de 10,0</p>
        </div>
        <div className="premium-card rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-success-soft text-success"><Target size={18} /></span>
            <span className="text-xs font-medium text-muted">Aprovação</span>
          </div>
          <p className="mt-3 text-3xl font-semibold tabular-nums text-success">{Math.round(aprovCount)}%</p>
          <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div className="meter-fill h-full rounded-full" style={{ width: `${analytics.aprov}%`, background: 'var(--success)' }} />
          </div>
        </div>
        <div className="premium-card rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-info-soft text-info"><FileStack size={18} /></span>
            <span className="text-xs font-medium text-muted">Submissões</span>
          </div>
          <p className="mt-3 text-3xl font-semibold tabular-nums text-text">{Math.round(countCount)}</p>
          <p className="mt-1 text-[11px] text-subtle">entregas no filtro</p>
        </div>
        <div className="premium-card rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"><BarChart3 size={18} /></span>
            <span className="text-xs font-medium text-muted">Distribuição de notas</span>
          </div>
          <div className="mt-3 flex h-20 items-stretch gap-2">
            {[['0-4', 'var(--danger)'], ['5-6', 'var(--warning)'], ['7-8', 'var(--primary)'], ['9-10', 'var(--success)']].map(([lbl, col], i) => (
              <div key={lbl} className="flex flex-1 flex-col items-center">
                <span className="text-[10px] font-semibold tabular-nums text-muted">{analytics.buckets[i]}</span>
                <div className="flex w-full flex-1 items-end">
                  <div className="bar-grow w-full rounded transition-[filter] hover:brightness-125" style={{ height: `${(analytics.buckets[i] / analytics.maxBucket) * 100}%`, background: col, minHeight: '3px', animationDelay: `${i * 0.09}s` }} />
                </div>
                <span className="mt-1 text-[10px] text-subtle">{lbl}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="app-enter">
        <PageState loading={loading} error={error} onRetry={refetch}>
          <DataTable
            columns={studentColumns}
            rows={studentRows}
            searchKeys={['studentName', 'studentEmail', 'studentClass']}
            onRowClick={openStudentResults}
            emptyTitle="Nenhum aluno com resultados"
            emptyDesc="Os alunos aparecerão aqui depois da primeira entrega."
          />
        </PageState>
      </div>
      </>}

      {selectedStudent && !submissionId && (
        <ResultPageFrame
          title={selectedStudent.studentName || 'Resultados do aluno'}
          subtitle={`${selectedStudent.studentClass} · ${selectedStudent.studentEmail}`}
          backLabel="Voltar aos resultados"
          onBack={() => navigate('/resultados')}
          action={<Button variant="secondary" icon={Download} onClick={() => openBoletim(selectedStudent.studentEmail)}>Boletim (PDF)</Button>}
        >
          <div className="space-y-5">
            <dl className="stagger-grid grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl bg-surface-2 p-3">
                <dt className="text-[11px] font-medium uppercase tracking-wider text-subtle">Média geral</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums text-text">{selectedStudent.average == null ? '-' : (selectedStudent.average / 10).toFixed(1)}</dd>
              </div>
              <div className="rounded-xl bg-surface-2 p-3">
                <dt className="text-[11px] font-medium uppercase tracking-wider text-subtle">Tentativas</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums text-text">{selectedStudent.submissionCount}</dd>
              </div>
              <div className="rounded-xl bg-danger-soft p-3">
                <dt className="text-[11px] font-medium uppercase tracking-wider text-primary">Módulos</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums text-primary">{selectedStudent.moduleCount}</dd>
              </div>
              <div className="rounded-xl bg-success-soft p-3">
                <dt className="text-[11px] font-medium uppercase tracking-wider text-success">Publicadas</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums text-success">{selectedStudent.publishedCount}</dd>
              </div>
            </dl>

            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-subtle">{selectedStudentModules.length} {selectedStudentModules.length === 1 ? 'módulo' : 'módulos'} · clique no módulo para expandir</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" icon={ChevronsUpDown} onClick={() => setOpenModules(new Set(selectedStudentModules.map((m) => m.moduleId)))}>Expandir tudo</Button>
                  <Button size="sm" variant="secondary" icon={ChevronsDownUp} onClick={() => setOpenModules(new Set())}>Recolher tudo</Button>
                </div>
              </div>
              {selectedStudentModules.map((module, moduleIdx) => {
                const accent = MODULE_ACCENTS[moduleIdx % MODULE_ACCENTS.length]
                const isOpen = openModules.has(module.moduleId)
                const moduleScores = module.examGroups.map((exam) => Number(exam.score)).filter(Number.isFinite)
                const best = moduleScores.length ? Math.max(...moduleScores) : null
                const worst = moduleScores.length ? Math.min(...moduleScores) : null
                const publishedCount = module.submissions.filter((s) => s.gradePublished === true).length
                const avgTone = Number(module.average) >= 60 ? 'success' : Number(module.average) >= 40 ? 'warning' : 'danger'
                const meterColor = Number(module.average) >= 60 ? 'var(--success)' : Number(module.average) >= 40 ? 'var(--warning)' : 'var(--danger)'
                const nameParts = String(module.moduleName).split('—')
                const code = nameParts.length > 1 ? nameParts[0].trim() : ''
                const title = nameParts.length > 1 ? nameParts.slice(1).join('—').trim() : module.moduleName
                return (
                <section key={module.moduleId} className="relative overflow-hidden rounded-2xl border" style={{ borderColor: `color-mix(in srgb, ${accent} 26%, var(--border))`, background: `color-mix(in srgb, ${accent} 6%, var(--surface))` }}>
                  <span className="absolute inset-y-0 left-0 w-[5px]" style={{ background: accent }} aria-hidden />
                  <button type="button" onClick={() => toggleModule(module.moduleId)} className="flex w-full items-center gap-3 py-4 pl-6 pr-4 text-left transition hover:brightness-110" style={{ background: `color-mix(in srgb, ${accent} 11%, var(--surface-2))` }}>
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}><BookOpen size={19} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {code && <span className="rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold" style={{ color: accent, borderColor: `color-mix(in srgb, ${accent} 34%, transparent)`, background: `color-mix(in srgb, ${accent} 14%, transparent)` }}>{code}</span>}
                        <h3 className="truncate text-sm font-semibold text-text">{title}</h3>
                      </div>
                      <p className="mt-1 text-[11px] text-subtle">{module.submissions.length} {module.submissions.length === 1 ? 'prova' : 'provas'} · {publishedCount} publicadas</p>
                    </div>
                    <Badge tone={avgTone} className="shrink-0">Média {module.average == null ? '-' : (module.average / 10).toFixed(1)}</Badge>
                    <ChevronDown size={18} className="shrink-0 text-muted transition-transform" style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} aria-hidden />
                  </button>

                  <div className="flex flex-col gap-3 border-t px-6 py-3 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: 'var(--border)' }}>
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center justify-between text-[11px] text-subtle">
                        <span>Aproveitamento do módulo</span>
                        <span className="tabular-nums">{module.average == null ? '-' : (module.average / 10).toFixed(1)} / 10</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                        <div className="meter-fill h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, Number(module.average) || 0))}%`, background: meterColor }} />
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted sm:justify-end">
                      <span>melhor <b className="font-semibold tabular-nums text-text">{best == null ? '-' : (best / 10).toFixed(1)}</b></span><span className="text-subtle">·</span>
                      <span>pior <b className="font-semibold tabular-nums text-text">{worst == null ? '-' : (worst / 10).toFixed(1)}</b></span>
                    </div>
                  </div>

                  {isOpen && (
                  <div className="rb space-y-2.5 p-4 pl-6">
                    <p className="rb-hint"><Info size={12} /> Cada prova em uma linha. Clique para ver a composição e ajustar.</p>
                    {module.provas.map((prova) => {
                      if (prova.applications.length <= 1) {
                        const only = prova.applications[0]
                        return <div key={prova.examKey || only.scopeKey}>{renderExamRow(only, { type: 'exam' })}</div>
                      }
                      return (
                        <div key={prova.examKey} className="rb-lin">
                          <div className="rb-trunk">
                            <span className="rb-trunk-ic"><BookOpen size={19} /></span>
                            <span className="rb-trunk-t">
                              <span className="n">{prova.examName || prova.examKey}</span>
                              <span className="s">1 prova · {prova.applications.length} aplicações</span>
                            </span>
                          </div>
                          <div className="rb-apps">
                            {prova.applications.map((exam, i) => (
                              <div key={exam.scopeKey} className="rb-ramo">
                                {renderExamRow(exam, { type: 'app', n: i + 1 })}
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  )}
                </section>
                )
              })}
            </div>
          </div>
        </ResultPageFrame>
      )}

      {detail && submissionId && (
        <ResultPageFrame
          title="Prova corrigida"
          subtitle={`${detail.studentName || detail.studentEmail} · ${detail.examKey}`}
          backLabel={selectedStudent ? `Voltar para ${selectedStudent.studentName}` : 'Voltar aos resultados'}
          onBack={() => navigate(selectedStudentPath)}
        >
        <div className="space-y-4">
          <dl className="grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-surface-2 p-3"><dt className="text-xs text-muted">Nota</dt><dd className="mt-1 text-2xl font-semibold text-text">{(Number(detail.score || 0) / 10).toFixed(1)}</dd></div>
            <div className="rounded-xl bg-surface-2 p-3"><dt className="text-xs text-muted">Acertos</dt><dd className="mt-1 text-2xl font-semibold text-text">{detail.correctCount ?? '-'}/{detail.totalCount ?? '-'}</dd></div>
            <div className="rounded-xl bg-surface-2 p-3"><dt className="text-xs text-muted">Versão</dt><dd className="mt-1 text-2xl font-semibold text-text">{detail.assignedVersion || '-'}</dd></div>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={detail.gradePublished === true ? EyeOff : Eye} onClick={() => publishGrades([detail], detail.gradePublished !== true)}>{detail.gradePublished === true ? 'Ocultar do aluno' : 'Publicar para o aluno'}</Button>
            <Button variant="secondary" icon={Download} onClick={() => exportCsv(detail)}>Exportar CSV da turma</Button>
            <Button variant="destructive" icon={Trash2} onClick={() => setDel(detail)}>Excluir registro</Button>
          </div>
          {reviewLoading && (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 border-y border-border text-muted">
              <Loader2 size={24} className="animate-spin text-primary" />
              <p className="text-sm">Montando a prova corrigida...</p>
            </div>
          )}
          {!reviewLoading && Array.isArray(review?.questions) && review.questions.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
                <Badge tone="neutral">Versão {review.assignedVersion || detail.assignedVersion || '-'}</Badge>
                {review.examCode && <span>Código da prova: {review.examCode}</span>}
              </div>
              {review.questions.map((question) => (
                <section key={`${question.questionNumber}-${question.position}`} className="border-t border-border py-4 first:border-t-0 first:pt-0">
                  <div className="flex items-start gap-3">
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-bold ${question.isCorrect ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>
                      {question.position}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                        <p className="font-medium leading-relaxed text-text">{question.text || `Questão ${question.position}`}</p>
                        <Badge tone={question.isCorrect ? 'success' : 'danger'}>{question.isCorrect ? 'Correta' : 'Errada'}</Badge>
                      </div>
                      <div className="mt-3 divide-y divide-border border-y border-border">
                        {(question.alternatives || []).map((alternative) => {
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
                                  <CheckCircle2 size={14} /> Resposta correta
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                      {!question.studentChoice && <p className="mt-2 text-xs font-medium text-warning">Questão não respondida.</p>}
                    </div>
                  </div>
                </section>
              ))}
            </div>
          )}
          {!reviewLoading && (!review?.questions || review.questions.length === 0) && Array.isArray(detail.gradedAnswers) && detail.gradedAnswers.length > 0 && (
            <div className="overflow-x-auto border-y border-border">
              <table className="w-full text-sm">
                <thead><tr className="bg-surface-2 text-muted"><th className="text-left px-3 py-2">Questão</th><th className="text-left px-3 py-2">Aluno</th><th className="text-left px-3 py-2">Correta</th><th className="text-left px-3 py-2">Status</th></tr></thead>
                <tbody>{detail.gradedAnswers.map((a, i) => <tr key={i} className="border-t border-border"><td className="px-3 py-2">{a.questionNumber}</td><td className="px-3 py-2">{a.studentChoice || '-'}</td><td className="px-3 py-2">{a.correctAnswer || '-'}</td><td className="px-3 py-2"><Badge tone={a.isCorrect ? 'success' : 'danger'}>{a.isCorrect ? 'Correta' : 'Errada'}</Badge></td></tr>)}</tbody>
              </table>
            </div>
          )}
          {!reviewLoading && (!review?.questions || review.questions.length === 0) && (!detail.gradedAnswers || detail.gradedAnswers.length === 0) && (
            <div className="border-y border-border py-6 text-center text-sm text-muted">
              Não foi possível reconstruir as questões desta entrega antiga.
            </div>
          )}
        </div>
        </ResultPageFrame>
      )}

      {studentId && !selectedStudent && (
        <PageState
          loading={loading}
          error={loading ? null : new Error('O aluno informado não possui resultados neste curso.')}
          onRetry={refetch}
        />
      )}

      {submissionId && routeSubmission && !detail && <PageState loading />}
      {submissionId && selectedStudent && !loading && !routeSubmission && (
        <PageState error={new Error('A prova informada não pertence a este aluno.')} />
      )}

      {/* Lançamento manual de notas */}
      <Modal open={manualOpen} onClose={() => setManualOpen(false)} title="Lancamento manual" description="Use nota rapida ou corrija uma prova impressa pelo cartao-resposta."
        footer={<><Button variant="ghost" onClick={() => setManualOpen(false)}>Cancelar</Button><Button loading={loadingManual} onClick={createManual}>Salvar nota</Button></>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Button variant={manual.mode === 'quick' ? 'primary' : 'secondary'} onClick={() => setManual({ ...manual, mode: 'quick' })}>Rapido</Button>
            <Button variant={manual.mode === 'card' ? 'primary' : 'secondary'} onClick={() => setManual({ ...manual, mode: 'card' })}>Cartao-resposta</Button>
          </div>
          <div><p className="mb-1 text-sm font-medium text-text">Turma</p><div className="h-[38px] rounded-md border border-border bg-surface-2 px-3 py-2 text-sm font-semibold text-text">{activeClassName}</div></div>
          <Select label="Aluno" value={manual.studentEmail} onChange={(e) => setManual({ ...manual, studentEmail: e.target.value })}>
            {classStudents.map((s) => <option key={s.email} value={s.email}>{s.name} - {s.email}</option>)}
          </Select>
          <Select label="Prova" value={manual.examKey} onChange={(e) => setManual({ ...manual, examKey: e.target.value, answers: {}, snapshotId: '' })}>
            <option value="">Selecione...</option>
            {exams.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
          </Select>

          {manual.mode === 'quick' ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Input label="Nota (%)" type="number" min="0" max="100" value={manual.score} onChange={(e) => setManual({ ...manual, score: e.target.value })} />
                <Input label="Acertos" type="number" min="0" value={manual.correctCount} onChange={(e) => setManual({ ...manual, correctCount: e.target.value })} />
                <Input label="Total" type="number" min="1" value={manual.totalCount} onChange={(e) => setManual({ ...manual, totalCount: e.target.value })} />
              </div>
              <Select label="Tipo" value={manual.type} onChange={(e) => setManual({ ...manual, type: e.target.value })}>
                <option value="manual">Manual</option>
                <option value="impressa">Impressa</option>
                <option value="online">Online</option>
              </Select>
            </>
          ) : (
            <div className="space-y-3">
              <Select label="Versão aplicada" value={manual.snapshotId} onChange={(e) => setManual({ ...manual, snapshotId: e.target.value, answers: {} })}>
                <option value="">Banco original sem embaralhamento</option>
                {snapshots.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </Select>
              <p className="text-xs text-subtle">{selectedSnapshot ? `Corrigindo pela ordem impressa do codigo ${selectedSnapshot.examCode || '-'}.` : 'Sem versão, as respostas seguem o banco original da avaliação.'}</p>
              <div className="max-h-[340px] divide-y divide-border overflow-auto border-y border-border">
                {cardRows.map((row) => (
                  <div key={row.key} className="flex items-center justify-between gap-3 py-2">
                    <span className="text-sm font-medium text-text">{row.title}</span>
                    <div className="flex flex-wrap gap-1">
                      {row.letters.map((letter) => (
                        <button key={letter} type="button" onClick={() => updateAnswer(row.key, letter)}
                          className={`w-8 h-8 rounded-full border text-xs font-bold ${manual.answers[row.key] === letter ? 'bg-primary text-primary-fg border-primary' : 'border-border text-muted hover:bg-surface-2'}`}>
                          {letter}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {cardRows.length === 0 && <p className="text-sm text-muted text-center py-6">Selecione uma prova para desenhar o cartao-resposta.</p>}
              </div>
            </div>
          )}
          <p className="text-xs text-subtle">{courseClasses.length} turmas no curso ativo. {selectedClass ? `Curso: ${selectedClass.courseId}.` : ''}</p>
        </div>
      </Modal>

      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={remove} danger confirmLabel="Excluir registro"
        title="Excluir submissao?" description={`${del?.studentName || del?.studentEmail || del?.student?.email} - ${del?.examKey}`} />
    </div>
  )
}
