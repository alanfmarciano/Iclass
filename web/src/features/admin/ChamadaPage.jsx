import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  ClipboardCheck, Download, Check, X, Clock, LogOut, FileText, Paperclip, Users,
  AlertTriangle, Search, PencilLine, TrendingDown, RotateCcw, Loader2,
} from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { PageState } from '../../components/ui/PageState'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'

// ---------------------------------------------------------------------------
// Status exibido por ALUNO. O backend guarda status por AULA (presente/falta/
// justificada); "atrasado" e "saiu cedo" são derivados: faltas no começo do dia
// indicam atraso, faltas no fim indicam saída antecipada (regra §4.2 do plano).
// ---------------------------------------------------------------------------
const STATUS = [
  { key: 'p', label: 'Presente', Icon: Check, cls: 'bg-success-soft text-success border-success/40' },
  { key: 'a', label: 'Atrasado', Icon: Clock, cls: 'bg-warning-soft text-warning border-warning/40' },
  { key: 'f', label: 'Falta', Icon: X, cls: 'bg-danger-soft text-danger border-danger/40' },
  { key: 'j', label: 'Justificado', Icon: FileText, cls: 'bg-info-soft text-info border-info/40' },
]
const JUST_TIPOS = [
  { key: 'atestado', label: 'Atestado médico' },
  { key: 'responsavel', label: 'Justif. do responsável' },
  { key: 'declaracao', label: 'Declaração' },
  { key: 'outro', label: 'Outro' },
]
const FILTROS = [
  { key: 'todos', label: 'Todos' },
  { key: 'semmarcar', label: 'Só sem marcar' },
  { key: 'atrasados', label: 'Atrasados' },
  { key: 'saiucedo', label: 'Saíram cedo' },
  { key: 'risco', label: 'Em risco' },
]
// Tipos que exigem documento anexo para a justificativa ser considerada completa.
const EXIGE_DOC = new Set(['atestado', 'declaracao'])

const dispName = (r) => (r.nomeSocial && r.nomeSocial.trim()) || r.name || r.email
const emptyJust = () => ({ tipo: 'atestado', de: '', ate: '', abonado: false, texto: '', arquivo: '', arquivoNome: '' })
const hhmmToMin = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v || '') ? (+v.slice(0, 2)) * 60 + (+v.slice(3, 5)) : null)
function authHeaders() {
  try {
    const a = JSON.parse(localStorage.getItem('iclass-v3-auth')) || {}
    const h = {}
    if (a.adminSession) h['x-admin-session'] = a.adminSession
    else if (a.adminAuth) h['Authorization'] = a.adminAuth
    return h
  } catch { return {} }
}

// Estado de UI de um aluno a partir das aulas salvas.
function deriveUi(aulas) {
  const base = { st: 'p', arrOrdem: null, arrHora: '', early: false, lvOrdem: null, lvHora: '' }
  if (!aulas || !aulas.length) return base
  if (aulas.some((a) => a.status === 'justificada')) return { ...base, st: 'j' }
  if (aulas.every((a) => a.status === 'falta')) return { ...base, st: 'f' }
  if (aulas.every((a) => a.status === 'presente')) return base
  const sts = aulas.map((a) => a.status)
  const firstP = sts.indexOf('presente')
  const lastP = sts.lastIndexOf('presente')
  const leading = firstP > 0
  const trailing = lastP >= 0 && lastP < aulas.length - 1
  return {
    st: leading ? 'a' : 'p',
    arrOrdem: leading ? aulas[firstP].ordem : null,
    arrHora: leading ? (aulas[firstP - 1].hora || '') : '',
    early: trailing,
    lvOrdem: trailing ? aulas[lastP + 1].ordem : null,
    lvHora: trailing ? (aulas[lastP + 1].hora || '') : '',
  }
}

// Reconstrói as aulas (formato do backend) a partir do estado de UI.
function buildAulas(grade, ui, toleranciaMin) {
  return grade.map((g) => {
    const nova = { ordem: g.ordem, disciplinaId: g.disciplinaId || '', inicio: g.inicio || '', status: 'presente', hora: '' }
    if (ui.st === 'j') return { ...nova, status: 'justificada' }
    if (ui.st === 'f') return { ...nova, status: 'falta' }
    // Atraso: por aula escolhida, ou derivado da hora de chegada + tolerância.
    if (ui.st === 'a') {
      if (ui.arrOrdem && g.ordem < ui.arrOrdem) return { ...nova, status: 'falta', hora: ui.arrHora || '' }
      if (!ui.arrOrdem && ui.arrHora) {
        const ini = hhmmToMin(g.inicio); const che = hhmmToMin(ui.arrHora)
        if (ini != null && che != null && che > ini + (toleranciaMin || 0)) return { ...nova, status: 'falta', hora: ui.arrHora }
      }
    }
    if (ui.early) {
      if (ui.lvOrdem && g.ordem >= ui.lvOrdem) return { ...nova, status: 'falta', hora: ui.lvHora || '' }
      if (!ui.lvOrdem && ui.lvHora) {
        const ini = hhmmToMin(g.inicio); const sai = hhmmToMin(ui.lvHora)
        if (ini != null && sai != null && ini >= sai) return { ...nova, status: 'falta', hora: ui.lvHora }
      }
    }
    return nova
  })
}

const arrMissing = (u) => u.st === 'a' && !u.arrOrdem && !u.arrHora
const lvMissing = (u) => u.early && !u.lvOrdem && !u.lvHora
const jMissing = (u) => u.st === 'j' && (EXIGE_DOC.has(u.just?.tipo) ? !u.just?.arquivo : !(u.just?.arquivo || (u.just?.texto || '').trim()))
const isInvalid = (u) => arrMissing(u) || lvMissing(u) || jMissing(u)
const freqTone = (f) => (f == null ? 'text-subtle bg-surface-2' : f < 75 ? 'text-danger bg-danger-soft' : f < 85 ? 'text-warning bg-warning-soft' : 'text-success bg-success-soft')

export default function ChamadaPage() {
  const { courseId: activeCourseId, courseName, className } = useAdminWorkspace()
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [grade, setGrade] = useState([])
  const [roster, setRoster] = useState([])
  const [ui, setUi] = useState({})              // email -> estado de UI
  const [tolerancia, setTolerancia] = useState(10)
  const [search, setSearch] = useState('')
  const [filtro, setFiltro] = useState('todos')
  const [density, setDensity] = useState('comfort')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [focusIdx, setFocusIdx] = useState(-1)
  const [undoSnap, setUndoSnap] = useState(null)
  const [modal, setModal] = useState(null)
  const toast = useToast()
  const listRef = useRef(null)
  const autosaveRef = useRef(null)

  async function load() {
    if (!className || !date) { setRoster([]); setGrade([]); setUi({}); return }
    setLoading(true); setError(null)
    try {
      const r = await api.get(`/api/admin/attendance/roster?studentClass=${encodeURIComponent(className)}&courseId=${encodeURIComponent(activeCourseId || '')}&date=${encodeURIComponent(date)}`)
      setGrade(r.aulas || [])
      setRoster(r.roster || [])
      setTolerancia(r.toleranciaMin ?? 10)
      const next = {}
      ;(r.roster || []).forEach((s) => {
        next[s.email] = {
          ...deriveUi(s.aulas || []),
          just: s.justificativa ? { ...emptyJust(), ...s.justificativa } : emptyJust(),
          nota: s.observacao || '',
          showNota: !!s.observacao,
        }
      })
      setUi(next); setDirty(false)
      setSavedAt((r.roster || []).some((s) => s.salvo) ? 'carregado' : null)
    } catch (e) { setError(e) } finally { setLoading(false) }
  }
  useEffect(() => { api.get('/api/settings/public', { auth: false }).then((r) => { if (r && r.today) setDate(r.today) }).catch(() => {}) }, [])
  useEffect(() => { load() /* eslint-disable-next-line */ }, [className, date, activeCourseId])

  // ---- edição ----
  const patch = useCallback((email, p) => {
    setUi((m) => ({ ...m, [email]: { ...m[email], ...(typeof p === 'function' ? p(m[email]) : p) } }))
    setDirty(true)
  }, [])

  const setStatus = useCallback((email, st) => {
    patch(email, (cur) => {
      const n = { ...cur, st }
      if (st !== 'a') { n.arrOrdem = null; n.arrHora = '' }
      if (st === 'f' || st === 'j') { n.early = false; n.lvOrdem = null; n.lvHora = '' }
      if (st === 'j' && !n.just) n.just = emptyJust()
      return n
    })
  }, [patch])

  const marcarTodos = (st) => {
    setUndoSnap(ui)
    setUi((m) => {
      const n = { ...m }
      roster.forEach((s) => {
        n[s.email] = { ...n[s.email], st, arrOrdem: null, arrHora: '', early: false, lvOrdem: null, lvHora: '' }
      })
      return n
    })
    setDirty(true)
  }
  const desfazer = () => { if (undoSnap) { setUi(undoSnap); setUndoSnap(null); setDirty(true) } }

  async function uploadJust(email, file) {
    if (!file) return
    const fd = new FormData(); fd.append('file', file); fd.append('studentEmail', email)
    try {
      const res = await fetch('/api/admin/attendance/justification-upload', { method: 'POST', headers: authHeaders(), body: fd })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error((data && data.error) || 'Falha no upload')
      patch(email, (cur) => ({ ...cur, just: { ...(cur.just || emptyJust()), arquivo: data.file, arquivoNome: data.name } }))
      toast.success('Comprovante anexado')
    } catch (e) { toast.error(e.message) }
  }

  // ---- persistência ----
  const buildEntries = useCallback(() => roster.map((s) => {
    const u = ui[s.email] || {}
    const aulas = buildAulas(grade, u, tolerancia)
    return {
      email: s.email,
      aulas,
      justificativa: u.st === 'j' ? u.just : null,
      observacao: u.nota || '',
    }
  }), [roster, ui, grade, tolerancia])

  const salvar = useCallback(async (concluida) => {
    if (!className || !activeCourseId || !grade.length) return
    setSaving(true)
    try {
      const r = await api.post('/api/admin/attendance/bulk', {
        studentClass: className, courseId: activeCourseId, date, concluida, entries: buildEntries(),
      })
      setDirty(false)
      setSavedAt(new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }))
      if (concluida) { toast.success(`Chamada concluída (${r.saved} alunos)`); load() }
      return true
    } catch (e) { toast.error(e.message); return false } finally { setSaving(false) }
  }, [className, activeCourseId, date, grade.length, buildEntries]) // eslint-disable-line

  // Autosave de rascunho: 2s após a última alteração. Não conclui a chamada.
  useEffect(() => {
    if (!dirty || !grade.length || !roster.length) return
    clearTimeout(autosaveRef.current)
    autosaveRef.current = setTimeout(() => { salvar(false) }, 2000)
    return () => clearTimeout(autosaveRef.current)
  }, [dirty, ui, grade.length, roster.length, salvar])

  async function exportCsv() {
    try {
      const text = await api.get(`/api/admin/attendance/export?studentClass=${encodeURIComponent(className)}`, { raw: true })
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob); a.download = `presenca_${className}.csv`; a.click(); URL.revokeObjectURL(a.href)
    } catch (e) { toast.error(e.message) }
  }

  // ---- derivados ----
  const counts = useMemo(() => {
    const c = { p: 0, a: 0, f: 0, j: 0, early: 0, risco: 0, invalid: 0 }
    roster.forEach((s) => {
      const u = ui[s.email]; if (!u) return
      c[u.st] = (c[u.st] || 0) + 1
      if (u.early) c.early++
      if (s.emRisco) c.risco++
      if (isInvalid(u)) c.invalid++
    })
    return c
  }, [roster, ui])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return roster.filter((s) => {
      if (q && !dispName(s).toLowerCase().includes(q)) return false
      const u = ui[s.email] || {}
      if (filtro === 'semmarcar') return !s.salvo
      if (filtro === 'atrasados') return u.st === 'a'
      if (filtro === 'saiucedo') return !!u.early
      if (filtro === 'risco') return !!s.emRisco
      return true
    })
  }, [roster, ui, search, filtro])

  // ---- teclado ----
  useEffect(() => {
    function onKey(e) {
      if (e.target.matches('input, textarea, select')) return
      if (modal) { if (e.key === 'Escape') setModal(null); return }
      const k = e.key.toLowerCase()
      if (k === 'arrowdown') { e.preventDefault(); setFocusIdx((i) => Math.min(visible.length - 1, i + 1)) }
      else if (k === 'arrowup') { e.preventDefault(); setFocusIdx((i) => Math.max(0, i - 1)) }
      else if (focusIdx >= 0 && visible[focusIdx]) {
        const email = visible[focusIdx].email
        const u = ui[email] || {}
        if ('pafj'.includes(k)) setStatus(email, k)
        else if (k === 's') { if (u.st === 'p' || u.st === 'a') patch(email, { early: !u.early }) }
        else if (k === 'n') patch(email, { showNota: !u.showNota })
        else if ('123456789'.includes(k)) {
          const ordem = +k
          if (u.st === 'a') patch(email, { arrOrdem: u.arrOrdem === ordem ? null : ordem })
          else if (u.early) patch(email, { lvOrdem: u.lvOrdem === ordem ? null : ordem })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, focusIdx, ui, modal, setStatus, patch])

  useEffect(() => {
    if (focusIdx < 0 || !listRef.current) return
    const el = listRef.current.children[focusIdx]
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [focusIdx])

  function abrirConclusao() {
    const problemas = []
    const semHoraChegada = roster.filter((s) => arrMissing(ui[s.email] || {})).length
    const semHoraSaida = roster.filter((s) => lvMissing(ui[s.email] || {})).length
    const justIncompleta = roster.filter((s) => jMissing(ui[s.email] || {})).length
    if (semHoraChegada) problemas.push({ tipo: 'bloqueio', texto: 'Atraso sem aula ou hora de chegada', n: semHoraChegada })
    if (semHoraSaida) problemas.push({ tipo: 'bloqueio', texto: 'Saída antecipada sem aula ou hora', n: semHoraSaida })
    if (justIncompleta) problemas.push({ tipo: 'bloqueio', texto: 'Justificativa sem documento ou texto', n: justIncompleta })
    if (counts.risco) problemas.push({ tipo: 'aviso', texto: 'Alunos em risco de frequência', n: counts.risco })
    setModal({ problemas })
  }

  const pad = density === 'compact' ? 'py-1.5' : 'py-3'
  const avatarSize = density === 'compact' ? 'w-8 h-8 text-[11px]' : 'w-10 h-10 text-xs'
  const total = roster.length
  const pct = (n) => (total ? (n / total) * 100 : 0)

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader title="Chamada" subtitle={`Presença por aula · ${courseName || activeCourseId} · ${className}`}>
        {className && roster.length > 0 && grade.length > 0 && (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" icon={Download} onClick={exportCsv}>Exportar CSV</Button>
            <Button size="sm" icon={ClipboardCheck} loading={saving} onClick={abrirConclusao}>Concluir chamada</Button>
          </div>
        )}
      </PageHeader>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl">
        <div className="flex flex-col gap-1.5"><span className="text-sm font-medium text-text">Turma</span><div className="h-[38px] rounded-md border border-border bg-surface-2 px-3 py-2 text-sm font-semibold text-text">{className}</div></div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="attendance-date" className="text-sm font-medium text-text">Data</label>
          <input id="attendance-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-[38px] px-3 rounded-md bg-surface border border-border text-text text-sm" />
        </div>
      </div>

      {!className ? (
        <div className="bg-surface border border-border rounded-xl p-6"><EmptyState icon={Users} title="Selecione uma turma" description="Escolha a turma e a data para fazer a chamada." /></div>
      ) : (
        <PageState loading={loading} error={error} onRetry={load}>
          {roster.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-6"><EmptyState icon={Users} title="Turma sem alunos" description="Nenhum aluno matriculado nesta turma." /></div>
          ) : grade.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-6"><EmptyState icon={Clock} title="Sem aulas neste dia" description="Esta turma não tem grade horária configurada para este dia da semana. Configure a grade em Cursos e turmas, ou escolha outra data." /></div>
          ) : (
            <>
              {/* Barra de progresso + autosave */}
              <section className="sticky top-2 z-30 bg-surface-glass backdrop-blur border border-border rounded-xl shadow-sm p-3 flex flex-wrap items-center gap-4">
                <div className="flex-1 min-w-[240px]">
                  <div className="flex items-baseline justify-between mb-1.5 text-xs">
                    <span className="text-muted font-medium">Progresso da chamada</span>
                    <span className={counts.invalid ? 'text-danger font-semibold' : 'text-success font-semibold'}>
                      {counts.invalid ? `${counts.invalid} com pendência` : 'pronto para concluir'}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-surface-2 overflow-hidden flex" role="img" aria-label={`${counts.p} presentes, ${counts.a} atrasados, ${counts.f} faltas, ${counts.j} justificados`}>
                    <span className="bg-success h-full" style={{ width: `${pct(counts.p)}%` }} />
                    <span className="bg-warning h-full" style={{ width: `${pct(counts.a)}%` }} />
                    <span className="bg-danger h-full" style={{ width: `${pct(counts.f)}%` }} />
                    <span className="bg-info h-full" style={{ width: `${pct(counts.j)}%` }} />
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {saving ? (
                    <span className="inline-flex items-center gap-1.5 text-muted"><Loader2 size={13} className="animate-spin" /> Salvando…</span>
                  ) : dirty ? (
                    <span className="inline-flex items-center gap-1.5 text-warning font-semibold"><span className="w-2 h-2 rounded-full bg-warning" /> Alterações não salvas</span>
                  ) : savedAt ? (
                    <span className="inline-flex items-center gap-1.5 text-success font-semibold"><Check size={13} /> {savedAt === 'carregado' ? 'Rascunho salvo' : `Salvo ${savedAt}`}</span>
                  ) : null}
                </div>
              </section>

              {/* Legenda */}
              <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted px-1">
                <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm bg-success" />{counts.p} presentes</span>
                <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm bg-warning" />{counts.a} atrasados</span>
                <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm bg-danger" />{counts.f} ausentes</span>
                <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm bg-info" />{counts.j} justificados</span>
                <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm bg-early" />{counts.early} saíram cedo</span>
                <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm bg-danger" />{counts.risco} em risco</span>
              </div>

              {/* Aulas do dia */}
              <div className="flex flex-wrap gap-2 items-center text-xs">
                <span className="text-subtle">Aulas do dia:</span>
                {grade.map((a) => (
                  <span key={a.ordem} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 border border-border px-2.5 py-1 text-text">
                    <b>{a.ordem}ª</b>{a.inicio && <span className="text-subtle tabular-nums">{a.inicio}</span>}{a.disciplinaNome && <span>· {a.disciplinaNome}</span>}
                  </span>
                ))}
              </div>

              {/* Ferramentas */}
              <div className="flex flex-wrap gap-2 items-center bg-surface-2 border border-border rounded-xl p-2.5">
                <div className="flex items-center gap-2 bg-surface border border-border rounded-md px-2.5 h-9 flex-1 min-w-[170px] max-w-[260px]">
                  <Search size={14} className="text-subtle shrink-0" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar aluno…" aria-label="Buscar aluno" className="bg-transparent border-none outline-none text-sm text-text w-full" />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {FILTROS.map((f) => (
                    <button key={f.key} type="button" onClick={() => setFiltro(f.key)}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${filtro === f.key ? 'bg-primary text-primary-fg border-primary' : 'border-border text-muted hover:text-text'}`}>
                      {f.label}
                    </button>
                  ))}
                </div>
                <div className="ml-auto flex flex-wrap gap-2 items-center">
                  <div className="inline-flex border border-border rounded-md overflow-hidden bg-surface">
                    <button type="button" onClick={() => setDensity('comfort')} className={`px-2.5 py-1.5 text-xs font-semibold ${density === 'comfort' ? 'bg-primary-soft text-primary' : 'text-subtle'}`}>Confortável</button>
                    <button type="button" onClick={() => setDensity('compact')} className={`px-2.5 py-1.5 text-xs font-semibold ${density === 'compact' ? 'bg-primary-soft text-primary' : 'text-subtle'}`}>Compacto</button>
                  </div>
                  <Button size="sm" variant="ghost" icon={Check} onClick={() => marcarTodos('p')}>Todos presente</Button>
                </div>
              </div>

              {/* Lista */}
              <div ref={listRef} className="bg-surface border border-border rounded-xl divide-y divide-border">
                {visible.map((s, idx) => {
                  const u = ui[s.email] || {}
                  const invalid = isInvalid(u)
                  return (
                    <div key={s.email} onClick={() => setFocusIdx(idx)}
                      className={`px-3 ${pad} flex flex-col gap-2 ${idx === focusIdx ? 'bg-info-soft' : ''} ${invalid ? 'shadow-[inset_3px_0_0_var(--danger)]' : ''}`}>
                      <div className="flex flex-wrap items-center gap-3">
                        <span className={`${avatarSize} rounded-full bg-primary-soft text-primary grid place-items-center font-semibold shrink-0`}>{(dispName(s)[0] || '?').toUpperCase()}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-text truncate flex items-center gap-2">
                            {dispName(s)}
                            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full tabular-nums ${freqTone(s.frequencia)}`} title={`${s.faltasAcumuladas || 0} faltas acumuladas`}>
                              {s.frequencia == null ? '—' : `${s.frequencia}%`}
                            </span>
                            {!s.salvo && <span className="text-[10px] text-subtle">· não salvo</span>}
                          </p>
                          <div className="flex flex-wrap gap-1.5 mt-1">
                            {u.st === 'a' && (u.arrOrdem || u.arrHora) && <Tag tone="warning" Icon={Clock}>chegou {u.arrOrdem ? `${u.arrOrdem}ª aula` : ''}{u.arrOrdem && u.arrHora ? ' · ' : ''}{u.arrHora}</Tag>}
                            {u.early && (u.lvOrdem || u.lvHora) && <Tag tone="early" Icon={LogOut}>saiu {u.lvOrdem ? `${u.lvOrdem}ª aula` : ''}{u.lvOrdem && u.lvHora ? ' · ' : ''}{u.lvHora}</Tag>}
                            {arrMissing(u) && <Tag tone="danger" Icon={AlertTriangle}>falta a hora da chegada</Tag>}
                            {lvMissing(u) && <Tag tone="danger" Icon={AlertTriangle}>falta a hora da saída</Tag>}
                            {jMissing(u) && <Tag tone="danger" Icon={AlertTriangle}>justificativa incompleta</Tag>}
                            {u.st === 'j' && u.just?.arquivoNome && <Tag tone="info" Icon={Paperclip}>{u.just.arquivoNome}{u.just.abonado ? ' · abona' : ' · não abona'}</Tag>}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap">
                          {u.st !== 'j' && (
                            <button type="button" title="Observação" aria-label={`Observação sobre ${dispName(s)}`} onClick={() => patch(s.email, { showNota: !u.showNota })}
                              className={`w-9 h-9 rounded-md border grid place-items-center transition ${u.showNota || u.nota ? 'bg-info-soft text-info border-info/40' : 'border-border text-subtle hover:text-text'}`}>
                              <PencilLine size={14} />
                            </button>
                          )}
                          <button type="button" disabled={u.st === 'f' || u.st === 'j'} onClick={() => patch(s.email, { early: !u.early })} title="Saiu mais cedo"
                            className={`h-9 px-3 rounded-md border text-xs font-semibold inline-flex items-center gap-1.5 transition disabled:opacity-35 disabled:cursor-not-allowed ${u.early ? 'bg-early-soft text-early border-early/40' : 'border-dashed border-border text-subtle hover:text-text'}`}>
                            <LogOut size={13} /> Saiu cedo
                          </button>
                          <div className="flex gap-1 bg-surface-2 border border-border rounded-lg p-1" role="radiogroup" aria-label={`Status de ${dispName(s)}`}>
                            {STATUS.map((st) => (
                              <button key={st.key} type="button" role="radio" aria-checked={u.st === st.key} onClick={() => setStatus(s.email, st.key)} title={st.label}
                                className={`h-8 px-2.5 rounded-md border text-xs font-semibold inline-flex items-center gap-1.5 transition ${u.st === st.key ? st.cls : 'border-transparent text-subtle hover:text-text'}`}>
                                <st.Icon size={13} /><span className="hidden lg:inline">{st.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Blocos de detalhe */}
                      {(u.st === 'a' || u.early || u.st === 'j' || u.showNota) && (
                        <div className="flex flex-wrap gap-2.5 sm:pl-[52px]">
                          {u.st === 'a' && (
                            <DetailBlock tone="warning" Icon={Clock} title="Chegada (atraso)" warn={arrMissing(u) ? 'informe aula ou hora' : ''}>
                              <AulaPicker grade={grade} value={u.arrOrdem} tone="warning" onPick={(o) => patch(s.email, { arrOrdem: u.arrOrdem === o ? null : o })} />
                              <span className="text-xs text-subtle">ou</span>
                              <input type="time" value={u.arrHora || ''} onChange={(e) => patch(s.email, { arrHora: e.target.value })} aria-label="Hora de chegada"
                                className="h-8 px-2 rounded-md bg-surface border border-border text-text text-xs tabular-nums" />
                            </DetailBlock>
                          )}
                          {u.early && (
                            <DetailBlock tone="early" Icon={LogOut} title="Saída antecipada" warn={lvMissing(u) ? 'informe aula ou hora' : ''}>
                              <AulaPicker grade={grade} value={u.lvOrdem} tone="early" onPick={(o) => patch(s.email, { lvOrdem: u.lvOrdem === o ? null : o })} />
                              <span className="text-xs text-subtle">ou</span>
                              <input type="time" value={u.lvHora || ''} onChange={(e) => patch(s.email, { lvHora: e.target.value })} aria-label="Hora de saída"
                                className="h-8 px-2 rounded-md bg-surface border border-border text-text text-xs tabular-nums" />
                            </DetailBlock>
                          )}
                          {u.st === 'j' && (
                            <div className="flex-1 min-w-[320px] rounded-lg border border-border bg-info-soft/40 p-3 flex flex-col gap-2">
                              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-info">
                                <FileText size={14} /> Justificativa de ausência
                                {jMissing(u) && <span className="normal-case tracking-normal font-semibold text-danger">— anexe o documento ou escreva a justificativa</span>}
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {JUST_TIPOS.map((t) => (
                                  <button key={t.key} type="button" onClick={() => patch(s.email, { just: { ...(u.just || emptyJust()), tipo: t.key } })}
                                    className={`px-2.5 py-1.5 rounded-md border text-xs font-semibold transition ${u.just?.tipo === t.key ? 'bg-info-soft text-info border-info/40' : 'border-border text-muted hover:text-text'}`}>
                                    {t.label}
                                  </button>
                                ))}
                              </div>
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                {u.just?.arquivo ? (
                                  <span className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-info-soft text-info border border-info/40 font-semibold">
                                    <Paperclip size={13} />{u.just.arquivoNome || 'comprovante'}
                                    <button type="button" onClick={() => patch(s.email, { just: { ...u.just, arquivo: '', arquivoNome: '' } })} className="text-danger" aria-label="Remover anexo">×</button>
                                  </span>
                                ) : (
                                  <label className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-dashed border-border text-subtle hover:text-text cursor-pointer font-semibold">
                                    <Paperclip size={13} /> Anexar {EXIGE_DOC.has(u.just?.tipo) ? 'atestado/documento' : 'documento (opcional)'}
                                    <input type="file" accept=".pdf,image/*" className="hidden" onChange={(e) => uploadJust(s.email, e.target.files?.[0])} />
                                  </label>
                                )}
                                <span className="inline-flex items-center gap-1.5 text-subtle">
                                  de <input type="date" value={u.just?.de || ''} onChange={(e) => patch(s.email, { just: { ...(u.just || emptyJust()), de: e.target.value } })} className="h-8 px-2 rounded-md bg-surface border border-border text-text text-xs" aria-label="Início" />
                                  até <input type="date" value={u.just?.ate || ''} onChange={(e) => patch(s.email, { just: { ...(u.just || emptyJust()), ate: e.target.value } })} className="h-8 px-2 rounded-md bg-surface border border-border text-text text-xs" aria-label="Fim" />
                                </span>
                                <button type="button" onClick={() => patch(s.email, { just: { ...(u.just || emptyJust()), abonado: !u.just?.abonado } })}
                                  className={`px-3 py-1.5 rounded-full text-xs font-bold border transition ${u.just?.abonado ? 'bg-success-soft text-success border-success/40' : 'border-border text-subtle hover:text-text'}`}>
                                  {u.just?.abonado ? 'Abona falta' : 'Não abona falta'}
                                </button>
                              </div>
                              <input value={u.just?.texto || ''} onChange={(e) => patch(s.email, { just: { ...(u.just || emptyJust()), texto: e.target.value } })}
                                placeholder="Justificativa, motivo, observações…" className="h-8 px-3 rounded-md bg-surface border border-border text-text text-xs w-full" />
                            </div>
                          )}
                          {u.showNota && u.st !== 'j' && (
                            <DetailBlock tone="info" Icon={PencilLine} title="Observação">
                              <input value={u.nota || ''} onChange={(e) => patch(s.email, { nota: e.target.value })} placeholder="Motivo, observação, contexto…"
                                className="h-8 px-3 rounded-md bg-surface border border-border text-text text-xs w-full min-w-[240px]" />
                            </DetailBlock>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
                {visible.length === 0 && (
                  <div className="p-6"><EmptyState icon={Search} title="Nenhum aluno encontrado" description="Ajuste a busca ou o filtro para ver os alunos." /></div>
                )}
              </div>

              {/* Ajuda de teclado */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted px-1">
                <span className="font-semibold text-subtle">Atalhos:</span>
                <span><Kbd>↑</Kbd><Kbd>↓</Kbd> navegar</span>
                <span><Kbd>P</Kbd> presente</span><span><Kbd>A</Kbd> atrasado</span>
                <span><Kbd>F</Kbd> falta</span><span><Kbd>J</Kbd> justificado</span>
                <span><Kbd>S</Kbd> saiu cedo</span><span><Kbd>1</Kbd>–<Kbd>{grade.length}</Kbd> aula</span>
                <span><Kbd>N</Kbd> observação</span>
              </div>
            </>
          )}
        </PageState>
      )}

      {/* Desfazer ação em massa */}
      {undoSnap && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9998] flex items-center gap-3 bg-surface border border-border rounded-lg shadow-lg px-4 py-3">
          <span className="text-sm text-text">Todos os alunos foram marcados.</span>
          <button type="button" onClick={desfazer} className="text-sm font-bold text-primary inline-flex items-center gap-1.5"><RotateCcw size={14} /> Desfazer</button>
          <button type="button" onClick={() => setUndoSnap(null)} className="text-subtle hover:text-text" aria-label="Fechar"><X size={15} /></button>
        </div>
      )}

      {/* Modal de conclusão */}
      {modal && (
        <div className="fixed inset-0 z-[9999] bg-black/55 backdrop-blur-sm grid place-items-center p-5" onClick={() => setModal(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="conclusao-titulo" onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg bg-surface border border-border rounded-xl shadow-lg p-6">
            <h3 id="conclusao-titulo" className="text-lg font-bold text-text">Concluir chamada?</h3>
            <p className="mt-1 mb-4 text-sm text-muted">
              {modal.problemas.some((p) => p.tipo === 'bloqueio') ? 'Encontramos pontos que valem revisão antes de finalizar:' : 'Revise o resumo antes de finalizar.'}
            </p>
            {modal.problemas.length === 0 ? (
              <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-md bg-success-soft border border-success/30 text-success text-sm font-semibold">
                <Check size={16} /> Nenhuma pendência. Tudo certo para concluir.
              </div>
            ) : modal.problemas.map((p, i) => (
              <div key={i} className={`flex items-center gap-2.5 px-3 py-2.5 rounded-md border mb-2 text-sm font-semibold ${p.tipo === 'bloqueio' ? 'bg-danger-soft border-danger/30 text-danger' : 'bg-surface-2 border-border text-muted'}`}>
                {p.tipo === 'bloqueio' ? <AlertTriangle size={15} /> : <TrendingDown size={15} />}
                {p.texto}<span className="ml-auto tabular-nums font-bold">{p.n}</span>
              </div>
            ))}
            <div className="flex justify-end gap-2 mt-5">
              <Button size="sm" variant="secondary" onClick={() => setModal(null)}>Revisar</Button>
              <Button size="sm" loading={saving} onClick={async () => { const ok = await salvar(true); if (ok) setModal(null) }}>Concluir chamada</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// --- subcomponentes ---------------------------------------------------------
const TAG_TONE = {
  warning: 'bg-warning-soft text-warning', danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info', early: 'bg-early-soft text-early',
}
function Tag({ tone, Icon, children }) {
  return <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${TAG_TONE[tone]}`}><Icon size={11} />{children}</span>
}

const BLOCK_TONE = { warning: 'border-l-warning', early: 'border-l-early', info: 'border-l-info' }
const BLOCK_TEXT = { warning: 'text-warning', early: 'text-early', info: 'text-info' }
function DetailBlock({ tone, Icon, title, warn, children }) {
  return (
    <div className={`rounded-lg border border-border border-l-[3px] ${BLOCK_TONE[tone]} bg-surface-2 p-3 flex flex-col gap-2 min-w-[250px]`}>
      <div className={`flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide ${BLOCK_TEXT[tone]}`}>
        <Icon size={13} /> {title}
        {warn && <span className="normal-case tracking-normal font-semibold text-danger">— {warn}</span>}
      </div>
      <div className="flex flex-wrap gap-2 items-center">{children}</div>
    </div>
  )
}

function AulaPicker({ grade, value, tone, onPick }) {
  const on = tone === 'early' ? 'bg-early-soft text-early border-early/50' : 'bg-warning-soft text-warning border-warning/50'
  return (
    <div className="flex gap-1">
      {grade.map((g) => (
        <button key={g.ordem} type="button" onClick={() => onPick(g.ordem)} title={g.disciplinaNome || `${g.ordem}ª aula`}
          className={`min-w-[34px] h-8 rounded-md border text-xs font-semibold transition ${value === g.ordem ? on : 'border-border text-muted hover:text-text'}`}>
          {g.ordem}ª
        </button>
      ))}
    </div>
  )
}

const Kbd = ({ children }) => <kbd className="bg-surface-2 border border-border rounded px-1.5 py-0.5 text-[10px] font-semibold text-text mx-0.5">{children}</kbd>
