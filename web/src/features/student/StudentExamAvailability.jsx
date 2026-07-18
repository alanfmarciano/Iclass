import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, BellRing, ClipboardList, Clock3, PauseCircle } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthProvider'
import { useApi } from '../../hooks/useApi'

const ACTIVE_STATUSES = new Set(['waiting', 'running', 'paused'])
const STATUS_PRIORITY = { running: 0, waiting: 1, paused: 2 }

function formatCountdown(seconds) {
  const safe = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(safe / 60)
  const rest = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

export function ExamAvailabilityPopup({ application, count = 1, now = Date.now(), onOpen }) {
  if (!application) return null
  const startsAt = Number(application.startsAt || application.config?.startTime || 0)
  const waitingSeconds = application.status === 'waiting' && startsAt > now
    ? Math.ceil((startsAt - now) / 1000)
    : 0
  const paused = application.status === 'paused'
  const waiting = waitingSeconds > 0
  const Icon = paused ? PauseCircle : waiting ? Clock3 : BellRing
  const eyebrow = paused ? 'PROVA PAUSADA' : waiting ? 'SALA DE ESPERA ABERTA' : 'PROVA DISPONÍVEL'
  const statusText = paused
    ? 'O professor pausou a aplicação. Você pode abrir a tela e aguardar a retomada.'
    : waiting
      ? `A prova começa em ${formatCountdown(waitingSeconds)}. Entre agora na sala de espera.`
      : 'A aplicação já foi iniciada e está disponível para você.'
  const actionLabel = paused ? 'Ver status' : waiting ? 'Entrar na sala' : 'Abrir prova'

  return (
    <aside
      className={`fixed inset-x-4 bottom-20 z-[70] mx-auto max-w-md overflow-hidden rounded-2xl border bg-surface-raised/95 shadow-[0_24px_70px_rgba(0,0,0,.42)] backdrop-blur-xl md:bottom-6 md:left-auto md:right-6 md:mx-0 ${paused ? 'border-warning/55' : 'border-primary/55'}`}
      role="status"
      aria-live="polite"
      aria-label="Aviso de prova disponível"
    >
      <div className={`h-1 w-full ${paused ? 'bg-warning' : 'bg-primary'}`} />
      <div className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className={`relative grid h-11 w-11 shrink-0 place-items-center rounded-xl ${paused ? 'bg-warning-soft text-warning' : 'bg-primary-soft text-primary'}`}>
            <Icon size={21} aria-hidden="true" />
            {!paused && <span className="absolute -right-0.5 -top-0.5 h-3 w-3 animate-pulse rounded-full border-2 border-surface-raised bg-primary" aria-hidden="true" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className={`text-[10px] font-bold uppercase tracking-[.18em] ${paused ? 'text-warning' : 'text-primary'}`}>{eyebrow}</p>
            <h2 className="mt-1 truncate text-base font-bold text-text">{application.examTitle || String(application.examKey || 'Prova').replace(/_/g, ' ')}</h2>
            <p className="mt-0.5 text-xs text-muted">{application.studentClass}{application.courseName ? ` · ${application.courseName}` : ''}</p>
          </div>
          {count > 1 && <span className="rounded-full bg-primary-soft px-2 py-1 text-[11px] font-bold text-primary">+{count - 1}</span>}
        </div>
        <p className="mt-3 text-sm leading-5 text-muted">{statusText}</p>
        <button
          type="button"
          onClick={() => onOpen?.(application)}
          className={`mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold transition active:translate-y-px ${paused ? 'bg-warning text-white hover:brightness-105' : 'bg-primary text-primary-fg hover:bg-primary-hover'}`}
        >
          <ClipboardList size={17} aria-hidden="true" />
          {actionLabel}
          <ArrowRight size={16} aria-hidden="true" />
        </button>
        {count > 1 && <p className="mt-2 text-center text-[11px] text-subtle">Há mais {count - 1} {count === 2 ? 'prova disponível' : 'provas disponíveis'}.</p>}
      </div>
    </aside>
  )
}

export function StudentExamAvailability() {
  const { auth, setActiveClass } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const activeCourseId = auth.activeClass?.courseId || ''
  const activeClassName = auth.activeClass?.name || ''
  const applications = useApi(auth.email && activeCourseId && activeClassName
    ? `/api/student/exam-applications?courseId=${encodeURIComponent(activeCourseId)}&studentClass=${encodeURIComponent(activeClassName)}`
    : null, [auth.email, activeCourseId, activeClassName], { pollMs: 3000 })
  const [now, setNow] = useState(Date.now())

  const available = useMemo(() => (applications.data?.applications || [])
    .filter(application => ACTIVE_STATUSES.has(application.status) && application.attemptsExhausted !== true)
    .sort((a, b) => (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9)), [applications.data])
  const application = available[0] || null
  const currentApplicationId = new URLSearchParams(location.search).get('applicationId') || ''
  const insideCurrentExam = location.pathname.startsWith('/aluno/prova/') && currentApplicationId === application?.id

  useEffect(() => {
    if (!application || application.status !== 'waiting') return undefined
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [application?.id, application?.status, application?.startsAt])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') applications.refetch(true)
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [applications.refetch])

  if (!application || insideCurrentExam) return null

  const openApplication = (target) => {
    const memberships = auth.student?.classes || []
    const matchingClass = memberships.find(item => typeof item === 'object'
      && item?.name === target.studentClass
      && (!target.courseId || !item.courseId || item.courseId === target.courseId))
    if (matchingClass) setActiveClass(matchingClass)
    else if (target.studentClass) setActiveClass({ name: target.studentClass, courseId: target.courseId || '' })
    navigate(`/aluno/prova/${encodeURIComponent(target.examKey)}?applicationId=${encodeURIComponent(target.id)}`)
  }

  return <ExamAvailabilityPopup application={application} count={available.length} now={now} onOpen={openApplication} />
}
