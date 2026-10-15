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

  // Faixa compacta (uma linha) em vez de cartão flutuante: continua sempre visível,
  // mas não cobre o conteúdo — o portal reserva o espaço via --exam-banner-space.
  return (
    <aside
      className={`fixed inset-x-0 bottom-0 z-[70] border-t bg-surface-raised/95 shadow-[0_-12px_40px_rgba(0,0,0,.28)] backdrop-blur-xl md:inset-x-auto md:bottom-5 md:right-6 md:w-[min(560px,calc(100vw-320px))] md:rounded-xl md:border ${paused ? 'border-warning/55' : 'border-primary/55'}`}
      role="status"
      aria-live="polite"
      aria-label="Aviso de prova disponível"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-lg ${paused ? 'bg-warning-soft text-warning' : 'bg-primary-soft text-primary'}`}>
          <Icon size={18} aria-hidden="true" />
          {!paused && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-surface-raised bg-primary" aria-hidden="true" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-[10px] font-bold uppercase tracking-[.16em] ${paused ? 'text-warning' : 'text-primary'}`}>
            {eyebrow}{count > 1 && <span className="ml-2 normal-case tracking-normal text-subtle">+{count - 1} {count === 2 ? 'prova' : 'provas'}</span>}
          </p>
          <h2 className="truncate text-sm font-bold text-text" title={statusText}>{application.examTitle || String(application.examKey || 'Prova').replace(/_/g, ' ')}</h2>
          <p className="truncate text-xs text-muted">{statusText}</p>
        </div>
        <button
          type="button"
          onClick={() => onOpen?.(application)}
          className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-bold transition active:translate-y-px ${paused ? 'bg-warning text-white hover:brightness-105' : 'bg-primary text-primary-fg hover:bg-primary-hover'}`}
        >
          <ClipboardList size={16} aria-hidden="true" className="hidden sm:block" />
          {actionLabel}
          <ArrowRight size={15} aria-hidden="true" />
        </button>
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

  const showBanner = !!application && !insideCurrentExam
  useEffect(() => {
    // Reserva espaço no fim do conteúdo para a faixa não cobrir a última linha.
    const root = document.documentElement
    if (showBanner) root.style.setProperty('--exam-banner-space', '88px')
    else root.style.removeProperty('--exam-banner-space')
    return () => root.style.removeProperty('--exam-banner-space')
  }, [showBanner])

  if (!showBanner) return null

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
