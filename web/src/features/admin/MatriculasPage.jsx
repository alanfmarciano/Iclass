import { useMemo, useState } from 'react'
import { Clock3, Search, UserCheck, UserRoundCheck, UserX } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { Modal } from '../../components/ui/Modal'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageState } from '../../components/ui/PageState'
import { Select } from '../../components/ui/Select'
import { Textarea } from '../../components/ui/Textarea'
import { useToast } from '../../context/ToastProvider'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'

const STATUS = {
  pending: { label: 'Aguardando aprovação', tone: 'warning' },
  approved: { label: 'Aprovada', tone: 'success' },
  rejected: { label: 'Recusada', tone: 'danger' },
  cancelled: { label: 'Cancelada pelo aluno', tone: 'neutral' },
}

function when(value) {
  return value ? new Date(Number(value)).toLocaleString('pt-BR') : '-'
}

export default function MatriculasPage() {
  const { courseId, courseName, className: activeClassName } = useAdminWorkspace()
  const path = courseId ? `/api/admin/enrollment-requests?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(activeClassName)}` : null
  const requestsApi = useApi(path, [courseId, activeClassName], { pollMs: 15000 })
  const classesApi = useApi(`/api/admin/classes?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(activeClassName)}`)
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('pending')
  const [page, setPage] = useState(1)
  const [approveRequest, setApproveRequest] = useState(null)
  const [rejectRequest, setRejectRequest] = useState(null)
  const [className, setClassName] = useState(activeClassName)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const requests = requestsApi.data?.requests || []
  const courseClasses = useMemo(() => (classesApi.data || []).filter((item) => item.courseId === courseId && item.name === activeClassName), [classesApi.data, courseId, activeClassName])
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return requests.filter((request) => (!status || request.status === status) && (!term || [request.studentName, request.studentEmail, request.studentPhone, request.requestedClassName]
      .some((value) => String(value || '').toLowerCase().includes(term))))
  }, [requests, query, status])
  const pageSize = 10
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const rows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const pendingCount = requests.filter((request) => request.status === 'pending').length

  function openApprove(request) {
    setApproveRequest(request)
    setClassName(activeClassName)
  }

  async function approve() {
    if (!approveRequest || !className) return toast.error('Escolha a turma do aluno')
    setBusy(true)
    try {
      await api.post(`/api/admin/enrollment-requests/${encodeURIComponent(approveRequest.id)}/approve`, { className })
      toast.success('Matrícula aprovada e acesso liberado')
      setApproveRequest(null)
      await requestsApi.refetch(true)
    } catch (error) { toast.error(error.message) } finally { setBusy(false) }
  }

  async function reject() {
    if (!rejectRequest || !reason.trim()) return toast.error('Informe o motivo da recusa')
    setBusy(true)
    try {
      await api.post(`/api/admin/enrollment-requests/${encodeURIComponent(rejectRequest.id)}/reject`, { reason })
      toast.success('Solicitação recusada')
      setRejectRequest(null)
      setReason('')
      await requestsApi.refetch(true)
    } catch (error) { toast.error(error.message) } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title="Matrículas" subtitle={`Analise solicitações · ${courseName || courseId} · ${activeClassName}`}>
        <Badge tone={pendingCount ? 'warning' : 'success'}>{pendingCount} pendente{pendingCount === 1 ? '' : 's'}</Badge>
      </PageHeader>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} aria-label="Buscar solicitações" placeholder="Buscar por aluno, e-mail ou turma…" className="h-[38px] w-full rounded-md border border-border bg-surface pl-9 pr-3 text-sm text-text" />
        </div>
        <Select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1) }} aria-label="Filtrar situação">
          <option value="pending">Pendentes</option>
          <option value="approved">Aprovadas</option>
          <option value="rejected">Recusadas</option>
          <option value="cancelled">Canceladas</option>
          <option value="">Todas</option>
        </Select>
      </div>

      <PageState loading={requestsApi.loading || classesApi.loading} error={requestsApi.error || classesApi.error} onRetry={() => { requestsApi.refetch(); classesApi.refetch() }}>
        {filtered.length === 0 ? (
          <Card><EmptyState icon={UserRoundCheck} title="Nenhuma solicitação encontrada" description={requests.length ? 'Altere a busca ou o filtro.' : 'As novas inscrições aparecerão aqui.'} /></Card>
        ) : (
          <div className="space-y-3">
            <p className="px-1 text-xs text-subtle">Mostrando {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filtered.length)} de {filtered.length}</p>
            {rows.map((request) => {
              const state = STATUS[request.status] || STATUS.pending
              return (
                <Card key={request.id} className="p-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"><UserRoundCheck size={20} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold text-text">{request.studentName}</h2><Badge tone={state.tone}>{state.label}</Badge></div>
                      <p className="mt-1 text-sm text-muted">{request.studentEmail}{request.studentPhone ? ` · ${request.studentPhone}` : ''}</p>
                      <p className="mt-2 text-sm text-text">{request.courseName} · {request.requestedClassName}{request.requestedPeriod ? ` — ${request.requestedPeriod}` : ''}</p>
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-subtle"><Clock3 size={13} /> Solicitada em {when(request.createdAt)}</p>
                      {request.status === 'rejected' && <p className="mt-2 text-sm text-danger">Motivo: {request.rejectionReason}</p>}
                      {request.reviewedAt && <p className="mt-1 text-xs text-subtle">Analisada por {request.reviewedBy || 'administrador'} em {when(request.reviewedAt)}</p>}
                    </div>
                    {request.status === 'pending' && (
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Button size="sm" variant="secondary" icon={UserX} onClick={() => { setRejectRequest(request); setReason('') }}>Recusar</Button>
                        <Button size="sm" icon={UserCheck} onClick={() => openApprove(request)}>Aprovar</Button>
                      </div>
                    )}
                  </div>
                </Card>
              )
            })}
            {pageCount > 1 && <div className="flex items-center justify-end gap-2"><Button size="sm" variant="secondary" disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Anterior</Button><span className="text-sm text-muted">{currentPage} de {pageCount}</span><Button size="sm" variant="secondary" disabled={currentPage === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>Próxima</Button></div>}
          </div>
        )}
      </PageState>

      <Modal open={!!approveRequest} onClose={() => !busy && setApproveRequest(null)} title="Aprovar matrícula" description={approveRequest ? `${approveRequest.studentName} · ${approveRequest.courseName}` : ''} footer={<><Button variant="ghost" disabled={busy} onClick={() => setApproveRequest(null)}>Cancelar</Button><Button icon={UserCheck} loading={busy} onClick={approve}>Aprovar matrícula</Button></>}>
        <div><p className="mb-1 text-sm font-medium text-text">Turma</p><div className="h-[38px] rounded-md border border-border bg-surface-2 px-3 py-2 text-sm font-semibold text-text">{activeClassName}</div></div>
        <p className="mt-3 text-sm text-muted">O acesso ao curso será liberado imediatamente.</p>
      </Modal>

      <Modal open={!!rejectRequest} onClose={() => !busy && setRejectRequest(null)} title="Recusar matrícula" description={rejectRequest ? rejectRequest.studentName : ''} footer={<><Button variant="ghost" disabled={busy} onClick={() => setRejectRequest(null)}>Cancelar</Button><Button variant="destructive" icon={UserX} loading={busy} onClick={reject}>Confirmar recusa</Button></>}>
        <Textarea label="Motivo da recusa" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Explique ao aluno por que a solicitação não foi aprovada." />
      </Modal>
    </div>
  )
}
