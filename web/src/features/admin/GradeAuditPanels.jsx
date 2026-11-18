import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { PageState } from '../../components/ui/PageState'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'

const fmtDateTime = (t) => (t ? new Date(t).toLocaleString('pt-BR') : '—')

// Lixeira de notas (AVA-08): entregas excluídas da turma, com quem excluiu e
// quando. "Restaurar" devolve o registro exatamente como estava (publicado ou não).
export function DeletedGradesModal({ open, onClose, courseId, studentClass, onRestored }) {
  const toast = useToast()
  const [busyId, setBusyId] = useState(null)
  const query = new URLSearchParams({ courseId: courseId || '', studentClass: studentClass || '' }).toString()
  const { data, loading, error, refetch } = useApi(open ? `/api/admin/submissions/deleted?${query}` : null)
  const items = data?.items || []

  async function restore(item) {
    setBusyId(item.auditId)
    try {
      const result = await api.post('/api/admin/submissions/restore', { auditId: item.auditId })
      toast.success(result?.message || 'Nota restaurada')
      await refetch()
      onRestored?.()
    } catch (e) {
      toast.error(e.message || 'Não foi possível restaurar a nota')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Notas excluídas"
      description="Entregas excluídas desta turma. A nota volta para Resultados exatamente como estava.">
      <PageState loading={loading} error={error} onRetry={refetch}>
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Nenhuma nota excluída nesta turma.</p>
        ) : (
          <ul className="divide-y divide-border border-y border-border" aria-label="Notas excluídas">
            {items.map((item) => (
              <li key={item.auditId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text">{item.studentName}</p>
                  <p className="text-xs text-muted">
                    {item.examTitle} · tentativa {item.attemptNumber} · nota {item.grade || 'inválida'} · {item.gradePublished ? 'publicada' : 'em revisão'}
                  </p>
                  <p className="text-xs text-subtle">Excluída em {fmtDateTime(item.deletedAt)} por {item.deletedBy || '—'}</p>
                </div>
                {item.canRestore
                  ? <Button size="sm" variant="secondary" icon={RotateCcw} loading={busyId === item.auditId} disabled={!!busyId} onClick={() => restore(item)}>Restaurar</Button>
                  : <Badge tone="neutral">Aluno fora do cadastro</Badge>}
              </li>
            ))}
          </ul>
        )}
      </PageState>
    </Modal>
  )
}

const KIND_LABEL = { application: 'Aplicação', exam: 'Prova', grade: 'Nota' }
const KIND_TONE = { application: 'neutral', exam: 'info', grade: 'warning' }

// Registro de uma aplicação (AVA-08): criação, início e encerramento, anulação,
// troca e correção de questão, contestações e cada alteração de nota das entregas.
export function ApplicationAuditModal({ open, onClose, applicationId }) {
  const { data, loading, error, refetch } = useApi(open && applicationId ? `/api/admin/exam-applications/${encodeURIComponent(applicationId)}/audit` : null)
  const entries = data?.entries || []
  const app = data?.application
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Registro da aplicação"
      description={app ? `${app.examTitle} · turma ${app.studentClass} · criada em ${fmtDateTime(app.createdAt)}` : 'O que aconteceu nesta aplicação, em ordem.'}>
      <PageState loading={loading} error={error} onRetry={refetch}>
        {entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Nada registrado nesta aplicação.</p>
        ) : (
          <ol className="space-y-2" aria-label="Registro da aplicação">
            {entries.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge tone={KIND_TONE[entry.kind] || 'neutral'}>{KIND_LABEL[entry.kind] || 'Registro'}</Badge>
                    <span className="text-sm font-medium text-text">{entry.title}</span>
                  </span>
                  <span className="text-xs text-subtle">{fmtDateTime(entry.at)}</span>
                </div>
                {entry.detail && <p className="mt-1 break-words text-xs text-muted">{entry.detail}</p>}
                {entry.actor && <p className="mt-1 text-xs text-subtle">por {entry.actor}</p>}
              </li>
            ))}
          </ol>
        )}
      </PageState>
    </Modal>
  )
}
