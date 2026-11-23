// Atividades do aluno (fase 3, C9 / P1-g; FUN-01): as tarefas com prazo e envio da turma,
// em cartões, separadas em "A fazer", "Enviadas" e "Devolvidas". A lista vem de GET
// /api/student/assignments (situação e prazo efetivo prontos, contrato C4 do P1) e se
// atualiza sozinha a cada 30 s (a devolução do professor aparece sem recarregar).
import { Link } from 'react-router-dom'
import { ChevronRight, ClipboardCheck, FileUp } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageState } from '../../components/ui/PageState'
import { HelpLink } from '../../components/ui/HelpLink'
import { useApi } from '../../hooks/useApi'
import { useStudent } from './useStudent'
import { SECTIONS, deadlineLine, groupAssignments, returnSummary, situationTone } from './atividades/atividadeText'

export const ASSIGNMENTS_POLL_MS = 30000

export function assignmentsPath(courseId, studentClass) {
  if (!courseId || !studentClass) return null
  return `/api/student/assignments?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`
}

export function atividadeHref(id) {
  return `/aluno/atividades/${encodeURIComponent(id)}`
}

function AtividadeCard({ row, now, timezone }) {
  const nota = row.nota ? returnSummary(row.nota) : null
  return (
    <li>
      <Link
        to={atividadeHref(row.id)}
        className="group flex min-h-[64px] items-start gap-3 rounded-xl border border-border bg-surface p-4 transition hover:border-primary/50 hover:bg-surface-2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary" aria-hidden="true"><FileUp size={18} /></span>
        <span className="min-w-0 flex-1">
          <span className="block break-words font-semibold text-text">{row.title}</span>
          <span className="mt-1 block text-sm text-muted">{deadlineLine(row, now, timezone)}</span>
          <span className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone={situationTone(row)}>{row.situacaoTexto}</Badge>
            {row.versoes > 0 && <span className="text-xs text-subtle">{row.versoes === 1 ? '1 versão enviada' : `${row.versoes} versões enviadas`}</span>}
            {nota && <span className="text-xs font-semibold text-text">Nota {nota.notaFinal}</span>}
          </span>
        </span>
        <ChevronRight aria-hidden="true" size={18} className="mt-2 shrink-0 text-subtle transition group-hover:text-text" />
      </Link>
    </li>
  )
}

export default function AtividadesPage() {
  const { courseId, studentClass } = useStudent()
  const list = useApi(assignmentsPath(courseId, studentClass), [courseId, studentClass], { pollMs: ASSIGNMENTS_POLL_MS })
  const data = list.data || {}
  const rows = Array.isArray(data.assignments) ? data.assignments : []
  const groups = groupAssignments(rows)
  const now = typeof data.serverNow === 'number' ? data.serverNow : Date.now()
  const timezone = data.timezone || ''

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-text">Atividades</h1>
          <p className="text-sm text-muted">Trabalhos com prazo para enviar pelo celular ou pelo computador. Toque numa atividade para ver o que enviar.</p>
        </div>
        <HelpLink topic="atividades" doc="aluno" className="h-11 w-11" />
      </div>
      {data.turmaEncerrada && <p role="status" className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-muted">Esta turma foi encerrada. O envio não é mais aceito; o que você já enviou continua aqui.</p>}
      <PageState loading={list.loading && !list.data} error={list.data ? null : list.error} onRetry={list.refetch}>
        {rows.length === 0 ? (
          <Card><EmptyState icon={ClipboardCheck} title="Nenhuma atividade por enquanto" description="Quando o professor publicar uma atividade para a sua turma, ela aparece aqui com o prazo." /></Card>
        ) : SECTIONS.map((section) => {
          const items = groups[section.id]
          if (!items.length && !section.empty) return null
          const headingId = `atividades-${section.id}`
          return (
            <section key={section.id} aria-labelledby={headingId} className="space-y-2">
              <h2 id={headingId} className="px-1 text-xs font-semibold uppercase tracking-wider text-subtle">{section.title}{items.length ? ` (${items.length})` : ''}</h2>
              {items.length ? (
                <ul className="space-y-2">
                  {items.map((row) => <AtividadeCard key={row.id} row={row} now={now} timezone={timezone} />)}
                </ul>
              ) : <p className="px-1 text-sm text-muted">{section.empty}</p>}
            </section>
          )
        })}
      </PageState>
    </div>
  )
}
