import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { UserPlus, Download, X } from 'lucide-react'
import { DataTable } from '../../components/ui/Table'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Select } from '../../components/ui/Select'
import { Modal } from '../../components/ui/Modal'
import { PageState } from '../../components/ui/PageState'
import { PageHeader } from '../../components/ui/PageHeader'
import { StatCard } from '../../components/ui/StatCard'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { csvCell } from '../../lib/csv'

const STATUS_TONE = { Ativo: 'success', Inativo: 'neutral', Bloqueado: 'danger', 'Concluído': 'success', Transferido: 'warning', Evadido: 'warning' }
const STATUS_LIST = ['Ativo', 'Inativo', 'Bloqueado', 'Concluído', 'Transferido', 'Evadido']
const RISCO_TONE = { alto: 'danger', medio: 'warning', baixo: 'success' }
const RISCO_LABEL = { alto: 'Alto', medio: 'Médio', baixo: 'Baixo' }
// Mesmo limiar usado pelo backend para risco por inatividade (studentAnalytics.js).
const DIAS_SEM_ACESSO = 14

function scn(s) {
  const raw = s.classes && s.classes.length ? s.classes : (s.studentClass ? [s.studentClass] : [])
  return raw.map((c) => typeof c === 'string' ? c : c.name).filter(Boolean)
}
function displayName(s) { return (s.nomeSocial && s.nomeSocial.trim()) || s.name || '' }
// O aluno pode ter sessão ativa (lastSeenAt) e/ou login registrado (lastLoginAt).
function lastActivity(s) { return Math.max(Number(s.lastSeenAt) || 0, Number(s.lastLoginAt) || 0) || null }
function daysSince(ts) { return ts ? Math.floor((Date.now() - ts) / 86400000) : null }
// frequencia é null quando a turma não teve chamada lançada — exibir 0% acusaria
// o aluno de faltar a tudo. "Sem dado" e "zero" são coisas diferentes.
function temFrequencia(ov) { return !!ov && ov.frequencia != null }
function relativeDays(ts) {
  const d = daysSince(ts)
  if (d === null) return 'nunca acessou'
  if (d === 0) return 'hoje'
  if (d === 1) return 'ontem'
  return `há ${d} dias`
}

export default function AlunosGlobalPage() {
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  // O recorte vive na URL: o filtro fica compartilhável e o botão "voltar" funciona.
  const escola = params.get('escola') || ''
  const curso = params.get('curso') || ''
  const turma = params.get('turma') || ''
  const situacao = params.get('situacao') || ''
  const foco = params.get('foco') || ''

  const setParam = (key, value) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value); else next.delete(key)
    // Trocar de escola/curso invalida a turma escolhida.
    if (key === 'escola' || key === 'curso') next.delete('turma')
    setParams(next, { replace: true })
  }
  const toggleFoco = (value) => setParam('foco', foco === value ? '' : value)
  const clearAll = () => setParams(new URLSearchParams(), { replace: true })

  // curso/turma são filtrados no servidor; escola e situação, no cliente.
  const query = new URLSearchParams({ courseId: curso, studentClass: turma }).toString()
  const { data: students, loading, error, refetch } = useApi(`/api/admin/students?${query}`)
  const { data: overview } = useApi(`/api/admin/dashboard/students-overview?${query}`)
  const { data: classes } = useApi('/api/admin/classes')
  const { data: courses } = useApi('/api/courses')
  const { data: schools } = useApi('/api/admin/schools')

  const classByName = useMemo(() => { const m = new Map(); (classes || []).forEach((c) => { if (!m.has(c.name)) m.set(c.name, c) }); return m }, [classes])
  const courseById = useMemo(() => { const m = new Map(); (courses || []).forEach((c) => m.set(c.id, c)); return m }, [courses])
  const schoolById = useMemo(() => { const m = new Map(); (schools || []).forEach((s) => m.set(s.id, s)); return m }, [schools])
  const overviewByEmail = useMemo(() => {
    const m = new Map(); (overview || []).forEach((o) => m.set((o.email || '').toLowerCase(), o)); return m
  }, [overview])

  function enrollmentChips(s) {
    return scn(s).map((name) => {
      const cls = classByName.get(name)
      const course = cls && courseById.get(cls.courseId)
      const school = course && schoolById.get(course.schoolId || 'escola_default')
      return { name, course: course?.name, school: school?.name }
    })
  }
  function schoolIdsOf(s) {
    return scn(s).map((name) => {
      const cls = classByName.get(name)
      const course = cls && courseById.get(cls.courseId)
      return course && (course.schoolId || 'escola_default')
    }).filter(Boolean)
  }

  // Base já recortada pelo servidor (curso/turma); aqui aplicamos escola, situação e foco.
  const base = useMemo(() => (students || []).map((s) => ({
    ...s,
    id: s.email,
    ov: overviewByEmail.get((s.email || '').toLowerCase()) || null,
    atividade: lastActivity(s),
  })), [students, overviewByEmail])

  const rows = useMemo(() => base.filter((s) => {
    if (escola && !schoolIdsOf(s).includes(escola)) return false
    if (situacao && (s.status || 'Ativo') !== situacao) return false
    if (foco === 'sem-turma' && scn(s).length > 0) return false
    if (foco === 'ativos' && (s.status || 'Ativo') !== 'Ativo') return false
    if (foco === 'inativos') {
      const d = daysSince(s.atividade)
      if (d !== null && d < DIAS_SEM_ACESSO) return false
    }
    return true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [base, escola, situacao, foco, classByName, courseById])

  const stats = useMemo(() => ({
    total: base.length,
    ativos: base.filter((s) => (s.status || 'Ativo') === 'Ativo').length,
    semTurma: base.filter((s) => scn(s).length === 0).length,
    inativos: base.filter((s) => { const d = daysSince(s.atividade); return d === null || d >= DIAS_SEM_ACESSO }).length,
  }), [base])

  // Turmas disponíveis no seletor, respeitando escola/curso já escolhidos.
  const turmasDisponiveis = useMemo(() => (classes || []).filter((c) => {
    if (curso && c.courseId !== curso) return false
    if (escola) {
      const course = courseById.get(c.courseId)
      if (!course || (course.schoolId || 'escola_default') !== escola) return false
    }
    return true
  }), [classes, curso, escola, courseById])

  const cursosDisponiveis = useMemo(() => (courses || []).filter((c) => !escola || (c.schoolId || 'escola_default') === escola), [courses, escola])

  // ---- Seleção e ações em lote ----
  const [selectedIds, setSelectedIds] = useState([])
  const [bulkOpen, setBulkOpen] = useState(null) // 'turma' | 'situacao'
  const [bulkValue, setBulkValue] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMsg, setBulkMsg] = useState(null)

  const openBulk = (kind) => { setBulkOpen(kind); setBulkValue(''); setBulkMsg(null) }
  async function applyBulk() {
    if (!bulkValue) return
    setBulkBusy(true); setBulkMsg(null)
    try {
      const path = bulkOpen === 'turma' ? '/api/admin/student/bulk-enroll' : '/api/admin/student/bulk-status'
      // Turma vai com o curso: o mesmo nome de turma pode existir em mais de um curso.
      const sep = bulkValue.indexOf('::')
      const bulkCourseId = sep >= 0 ? bulkValue.slice(0, sep) : ''
      const bulkClassName = sep >= 0 ? bulkValue.slice(sep + 2) : bulkValue
      const body = bulkOpen === 'turma'
        ? { emails: selectedIds, className: bulkClassName, courseId: bulkCourseId }
        : { emails: selectedIds, status: bulkValue }
      const res = await api.post(path, body)
      setBulkMsg({ ok: true, text: `${res.updated} aluno(s) atualizado(s).`, skipped: res.skipped || [] })
      setSelectedIds([])
      setBulkOpen(null)
      refetch()
    } catch (e) {
      setBulkMsg({ ok: false, text: e.message })
    } finally {
      setBulkBusy(false)
    }
  }

  function exportCsv() {
    const head = ['Nome', 'E-mail', 'Matrícula', 'Turmas', 'Situação', 'Risco', 'Frequência', 'Último acesso']
    const body = rows.map((s) => [
      displayName(s), s.email, s.matricula || '', scn(s).join(' | '), s.status || 'Ativo',
      s.ov ? RISCO_LABEL[s.ov.riscoLevel] || '' : '',
      temFrequencia(s.ov) ? `${s.ov.frequencia}%` : '',
      relativeDays(s.atividade),
    ])
    const csv = [head, ...body]
      .map((line) => line.map(csvCell).join(';'))
      .join('\r\n')
    // BOM para o Excel reconhecer os acentos.
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }))
    const a = document.createElement('a')
    a.href = url; a.download = 'alunos.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const openStudent = (email) => nav('/diretorio/' + encodeURIComponent(email))

  const columns = [
    { key: 'name', label: 'Aluno', render: (r) => {
      const hasSocial = r.nomeSocial && r.nomeSocial.trim() && r.nomeSocial.trim() !== (r.name || '').trim()
      return (
        <div className="flex items-center gap-2">
          <span className="relative w-7 h-7 rounded-full bg-primary-soft text-primary grid place-items-center text-xs font-semibold shrink-0">
            {(displayName(r) || '?').split(' ').map((x) => x[0]).slice(0, 2).join('')}
            {r.isOnline && <span className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full bg-success border-2 border-surface" title="Online agora" />}
          </span>
          <div className="min-w-0">
            <span className="block truncate text-text">{displayName(r)}</span>
            <span className="block text-xs text-subtle truncate">{hasSocial ? r.name : r.email}</span>
          </div>
        </div>)
    } },
    { key: 'enroll', label: 'Matrículas', sortable: false, render: (r) => {
      const ch = enrollmentChips(r)
      return ch.length ? (
        <div className="flex flex-wrap gap-1">
          {ch.slice(0, 3).map((e, i) => <Badge key={i} tone="info">{e.course ? `${e.course} · ${e.name}` : e.name}</Badge>)}
          {ch.length > 3 && <Badge tone="neutral">+{ch.length - 3}</Badge>}
        </div>
      ) : <Badge tone="warning">sem matrícula</Badge>
    } },
    { key: 'risco', label: 'Risco', sortable: false, render: (r) => r.ov
      ? <Badge tone={RISCO_TONE[r.ov.riscoLevel] || 'neutral'} dot>{RISCO_LABEL[r.ov.riscoLevel] || '—'}</Badge>
      : <span className="text-subtle text-sm">—</span> },
    // "Sem dado" não é zero: exibir 0% numa turma sem chamada diria que o aluno faltou a tudo.
    // Aceita os dois contratos do backend — temFreq=false (atual) e frequencia=null (em migração).
    { key: 'freq', label: 'Frequência', sortable: false, render: (r) => temFrequencia(r.ov)
      ? <span className="tabular-nums text-text">{r.ov.frequencia}%</span>
      : <span className="text-subtle text-sm" title="Nenhuma aula lançada nesta turma">sem aulas</span> },
    { key: 'atividade', label: 'Último acesso', render: (r) => {
      const d = daysSince(r.atividade)
      const cold = d === null || d >= DIAS_SEM_ACESSO
      return <span className={cold ? 'text-warning text-sm' : 'text-muted text-sm'}>{relativeDays(r.atividade)}</span>
    } },
    { key: 'status', label: 'Situação', render: (r) => <Badge tone={STATUS_TONE[r.status || 'Ativo'] || 'neutral'}>{r.status || 'Ativo'}</Badge> },
  ]

  const activeChips = [
    escola && { key: 'escola', label: schoolById.get(escola)?.name || escola },
    curso && { key: 'curso', label: courseById.get(curso)?.name || curso },
    turma && { key: 'turma', label: `Turma ${turma}` },
    situacao && { key: 'situacao', label: situacao },
    foco && { key: 'foco', label: { 'sem-turma': 'Sem matrícula', ativos: 'Ativos', inativos: `Sem acesso há ${DIAS_SEM_ACESSO}d` }[foco] },
  ].filter(Boolean)

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader title="Alunos" subtitle="Todos os alunos da instituição — matricule em qualquer curso ou escola">
        <Button variant="secondary" icon={Download} onClick={exportCsv}>Exportar</Button>
        <Button icon={UserPlus} onClick={() => nav('/diretorio/novo')}>Novo aluno</Button>
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total de alunos" value={stats.total} icon="Users" onClick={clearAll} active={!activeChips.length} />
        <StatCard label="Ativos" value={stats.ativos} icon="UserCheck" onClick={() => toggleFoco('ativos')} active={foco === 'ativos'} />
        <StatCard label="Sem matrícula" value={stats.semTurma} icon="UserMinus" onClick={() => toggleFoco('sem-turma')} active={foco === 'sem-turma'} />
        <StatCard label={`Sem acesso há ${DIAS_SEM_ACESSO}d`} value={stats.inativos} icon="UserX" onClick={() => toggleFoco('inativos')} active={foco === 'inativos'} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Select label="Escola" value={escola} onChange={(e) => setParam('escola', e.target.value)}>
          <option value="">Todas</option>
          {(schools || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select label="Curso" value={curso} onChange={(e) => setParam('curso', e.target.value)}>
          <option value="">Todos</option>
          {cursosDisponiveis.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select label="Turma" value={turma} onChange={(e) => setParam('turma', e.target.value)}>
          <option value="">Todas</option>
          {turmasDisponiveis.map((c) => <option key={c.id || c.name} value={c.name}>{c.name}</option>)}
        </Select>
        <Select label="Situação" value={situacao} onChange={(e) => setParam('situacao', e.target.value)}>
          <option value="">Todas</option>
          {STATUS_LIST.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
      </div>

      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {activeChips.map((c) => (
            <button key={c.key} onClick={() => setParam(c.key, '')}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-info-soft text-info text-xs font-medium hover:brightness-110">
              {c.label}<X size={12} aria-hidden />
              <span className="sr-only">Remover filtro</span>
            </button>
          ))}
          <button onClick={clearAll} className="text-xs text-muted underline underline-offset-2 hover:text-text">limpar tudo</button>
          <span className="ml-auto text-xs text-subtle tabular-nums">{rows.length} de {stats.total} alunos</span>
        </div>
      )}

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 rounded-xl bg-primary-soft border border-primary">
          <span className="text-sm font-semibold text-text">{selectedIds.length} aluno(s) selecionado(s)</span>
          <Button size="sm" variant="secondary" onClick={() => openBulk('turma')}>Matricular em turma</Button>
          <Button size="sm" variant="secondary" onClick={() => openBulk('situacao')}>Alterar situação</Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelectedIds([])}>Limpar seleção</Button>
        </div>
      )}

      {bulkMsg && !bulkOpen && (
        <div className={`px-4 py-3 rounded-xl text-sm ${bulkMsg.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>
          {bulkMsg.text}
          {bulkMsg.skipped?.length > 0 && (
            <ul className="mt-1 text-xs opacity-90">
              {bulkMsg.skipped.map((s, i) => <li key={i}>{s.email}: {s.reason}</li>)}
            </ul>
          )}
        </div>
      )}

      <PageState loading={loading} error={error} onRetry={refetch}>
        <DataTable columns={columns} rows={rows}
          searchKeys={['name', 'nomeSocial', 'email', 'matricula']}
          selectable selectedIds={selectedIds} onSelectionChange={setSelectedIds}
          paginated pageSize={25}
          rowActions={(r) => openStudent(r.email)} onRowClick={(r) => openStudent(r.email)}
          emptyTitle="Nenhum aluno" emptyDesc="Nenhum aluno corresponde a este filtro." />
      </PageState>

      <Modal open={!!bulkOpen} onClose={() => setBulkOpen(null)}
        title={bulkOpen === 'turma' ? 'Matricular em turma' : 'Alterar situação'}
        description={`${selectedIds.length} aluno(s) selecionado(s).`}
        footer={<>
          <Button variant="ghost" onClick={() => setBulkOpen(null)}>Cancelar</Button>
          <Button onClick={applyBulk} loading={bulkBusy} disabled={!bulkValue}>Aplicar</Button>
        </>}>
        {bulkOpen === 'turma' ? (
          <Select label="Turma de destino" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}>
            <option value="">Selecione…</option>
            {(classes || []).map((c) => <option key={`${c.courseId}::${c.name}`} value={`${c.courseId}::${c.name}`}>{c.name}{courseById.get(c.courseId)?.name ? ` · ${courseById.get(c.courseId).name}` : ''}</option>)}
          </Select>
        ) : (
          <Select label="Nova situação" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}>
            <option value="">Selecione…</option>
            {STATUS_LIST.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        )}
        {bulkMsg && !bulkMsg.ok && <p className="mt-3 text-sm text-danger">{bulkMsg.text}</p>}
      </Modal>
    </div>
  )
}
