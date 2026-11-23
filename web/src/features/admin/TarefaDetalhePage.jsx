import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Archive, ArchiveRestore, ArrowLeft, ClipboardCheck, Copy, Download, Pencil, Send, Trash2, Undo2, Users } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Card } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageState } from '../../components/ui/PageState'
import { EmptyState } from '../../components/ui/EmptyState'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { useApi } from '../../hooks/useApi'
import { useAuth } from '../../context/AuthProvider'
import { useToast } from '../../context/ToastProvider'
import { api, downloadFile } from '../../lib/api'
import { fmtGrade } from '../../lib/grades'
import { assignmentStatusInfo, closeLine, countsLine, deadlineLine, hidePlaceholderEmails, latePolicyText, studentKey, studentLabel } from './tarefas/assignmentText'
import { ASSIGNMENT_DIALOGS } from './tarefas/assignmentDialogs'
import { ROSTER_FILTERS, ROSTER_FILTER_IDS, filterCounts, isReturnableRow, lateText, rowDisplay, rowMatches, rowStatusInfo, schoolDateTime } from './tarefas/correction'
import { CorrecaoPanel } from './tarefas/CorrecaoPanel'
import { TOUCH, TOUCH_SQUARE } from './tarefas/touch'

// Detalhe de uma tarefa no painel (fase 3, C8 / P1-f; FUN-01, D9, D10 e D13 do P1). Rota
// /tarefas/:id (o título do cartão em Tarefas).
//
// - Cabeçalho com o prazo no relógio da escola, a regra de atraso, as contagens e as
//   ações: Editar, Publicar (rascunho), Arquivar e Reativar, Excluir (só sem nenhum
//   registro de aluno), Copiar para outra turma, Baixar entregas (ZIP, a última versão ou
//   todas) e Devolver todas as corrigidas.
// - A lista da turma (GET /api/admin/assignments/:id, roster): tabela no computador e
//   cartões no celular, com o aluno (nome, matrícula, "sem e-mail" no aluno sem e-mail),
//   a situação, quando chegou, o atraso, a versão e a nota. Filtros "Para corrigir",
//   "Corrigidas, sem devolver", "Atrasadas", "Sem envio" e "Devolvidas" (?filtro=).
// - "Corrigir" (ou "Abrir") abre o painel de correção (CorrecaoPanel); "Próximo aluno"
//   segue a lista filtrada como estava quando o painel abriu.
// - A conta só de consulta (Coordenação) vê tudo e baixa o ZIP, sem os botões de mudar
//   (o servidor recusa o POST dela com 403). Tarefa arquivada mostra as entregas sem
//   corrigir (reative antes); rascunho ainda não tem entrega.

const EXPORT_OPTIONS = Object.freeze([
  { id: 'ultima', label: 'Só a última versão de cada aluno' },
  { id: 'todas', label: 'Todas as versões' },
])

export default function TarefaDetalhePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { auth } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const readOnly = auth?.readOnly === true
  const base = `/api/admin/assignments/${encodeURIComponent(id || '')}`
  const { data, loading, error, refetch, setData } = useApi(id ? base : null, [id])
  const filterParam = searchParams.get('filtro') || 'todos'
  const filter = ROSTER_FILTER_IDS.includes(filterParam) ? filterParam : 'todos'
  const [panel, setPanel] = useState(null)
  const [pending, setPending] = useState(null)
  const [exportChoice, setExportChoice] = useState('ultima')
  const [copy, setCopy] = useState({ target: '', dueDate: '', dueTime: '', courses: null, error: '' })

  const assignment = data?.assignment || null
  const timezone = data?.timezone || ''
  const serverNow = Number.isFinite(data?.serverNow) ? data.serverNow : Date.now()
  const rows = useMemo(() => (Array.isArray(data?.roster) ? data.roster : []), [data])
  const counts = useMemo(() => filterCounts(rows), [rows])
  const visible = useMemo(() => rows.filter((row) => rowMatches(row, filter)), [rows, filter])
  const returnable = useMemo(() => rows.filter(isReturnableRow).length, [rows])
  const status = assignmentStatusInfo(assignment?.status)
  const canGrade = !readOnly && assignment?.status === 'publicada'
  const panelRow = panel ? rows.find((row) => studentKey(row) === panel.key) || null : null

  function setFilter(next) {
    const params = new URLSearchParams(searchParams)
    if (next && next !== 'todos') params.set('filtro', next); else params.delete('filtro')
    setSearchParams(params, { replace: true })
  }

  // Painel: a fila é a lista filtrada de agora (o "Próximo aluno" não pula quando a
  // entrega corrigida sai do filtro).
  function openPanel(row) {
    setPanel({ key: studentKey(row), queue: visible.map(studentKey) })
  }

  // A resposta de uma mudança traz a linha nova do aluno: entra na lista na hora, e a
  // tarefa (contagens) é lida de novo sem piscar a tela.
  function onRowChanged(nextRow) {
    if (!nextRow) return
    setData((current) => {
      if (!current || !Array.isArray(current.roster)) return current
      const roster = current.roster.some((row) => row.studentEmail === nextRow.studentEmail)
        ? current.roster.map((row) => (row.studentEmail === nextRow.studentEmail ? nextRow : row))
        : [...current.roster, nextRow]
      return { ...current, roster }
    })
    refetch(true)
  }

  // Cópia para outra turma: as turmas que a conta vê, com o nome do curso.
  useEffect(() => {
    if (pending?.kind !== 'copy' || copy.courses) return
    let alive = true
    api.get('/api/admin/course-summaries')
      .then((list) => { if (alive) setCopy((current) => ({ ...current, courses: Array.isArray(list) ? list : [] })) })
      .catch((err) => { if (alive) setCopy((current) => ({ ...current, courses: [], error: hidePlaceholderEmails(err?.message) || 'Não foi possível carregar as turmas.' })) })
    return () => { alive = false }
  }, [pending?.kind, copy.courses])

  const copyTargets = useMemo(() => (copy.courses || []).flatMap((course) => (Array.isArray(course.classes) ? course.classes : [])
    .map((cls) => ({ value: JSON.stringify([course.id, cls.name]), label: `${cls.name} · ${course.name || course.id}`, same: course.id === assignment?.courseId && cls.name === assignment?.studentClass }))), [copy.courses, assignment])

  function ask(kind) {
    if (kind === 'copy') setCopy((current) => ({ ...current, target: '', dueDate: assignment?.local?.dueDate || '', dueTime: assignment?.local?.dueTime || '', error: '' }))
    setPending({ kind })
  }

  async function run(reason) {
    try {
      await runAction(reason)
    } catch (err) {
      // O servidor pediu o motivo (nota devolvida que entra ou sai da média, C18): a pergunta
      // passa a mostrar o campo.
      if (err?.data?.code === 'reason_required') setPending((current) => (current ? { ...current, forceReason: true } : current))
      throw Object.assign(new Error(hidePlaceholderEmails(err?.message) || 'Não foi possível concluir. Tente de novo.'), { data: err?.data, status: err?.status })
    }
  }

  async function runAction(reason) {
    const kind = pending?.kind
    const withReason = reason && String(reason).trim() ? { reason: String(reason).trim() } : {}
    if (kind === 'publish') {
      await api.post(`${base}/publish`, withReason)
      toast.success('Tarefa publicada')
    } else if (kind === 'archive') {
      await api.post(`${base}/archive`, withReason)
      toast.success('Tarefa arquivada')
    } else if (kind === 'unarchive') {
      await api.post(`${base}/unarchive`, withReason)
      toast.success('Tarefa reativada')
    } else if (kind === 'delete') {
      await api.post(`${base}/delete`, { confirm: 'EXCLUIR' })
      toast.success('Tarefa excluída')
      setPending(null)
      navigate('/tarefas', { replace: true })
      return
    } else if (kind === 'return-all') {
      const result = await api.post(`${base}/return-all`, {})
      const returned = Number(result?.returned) || 0
      if (returned) toast.success(returned === 1 ? '1 correção devolvida ao aluno' : `${returned} correções devolvidas aos alunos`)
      else toast.info('Nenhuma correção salva para devolver.')
      if (Number(result?.newVersionPending) > 0) toast.warning(`${result.newVersionPending} aluno(s) mandaram versão nova depois da correção e ficaram de fora: corrija de novo.`)
    } else if (kind === 'export') {
      await downloadFile(`${base}/export?versoes=${exportChoice}`, 'entregas.zip')
      toast.success('ZIP das entregas baixado')
    } else if (kind === 'copy') {
      if (!copy.target) throw new Error('Escolha a turma de destino.')
      const [courseId, studentClass] = JSON.parse(copy.target)
      const result = await api.post(`${base}/copy`, { courseId, studentClass, dueDate: copy.dueDate || null, dueTime: copy.dueTime || null })
      toast.success(`Cópia criada como rascunho na turma ${studentClass}`)
      ;(Array.isArray(result?.avisos) ? result.avisos : []).forEach((aviso) => toast.warning(aviso))
    }
    setPending(null)
    refetch(true)
  }

  const dialog = pending ? dialogFor(pending.kind, { assignment, returnable, exportChoice, setExportChoice, copy, setCopy, copyTargets, forceReason: pending.forceReason === true }) : null

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <PageHeader title={assignment?.title || 'Tarefa'} subtitle={assignment ? `Turma ${assignment.studentClass}${timezone ? ` · horários no relógio da escola (${timezone})` : ''}` : ''} helpTopic="tarefas" helpClassName={TOUCH_SQUARE}>
        <Button variant="ghost" icon={ArrowLeft} className={TOUCH} onClick={() => navigate('/tarefas')}>Voltar para Tarefas</Button>
      </PageHeader>

      <PageState loading={loading && !data} error={!data ? error : null} onRetry={() => refetch()}>
        {assignment && (
          <>
            <Card className="p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={status.tone}>{status.label}</Badge>
                {readOnly && <Badge tone="neutral">Só consulta</Badge>}
              </div>
              <div className="space-y-1">
                <p className="text-sm text-text">{deadlineLine(assignment, serverNow)}</p>
                {closeLine(assignment) && <p className="text-xs text-muted">{closeLine(assignment)}</p>}
                <p className="text-xs text-muted">{latePolicyText(assignment.latePolicy)}</p>
                {assignment.status !== 'rascunho' && <p className="text-sm text-muted">{countsLine(assignment.counts)}</p>}
              </div>
              {assignment.status === 'rascunho' && <p className="text-sm text-muted">Rascunho: os alunos ainda não veem esta tarefa. Publique para receber as entregas.</p>}
              {assignment.status === 'arquivada' && <p className="text-sm text-muted">Arquivada: os alunos não veem a tarefa. As entregas ficam guardadas; reative para corrigir.</p>}
              <div className="flex flex-wrap gap-2">
                {!readOnly && assignment.status !== 'arquivada' && (
                  <Link to={`/tarefas/${encodeURIComponent(assignment.id)}/editar`} className={`inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-border bg-surface-raised px-3 text-sm font-semibold text-text hover:bg-surface-2 ${TOUCH}`}>
                    <Pencil aria-hidden="true" size={16} />Editar
                  </Link>
                )}
                {readOnly && (
                  <Link to={`/tarefas/${encodeURIComponent(assignment.id)}/editar`} className={`inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-border bg-surface-raised px-3 text-sm font-semibold text-text hover:bg-surface-2 ${TOUCH}`}>
                    <Pencil aria-hidden="true" size={16} />Ver o formulário
                  </Link>
                )}
                {!readOnly && assignment.status === 'rascunho' && <Button size="sm" icon={Send} className={TOUCH} onClick={() => ask('publish')}>Publicar</Button>}
                {canGrade && returnable > 0 && <Button size="sm" icon={Undo2} className={TOUCH} onClick={() => ask('return-all')}>Devolver todas as corrigidas ({returnable})</Button>}
                {assignment.status !== 'rascunho' && <Button size="sm" variant="secondary" icon={Download} className={TOUCH} onClick={() => ask('export')}>Baixar entregas (ZIP)</Button>}
                {!readOnly && <Button size="sm" variant="secondary" icon={Copy} className={TOUCH} onClick={() => ask('copy')}>Copiar para outra turma</Button>}
                {!readOnly && assignment.status !== 'arquivada' && <Button size="sm" variant="secondary" icon={Archive} className={TOUCH} onClick={() => ask('archive')}>Arquivar</Button>}
                {!readOnly && assignment.status === 'arquivada' && <Button size="sm" variant="secondary" icon={ArchiveRestore} className={TOUCH} onClick={() => ask('unarchive')}>Reativar</Button>}
                {!readOnly && assignment.deletable === true && <Button size="sm" variant="ghost" icon={Trash2} className={`text-danger ${TOUCH}`} onClick={() => ask('delete')}>Excluir</Button>}
              </div>
            </Card>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="w-full sm:max-w-xs">
                <Select label="Mostrar" className={TOUCH} value={filter} onChange={(event) => setFilter(event.target.value)}>
                  {ROSTER_FILTERS.map((item) => <option key={item.id} value={item.id}>{`${item.label} (${counts[item.id] || 0})`}</option>)}
                </Select>
              </div>
              <p className="text-sm text-muted">{visible.length === rows.length ? `${rows.length} aluno(s)` : `${visible.length} de ${rows.length} aluno(s)`}</p>
            </div>

            {visible.length === 0 ? (
              <Card>
                <EmptyState icon={Users}
                  title={rows.length ? 'Nenhum aluno com este filtro' : 'Nenhum aluno nesta turma'}
                  description={rows.length ? 'Mude o filtro para ver os outros.' : 'Quando a turma tiver alunos matriculados, eles aparecem aqui.'} />
              </Card>
            ) : (
              <>
                <RosterTable rows={visible} timezone={timezone} canGrade={canGrade} onOpen={openPanel} />
                <RosterCards rows={visible} timezone={timezone} canGrade={canGrade} onOpen={openPanel} />
              </>
            )}
          </>
        )}
      </PageState>

      {panel && panelRow && (
        <CorrecaoPanel
          open
          onClose={() => setPanel(null)}
          assignment={assignment}
          row={panelRow}
          queue={panel.queue}
          onNavigate={(key) => setPanel((current) => ({ ...current, key }))}
          onChanged={onRowChanged}
          readOnly={readOnly}
          timezone={timezone}
          serverNow={serverNow}
        />
      )}

      <ConfirmDialog
        open={!!dialog}
        onClose={() => setPending(null)}
        onConfirm={run}
        title={dialog?.title}
        message={dialog?.message}
        confirmLabel={dialog?.confirmLabel}
        tone={dialog?.tone}
        confirmDisabled={dialog?.confirmDisabled}
        requireReason={dialog?.requireReason === true}
        reasonLabel={dialog?.reasonLabel}
        reasonPlaceholder={dialog?.reasonPlaceholder}
      >
        {dialog?.children}
      </ConfirmDialog>
    </div>
  )
}

function dialogFor(kind, { assignment, returnable, exportChoice, setExportChoice, copy, setCopy, copyTargets, forceReason = false }) {
  if (!assignment) return null
  if (ASSIGNMENT_DIALOGS[kind]) return ASSIGNMENT_DIALOGS[kind](assignment, { forceReason })
  if (kind === 'return-all') {
    return {
      title: 'Devolver todas as corrigidas?',
      message: `${returnable === 1 ? '1 correção salva aparece' : `${returnable} correções salvas aparecem`} para os alunos, com a nota e o comentário. Quem mandou versão nova depois da correção fica de fora.`,
      confirmLabel: 'Devolver',
      tone: 'primary',
    }
  }
  if (kind === 'export') {
    return {
      title: 'Baixar as entregas em ZIP?',
      message: 'Uma pasta por aluno com os arquivos, e a lista.csv com a situação, as datas, o atraso e a nota. O download fica na Auditoria.',
      confirmLabel: 'Baixar',
      tone: 'primary',
      children: (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-text">Versões</legend>
          {EXPORT_OPTIONS.map((option) => (
            <label key={option.id} className="flex min-h-[44px] items-center gap-2 text-sm text-text sm:min-h-0">
              <input type="radio" name="tarefa-zip-versoes" value={option.id} checked={exportChoice === option.id} onChange={() => setExportChoice(option.id)} />
              {option.label}
            </label>
          ))}
        </fieldset>
      ),
    }
  }
  if (kind === 'copy') {
    return {
      title: 'Copiar para outra turma?',
      message: 'A cópia nasce como rascunho na turma escolhida, sem as entregas. Confira e publique por lá.',
      confirmLabel: 'Copiar',
      tone: 'primary',
      confirmDisabled: !copy.target,
      children: (
        <div className="space-y-3">
          {copy.courses === null && <p className="text-sm text-muted" aria-live="polite">Carregando as turmas...</p>}
          {copy.error && <p role="alert" className="text-sm text-danger">{copy.error}</p>}
          {copy.courses !== null && (
            <Select label="Turma de destino" value={copy.target} onChange={(event) => setCopy((current) => ({ ...current, target: event.target.value }))} autoFocus>
              <option value="">Escolha a turma</option>
              {copyTargets.map((target) => <option key={target.value} value={target.value}>{target.same ? `${target.label} (esta turma)` : target.label}</option>)}
            </Select>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input type="date" label="Prazo da cópia: data" value={copy.dueDate} onChange={(event) => setCopy((current) => ({ ...current, dueDate: event.target.value }))} />
            <Input type="time" label="Prazo da cópia: hora" value={copy.dueTime} onChange={(event) => setCopy((current) => ({ ...current, dueTime: event.target.value }))} />
          </div>
        </div>
      ),
    }
  }
  return null
}

function gradeText(row) {
  const grade = row?.grade
  if (!grade || grade.finalScore === null || grade.finalScore === undefined) return '—'
  return fmtGrade(grade.finalScore)
}

function receivedText(row, timezone) {
  if (row?.lastVersion) return schoolDateTime(row.lastVersion.requestAt, timezone)
  if (row?.manualEntry) return `Em mãos, ${schoolDateTime(row.manualEntry.at, timezone)}`
  return '—'
}

function StudentCell({ row }) {
  const who = rowDisplay(row)
  return (
    <div className="min-w-0">
      <p className="break-words font-medium text-text">{who.name}</p>
      {who.detail && <p className="break-words text-xs text-muted">{who.detail}</p>}
    </div>
  )
}

function StatusBadges({ row }) {
  const info = rowStatusInfo(row)
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge tone={info.tone}>{info.label}</Badge>
      {row.newVersionAfterGrade && <Badge tone="warning">Nova versão</Badge>}
      {row.extension && <Badge tone="info">Prazo próprio</Badge>}
      {row.enrolled === false && <Badge tone="neutral">Fora da turma</Badge>}
    </div>
  )
}

// "Corrigir" só na entrega que espera correção; o resto abre o painel do mesmo jeito (nota
// zero, entrega em mãos, prorrogação, mudar a nota devolvida).
function openLabel(row, canGrade) {
  return canGrade && row.status === 'para_corrigir' ? 'Corrigir' : 'Abrir'
}

function RosterTable({ rows, timezone, canGrade, onOpen }) {
  return (
    <Card className="hidden overflow-x-auto md:block">
      <table className="w-full text-sm">
        <caption className="sr-only">Entregas dos alunos da turma</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-4 py-3 font-medium">Aluno</th>
            <th scope="col" className="px-4 py-3 font-medium">Situação</th>
            <th scope="col" className="px-4 py-3 font-medium">Enviada em</th>
            <th scope="col" className="px-4 py-3 font-medium">Atraso</th>
            <th scope="col" className="px-4 py-3 font-medium">Versão</th>
            <th scope="col" className="px-4 py-3 font-medium">Nota</th>
            <th scope="col" className="px-4 py-3 font-medium"><span className="sr-only">Ação</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const label = openLabel(row, canGrade)
            return (
              <tr key={row.studentEmail} className="border-b border-border last:border-0 align-top">
                <td className="px-4 py-3"><StudentCell row={row} /></td>
                <td className="px-4 py-3"><StatusBadges row={row} /></td>
                <td className="px-4 py-3 text-text">{receivedText(row, timezone)}</td>
                <td className="px-4 py-3 text-text">{row.lastVersion?.late ? lateText(row.lastVersion.lateMs) : '—'}</td>
                <td className="px-4 py-3 text-text">{row.versions ? row.versions : '—'}</td>
                <td className="px-4 py-3 text-text">{gradeText(row)}</td>
                <td className="px-4 py-3 text-right">
                  <Button size="sm" variant={label === 'Corrigir' ? 'primary' : 'secondary'} icon={ClipboardCheck} onClick={() => onOpen(row)} aria-label={`${label}: ${studentLabel(row).title}`}>{label}</Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}

function RosterCards({ rows, timezone, canGrade, onOpen }) {
  return (
    <ul className="space-y-3 md:hidden" aria-label="Entregas dos alunos da turma">
      {rows.map((row) => {
        const label = openLabel(row, canGrade)
        return (
          <li key={row.studentEmail}>
            <Card className="p-4 space-y-2">
              <StudentCell row={row} />
              <StatusBadges row={row} />
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted">Enviada em</dt><dd className="text-text">{receivedText(row, timezone)}</dd>
                {row.lastVersion?.late && <><dt className="text-muted">Atraso</dt><dd className="text-text">{lateText(row.lastVersion.lateMs)}</dd></>}
                <dt className="text-muted">Versões</dt><dd className="text-text">{row.versions || '—'}</dd>
                <dt className="text-muted">Nota</dt><dd className="text-text">{gradeText(row)}</dd>
              </dl>
              <Button variant={label === 'Corrigir' ? 'primary' : 'secondary'} icon={ClipboardCheck} className="w-full min-h-[44px]" onClick={() => onOpen(row)} aria-label={`${label}: ${studentLabel(row).title}`}>{label}</Button>
            </Card>
          </li>
        )
      })}
    </ul>
  )
}
