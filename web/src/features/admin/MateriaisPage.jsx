import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { BookOpen, ClipboardList, FileCheck2, ChevronRight, Lock, Unlock, PackageOpen, Layers, CheckCircle2, XCircle, MonitorPlay } from 'lucide-react'
import { Switch } from '../../components/ui/Switch'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { PageState } from '../../components/ui/PageState'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'

const TYPE_ICON = { 'Apostila': BookOpen, 'Prova online': ClipboardList, 'Gabarito': FileCheck2 }

function moduleUnits(mod) {
  return (mod.units || mod.items || []).map((u) => {
    const name = u.name || u.title || u.apostilaKey || u.avaliacaoKey || 'Unidade'
    const items = [
      u.apostilaKey && { key: u.apostilaKey, type: 'Apostila' },
      u.avaliacaoKey && { key: u.avaliacaoKey, type: 'Prova online' },
      u.avaliacaoKey && { key: `Gabarito_${u.avaliacaoKey}`, type: 'Gabarito' },
    ].filter(Boolean)
    return { name, items }
  }).filter((u) => u.items.length)
}

function moduleItems(mod) { return moduleUnits(mod).flatMap((u) => u.items) }
function moduleTitle(mod, i) { return mod.title || mod.name || `Modulo ${i + 1}` }

// A prova online não é um item liberável: ela é aplicada em Provas e controlada no
// Monitor. Em lote, "liberar" vale só para as apostilas (nunca cria aplicação, não
// reabre prova encerrada nem libera gabarito) e "bloquear" para apostilas e gabaritos.
export function batchReleaseKeys(items, value) {
  return items
    .filter((item) => item.type === 'Apostila' || (!value && item.type === 'Gabarito'))
    .map((item) => item.key)
}
// Itens contados como "liberados" (a prova online fica de fora: tem status próprio).
function countedItems(items) { return items.filter((item) => item.type !== 'Prova online') }

const EXAM_STATUS = {
  running: { label: 'Em andamento', tone: 'success' },
  waiting: { label: 'Sala de espera', tone: 'warning' },
  paused: { label: 'Pausada', tone: 'warning' },
  prepared: { label: 'Preparada', tone: 'info' },
  finished: { label: 'Finalizada', tone: 'neutral' },
}
const OPEN_EXAM_STATUSES = new Set(['prepared', 'waiting', 'running', 'paused'])
function examStatusOf(configs, examKey) { return configs?.[examKey]?.status || 'none' }

function relTime(iso) {
  if (!iso) return ''
  const d = new Date(iso); const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return 'agora'
  if (s < 3600) return `ha ${Math.floor(s / 60)} min`
  if (s < 86400) return `ha ${Math.floor(s / 3600)} h`
  const days = Math.floor(s / 86400)
  if (days < 30) return `ha ${days} ${days === 1 ? 'dia' : 'dias'}`
  return d.toLocaleDateString('pt-BR')
}

function Ring({ pct }) {
  const off = 157 - (157 * pct) / 100
  const color = pct >= 100 ? 'var(--success)' : pct > 0 ? 'var(--primary)' : 'var(--text-subtle)'
  return (
    <svg width="60" height="60" viewBox="0 0 60 60" className="shrink-0" role="img" aria-label={`${pct}% liberado`}>
      <circle cx="30" cy="30" r="25" fill="none" stroke="var(--surface-2)" strokeWidth="7" />
      <circle cx="30" cy="30" r="25" fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray="157" strokeDashoffset={off} transform="rotate(-90 30 30)" />
      <text x="30" y="34" textAnchor="middle" fontSize="14" fontWeight="500" fill="var(--text)">{pct}%</text>
    </svg>
  )
}

export default function MateriaisPage() {
  const { courseId, courseName, className } = useAdminWorkspace()
  const [structure, setStructure] = useState(null)
  const [released, setReleased] = useState({})
  const [releaseMeta, setReleaseMeta] = useState({})
  const [examConfigs, setExamConfigs] = useState({})
  const [selIdx, setSelIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const toast = useToast()
  const navigate = useNavigate()

  async function load() {
    if (!courseId) { setStructure(null); return }
    setLoading(true); setError(null)
    try {
      const s = await api.get(`/api/admin/courses/${courseId}/structure?studentClass=${encodeURIComponent(className)}`)
      setStructure(s.structure || [])
      if (className) {
        const st = await api.get(`/api/status?studentClass=${encodeURIComponent(className)}&courseId=${encodeURIComponent(courseId)}`)
        setReleased(st.releasedItems || {})
        setReleaseMeta(st.releaseMeta || {})
        setExamConfigs(st.onlineExamConfigs || {})
      } else { setReleased({}); setReleaseMeta({}); setExamConfigs({}) }
    } catch (e) { setError(e) } finally { setLoading(false) }
  }

  useEffect(() => { load() /* eslint-disable-next-line */ }, [courseId, className])
  useEffect(() => { setSelIdx(0) }, [structure])

  async function toggle(itemKey, value) {
    if (!className) return toast.error('Selecione uma turma')
    setReleased((r) => ({ ...r, [itemKey]: value }))
    if (value) setReleaseMeta((m) => ({ ...m, [itemKey]: { by: 'voce', at: new Date().toISOString() } }))
    try {
      await api.post('/api/admin/release-item', { studentClass: className, courseId, itemKey, released: value })
      toast.success(value ? 'Liberado' : 'Bloqueado')
    } catch (e) {
      toast.error(e.message)
      setReleased((r) => ({ ...r, [itemKey]: !value }))
    }
  }

  async function setBatch(items, value) {
    if (!className) return toast.error('Selecione uma turma')
    const keys = batchReleaseKeys(items, value)
    const skipped = items.length - keys.length
    setReleased((r) => keys.reduce((a, k) => ({ ...a, [k]: value }), r))
    // Um erro não interrompe o lote no meio: cada item é tentado e o resumo diz o que falhou.
    const failures = []
    for (const itemKey of keys) {
      try { await api.post('/api/admin/release-item', { studentClass: className, courseId, itemKey, released: value }) }
      catch (e) { failures.push(e.message) }
    }
    if (failures.length) toast.error(`${failures.length} item(ns) não foram alterados: ${failures[0]}`)
    else if (keys.length) toast.success(value ? 'Apostilas liberadas' : 'Itens bloqueados')
    if (value && skipped > 0) toast.info('Provas e gabaritos não são liberados em lote: aplique a prova em Provas e libere cada gabarito na própria chave.')
    load()
  }

  function openExam(examKey) {
    const cfg = examConfigs[examKey]
    if (cfg && OPEN_EXAM_STATUSES.has(cfg.status) && cfg.applicationId) {
      const params = new URLSearchParams({ courseId, className, examKey, applicationId: cfg.applicationId })
      navigate(`/monitor?${params.toString()}`)
    } else navigate('/provas')
  }

  const modules = structure || []
  const counts = useMemo(() => modules.map((m) => {
    const items = countedItems(moduleItems(m))
    return { total: items.length, on: items.filter((i) => released[i.key]).length }
  }), [modules, released])
  const totals = useMemo(() => counts.reduce((a, c) => ({ total: a.total + c.total, on: a.on + c.on }), { total: 0, on: 0 }), [counts])
  const pct = totals.total ? Math.round((totals.on / totals.total) * 100) : 0

  const selMod = modules[selIdx]
  const selUnits = selMod ? moduleUnits(selMod) : []
  const selItems = selUnits.flatMap((u) => u.items)
  const setAll = (value) => setBatch(modules.flatMap((m) => moduleItems(m)), value)

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader title="Materiais e liberação" subtitle={`Libere apostilas, provas e gabaritos · ${courseName || courseId} · ${className}`}>
        {className && modules.length > 0 && (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" icon={Unlock} onClick={() => setAll(true)}>Liberar todas as apostilas</Button>
            <Button size="sm" variant="secondary" icon={Lock} onClick={() => setAll(false)}>Bloquear tudo</Button>
          </div>
        )}
      </PageHeader>

      <div className="max-w-xl rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-text"><span className="text-subtle">Contexto:</span> <strong>{courseName || courseId} · {className}</strong></div>

      {!courseId ? (
        <div className="bg-surface border border-border rounded-xl p-6"><EmptyState icon={Unlock} title="Escolha um curso" description="Selecione o curso de trabalho para gerenciar liberacoes." /></div>
      ) : !className ? (
        <div className="bg-surface border border-border rounded-xl p-6"><EmptyState icon={Layers} title="Selecione uma turma" description="Escolha a turma acima para ver e liberar os materiais." /></div>
      ) : (
        <PageState loading={loading} error={error} onRetry={load}>
          {modules.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-6"><EmptyState title="Curso sem estrutura" description="Cadastre módulos no Editor de Conteúdo." /></div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center gap-5 bg-surface border border-border rounded-xl p-4 sm:p-5">
                <Ring pct={pct} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text">{totals.on} de {totals.total} itens liberados</p>
                  <p className="text-xs text-muted mt-0.5">{modules.length} modulo{modules.length > 1 ? 's' : ''} - turma {className}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4 items-start">
                <div className="bg-surface border border-border rounded-xl overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-border text-xs text-subtle">Módulos</div>
                  {modules.map((m, i) => {
                    const c = counts[i]; const active = i === selIdx
                    return (
                      <button key={m.id || i} onClick={() => setSelIdx(i)} className={`w-full flex items-center gap-3 px-4 py-3 border-b border-border/60 last:border-0 text-left transition ${active ? 'bg-primary-soft' : 'hover:bg-surface-2'}`}>
                        <span className={`w-7 h-7 grid place-items-center rounded-lg text-xs font-semibold shrink-0 ${active ? 'bg-primary text-primary-fg' : 'bg-surface-2 text-muted'}`}>{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm truncate ${active ? 'text-primary font-medium' : 'text-text'}`}>{moduleTitle(m, i)}</p>
                          <p className="text-xs text-muted mt-0.5">{c.total ? `${c.on} de ${c.total} liberados` : 'sem itens'}</p>
                        </div>
                        {active && <ChevronRight size={16} className="text-primary shrink-0" />}
                      </button>
                    )
                  })}
                </div>

                <div className="bg-surface border border-border rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-4 border-b border-border flex-wrap">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text truncate">{moduleTitle(selMod, selIdx)}</p>
                      <p className="text-xs text-muted mt-0.5">{counts[selIdx]?.on || 0} de {counts[selIdx]?.total || 0} itens liberados - {selUnits.length} unidade{selUnits.length > 1 ? 's' : ''}</p>
                    </div>
                    {selItems.length > 0 && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="secondary" icon={CheckCircle2} onClick={() => setBatch(selItems, true)}>Liberar apostilas</Button>
                        <Button size="sm" variant="secondary" icon={XCircle} onClick={() => setBatch(selItems, false)}>Bloquear</Button>
                      </div>
                    )}
                  </div>
                  {selUnits.length === 0 ? (
                    <div className="p-6"><EmptyState icon={PackageOpen} title="Sem unidades" description="Este módulo ainda não possui materiais cadastrados." /></div>
                  ) : selUnits.map((unit, ui) => {
                    const counted = countedItems(unit.items)
                    const uon = counted.filter((i) => released[i.key]).length
                    const apostilaBlocked = unit.items.some((i) => i.type === 'Apostila' && !released[i.key])
                    const canRelease = apostilaBlocked
                    const canBlock = unit.items.some((i) => i.type !== 'Prova online' && released[i.key])
                    return (
                      <div key={ui} className="border-b border-border last:border-0">
                        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-2.5 bg-surface-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm font-medium text-text truncate">{unit.name}</span>
                            {(canRelease || canBlock) && (
                              <button onClick={() => setBatch(unit.items, canRelease)} className="text-xs text-primary hover:underline shrink-0">{canRelease ? 'liberar apostila' : 'bloquear unidade'}</button>
                            )}
                          </div>
                          <span className="text-xs text-subtle shrink-0">{uon} de {counted.length} liberados</span>
                        </div>
                        {unit.items.map((item) => {
                          const isOn = !!released[item.key]; const Icon = TYPE_ICON[item.type] || BookOpen; const meta = releaseMeta[item.key]
                          if (item.type === 'Prova online') {
                            const status = examStatusOf(examConfigs, item.key)
                            const info = EXAM_STATUS[status] || { label: 'Não aplicada', tone: 'neutral' }
                            const open = OPEN_EXAM_STATUSES.has(status)
                            return (
                              <div key={item.key} className="flex flex-wrap items-center gap-3 px-4 sm:px-5 py-3 pl-8 sm:pl-10 border-b border-border/50 last:border-0">
                                <Icon size={18} className={open ? 'text-text' : 'text-subtle'} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm text-text">{item.type}</p>
                                  <p className="text-xs text-muted mt-0.5">{open ? 'Controlada pelo Monitor: encerre por lá, salvando ou desconsiderando as respostas.' : 'Prepare em Provas e inicie pelo Monitor.'}</p>
                                </div>
                                <Badge tone={info.tone}>{info.label}</Badge>
                                <Button size="sm" variant="secondary" icon={MonitorPlay} onClick={() => openExam(item.key)}>{open ? 'Abrir Monitor' : 'Ir para Provas'}</Button>
                              </div>
                            )
                          }
                          // Gabarito só depois que a aplicação da prova termina.
                          const examKey = item.type === 'Gabarito' ? item.key.replace(/^Gabarito_/, '') : null
                          const lockedByExam = !!examKey && OPEN_EXAM_STATUSES.has(examStatusOf(examConfigs, examKey)) && !isOn
                          return (
                            <div key={item.key} className="flex items-center gap-3 px-4 sm:px-5 py-3 pl-8 sm:pl-10 border-b border-border/50 last:border-0">
                              <Icon size={18} className={isOn ? 'text-text' : 'text-subtle'} />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm text-text">{item.type}</p>
                                {isOn && meta?.by && <p className="text-xs text-muted mt-0.5">liberado por {meta.by} {relTime(meta.at)}</p>}
                                {lockedByExam && <p className="text-xs text-muted mt-0.5">Disponível depois que a aplicação da prova for encerrada.</p>}
                              </div>
                              <span className={`text-xs mr-2 shrink-0 ${isOn ? 'text-success' : 'text-muted'}`}>{isOn ? 'Liberado' : 'Bloqueado'}</span>
                              <Switch checked={isOn} disabled={lockedByExam} onChange={(v) => toggle(item.key, v)} />
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </PageState>
      )}
    </div>
  )
}
