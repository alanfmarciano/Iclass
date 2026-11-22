import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Archive, ArchiveRestore, FilePlus, FileUp, Pencil, Send, Trash2, Eye } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Card } from '../../components/ui/Card'
import { Select } from '../../components/ui/Select'
import { Tabs } from '../../components/ui/Tabs'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageState } from '../../components/ui/PageState'
import { EmptyState } from '../../components/ui/EmptyState'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { useApi } from '../../hooks/useApi'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'
import { useAuth } from '../../context/AuthProvider'
import { useToast } from '../../context/ToastProvider'
import { api } from '../../lib/api'
import { assignmentStatusInfo, closeLine, countsLine, deadlineLine, hidePlaceholderEmails, opensLine } from './tarefas/assignmentText'

// Tarefas do painel (fase 3, C7 / P1-e; FUN-01): a lista da turma em cartões, com o prazo
// no relógio da escola (relativo e absoluto), a situação (Rascunho, Publicada, Arquivada)
// e as contagens "Para corrigir · Atrasadas · Sem envio" (assignmentStatusSummary do
// servidor, contrato C4 do P1). Filtro por situação e aba "Arquivadas". O link da fila
// "Precisa de você" (/tarefas?filtro=para-corrigir) abre com o filtro.
//
// Ações do cartão: Editar, Publicar (rascunho), Arquivar, Reativar (arquivada) e Excluir
// (só sem entrega: o servidor recusa com 409 e a mensagem aparece). Todas confirmam pelo
// ConfirmDialog. A conta só de consulta (Coordenação, readOnly do whoami) vê a lista e
// abre a tarefa sem os botões de mudar (o servidor recusa o POST dela com 403).
//
// A entrega de cada aluno e a correção (TarefaDetalhePage) chegam no C8.

const FILTERS = Object.freeze([
  { id: 'todas', label: 'Todas' },
  { id: 'publicada', label: 'Publicadas' },
  { id: 'rascunho', label: 'Rascunhos' },
  { id: 'para-corrigir', label: 'Com entregas para corrigir' },
])
const FILTER_IDS = FILTERS.map((item) => item.id)

function applyFilter(list, filter) {
  if (filter === 'publicada' || filter === 'rascunho') return list.filter((item) => item.status === filter)
  if (filter === 'para-corrigir') return list.filter((item) => (item.counts?.paraCorrigir || 0) > 0)
  return list
}

export default function TarefasPage() {
  const { auth } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { courseId, courseName, className } = useAdminWorkspace()
  const readOnly = auth?.readOnly === true
  const tab = searchParams.get('aba') === 'arquivadas' ? 'arquivadas' : 'ativas'
  const filterParam = searchParams.get('filtro') || 'todas'
  const filter = FILTER_IDS.includes(filterParam) ? filterParam : 'todas'
  const status = tab === 'arquivadas' ? 'arquivada' : 'ativas'
  const query = new URLSearchParams({ courseId, studentClass: className, status }).toString()
  const { data, loading, error, refetch } = useApi(courseId && className ? `/api/admin/assignments?${query}` : null, [courseId, className, status])
  const [pending, setPending] = useState(null)
  // Diferença entre o relógio do servidor e o do navegador quando a lista chegou: "faltam
  // 2 dias" conta pelo servidor (D8 do P1).
  const now = useMemo(() => (data && Number.isFinite(data.serverNow) ? data.serverNow : Date.now()), [data])

  const list = useMemo(() => (Array.isArray(data?.assignments) ? data.assignments : []), [data])
  const visible = useMemo(() => (tab === 'arquivadas' ? list : applyFilter(list, filter)), [list, tab, filter])

  function setParams(next) {
    const params = new URLSearchParams(searchParams)
    Object.entries(next).forEach(([key, value]) => { if (value) params.set(key, value); else params.delete(key) })
    setSearchParams(params, { replace: true })
  }

  function ask(kind, assignment) {
    setPending({ kind, assignment })
  }

  async function run() {
    try {
      await runAction()
    } catch (error) {
      // O diálogo mostra a recusa do servidor; nunca com o endereço interno de aluno.
      throw Object.assign(new Error(hidePlaceholderEmails(error?.message) || 'Não foi possível concluir. Tente de novo.'), { data: error?.data, status: error?.status })
    }
  }

  async function runAction() {
    const { kind, assignment } = pending
    const base = `/api/admin/assignments/${encodeURIComponent(assignment.id)}`
    if (kind === 'publish') {
      await api.post(`${base}/publish`, {})
      toast.success('Tarefa publicada')
    } else if (kind === 'archive') {
      await api.post(`${base}/archive`, {})
      toast.success('Tarefa arquivada')
    } else if (kind === 'unarchive') {
      await api.post(`${base}/unarchive`, {})
      toast.success('Tarefa reativada')
    } else if (kind === 'delete') {
      await api.post(`${base}/delete`, { confirm: 'EXCLUIR' })
      toast.success('Tarefa excluída')
    }
    setPending(null)
    refetch()
  }

  const dialog = pending ? DIALOGS[pending.kind](pending.assignment) : null

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <PageHeader title="Tarefas" subtitle={`Trabalhos com prazo e envio pelos alunos · ${courseName || courseId} · ${className}`} helpTopic="tarefas">
        {!readOnly && <Button icon={FilePlus} className="min-h-[44px] sm:min-h-0" onClick={() => navigate('/tarefas/nova')}>Nova tarefa</Button>}
      </PageHeader>

      <Tabs
        tabs={[{ id: 'ativas', label: 'Ativas' }, { id: 'arquivadas', label: 'Arquivadas' }]}
        active={tab}
        onChange={(id) => setParams({ aba: id === 'arquivadas' ? 'arquivadas' : '', filtro: '' })}
      />

      {tab === 'ativas' && (
        <div className="w-full sm:max-w-xs">
          <Select label="Mostrar" value={filter} onChange={(event) => setParams({ filtro: event.target.value === 'todas' ? '' : event.target.value })}>
            {FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </Select>
        </div>
      )}

      <PageState loading={loading} error={error} onRetry={refetch}>
        {visible.length === 0 ? (
          <Card>
            <EmptyState
              icon={FileUp}
              title={tab === 'arquivadas' ? 'Nenhuma tarefa arquivada' : list.length ? 'Nenhuma tarefa com este filtro' : 'Nenhuma tarefa nesta turma'}
              description={tab === 'arquivadas'
                ? 'Tarefas arquivadas somem para os alunos e ficam aqui, com as entregas guardadas.'
                : list.length ? 'Mude o filtro para ver as outras.' : (readOnly ? 'Esta turma ainda não tem tarefas.' : 'Crie a primeira: o aluno envia o trabalho pelo celular ou pelo computador até o prazo.')}
              action={!readOnly && tab === 'ativas' && !list.length ? 'Nova tarefa' : undefined}
              onAction={() => navigate('/tarefas/nova')}
            />
          </Card>
        ) : (
          <ul className="space-y-3" aria-label="Tarefas da turma">
            {visible.map((assignment) => (
              <li key={assignment.id}>
                <AssignmentCard assignment={assignment} now={now} readOnly={readOnly} onAction={ask} />
              </li>
            ))}
          </ul>
        )}
      </PageState>

      <ConfirmDialog
        open={!!dialog}
        onClose={() => setPending(null)}
        onConfirm={run}
        title={dialog?.title}
        message={dialog?.message}
        confirmLabel={dialog?.confirmLabel}
        tone={dialog?.tone}
      />
    </div>
  )
}

const DIALOGS = {
  publish: (assignment) => ({
    title: 'Publicar a tarefa?',
    message: assignment.opensAt && assignment.local?.opensDate
      ? `"${assignment.title}" aparece para os alunos da turma na data de abertura, com o aviso no sino.`
      : `"${assignment.title}" aparece agora para os alunos da turma, com o aviso no sino.`,
    confirmLabel: 'Publicar',
    tone: 'primary',
  }),
  archive: (assignment) => ({
    title: 'Arquivar a tarefa?',
    message: `"${assignment.title}" some para os alunos. As entregas e as notas ficam guardadas, e a tarefa pode voltar pela aba Arquivadas.`,
    confirmLabel: 'Arquivar',
    tone: 'primary',
  }),
  unarchive: (assignment) => ({
    title: 'Reativar a tarefa?',
    message: assignment.publishedAt
      ? `"${assignment.title}" volta a aparecer para os alunos da turma.`
      : `"${assignment.title}" volta como rascunho.`,
    confirmLabel: 'Reativar',
    tone: 'primary',
  }),
  delete: (assignment) => ({
    title: 'Excluir a tarefa?',
    message: `"${assignment.title}" é apagada de vez. Só dá para excluir tarefa sem nenhum registro de aluno; com entrega ou nota, arquive.`,
    confirmLabel: 'Excluir',
    tone: 'danger',
  }),
}

// Link com a cara do botão secundário (abrir o formulário é navegação, não ação).
function LinkButton({ to, icon: Icon, className = '', label, children }) {
  return (
    <Link to={to} aria-label={label} className={`inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-border bg-surface-raised px-3 text-sm font-semibold text-text transition-all hover:border-[var(--border-strong)] hover:bg-surface-2 ${className}`}>
      <Icon aria-hidden="true" size={16} />{children}
    </Link>
  )
}

function AssignmentCard({ assignment, now, readOnly, onAction }) {
  const info = assignmentStatusInfo(assignment.status)
  const editPath = `/tarefas/${encodeURIComponent(assignment.id)}/editar`
  const opens = opensLine(assignment, now)
  const close = closeLine(assignment)
  // "Excluir" só quando o servidor deixa (deletable: nenhuma linha de aluno, nem nota sem
  // envio ou prorrogação); resposta sem o campo cai nas contagens.
  const canDelete = typeof assignment.deletable === 'boolean' ? assignment.deletable : !((assignment.counts?.enviadas || 0) > 0)
  const actionClass = 'min-h-[44px] sm:min-h-0'
  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 break-words text-base font-semibold text-text">
              <Link to={editPath} className="inline-flex min-h-[44px] items-center hover:underline sm:min-h-0">{assignment.title}</Link>
            </h2>
            <Badge tone={info.tone}>{info.label}</Badge>
          </div>
          <p className="text-sm text-text">{deadlineLine(assignment, now)}</p>
          {opens && <p className="text-xs text-muted">{opens}</p>}
          {close && <p className="text-xs text-muted">{close}</p>}
          {assignment.status !== 'rascunho' && <p className="text-sm text-muted">{countsLine(assignment.counts)}</p>}
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {readOnly ? (
            <LinkButton to={editPath} icon={Eye} className={actionClass} label={`Ver a tarefa ${assignment.title}`}>Ver</LinkButton>
          ) : (
            <>
              {assignment.status !== 'arquivada' && (
                <LinkButton to={editPath} icon={Pencil} className={actionClass} label={`Editar a tarefa ${assignment.title}`}>Editar</LinkButton>
              )}
              {assignment.status === 'rascunho' && <Button size="sm" icon={Send} className={actionClass} onClick={() => onAction('publish', assignment)} aria-label={`Publicar a tarefa ${assignment.title}`}>Publicar</Button>}
              {assignment.status !== 'arquivada' && <Button size="sm" variant="secondary" icon={Archive} className={actionClass} onClick={() => onAction('archive', assignment)} aria-label={`Arquivar a tarefa ${assignment.title}`}>Arquivar</Button>}
              {assignment.status === 'arquivada' && <Button size="sm" variant="secondary" icon={ArchiveRestore} className={actionClass} onClick={() => onAction('unarchive', assignment)} aria-label={`Reativar a tarefa ${assignment.title}`}>Reativar</Button>}
              {canDelete && <Button size="sm" variant="ghost" icon={Trash2} className={`text-danger ${actionClass}`} onClick={() => onAction('delete', assignment)} aria-label={`Excluir a tarefa ${assignment.title}`}>Excluir</Button>}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
