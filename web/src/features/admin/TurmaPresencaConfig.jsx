import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Clock, Copy, Check, Download, AlertTriangle } from 'lucide-react'
import { Modal } from '../../components/ui/Modal'
import { Button } from '../../components/ui/Button'
import { Card, CardBody } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { Badge } from '../../components/ui/Badge'
import { printGrade } from './gradePrint'
import { detectTeacherClashes } from './gradeConflicts'

// Dias da semana usados na grade (0=dom … 6=sáb). Ordem de exibição: seg→dom.
export const WEEKDAYS = [
  { key: '1', label: 'Segunda' },
  { key: '2', label: 'Terça' },
  { key: '3', label: 'Quarta' },
  { key: '4', label: 'Quinta' },
  { key: '5', label: 'Sexta' },
  { key: '6', label: 'Sábado' },
  { key: '0', label: 'Domingo' },
]

const slug = (nome) => String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'DISC'

// ---------------------------------------------------------------------------
// Modal de disciplinas do curso
// ---------------------------------------------------------------------------
export function DisciplinasModal({ open, onClose, course, onSave, saving }) {
  const [list, setList] = useState([])

  // Reinicia a lista quando o modal abre para um curso.
  const courseId = course?.id
  useEffect(() => { if (open) setList((course?.disciplinas || []).map(d => ({ ...d }))) }, [open, courseId]) // eslint-disable-line

  const add = () => setList(l => [...l, { id: '', nome: '', cor: '' }])
  const remove = (i) => setList(l => l.filter((_, idx) => idx !== i))
  const setNome = (i, nome) => setList(l => l.map((d, idx) => idx === i ? { ...d, nome, id: d.id || slug(nome) } : d))
  const setId = (i, id) => setList(l => l.map((d, idx) => idx === i ? { ...d, id: String(id).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16) } : d))

  const save = () => {
    const clean = list.map(d => ({ id: (d.id || slug(d.nome)).toUpperCase(), nome: d.nome.trim(), cor: d.cor || '' })).filter(d => d.nome)
    const ids = clean.map(d => d.id)
    if (new Set(ids).size !== ids.length) return
    onSave(clean)
  }

  return (
    <Modal open={open} onClose={onClose} title="Disciplinas do curso" description={course?.name}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={saving} onClick={save}>Salvar disciplinas</Button></>}>
      <div className="space-y-3">
        <p className="text-xs text-subtle">As disciplinas ficam disponíveis para montar a grade horária de qualquer turma deste curso.</p>
        {list.length === 0 && <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted">Nenhuma disciplina cadastrada.</p>}
        <div className="space-y-2">
          {list.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className="h-[38px] flex-1 rounded-md border border-border bg-surface px-3 text-sm text-text" placeholder="Nome (ex.: Matemática)" value={d.nome} onChange={e => setNome(i, e.target.value)} aria-label="Nome da disciplina" />
              <input className="h-[38px] w-28 rounded-md border border-border bg-surface px-3 text-sm text-text" placeholder="ID" value={d.id} onChange={e => setId(i, e.target.value)} aria-label="Código da disciplina" />
              <button type="button" onClick={() => remove(i)} className="grid h-[38px] w-9 shrink-0 place-items-center rounded-md border border-border text-muted hover:text-danger" aria-label="Remover disciplina"><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
        <Button size="sm" variant="secondary" icon={Plus} onClick={add}>Adicionar disciplina</Button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Editor de grade horária + tolerância + limiar (usado no modal da turma)
// ---------------------------------------------------------------------------
export function GradeEditor({ config, disciplinas, onChange }) {
  const cfg = config || { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} }
  const disc = disciplinas || []

  const setField = (patch) => onChange({ ...cfg, ...patch })
  const setGrade = (wd, aulas) => {
    const grade = { ...cfg.grade }
    if (aulas.length) grade[wd] = aulas; else delete grade[wd]
    onChange({ ...cfg, grade })
  }
  const addAula = (wd) => {
    const cur = cfg.grade[wd] || []
    const ordem = (cur.reduce((m, a) => Math.max(m, a.ordem || 0), 0) || 0) + 1
    setGrade(wd, [...cur, { ordem, inicio: '', disciplinaId: disc[0]?.id || '' }])
  }
  const updateAula = (wd, idx, patch) => setGrade(wd, (cfg.grade[wd] || []).map((a, i) => i === idx ? { ...a, ...patch } : a))
  const removeAula = (wd, idx) => setGrade(wd, (cfg.grade[wd] || []).filter((_, i) => i !== idx))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Input label="Tolerância de atraso (min)" type="number" min="0" max="240" value={cfg.toleranciaMin ?? 10}
          onChange={e => setField({ toleranciaMin: Number(e.target.value) })} />
        <Input label="Limiar de risco (%)" type="number" min="0" max="100" value={cfg.limiarRiscoPct ?? 75}
          onChange={e => setField({ limiarRiscoPct: Number(e.target.value) })} />
      </div>

      {disc.length === 0 && (
        <p className="rounded-lg border border-dashed border-warning/50 bg-warning/10 p-3 text-xs text-warning">
          Cadastre as disciplinas do curso primeiro para poder montá-las na grade.
        </p>
      )}

      <div>
        <h4 className="mb-1 text-sm font-medium text-text">Grade horária</h4>
        <p className="mb-3 text-xs text-subtle">Dias sem aula ficam vazios (não letivos). A quantidade de aulas define o total do dia.</p>
        <div className="space-y-3">
          {WEEKDAYS.map(({ key, label }) => {
            const aulas = cfg.grade[key] || []
            return (
              <div key={key} className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-text">{label}</span>
                  <span className="text-xs text-subtle">{aulas.length ? `${aulas.length} aula(s)` : 'Sem aula'}</span>
                </div>
                {aulas.length > 0 && (
                  <div className="mb-2 space-y-2">
                    {aulas.map((a, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <span className="w-8 shrink-0 text-xs font-semibold text-muted">{a.ordem}ª</span>
                        <span className="inline-flex items-center gap-1 text-subtle"><Clock size={13} />
                          <input type="time" value={a.inicio || ''} onChange={e => updateAula(key, idx, { inicio: e.target.value })}
                            className="h-[34px] rounded-md border border-border bg-surface px-2 text-sm text-text" aria-label={`Início da ${a.ordem}ª aula de ${label}`} />
                        </span>
                        <select value={a.disciplinaId || ''} onChange={e => updateAula(key, idx, { disciplinaId: e.target.value })}
                          className="h-[34px] flex-1 rounded-md border border-border bg-surface px-2 text-sm text-text" aria-label={`Disciplina da ${a.ordem}ª aula de ${label}`}>
                          <option value="">— disciplina —</option>
                          {disc.map(d => <option key={d.id} value={d.id}>{d.nome}</option>)}
                        </select>
                        <button type="button" onClick={() => removeAula(key, idx)} className="grid h-[34px] w-8 shrink-0 place-items-center rounded-md border border-border text-muted hover:text-danger" aria-label="Remover aula"><Trash2 size={14} /></button>
                      </div>
                    ))}
                  </div>
                )}
                <Button size="sm" variant="ghost" icon={Plus} onClick={() => addAula(key)}>Adicionar aula</Button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Assistente de horários (wizard rápido para montar a grade da turma)
// ---------------------------------------------------------------------------

// Ordem de exibição seg→dom; chaves seguem o modelo do backend (0=dom … 6=sáb).
const WD = [
  { key: '1', short: 'Seg', full: 'Segunda' },
  { key: '2', short: 'Ter', full: 'Terça' },
  { key: '3', short: 'Qua', full: 'Quarta' },
  { key: '4', short: 'Qui', full: 'Quinta' },
  { key: '5', short: 'Sex', full: 'Sexta' },
  { key: '6', short: 'Sáb', full: 'Sábado' },
  { key: '0', short: 'Dom', full: 'Domingo' },
]
const WD_KEYS = WD.map(d => d.key)
const STEP_LABELS = ['Matérias', 'Ritmo do dia', 'Montar grade', 'Revisão']
const NEW_SUBJECT_COLORS = ['#e5484d', '#f2a20c', '#46a758', '#12a594', '#0091ff', '#6e56cf', '#c026d3', '#e93d82']

const pad2 = (n) => String(n).padStart(2, '0')
const hmToMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? (+m[1]) * 60 + (+m[2]) : null }
const minToHm = (m) => { const v = ((Math.round(m) % 1440) + 1440) % 1440; return `${pad2(Math.floor(v / 60))}:${pad2(v % 60)}` }
const fmtDur = (min) => { const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h${m ? pad2(m) : ''}` : `${m}min` }

function computeSlots(rhythm) {
  const slots = []
  let cursor = hmToMin(rhythm.start) ?? 420
  for (let i = 0; i < rhythm.count; i++) {
    const start = cursor
    const end = start + rhythm.duration
    const gapAfter = i < rhythm.count - 1 ? (rhythm.gaps[i] ?? rhythm.defaultGap) : 0
    slots.push({ start, end, gapAfter })
    cursor = end + gapAfter
  }
  return slots
}

// Ajusta gaps (count-1) e grid (count colunas por dia) ao número de aulas.
function reshape(rhythm, grid) {
  const gaps = rhythm.gaps.slice(0, Math.max(0, rhythm.count - 1))
  while (gaps.length < rhythm.count - 1) gaps.push(rhythm.defaultGap)
  const nextGrid = {}
  WD_KEYS.forEach(k => {
    const row = (grid[k] || []).slice(0, rhythm.count)
    while (row.length < rhythm.count) row.push('')
    nextGrid[k] = row
  })
  return { rhythm: { ...rhythm, gaps }, grid: nextGrid }
}

// Deriva estado inicial a partir de uma grade já existente (modo edição).
function deriveInitial(config) {
  const grade = (config && config.grade) || {}
  const dayKeys = WD_KEYS.filter(k => Array.isArray(grade[k]) && grade[k].length)
  const emptyGrid = () => Object.fromEntries(WD_KEYS.map(k => [k, []]))
  if (!dayKeys.length) {
    // Padrão de abertura: 07:00, 4 aulas de 55 min geminadas com um recreio de 20 min no meio.
    const base = reshape({ start: '07:00', duration: 55, count: 4, defaultGap: 20, gaps: [0, 20, 0] }, emptyGrid())
    return { ...base, days: { '1': true, '2': true, '3': true, '4': true, '5': true, '6': false, '0': false } }
  }
  let count = 0
  dayKeys.forEach(k => { count = Math.max(count, grade[k].length) })
  const fullest = dayKeys.reduce((a, b) => (grade[b].length > grade[a].length ? b : a), dayKeys[0])
  const aulas = [...grade[fullest]].sort((a, b) => (a.ordem || 0) - (b.ordem || 0))
  const inicios = aulas.map(a => hmToMin(a.inicio)).filter(v => v != null)
  const start = inicios.length ? minToHm(inicios[0]) : '07:00'
  // Reconstrói duração/intervalos a partir dos horários de início (exato no dia mais cheio).
  const blocks = []
  for (let i = 0; i < inicios.length - 1; i++) blocks.push(inicios[i + 1] - inicios[i])
  const positive = blocks.filter(b => b > 0)
  const duration = positive.length ? Math.max(10, Math.min(...positive)) : 50
  const gaps = blocks.map(b => Math.max(0, b - duration))
  const grid = {}
  WD_KEYS.forEach(k => {
    const row = Array.from({ length: count }, () => '')
    ;(grade[k] || []).forEach(a => {
      const idx = (a.ordem || 0) - 1
      if (idx >= 0 && idx < count) row[idx] = String(a.disciplinaId || '').toUpperCase()
    })
    grid[k] = row
  })
  const rhythm = { start, duration, count, defaultGap: gaps[0] ?? 10, gaps }
  const days = Object.fromEntries(WD_KEYS.map(k => [k, dayKeys.includes(k)]))
  return { rhythm, grid, days }
}

const subjectSlug = (nome) => String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16) || 'DISC'

function Stepper({ step }) {
  return (
    <ol className="mt-4 flex items-center gap-1" aria-label="Progresso do assistente">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1
        const done = n < step
        const current = n === step
        return (
          <li key={label} className="flex flex-1 items-center gap-1">
            <span className="flex items-center gap-2">
              <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${done ? 'bg-success-soft text-success' : current ? 'bg-primary text-primary-fg' : 'bg-surface-2 text-subtle border border-border'}`}>
                {done ? <Check size={13} /> : n}
              </span>
              <span className={`hidden text-xs font-medium sm:block ${current ? 'text-text' : 'text-subtle'}`}>{label}</span>
            </span>
            {i < STEP_LABELS.length - 1 && <span className={`h-px flex-1 ${done ? 'bg-success/50' : 'bg-border'}`} />}
          </li>
        )
      })}
    </ol>
  )
}

// Wizard de grade horária. Renderizado como página (a rota monta um por turma,
// com `key`, então o estado inicial é calculado uma única vez por montagem).
export function AssistenteHorariosWizard({ course, turma, allClasses = [], professors = [], onSave, onCancel, saving }) {
  const [initial] = useState(() => deriveInitial(turma?.attendanceConfig))
  const [step, setStep] = useState(1)
  const [subjects, setSubjects] = useState(() => (course?.disciplinas || []).map(d => ({ id: d.id, nome: d.nome, cor: d.cor || '', isNew: false })))
  const [selectedIds, setSelectedIds] = useState(() => new Set((course?.disciplinas || []).map(d => d.id)))
  const [rhythm, setRhythm] = useState(initial.rhythm)
  const [days, setDays] = useState(initial.days)
  const [grid, setGrid] = useState(initial.grid)
  const [newSubject, setNewSubject] = useState('')
  const [bulk, setBulk] = useState(() => Array.from({ length: initial.rhythm.count }, () => ''))
  const [copyFrom, setCopyFrom] = useState(null)
  const [copyTargets, setCopyTargets] = useState(() => new Set())
  const [saveAsTemplate, setSaveAsTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')

  const slots = useMemo(() => computeSlots(rhythm), [rhythm])
  const activeDays = useMemo(() => WD.filter(d => days[d.key]), [days])
  const options = useMemo(() => subjects.filter(s => selectedIds.has(s.id)), [subjects, selectedIds])
  const subjectById = (id) => subjects.find(s => s.id === id)

  // Turmas do mesmo curso, já com grade, disponíveis para copiar (exclui a atual).
  const sourceClasses = useMemo(() => (allClasses || []).filter(c =>
    c.courseId === course?.id && c.name !== turma?.name &&
    c.attendanceConfig && c.attendanceConfig.grade && Object.keys(c.attendanceConfig.grade).length
  ), [allClasses, course?.id, turma?.name])

  const templates = useMemo(() => course?.gradeTemplates || [], [course?.gradeTemplates])

  // Aplica uma configuração pronta (de outra turma ou de um modelo) ao estado do assistente.
  const applyConfig = (attendanceConfig) => {
    const initial = deriveInitial(attendanceConfig)
    setRhythm(initial.rhythm)
    setDays(initial.days)
    setGrid(initial.grid)
    setBulk(Array.from({ length: initial.rhythm.count }, () => ''))
    // Garante que as disciplinas usadas fiquem selecionadas.
    const usados = new Set()
    Object.values(attendanceConfig?.grade || {}).forEach(aulas => (aulas || []).forEach(a => a.disciplinaId && usados.add(String(a.disciplinaId).toUpperCase())))
    setSelectedIds(prev => { const n = new Set(prev); usados.forEach(id => n.add(id)); return n })
  }

  const applyTemplate = (tpl) => {
    if (!tpl) return
    setRhythm({ ...tpl.rhythm, gaps: [...(tpl.rhythm.gaps || [])] })
    setDays({ ...tpl.days })
    setGrid(Object.fromEntries(WD_KEYS.map(k => [k, [...(tpl.grid?.[k] || [])]])))
    setBulk(Array.from({ length: tpl.rhythm.count }, () => ''))
    if (Array.isArray(tpl.subjectIds)) setSelectedIds(prev => { const n = new Set(prev); tpl.subjectIds.forEach(id => n.add(id)); return n })
  }

  const patchRhythm = (patch) => setRhythm(prev => {
    const next = { ...prev, ...patch }
    const { rhythm: r } = reshape(next, grid)
    if ('count' in patch) {
      setGrid(g => reshape(next, g).grid)
      setBulk(b => { const nb = b.slice(0, r.count); while (nb.length < r.count) nb.push(''); return nb })
    }
    return r
  })

  const toggleSubject = (id) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const addSubject = () => {
    const nome = newSubject.trim()
    if (!nome) return
    let id = subjectSlug(nome)
    if (subjects.some(s => s.id === id)) id = `${id}${subjects.length + 1}`.slice(0, 16)
    const cor = NEW_SUBJECT_COLORS[subjects.filter(s => s.isNew).length % NEW_SUBJECT_COLORS.length]
    setSubjects(prev => [...prev, { id, nome, cor, isNew: true }])
    setSelectedIds(prev => new Set(prev).add(id))
    setNewSubject('')
  }

  const toggleDay = (key) => setDays(prev => ({ ...prev, [key]: !prev[key] }))
  const setCell = (dayKey, idx, value) => setGrid(prev => ({ ...prev, [dayKey]: prev[dayKey].map((v, i) => (i === idx ? value : v)) }))
  const setDefaultToAll = () => setRhythm(prev => ({ ...prev, gaps: prev.gaps.map(() => prev.defaultGap) }))
  const setGap = (i, value) => setRhythm(prev => ({ ...prev, gaps: prev.gaps.map((g, idx) => (idx === i ? Math.max(0, parseInt(value || '0', 10)) : g)) }))

  const applyBulk = () => setGrid(prev => {
    const next = { ...prev }
    activeDays.forEach(d => { next[d.key] = next[d.key].map((v, i) => (bulk[i] ? bulk[i] : v)) })
    return next
  })
  const applyCopy = () => {
    if (!copyFrom) return
    setGrid(prev => {
      const src = prev[copyFrom]
      const next = { ...prev }
      copyTargets.forEach(t => { next[t] = [...src] })
      return next
    })
    setCopyFrom(null)
  }
  const openCopy = (dayKey) => { setCopyFrom(dayKey); setCopyTargets(new Set()) }

  const buildConfig = () => {
    const base = turma?.attendanceConfig || {}
    const grade = {}
    activeDays.forEach(d => {
      grade[d.key] = slots.map((s, i) => ({ ordem: i + 1, inicio: minToHm(s.start), disciplinaId: grid[d.key][i] || '' }))
    })
    return {
      toleranciaMin: Number.isFinite(Number(base.toleranciaMin)) ? Number(base.toleranciaMin) : 10,
      limiarRiscoPct: Number.isFinite(Number(base.limiarRiscoPct)) ? Number(base.limiarRiscoPct) : 75,
      grade,
    }
  }

  const handleSave = async () => {
    const config = buildConfig()
    const existingIds = new Set((course?.disciplinas || []).map(d => d.id))
    const newDisciplinas = subjects
      .filter(s => s.isNew && selectedIds.has(s.id) && !existingIds.has(s.id))
      .map(s => ({ id: s.id, nome: s.nome, cor: s.cor || '' }))
    const template = saveAsTemplate && templateName.trim()
      ? { id: subjectSlug(templateName), nome: templateName.trim(), rhythm, days, grid, subjectIds: [...selectedIds] }
      : null
    await onSave({ attendanceConfig: config, newDisciplinas, template })
  }

  const exportPdf = () => {
    const ok = printGrade({ courseName: course?.name, turmaName: turma?.name, attendanceConfig: buildConfig(), disciplinas: subjects })
    if (!ok && typeof window !== 'undefined') window.alert('Não foi possível abrir a janela de impressão. Verifique se o bloqueador de pop-ups está desativado.')
  }

  const totalIntervalo = rhythm.gaps.reduce((a, b) => a + b, 0)
  const totalAula = rhythm.count * rhythm.duration
  const last = slots[slots.length - 1]
  const totalAulasSemana = activeDays.length * rhythm.count

  // Conflitos: professores desta turma com aula em outra turma no mesmo dia/horário.
  const clashes = useMemo(() => {
    if (step !== 4 || !turma?.name) return []
    return detectTeacherClashes({ courseId: course?.id, className: turma.name, grade: buildConfig().grade, allClasses, professors })
  }, [step, activeDays, grid, rhythm, allClasses, professors, course?.id, turma?.name]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card>
      <CardBody className="pt-5">
        <p className="text-xs font-medium text-subtle">Passo {step} de 4</p>
        <Stepper step={step} />
        <div className="mt-5">
        {step === 1 && (
          <div>
            {(sourceClasses.length > 0 || templates.length > 0) && (
              <div className="mb-4 grid gap-2.5 rounded-lg border border-border bg-surface-2 p-3 sm:grid-cols-2">
                {sourceClasses.length > 0 && (
                  <label className="text-xs">
                    <span className="mb-1 block font-medium text-subtle">Copiar de outra turma</span>
                    <select defaultValue="" onChange={e => { const src = sourceClasses.find(c => c.name === e.target.value); if (src) applyConfig(src.attendanceConfig); e.target.value = '' }}
                      className="h-[38px] w-full rounded-md border border-border bg-surface px-2 text-sm text-text" aria-label="Copiar grade de outra turma">
                      <option value="">Selecione uma turma…</option>
                      {sourceClasses.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  </label>
                )}
                {templates.length > 0 && (
                  <label className="text-xs">
                    <span className="mb-1 block font-medium text-subtle">Aplicar modelo salvo</span>
                    <select defaultValue="" onChange={e => { applyTemplate(templates.find(t => t.id === e.target.value)); e.target.value = '' }}
                      className="h-[38px] w-full rounded-md border border-border bg-surface px-2 text-sm text-text" aria-label="Aplicar modelo salvo">
                      <option value="">Selecione um modelo…</option>
                      {templates.map(t => <option key={t.id} value={t.id}>{t.nome}</option>)}
                    </select>
                  </label>
                )}
              </div>
            )}
            <h3 className="text-base font-semibold text-text">Quais matérias essa turma vai ter?</h3>
            <p className="mb-4 mt-0.5 text-sm text-muted">Selecione as matérias já cadastradas no curso. Se faltar alguma, adicione aqui mesmo — ela será criada no curso ao salvar.</p>
            <div className="flex flex-wrap gap-2">
              {subjects.map(s => {
                const on = selectedIds.has(s.id)
                return (
                  <button key={s.id} type="button" onClick={() => toggleSubject(s.id)}
                    className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition ${on ? 'border-primary bg-primary/10 text-text' : 'border-border bg-surface-2 text-muted hover:border-[var(--border-strong)]'}`}>
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.cor || 'var(--text-subtle)' }} />
                    {s.nome}
                    {s.isNew && <Badge tone="info" className="px-1.5 py-0">nova</Badge>}
                  </button>
                )
              })}
              {subjects.length === 0 && <p className="text-sm text-muted">Nenhuma disciplina no curso ainda — adicione abaixo.</p>}
            </div>
            <div className="mt-4 flex gap-2">
              <input value={newSubject} onChange={e => setNewSubject(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSubject() } }}
                placeholder="Nova matéria (ex.: Educação Física)"
                className="h-[38px] flex-1 rounded-md border border-border bg-surface px-3 text-sm text-text" aria-label="Nova matéria" />
              <Button variant="secondary" icon={Plus} onClick={addSubject}>Adicionar</Button>
            </div>
            <p className="mt-3 text-xs text-subtle">{selectedIds.size} de {subjects.length} matérias selecionadas.</p>
          </div>
        )}

        {step === 2 && (
          <div>
            <h3 className="text-base font-semibold text-text">Qual o ritmo do dia letivo?</h3>
            <p className="mb-4 mt-0.5 text-sm text-muted">Defina o básico e ajuste cada intervalo separadamente — dá pra ter, por exemplo, 20 min entre a 2ª e a 3ª aula e 10 min nos demais.</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Input label="Início das aulas" type="time" value={rhythm.start} onChange={e => patchRhythm({ start: e.target.value })} />
              <Input label="Duração da aula (min)" type="number" min="10" step="5" value={rhythm.duration} onChange={e => patchRhythm({ duration: Math.max(10, parseInt(e.target.value || '10', 10)) })} />
              <Input label="Aulas por dia" type="number" min="1" max="12" value={rhythm.count} onChange={e => patchRhythm({ count: Math.min(12, Math.max(1, parseInt(e.target.value || '1', 10))) })} />
              <Input label="Intervalo padrão (min)" type="number" min="0" step="5" value={rhythm.defaultGap} onChange={e => patchRhythm({ defaultGap: Math.max(0, parseInt(e.target.value || '0', 10)) })} />
            </div>

            {rhythm.count > 1 && (
              <div className="mt-5">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-xs font-bold uppercase tracking-wide text-subtle">Intervalo entre cada aula</h4>
                  <Button size="sm" variant="ghost" onClick={setDefaultToAll}>Igualar todos a {rhythm.defaultGap} min</Button>
                </div>
                <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  {slots.slice(0, -1).map((s, i) => {
                    const big = rhythm.gaps[i] > rhythm.defaultGap
                    return (
                      <div key={i} className={`rounded-lg border p-2.5 ${big ? 'border-warning/50 bg-warning-soft' : 'border-border bg-surface-2'}`}>
                        <label className={`mb-1.5 block text-[11px] font-medium ${big ? 'text-warning' : 'text-subtle'}`}>Entre {i + 1}ª e {i + 2}ª · {minToHm(s.end)}</label>
                        <div className="flex items-center gap-2">
                          <input type="number" min="0" step="5" value={rhythm.gaps[i]} onChange={e => setGap(i, e.target.value)}
                            className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm text-text" aria-label={`Intervalo entre a ${i + 1}ª e a ${i + 2}ª aula`} />
                          <span className="text-xs text-subtle">min</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="mt-5 rounded-lg border border-border bg-surface-2 p-4">
              <div className="flex items-stretch gap-1 overflow-x-auto">
                {slots.map((s, i) => (
                  <div key={i} className="flex items-stretch gap-1">
                    <div className="grid min-w-[40px] place-items-center rounded-md border border-primary/40 bg-primary/10 px-1 text-[11px] font-bold text-primary" title={`${minToHm(s.start)}–${minToHm(s.end)}`}>{i + 1}ª</div>
                    {i < slots.length - 1 && (
                      s.gapAfter > rhythm.defaultGap
                        ? <div className="grid min-w-[30px] place-items-center rounded bg-warning-soft text-[10px] font-bold text-warning" title={`${s.gapAfter} min`}>{s.gapAfter}'</div>
                        : <div className="min-w-[10px] rounded bg-border" title={`${s.gapAfter} min`} />
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-3 text-sm text-muted"><b className="text-text">{rhythm.count} aulas</b> · das <b className="text-text">{rhythm.start}</b> às <b className="text-text">{last ? minToHm(last.end) : '--:--'}</b> · <b className="text-text">{fmtDur(totalAula)}</b> de aula + <b className="text-text">{fmtDur(totalIntervalo)}</b> de intervalo</p>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h3 className="text-base font-semibold text-text">Monte a grade da semana</h3>
            <p className="mb-4 mt-0.5 text-sm text-muted">Marque os dias letivos, escolha a matéria de cada aula e use “copiar” para repetir um dia inteiro em outros.</p>

            <div className="mb-4 flex flex-wrap gap-1.5">
              {WD.map(d => (
                <button key={d.key} type="button" onClick={() => toggleDay(d.key)}
                  className={`rounded-md border px-3.5 py-1.5 text-xs font-bold transition ${days[d.key] ? 'border-primary bg-primary text-primary-fg' : 'border-border bg-surface-2 text-subtle hover:border-[var(--border-strong)]'}`}>{d.short}</button>
              ))}
            </div>

            {options.length === 0
              ? <p className="rounded-lg border border-dashed border-warning/50 bg-warning/10 p-3 text-xs text-warning">Selecione ou adicione ao menos uma matéria no passo 1 para montar a grade.</p>
              : (
                <>
                  <div className="mb-4 rounded-lg border border-border bg-surface-2 p-3">
                    <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-subtle">Preencher por posição (aplica no mesmo horário de todos os dias marcados)</p>
                      <Button size="sm" variant="secondary" onClick={applyBulk} disabled={activeDays.length === 0}>Aplicar aos dias marcados</Button>
                    </div>
                    <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
                      {slots.map((s, i) => (
                        <label key={i} className="min-w-0">
                          <span className="mb-1 block text-[11px] text-subtle">{i + 1}ª · {minToHm(s.start)}</span>
                          <select value={bulk[i] || ''} onChange={e => setBulk(b => b.map((v, idx) => (idx === i ? e.target.value : v)))}
                            className="h-9 w-full min-w-0 rounded-md border border-border bg-surface px-2 text-sm text-text" aria-label={`Matéria da ${i + 1}ª aula para todos os dias`}>
                            <option value="">—</option>
                            {options.map(o => <option key={o.id} value={o.id}>{o.nome}</option>)}
                          </select>
                        </label>
                      ))}
                    </div>
                  </div>

                  {activeDays.length === 0
                    ? <p className="text-sm text-muted">Nenhum dia letivo marcado ainda.</p>
                    : (
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {activeDays.map(d => {
                          const row = grid[d.key] || []
                          const filled = row.filter(Boolean).length
                          return (
                            <div key={d.key} className="min-w-0 rounded-lg border border-border bg-surface-2 p-3">
                              <div className="mb-2.5 flex items-center justify-between">
                                <h4 className="text-sm font-semibold text-text">{d.full}</h4>
                                <div className="flex items-center gap-1.5">
                                  <Badge tone={filled === slots.length ? 'success' : 'warning'}>{filled}/{slots.length}</Badge>
                                  <div className="relative">
                                    <button type="button" onClick={() => openCopy(d.key)} title="Copiar para outros dias" aria-label={`Copiar grade de ${d.full}`}
                                      className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted hover:text-text"><Copy size={14} /></button>
                                    {copyFrom === d.key && (
                                      <div className="absolute right-0 top-8 z-10 w-44 rounded-lg border border-[var(--border-strong)] bg-surface-raised p-2.5 shadow-lg">
                                        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-subtle">Copiar {d.full} para:</p>
                                        {activeDays.filter(x => x.key !== d.key).length === 0
                                          ? <p className="text-[11px] text-subtle">Nenhum outro dia marcado.</p>
                                          : (
                                            <>
                                              {activeDays.filter(x => x.key !== d.key).map(x => (
                                                <label key={x.key} className="flex cursor-pointer items-center gap-2 py-0.5 text-[13px] text-text">
                                                  <input type="checkbox" checked={copyTargets.has(x.key)}
                                                    onChange={e => setCopyTargets(prev => { const n = new Set(prev); e.target.checked ? n.add(x.key) : n.delete(x.key); return n })} />
                                                  {x.full}
                                                </label>
                                              ))}
                                              <Button size="sm" className="mt-2 w-full justify-center" disabled={copyTargets.size === 0} onClick={applyCopy}>Copiar</Button>
                                            </>
                                          )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                              <div className="space-y-1.5">
                                {slots.map((s, i) => (
                                  <div key={i} className="flex items-center gap-1.5">
                                    <span className="w-9 shrink-0 text-[11px] text-subtle">{minToHm(s.start)}</span>
                                    <select value={row[i] || ''} onChange={e => setCell(d.key, i, e.target.value)}
                                      className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-1.5 text-[13px] text-text" aria-label={`${i + 1}ª aula de ${d.full}`}>
                                      <option value="">—</option>
                                      {options.map(o => <option key={o.id} value={o.id}>{o.nome}</option>)}
                                    </select>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                </>
              )}
          </div>
        )}

        {step === 4 && (
          <div>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-text">Revisão da grade</h3>
                <p className="mt-0.5 text-sm text-muted">Confira antes de salvar. Você pode voltar para ajustar qualquer dia.</p>
              </div>
              <Button size="sm" variant="secondary" icon={Download} onClick={exportPdf} disabled={activeDays.length === 0}>Exportar PDF</Button>
            </div>

            {clashes.length > 0 && (
              <div className="mb-4 rounded-lg border border-warning/50 bg-warning/10 p-3">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-warning"><AlertTriangle size={15} /> Possível conflito de horário</p>
                <ul className="mt-1.5 space-y-1 text-xs text-warning">
                  {clashes.slice(0, 6).map((c, i) => (
                    <li key={i}><b>{c.professor}</b> já tem aula na turma <b>{c.otherClass}</b> em {c.weekdayLabel} às {c.inicio}.</li>
                  ))}
                  {clashes.length > 6 && <li>… e mais {clashes.length - 6} conflito(s).</li>}
                </ul>
                <p className="mt-1.5 text-[11px] text-warning/80">A grade pode ser salva mesmo assim — este é apenas um alerta.</p>
              </div>
            )}

            <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {[[activeDays.length, 'dias letivos'], [rhythm.count, 'aulas por dia'], [totalAulasSemana, 'aulas por semana'], [fmtDur(rhythm.count * rhythm.duration), 'de aula por dia']].map(([num, lbl]) => (
                <div key={lbl} className="rounded-lg border border-border bg-surface-2 p-3">
                  <div className="text-lg font-bold text-text">{num}</div>
                  <div className="text-[11px] text-subtle">{lbl}</div>
                </div>
              ))}
            </div>
            {activeDays.length === 0
              ? <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted">Nenhum dia letivo marcado — volte ao passo 3.</p>
              : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full min-w-[440px] text-[13px]">
                    <thead><tr className="bg-surface-2 text-[11px] uppercase tracking-wide text-subtle">
                      <th className="px-2.5 py-2 text-left font-bold">Horário</th>
                      {activeDays.map(d => <th key={d.key} className="px-2.5 py-2 text-left font-bold">{d.short}</th>)}
                    </tr></thead>
                    <tbody>
                      {slots.map((s, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="whitespace-nowrap px-2.5 py-2 text-[11px] text-subtle">{minToHm(s.start)}</td>
                          {activeDays.map(d => {
                            const subj = subjectById(grid[d.key][i])
                            return <td key={d.key} className="px-2.5 py-2">{subj
                              ? <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="h-2 w-2 rounded-full" style={{ background: subj.cor || 'var(--text-subtle)' }} />{subj.nome}</span>
                              : <span className="text-subtle">—</span>}</td>
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            <div className="mt-4 rounded-lg border border-border bg-surface-2 p-3">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" checked={saveAsTemplate} onChange={e => setSaveAsTemplate(e.target.checked)} className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium text-text">Salvar como modelo reutilizável</span>
                  <span className="mt-0.5 block text-xs text-subtle">Reaplique este ritmo e grade em outras turmas do curso a partir do passo 1.</span>
                </span>
              </label>
              {saveAsTemplate && (
                <input value={templateName} onChange={e => setTemplateName(e.target.value)}
                  placeholder="Nome do modelo (ex.: Manhã — 5 aulas)"
                  className="mt-2.5 h-[38px] w-full rounded-md border border-border bg-surface px-3 text-sm text-text" aria-label="Nome do modelo" />
              )}
            </div>
          </div>
        )}
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
          <Button variant="ghost" onClick={() => (step === 1 ? onCancel?.() : setStep(step - 1))}>{step === 1 ? 'Cancelar' : 'Voltar'}</Button>
          {step < 4
            ? <Button onClick={() => setStep(step + 1)}>Continuar</Button>
            : <Button loading={saving} icon={Check} onClick={handleSave}>Salvar grade horária</Button>}
        </div>
      </CardBody>
    </Card>
  )
}
