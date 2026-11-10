import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronRight, Download, RotateCcw, ScrollText } from 'lucide-react'
import { Card, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Badge } from '../../components/ui/Badge'
import { PageHeader } from '../../components/ui/PageHeader'
import { api, downloadFile } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'

// Tela Auditoria (H7a-2; SEG-07, FUN-04): a trilha inteira, do mais novo para o mais
// antigo, com filtros no servidor (GET /api/admin/audit) e exportação em CSV com os
// mesmos filtros. Só o administrador (audit.view). Os filtros ficam no endereço, para
// abrir a auditoria de uma prova ou de uma aplicação por link (?examKey=, ?applicationId=).

const PAGE_SIZE = 100
// Filtros da query, na ordem da tela. Os de texto esperam a pessoa parar de digitar.
const FILTER_KEYS = ['from', 'to', 'category', 'actor', 'student', 'courseId', 'studentClass', 'examKey', 'applicationId', 'q']
const TEXT_KEYS = new Set(['student', 'q'])
const TEXT_DELAY_MS = 400

const CATEGORY_TONES = { grade: 'info', exam: 'warning', account: 'danger', backup: 'neutral', system: 'neutral', student: 'success', academic: 'info', other: 'neutral' }

export function fmtAuditDateTime(timestamp) {
  if (!timestamp) return 'data não registrada'
  return new Date(timestamp).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function personText(email, name) {
  if (!email) return ''
  if (email === 'sistema') return 'Sistema'
  return name ? `${name} (${email})` : email
}

function valueText(value) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

function prettyJson(value) {
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

// Resumo de uma linha: o campo e o valor antigo → novo; sem eles, as configurações que
// mudaram; sem nada disso, nada (o resto fica em Detalhes).
export function auditSummary(item) {
  const oldValue = valueText(item.oldValue)
  const newValue = valueText(item.newValue)
  if (oldValue || newValue) return { field: item.field || '', oldValue, newValue }
  const changes = item.details && Array.isArray(item.details.changes) ? item.details.changes : null
  if (changes && changes.length) {
    return { field: 'Mudanças', oldValue: changes.map(change => `${change.key}: ${valueText(change.before)}`).join('; '), newValue: changes.map(change => `${change.key}: ${valueText(change.after)}`).join('; ') }
  }
  return null
}

function filtersFrom(params) {
  const filters = {}
  FILTER_KEYS.forEach(key => { const value = params.get(key); if (value) filters[key] = value })
  return filters
}

function queryFrom(filters, extra = {}) {
  const query = new URLSearchParams()
  FILTER_KEYS.forEach(key => { if (filters[key]) query.set(key, filters[key]) })
  Object.entries(extra).forEach(([key, value]) => query.set(key, String(value)))
  return query.toString()
}

function AuditRow({ item }) {
  const [open, setOpen] = useState(false)
  const summary = auditSummary(item)
  const where = [item.courseName || item.courseId, item.studentClass].filter(Boolean).join(' · ')
  const detailId = `audit-detalhes-${item.id || item.timestamp}`
  const hasJson = item.before !== null || item.after !== null || (item.details !== null && item.details !== undefined)
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text">{item.label || item.action}</span>
            <Badge tone={CATEGORY_TONES[item.category] || 'neutral'}>{item.categoryLabel || item.category}</Badge>
          </div>
          <p className="text-xs text-muted break-words">
            por {personText(item.actor, item.actorName) || 'desconhecido'}
            {item.studentEmail ? <> · aluno {personText(item.studentEmail, item.studentName)}</> : null}
            {item.targetEmail && item.targetEmail !== item.studentEmail ? <> · conta {personText(item.targetEmail, item.targetName)}</> : null}
          </p>
          {(where || item.examTitle || item.examKey) && (
            <p className="text-xs text-subtle break-words">{[where, item.examTitle || item.examKey].filter(Boolean).join(' · ')}</p>
          )}
          {summary && (
            <p className="text-xs text-muted break-words">
              {summary.field && <span className="text-subtle">{summary.field}: </span>}
              {summary.oldValue && <><span className="text-subtle line-through">{summary.oldValue}</span>{' → '}</>}
              <span className="text-text">{summary.newValue || '(vazio)'}</span>
            </p>
          )}
          {item.reason && <p className="text-xs text-text break-words"><span className="text-subtle">Motivo: </span>{item.reason}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <time className="text-xs text-subtle" dateTime={item.timestamp ? new Date(item.timestamp).toISOString() : undefined}>{fmtAuditDateTime(item.timestamp)}</time>
          <button type="button" className="inline-flex min-h-[32px] items-center gap-1 rounded-md px-2 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text"
            aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(value => !value)}>
            {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />} Detalhes
          </button>
        </div>
      </div>
      {open && (
        <div id={detailId} className="mt-2 space-y-2 rounded-lg border border-border bg-surface-2 p-3 text-xs">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
            <dt className="text-subtle">Ação</dt><dd className="break-all text-text">{item.action}</dd>
            {item.ip && <><dt className="text-subtle">IP</dt><dd className="break-all text-text">{item.ip}</dd></>}
            {item.device && <><dt className="text-subtle">Aparelho</dt><dd className="break-words text-text">{item.device}</dd></>}
            {item.applicationId && <><dt className="text-subtle">Aplicação</dt><dd className="break-all text-text">{item.applicationId}</dd></>}
            {item.submissionId && <><dt className="text-subtle">Entrega</dt><dd className="break-all text-text">{item.submissionId}</dd></>}
          </dl>
          {hasJson && (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {item.before !== null && <div><p className="mb-1 font-medium text-muted">Antes</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-2 text-[11px] text-text">{prettyJson(item.before)}</pre></div>}
              {item.after !== null && <div><p className="mb-1 font-medium text-muted">Depois</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-2 text-[11px] text-text">{prettyJson(item.after)}</pre></div>}
              {item.details !== null && item.details !== undefined && <div className="md:col-span-2"><p className="mb-1 font-medium text-muted">Detalhes</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-2 text-[11px] text-text">{prettyJson(item.details)}</pre></div>}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

export default function AuditoriaPage() {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => filtersFrom(params), [params])
  const query = queryFrom(filters)
  // Texto digitado (aluno e busca): vai para o endereço depois de uma pausa.
  const [draft, setDraft] = useState(() => ({ student: filters.student || '', q: filters.q || '' }))
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [facets, setFacets] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState(null)
  const [reload, setReload] = useState(0)
  const requestRef = useRef(0)

  // Atualização em função do endereço atual: o texto que chega depois da pausa não
  // desfaz um filtro escolhido nesse meio-tempo.
  function setFilter(key, value) {
    setParams(current => {
      const next = new URLSearchParams(current)
      if (value) next.set(key, value)
      else next.delete(key)
      // Trocar o curso limpa a turma; trocar a prova limpa a aplicação.
      if (key === 'courseId') next.delete('studentClass')
      if (key === 'examKey') next.delete('applicationId')
      return next
    }, { replace: true })
  }

  useEffect(() => {
    const timers = [...TEXT_KEYS].map(key => {
      if ((draft[key] || '') === (filters[key] || '')) return null
      return setTimeout(() => setFilter(key, draft[key].trim()), TEXT_DELAY_MS)
    })
    return () => timers.forEach(timer => timer && clearTimeout(timer))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  useEffect(() => {
    const requestId = ++requestRef.current
    setLoading(true)
    setError(null)
    api.get(`/api/admin/audit?${queryFrom(filters, { limit: PAGE_SIZE, offset: 0, ...(facets ? {} : { facets: 1 }) })}`)
      .then(data => {
        if (requestId !== requestRef.current) return
        setItems(data.items || [])
        setTotal(data.total || 0)
        if (data.facets) setFacets(data.facets)
      })
      .catch(err => { if (requestId === requestRef.current) { setItems([]); setTotal(0); setError(err) } })
      .finally(() => { if (requestId === requestRef.current) setLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, reload])

  async function loadMore() {
    const requestId = requestRef.current
    setLoadingMore(true)
    try {
      const data = await api.get(`/api/admin/audit?${queryFrom(filters, { limit: PAGE_SIZE, offset: items.length })}`)
      if (requestId !== requestRef.current) return
      setItems(current => [...current, ...(data.items || [])])
      setTotal(data.total || 0)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoadingMore(false)
    }
  }

  async function exportCsv() {
    setExporting(true)
    try {
      await downloadFile(`/api/admin/audit/export?${query}`, 'auditoria.csv')
      toast.success('CSV da auditoria baixado.')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setExporting(false)
    }
  }

  function clearFilters() {
    setDraft({ student: '', q: '' })
    setParams(new URLSearchParams(), { replace: true })
  }

  const classes = (facets?.classes || []).filter(item => !filters.courseId || !item.courseId || item.courseId === filters.courseId)
  const applications = (facets?.applications || []).filter(item => !filters.examKey || item.examKey === filters.examKey)
  const hasFilters = FILTER_KEYS.some(key => filters[key])
  const fieldError = error?.status === 400 ? error.data?.field : null
  // Valor do endereço que não está nas opções (link antigo, aplicação sem entrada): fica na lista.
  const withCurrent = (list, value, label = value) => (value && !list.some(item => item.value === value) ? [...list, { value, label }] : list)

  return (
    <div className="space-y-5">
      <PageHeader title="Auditoria" subtitle="Quem fez o quê, quando e de onde. Só o administrador vê esta tela.">
        <Button variant="secondary" icon={Download} loading={exporting} onClick={exportCsv} disabled={loading || !!error || total === 0}>Exportar CSV</Button>
      </PageHeader>

      <Card>
        <CardBody className="pt-5">
          <form className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => event.preventDefault()} aria-label="Filtros da auditoria">
            <Input type="date" label="De" value={filters.from || ''} onChange={(event) => setFilter('from', event.target.value)} error={fieldError === 'from' ? error.message : undefined} />
            <Input type="date" label="Até" value={filters.to || ''} onChange={(event) => setFilter('to', event.target.value)} error={fieldError === 'to' ? error.message : undefined} />
            <Select label="Categoria" value={filters.category || ''} onChange={(event) => setFilter('category', event.target.value)}>
              <option value="">Todas</option>
              {(facets?.categories || []).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </Select>
            <Select label="Quem fez" value={filters.actor || ''} onChange={(event) => setFilter('actor', event.target.value)}>
              <option value="">Todos</option>
              {withCurrent(facets?.actors || [], filters.actor).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </Select>
            <Input label="Aluno" placeholder="E-mail ou nome" value={draft.student} onChange={(event) => setDraft(current => ({ ...current, student: event.target.value }))} />
            <Select label="Curso" value={filters.courseId || ''} onChange={(event) => setFilter('courseId', event.target.value)}>
              <option value="">Todos</option>
              {withCurrent(facets?.courses || [], filters.courseId).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </Select>
            <Select label="Turma" value={filters.studentClass || ''} onChange={(event) => setFilter('studentClass', event.target.value)}>
              <option value="">Todas</option>
              {withCurrent([...new Map(classes.map(item => [item.value, item])).values()], filters.studentClass).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </Select>
            <Select label="Prova" value={filters.examKey || ''} onChange={(event) => setFilter('examKey', event.target.value)}>
              <option value="">Todas</option>
              {withCurrent(facets?.exams || [], filters.examKey).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </Select>
            <Select label="Aplicação" value={filters.applicationId || ''} onChange={(event) => setFilter('applicationId', event.target.value)}>
              <option value="">Todas</option>
              {withCurrent(applications, filters.applicationId).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </Select>
            <div className="sm:col-span-2 lg:col-span-2">
              <Input label="Buscar" placeholder="Campo, valor, motivo ou pessoa" value={draft.q} onChange={(event) => setDraft(current => ({ ...current, q: event.target.value }))} />
            </div>
            <div className="flex items-end">
              <Button type="button" variant="ghost" icon={RotateCcw} onClick={clearFilters} disabled={!hasFilters && !draft.student && !draft.q}>Limpar filtros</Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text"><ScrollText size={15} aria-hidden="true" /> Eventos</h2>
            {!loading && !error && <span className="text-xs text-subtle" aria-live="polite">{items.length} de {total} evento(s)</span>}
          </div>
          {loading ? (
            <p className="py-6 text-sm text-muted">Carregando a auditoria...</p>
          ) : error ? (
            <div role="alert" className="py-6 text-sm text-danger">
              {fieldError ? 'Corrija o filtro marcado acima.' : error.message}
              {error.status !== 400 && <div className="mt-3"><Button size="sm" variant="secondary" onClick={() => setReload(value => value + 1)}>Tentar novamente</Button></div>}
            </div>
          ) : items.length === 0 ? (
            <p className="py-6 text-sm text-muted">{hasFilters ? 'Nenhum evento com estes filtros.' : 'Nenhum evento registrado ainda.'}</p>
          ) : (
            <>
              <ol className="divide-y divide-border">
                {items.map((item, index) => <AuditRow key={item.id || `${item.timestamp}-${index}`} item={item} />)}
              </ol>
              {items.length < total && (
                <div className="pt-3 text-center">
                  <Button variant="secondary" loading={loadingMore} onClick={loadMore}>Carregar mais</Button>
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
