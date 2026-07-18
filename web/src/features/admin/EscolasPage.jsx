import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, Plus } from 'lucide-react'
import { DataTable } from '../../components/ui/Table'
import { Button } from '../../components/ui/Button'
import { PageState } from '../../components/ui/PageState'
import { PageHeader } from '../../components/ui/PageHeader'
import { useApi } from '../../hooks/useApi'

export default function EscolasPage() {
  const nav = useNavigate()
  const { data: schools, loading, error, refetch } = useApi('/api/admin/schools')
  const { data: courses } = useApi('/api/courses')

  const countByCourse = useMemo(() => {
    const m = {}
    ;(courses || []).forEach((c) => { if (!c.deleted) m[c.schoolId] = (m[c.schoolId] || 0) + 1 })
    return m
  }, [courses])

  const open = (schoolId) => nav('/escolas/' + encodeURIComponent(schoolId))

  const columns = [
    { key: 'name', label: 'Escola', render: (r) => (
      <div className="flex items-center gap-2">
        <span className="w-7 h-7 rounded-md bg-primary-soft text-primary grid place-items-center"><Building2 size={15} /></span>
        <span className="text-text">{r.name}</span>
      </div>) },
    { key: 'city', label: 'Cidade/UF', render: (r) => <span className="text-muted">{r.info?.cityState || '—'}</span> },
    { key: 'courses', label: 'Cursos', render: (r) => <span className="text-muted">{countByCourse[r.id] || 0}</span> },
  ]

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader title="Escolas / Instituições" subtitle="Dados institucionais. A identidade visual de cada uma é editada em Identidade.">
        <Button icon={Plus} onClick={() => nav('/escolas/novo')}>Nova escola</Button>
      </PageHeader>
      <PageState loading={loading} error={error} onRetry={refetch}>
        <DataTable columns={columns} rows={(schools || []).map((s, i) => ({ id: s.id || i, ...s }))}
          searchKeys={['name']} rowActions={(r) => open(r.id)} onRowClick={(r) => open(r.id)}
          emptyTitle="Nenhuma escola" emptyDesc="Crie a primeira instituição." />
      </PageState>
    </div>
  )
}
