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
import { useAuth } from '../../context/AuthProvider'
import { ADMIN_PERMISSIONS, canAccessAdminPermission, permissionLabel } from '../../lib/adminPermissions'

const ROLE_LABEL = { admin: 'Administrador', professor: 'Professor' }

export default function AdminsPage() {
  const nav = useNavigate()
  const { auth } = useAuth()
  const { data: admins, loading, error, refetch } = useApi('/api/admin/accounts')
  const canManage = canAccessAdminPermission(auth, ADMIN_PERMISSIONS.ACCOUNTS_MANAGE)

  const rows = admins || []
  const stats = useMemo(() => ({
    total: rows.length,
    admins: rows.filter((a) => a.role !== 'professor').length,
    profs: rows.filter((a) => a.role === 'professor').length,
  }), [rows])

  const open = (emailAddr) => nav('/admins/' + encodeURIComponent(emailAddr))

  const columns = [
    { key: 'name', label: 'Nome', render: (r) => <span className="font-medium text-text">{r.name || '—'}</span> },
    { key: 'email', label: 'E-mail', render: (r) => <span className="text-muted">{r.email}</span> },
    { key: 'role', label: 'Papel', render: (r) => <Badge tone={r.role === 'professor' ? 'info' : 'neutral'}>{ROLE_LABEL[r.role] || 'Administrador'}</Badge> },
    { key: 'assignedClasses', label: 'Turmas', render: (r) => r.role === 'professor'
      ? ((r.assignedClasses || []).map((assignment) => assignment.className).join(', ') || '—')
      : `Todas as turmas (${(r.assignedClasses || []).length})` },
    { key: 'additionalPermissions', label: 'Acessos extras', render: (r) => r.role === 'professor' && (r.additionalPermissions || []).length
      ? <span className="text-xs text-muted">{r.additionalPermissions.map(permissionLabel).join(', ')}</span>
      : '—' },
  ]

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader title="Contas de acesso" subtitle="Administradores e professores com acesso ao painel">
        {canManage ? <Button icon={UserPlus} onClick={() => nav('/admins/novo')}>Nova conta</Button> : <Badge tone="neutral">Somente consulta</Badge>}
      </PageHeader>

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Total de contas" value={stats.total} icon="KeyRound" />
        <StatCard label="Administradores" value={stats.admins} icon="ShieldCheck" />
        <StatCard label="Professores" value={stats.profs} icon="GraduationCap" />
      </div>

      <PageState loading={loading} error={error} onRetry={refetch}>
        <DataTable columns={columns} rows={rows.map((a, i) => ({ id: a.email || i, ...a }))}
          searchKeys={['name', 'email']} rowActions={(r) => open(r.email)} onRowClick={(r) => open(r.email)}
          emptyTitle="Nenhuma conta" />
      </PageState>
    </div>
  )
}
