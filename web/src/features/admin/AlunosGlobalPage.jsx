import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import { DataTable } from '../../components/ui/Table'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { PageState } from '../../components/ui/PageState'
import { PageHeader } from '../../components/ui/PageHeader'
import { StatCard } from '../../components/ui/StatCard'
import { useApi } from '../../hooks/useApi'

const STATUS_TONE = { Ativo: 'success', Inativo: 'neutral', Bloqueado: 'danger', 'Concluído': 'success', Transferido: 'warning', Evadido: 'warning' }

function scn(s) {
  const raw = s.classes && s.classes.length ? s.classes : (s.studentClass ? [s.studentClass] : [])
  return raw.map((c) => typeof c === 'string' ? c : c.name).filter(Boolean)
}
function displayName(s) { return (s.nomeSocial && s.nomeSocial.trim()) || s.name || '' }

export default function AlunosGlobalPage() {
  const nav = useNavigate()
  const { data: students, loading, error, refetch } = useApi('/api/admin/students')
  const { data: classes } = useApi('/api/admin/classes')
  const { data: courses } = useApi('/api/courses')
  const { data: schools } = useApi('/api/admin/schools')

  const classByName = useMemo(() => { const m = new Map(); (classes || []).forEach((c) => { if (!m.has(c.name)) m.set(c.name, c) }); return m }, [classes])
  const courseById = useMemo(() => { const m = new Map(); (courses || []).forEach((c) => m.set(c.id, c)); return m }, [courses])
  const schoolById = useMemo(() => { const m = new Map(); (schools || []).forEach((s) => m.set(s.id, s)); return m }, [schools])

  function enrollmentChips(s) {
    return scn(s).map((name) => {
      const cls = classByName.get(name)
      const course = cls && courseById.get(cls.courseId)
      const school = course && schoolById.get(course.schoolId || 'escola_default')
      return { name, course: course?.name, school: school?.name }
    })
  }

  const rows = students || []
  const stats = useMemo(() => ({
    total: rows.length,
    ativos: rows.filter((s) => (s.status || 'Ativo') === 'Ativo').length,
    semTurma: rows.filter((s) => scn(s).length === 0).length,
  }), [rows])

  const openStudent = (email) => nav('/diretorio/' + encodeURIComponent(email))

  const columns = [
    { key: 'name', label: 'Nome', render: (r) => {
      const hasSocial = r.nomeSocial && r.nomeSocial.trim() && r.nomeSocial.trim() !== (r.name || '').trim()
      return (
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-full bg-primary-soft text-primary grid place-items-center text-xs font-semibold shrink-0">{(displayName(r) || '?').split(' ').map((x) => x[0]).slice(0, 2).join('')}</span>
          <div className="min-w-0">
            <span className="block truncate text-text">{displayName(r)}</span>
            {hasSocial && <span className="block text-xs text-subtle truncate" title="Nome completo">{r.name}</span>}
          </div>
        </div>)
    } },
    { key: 'email', label: 'E-mail', render: (r) => <span className="text-muted">{r.email}</span> },
    { key: 'enroll', label: 'Matrículas', render: (r) => {
      const ch = enrollmentChips(r)
      return ch.length ? (
        <div className="flex flex-wrap gap-1">
          {ch.slice(0, 4).map((e, i) => <Badge key={i} tone="info">{e.course ? `${e.course} · ${e.name}` : e.name}</Badge>)}
          {ch.length > 4 && <Badge tone="neutral">+{ch.length - 4}</Badge>}
        </div>
      ) : <span className="text-subtle text-sm">sem matrícula</span>
    } },
    { key: 'status', label: 'Situação', render: (r) => <Badge tone={STATUS_TONE[r.status || 'Ativo'] || 'neutral'}>{r.status || 'Ativo'}</Badge> },
  ]

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader title="Alunos" subtitle="Todos os alunos da instituição — matricule em qualquer curso ou escola">
        <Button icon={UserPlus} onClick={() => nav('/diretorio/novo')}>Novo aluno</Button>
      </PageHeader>

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Total de alunos" value={stats.total} icon="Users" />
        <StatCard label="Ativos" value={stats.ativos} icon="UserCheck" />
        <StatCard label="Sem matrícula" value={stats.semTurma} icon="UserMinus" />
      </div>

      <PageState loading={loading} error={error} onRetry={refetch}>
        <DataTable columns={columns} rows={rows.map((s, i) => ({ id: s.email || i, ...s }))}
          searchKeys={['name', 'nomeSocial', 'email', 'matricula']} rowActions={(r) => openStudent(r.email)} onRowClick={(r) => openStudent(r.email)}
          emptyTitle="Nenhum aluno" emptyDesc="Cadastre o primeiro aluno." />
      </PageState>
    </div>
  )
}
