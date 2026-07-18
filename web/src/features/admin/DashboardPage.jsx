import { useMemo } from 'react'
import { Download, Minus, Plus, CalendarX, AlertTriangle, ArrowRight } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { StatCard } from '../../components/ui/StatCard'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { PageState } from '../../components/ui/PageState'
import { PageHeader } from '../../components/ui/PageHeader'
import { useApi } from '../../hooks/useApi'
import { useAuth } from '../../context/AuthProvider'
import { usePreferences } from '../../context/PreferencesProvider'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'

function classNamesOf(student) {
  const raw = student.classes && student.classes.length ? student.classes : (student.studentClass ? [student.studentClass] : [])
  return raw.map((c) => typeof c === 'string' ? c : c.name).filter(Boolean)
}
const initials = (n) => (n || '?').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase()
const RISK_TONE = { alto: 'danger', medio: 'warning', baixo: 'neutral' }

function Card({ title, action, children }) {
  return (
    <div className="premium-card rounded-xl p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-3"><p className="text-[15px] font-semibold tracking-[-0.015em] text-text">{title}</p>{action}</div>
      {children}
    </div>
  )
}

function Stepper({ value, onChange, min = 1, max = 50, step = 1 }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-border">
      <button aria-label="Menos" onClick={() => onChange(Math.max(min, value - step))} className="p-1.5 text-muted hover:text-text disabled:opacity-40" disabled={value <= min}><Minus size={14} /></button>
      <span className="text-sm text-text min-w-[24px] text-center tabular-nums">{value}</span>
      <button aria-label="Mais" onClick={() => onChange(Math.min(max, value + step))} className="p-1.5 text-muted hover:text-text disabled:opacity-40" disabled={value >= max}><Plus size={14} /></button>
    </div>
  )
}

export default function DashboardPage() {
  const { auth } = useAuth()
  const { courseId: activeCourseId, courseName, className: activeClassName, period } = useAdminWorkspace()
  const location = useLocation()
  const nav = useNavigate()
  const { pref, setPref } = usePreferences()
  const absCount = pref('dashboard.absencesCount', 5)
  const riskCount = pref('dashboard.riskCount', 5)

  const contextQuery = new URLSearchParams({ courseId: activeCourseId, studentClass: activeClassName }).toString()
  const students = useApi(`/api/admin/students?${contextQuery}`)
  const submissions = useApi(`/api/admin/submissions?${contextQuery}`)
  const classes = useApi(`/api/admin/classes?${contextQuery}`)
  const overview = useApi(`/api/admin/dashboard/students-overview?${contextQuery}`)
  const loading = students.loading || submissions.loading || classes.loading || overview.loading
  const error = students.error || submissions.error || classes.error || overview.error

  const courseClasses = useMemo(() => (classes.data || []).filter((c) => c.courseId === activeCourseId && c.name === activeClassName), [classes.data, activeCourseId, activeClassName])
  const courseClassNames = useMemo(() => new Set(courseClasses.map((c) => c.name)), [courseClasses])
  const filteredStudents = useMemo(() => (students.data || []).filter((s) => !activeCourseId || classNamesOf(s).some((n) => courseClassNames.has(n))), [students.data, activeCourseId, courseClassNames])
  const filteredSubs = useMemo(() => (submissions.data || []).filter((s) => !activeCourseId || s.courseId === activeCourseId || courseClassNames.has(s.studentClass || s.student?.studentClass)), [submissions.data, activeCourseId, courseClassNames])

  const stats = useMemo(() => {
    const scores = filteredSubs.map((s) => Number(s.score)).filter((n) => !isNaN(n))
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
    return { students: filteredStudents.length, online: filteredStudents.filter((s) => s.isOnline).length, submissions: filteredSubs.length, average: avg ? (avg / 10).toFixed(1).replace('.', ',') : '-' }
  }, [filteredStudents, filteredSubs])

  const performance = useMemo(() => {
    const scoresByStudent = new Map()
    filteredSubs.forEach((submission) => {
      const email = String(submission.studentEmail || submission.student?.email || submission.email || '').trim().toLowerCase()
      const score = Number(submission.score)
      if (!email || !Number.isFinite(score)) return
      const current = scoresByStudent.get(email) || { total: 0, count: 0 }
      current.total += score
      current.count += 1
      scoresByStudent.set(email, current)
    })

    const result = { satisfactory: 0, attention: 0, critical: 0, notEvaluated: 0, evaluated: 0, total: filteredStudents.length }
    filteredStudents.forEach((student) => {
      const email = String(student.email || '').trim().toLowerCase()
      const scores = scoresByStudent.get(email)
      if (!scores?.count) {
        result.notEvaluated += 1
        return
      }
      const average = scores.total / scores.count
      result.evaluated += 1
      if (average >= 70) result.satisfactory += 1
      else if (average >= 50) result.attention += 1
      else result.critical += 1
    })
    result.satisfactoryRate = result.evaluated ? Math.round((result.satisfactory / result.evaluated) * 100) : 0
    return result
  }, [filteredStudents, filteredSubs])

  const classSummary = useMemo(() => {
    const rows = overview.data || []
    const frequencies = rows.map((row) => Number(row.frequencia)).filter(Number.isFinite)
    return {
      averageFrequency: frequencies.length ? Math.round(frequencies.reduce((sum, value) => sum + value, 0) / frequencies.length) : null,
      totalAbsences: rows.reduce((sum, row) => sum + (Number(row.faltas) || 0), 0),
      withoutAbsences: rows.filter((row) => !(Number(row.faltas) > 0)).length,
      attention: rows.filter((row) => row.riscoLevel !== 'baixo').length,
    }
  }, [overview.data])

  const currentClass = courseClasses[0] || { name: activeClassName, period }
  const classContext = currentClass
    ? `${currentClass.name}${currentClass.period ? ` — ${currentClass.period}` : ''} · ${filteredStudents.length} alunos`
    : `${courseClasses.length} turmas · ${filteredStudents.length} alunos`

  const faltosos = useMemo(() => [...(overview.data || [])].filter((o) => o.faltas > 0).sort((a, b) => b.faltas - a.faltas).slice(0, absCount), [overview.data, absCount])
  const emRisco = useMemo(() => [...(overview.data || [])].filter((o) => o.riscoLevel !== 'baixo').sort((a, b) => (a.riscoLevel === 'alto' ? -1 : 1) - (b.riscoLevel === 'alto' ? -1 : 1) || a.frequencia - b.frequencia).slice(0, riskCount), [overview.data, riskCount])

  const open = (email) => nav('/alunos/' + encodeURIComponent(email))

  return (
    <div className="mx-auto max-w-[1320px] space-y-6">
      {location.state?.accessDenied && (
        <div role="alert" className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-text">Sua conta não possui permissão para abrir essa tela.</div>
      )}
      <PageHeader title="Dashboard" subtitle={`Visão geral · ${courseName || activeCourseId} · ${activeClassName}`}>
        <Button variant="secondary" icon={Download} onClick={() => window.print()}>Exportar</Button>
      </PageHeader>

      <PageState loading={loading} error={error} onRetry={() => { students.refetch(); submissions.refetch(); classes.refetch(); overview.refetch() }}>
        <div className="stagger-grid grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Alunos" value={stats.students} icon="Users" />
          <StatCard label="Online agora" value={stats.online} icon="MonitorPlay" />
          <StatCard label="Provas realizadas" value={stats.submissions} icon="FileCheck2" />
          <StatCard label="Média geral" value={stats.average} icon="TrendingUp" />
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card
              title="Panorama de desempenho"
              action={(
                <button onClick={() => nav('/resultados')} className="inline-flex items-center gap-1.5 text-xs font-medium text-primary transition-colors hover:text-primary-hover">
                  Ver resultados <ArrowRight size={13} />
                </button>
              )}
            >
              {performance.total ? (
                <div className="space-y-5">
                  <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
                    <div>
                      <p className="text-3xl font-semibold tracking-[-0.04em] text-text tabular-nums">{performance.satisfactoryRate}%</p>
                      <p className="mt-1 text-sm text-muted">dos alunos avaliados estão com média igual ou superior a 7</p>
                    </div>
                    <p className="shrink-0 text-xs text-subtle">{performance.evaluated} de {performance.total} alunos avaliados</p>
                  </div>

                  <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2" aria-label="Distribuição do desempenho dos alunos">
                    {performance.satisfactory > 0 && <div className="bg-success transition-all" style={{ width: `${(performance.satisfactory / performance.total) * 100}%` }} title={`${performance.satisfactory} com desempenho satisfatório`} />}
                    {performance.attention > 0 && <div className="bg-warning transition-all" style={{ width: `${(performance.attention / performance.total) * 100}%` }} title={`${performance.attention} em atenção`} />}
                    {performance.critical > 0 && <div className="bg-danger transition-all" style={{ width: `${(performance.critical / performance.total) * 100}%` }} title={`${performance.critical} em situação crítica`} />}
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                    <div className="rounded-lg border border-success/20 bg-success-soft p-3">
                      <div className="mb-2 h-1.5 w-1.5 rounded-full bg-success" />
                      <p className="text-xl font-semibold tabular-nums text-text">{performance.satisfactory}</p>
                      <p className="mt-0.5 text-xs text-muted">Satisfatório</p>
                    </div>
                    <div className="rounded-lg border border-warning/20 bg-warning-soft p-3">
                      <div className="mb-2 h-1.5 w-1.5 rounded-full bg-warning" />
                      <p className="text-xl font-semibold tabular-nums text-text">{performance.attention}</p>
                      <p className="mt-0.5 text-xs text-muted">Em atenção</p>
                    </div>
                    <div className="rounded-lg border border-danger/20 bg-danger-soft p-3">
                      <div className="mb-2 h-1.5 w-1.5 rounded-full bg-danger" />
                      <p className="text-xl font-semibold tabular-nums text-text">{performance.critical}</p>
                      <p className="mt-0.5 text-xs text-muted">Situação crítica</p>
                    </div>
                    <div className="rounded-lg border border-border bg-surface-2/70 p-3">
                      <div className="mb-2 h-1.5 w-1.5 rounded-full bg-subtle" />
                      <p className="text-xl font-semibold tabular-nums text-text">{performance.notEvaluated}</p>
                      <p className="mt-0.5 text-xs text-muted">Sem avaliação</p>
                    </div>
                  </div>
                </div>
              ) : <p className="text-sm text-muted">Nenhum aluno nesta turma.</p>}
            </Card>
          </div>
          <Card title={currentClass ? 'Resumo da turma' : 'Resumo do curso'}>
            <p className="mb-4 truncate text-xs text-muted" title={classContext}>{classContext}</p>
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-lg bg-surface-2/70 p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-subtle">Frequência média</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-text">{classSummary.averageFrequency == null ? '—' : `${classSummary.averageFrequency}%`}</p>
              </div>
              <div className="rounded-lg bg-danger-soft p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-danger">Faltas registradas</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-danger">{classSummary.totalAbsences}</p>
              </div>
              <div className="rounded-lg bg-success-soft p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-success">Sem faltas</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-success">{classSummary.withoutAbsences}</p>
              </div>
              <div className="rounded-lg bg-warning-soft p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-warning">Precisam de atenção</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-warning">{classSummary.attention}</p>
              </div>
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card title="Alunos com mais faltas" action={<Stepper value={absCount} onChange={(v) => setPref('dashboard.absencesCount', v)} />}>
            {faltosos.length ? (
              <div className="flex flex-col">
                {faltosos.map((o) => (
                  <button key={o.email} onClick={() => open(o.email)} className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0 text-left hover:bg-surface-2/60 rounded-md px-1 -mx-1">
                    <span className="w-8 h-8 rounded-full bg-primary-soft text-primary grid place-items-center text-xs font-semibold shrink-0">{initials(o.name)}</span>
                    <div className="flex-1 min-w-0"><p className="text-sm text-text truncate">{o.name}</p><p className="text-xs text-muted">{o.className || '—'} · frequência {o.frequencia}%</p></div>
                    <span className="inline-flex items-center gap-1 text-xs text-danger" aria-label={`${o.faltas} ${o.faltas === 1 ? 'falta registrada no total' : 'faltas registradas no total'}`} title={`${o.faltas} ${o.faltas === 1 ? 'falta registrada' : 'faltas registradas'} no total`}><CalendarX size={13} aria-hidden="true" />{o.faltas}</span>
                  </button>
                ))}
              </div>
            ) : <p className="text-sm text-muted">Nenhuma falta registrada.</p>}
          </Card>

          <Card title="Alunos que precisam de atenção" action={<Stepper value={riskCount} onChange={(v) => setPref('dashboard.riskCount', v)} />}>
            {emRisco.length ? (
              <div className="flex flex-col">
                {emRisco.map((o) => (
                  <button key={o.email} onClick={() => open(o.email)} className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0 text-left hover:bg-surface-2/60 rounded-md px-1 -mx-1">
                    <span className="w-8 h-8 rounded-full bg-primary-soft text-primary grid place-items-center text-xs font-semibold shrink-0">{initials(o.name)}</span>
                    <div className="flex-1 min-w-0"><p className="text-sm text-text truncate">{o.name}</p><p className="text-xs text-muted">{o.className || '—'} · média {o.media.toFixed(1).replace('.', ',')} · freq {o.frequencia}%</p></div>
                    <Badge tone={RISK_TONE[o.riscoLevel]}>{o.riscoLevel}</Badge>
                  </button>
                ))}
              </div>
            ) : <p className="text-sm text-muted flex items-center gap-2"><AlertTriangle size={14} className="text-success" />Nenhum aluno em risco.</p>}
          </Card>
        </div>
      </PageState>
    </div>
  )
}
