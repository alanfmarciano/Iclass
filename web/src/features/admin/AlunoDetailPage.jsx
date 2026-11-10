import { useMemo, useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Pencil, BookOpen, CheckCircle2, LogIn, FileText } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { PageState } from '../../components/ui/PageState'
import { Tabs } from '../../components/ui/Tabs'
import { ProgressRing } from '../../components/ui/ProgressRing'
import { MiniLineChart } from '../../components/ui/MiniLineChart'
import { MonthCalendar } from '../../components/ui/MonthCalendar'
import { Timeline } from '../../components/ui/Timeline'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { printBoletim } from './boletimPrint'
import { useAuth } from '../../context/AuthProvider'
import { StudentAuditPanel } from './StudentAuditPanel'
import { Modal } from '../../components/ui/Modal'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'
import { boletimChoiceOptions, boletimContext, fmtGrade, fmtGradeValue, gradeOf } from '../../lib/grades'

const STATUS_TONE = { Ativo: 'success', Inativo: 'neutral', Bloqueado: 'danger', 'Concluído': 'success', Transferido: 'warning', Evadido: 'warning' }
const dn = (s) => (s?.nomeSocial && s.nomeSocial.trim()) || s?.name || ''
const initials = (n) => (n || '?').split(' ').map((x) => x[0]).slice(0, 2).join('')
const moduleOf = (examKey) => String(examKey || '').split('_')[1] || '—'
const semesterOf = (t) => { const d = new Date(t || 0); return `${d.getFullYear()}.${d.getMonth() < 6 ? 1 : 2}` }
const fmtDate = (t) => t ? new Date(t).toLocaleDateString('pt-BR') : '—'
const fmtDateTime = (t) => t ? new Date(t).toLocaleString('pt-BR') : '—'

function Card({ title, action, children, className = '' }) {
  return (
    <div className={`bg-surface border border-border rounded-xl p-4 sm:p-5 ${className}`}>
      {title && <div className="flex items-center justify-between mb-3"><p className="text-sm font-medium text-text">{title}</p>{action}</div>}
      {children}
    </div>
  )
}

function Kpi({ label, value, sub, children }) {
  return (
    <div className="bg-surface-2 rounded-lg p-3.5">
      <p className="text-xs text-muted mb-1.5">{label}</p>
      {children || <p className="text-2xl font-semibold text-text">{value}</p>}
      {sub && <p className="text-xs text-muted mt-1.5">{sub}</p>}
    </div>
  )
}

function CompareBar({ label, me, them, max = 100, suffix = '', format = (value) => value }) {
  const pm = Math.min(100, (Number(me) / max) * 100)
  const pt = Math.min(100, (Number(them) / max) * 100)
  return (
    <div>
      <div className="flex justify-between text-xs mb-1"><span className="text-text">{label}</span><span className="text-muted">aluno {format(me)}{suffix} · turma {format(them)}{suffix}</span></div>
      <div className="space-y-1">
        <div className="h-2 rounded bg-surface-2 overflow-hidden"><div className="h-full bg-primary" style={{ width: pm + '%' }} /></div>
        <div className="h-2 rounded bg-surface-2 overflow-hidden"><div className="h-full" style={{ width: pt + '%', background: 'var(--text-muted)' }} /></div>
      </div>
    </div>
  )
}

export default function AlunoDetailPage() {
  const { id } = useParams()
  const email = decodeURIComponent(id || '')
  const nav = useNavigate()
  const toast = useToast()
  const { auth } = useAuth()
  const workspace = useAdminWorkspace()
  const [boletimChoices, setBoletimChoices] = useState(null)
  // Boletim do curso/turma ativos (UXI-X1, FUN-X1). Aluno em vários cursos e fora
  // do curso ativo: o professor escolhe a matrícula.
  async function openBoletim(context) {
    const ctx = context || boletimContext(student, { courseId: workspace.courseId, className: workspace.className })
    if (ctx.choose) {
      // Nome do curso no seletor (o id técnico não diz nada ao professor); matrícula
      // em curso fora do escopo do professor aparece desativada (o boletim dela daria 403).
      const summaries = await api.get('/api/admin/course-summaries').catch(() => [])
      const list = Array.isArray(summaries) ? summaries : summaries?.courses || []
      setBoletimChoices(boletimChoiceOptions(ctx.choose, list, { restricted: auth.accountRole === 'professor', workspace }))
      return
    }
    setBoletimChoices(null)
    try {
      const query = new URLSearchParams({ email, courseId: ctx.courseId || '', studentClass: ctx.studentClass || '' })
      const report = await api.get(`/api/admin/student/report?${query}`)
      if (!printBoletim(report)) toast.error('O navegador bloqueou a janela de impressão. Libere pop-ups para este site.')
    } catch (e) { toast.error(e.message) }
  }
  const isProfessor = auth.accountRole === 'professor'
  const { data: students, loading, error } = useApi('/api/admin/students')
  const [academic, setAcademic] = useState(null)
  const [dash, setDash] = useState(null)
  const [tab, setTab] = useState('geral')
  const [auditRows, setAuditRows] = useState([])
  const [filterModule, setFilterModule] = useState('all')
  const [filterSemester, setFilterSemester] = useState('all')

  const student = useMemo(() => (students || []).find((s) => s.email && s.email.toLowerCase() === email.toLowerCase()), [students, email])

  useEffect(() => {
    if (!email) return
    api.get(`/api/admin/student/academic?email=${encodeURIComponent(email)}`).then(setAcademic).catch(() => setAcademic({ submissions: [], progress: { completedCount: 0 }, moduleAccess: [], attendance: { count: 0, recent: [] }, certificates: [] }))
    // Média da matrícula no curso/turma ativos, consolidada como em Resultados.
    const dashQuery = new URLSearchParams({ email, courseId: workspace.courseId || '', studentClass: workspace.className || '' })
    api.get(`/api/admin/student/dashboard?${dashQuery}`).then(setDash).catch(() => setDash(null))
    api.get(`/api/admin/student/audit?email=${encodeURIComponent(email)}`).then((r) => setAuditRows(Array.isArray(r) ? r : [])).catch(() => setAuditRows([]))
  }, [email, workspace.courseId, workspace.className])

  const subs = academic?.submissions || []
  // Nota inválida de registro antigo (vazia ou fora de 0 a 10) não entra em média nem gráfico.
  const validSubs = useMemo(() => subs.filter((s) => gradeOf(s.score) !== null), [subs])
  const modules = useMemo(() => [...new Set(subs.map((s) => moduleOf(s.examKey)))].filter((m) => m !== '—'), [subs])
  const semesters = useMemo(() => [...new Set(subs.map((s) => semesterOf(s.timestamp)))].sort(), [subs])
  const filteredSubs = useMemo(() => validSubs.filter((s) => (filterModule === 'all' || moduleOf(s.examKey) === filterModule) && (filterSemester === 'all' || semesterOf(s.timestamp) === filterSemester)), [validSubs, filterModule, filterSemester])
  const notas = useMemo(() => [...filteredSubs].sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0)).map((s) => ({ label: moduleOf(s.examKey) + (s.examKey?.split('_')[2] ? ' ' + s.examKey.split('_')[2] : ''), value: gradeOf(s.score) })), [filteredSubs])
  // Média por módulo do servidor: mesma consolidação e mesmo curso/turma da "Média geral"
  // (antes era a média simples de todas as tentativas, feita aqui no navegador).
  const modulos = Array.isArray(dash?.modulos) ? dash.modulos : []
  const timeline = useMemo(() => {
    const ev = []
    subs.forEach((s) => ev.push({ id: 'g' + s.id, t: new Date(s.timestamp || 0).getTime(), tone: 'bg-success', title: `Prova ${s.examKey} · nota ${fmtGrade(s.score)}`, time: fmtDate(s.timestamp) }))
    ;(academic?.moduleAccess || []).forEach((m) => ev.push({ id: 'a' + m.id, t: m.timestamp, tone: 'bg-primary', title: `Abriu ${String(m.key).replace(/_/g, ' ')}`, time: fmtDateTime(m.timestamp) }))
    ;(academic?.attendance?.recent || []).forEach((a) => ev.push({ id: 'p' + a.id, t: a.timestamp, tone: 'bg-surface-2', title: `Presença (${a.origin === 'login' ? 'automática' : a.origin === 'chamada' ? 'chamada' : 'manual'})`, time: a.date }))
    return ev.sort((x, y) => y.t - x.t).slice(0, 8)
  }, [subs, academic])

  const cls = (student?.classes || []).map((c) => typeof c === 'string' ? c : c.name).filter(Boolean).join(', ')

  const tabs = [
    { id: 'geral', label: 'Visão geral' },
    { id: 'academico', label: 'Acadêmico' },
    { id: 'frequencia', label: 'Frequência' },
    { id: 'auditoria', label: 'Auditoria' },
    ...(!isProfessor ? [{ id: 'seguranca', label: 'Segurança' }] : []),
  ]

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <button onClick={() => nav('/alunos')} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-text"><ArrowLeft size={15} /> Alunos</button>

      <PageState loading={loading} error={error}>
        {!student ? <p className="text-sm text-muted">Aluno não encontrado.</p> : (
          <div className="space-y-4">
            <div className="bg-surface border border-border rounded-2xl p-4 sm:p-5 flex items-center gap-4 flex-wrap">
              <span className="w-13 h-13 min-w-[52px] rounded-full bg-primary-soft text-primary grid place-items-center text-lg font-semibold" style={{ width: 52, height: 52 }}>{initials(dn(student))}</span>
              <div className="flex-1 min-w-[180px]">
                <div className="flex items-center gap-2">
                  <span className="text-lg font-semibold text-text">{dn(student)}</span>
                  <Badge tone={STATUS_TONE[student.status] || 'neutral'}>{student.status || 'Ativo'}</Badge>
                  {student.isOnline && <Badge tone="success" dot>online</Badge>}
                </div>
                <p className="text-xs text-muted mt-1">{student.matricula || 's/ matrícula'} · {cls || 's/ turma'} · {student.email}</p>
              </div>
              <Button variant="secondary" icon={FileText} onClick={() => openBoletim()}>Boletim (PDF)</Button>
              <Button variant="secondary" icon={Pencil} onClick={() => nav('/diretorio/' + encodeURIComponent(student.email))}>Editar</Button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Kpi label="Frequência">
                {/* null = turma sem chamada lançada. "0%" acusaria o aluno de faltar a tudo. */}
                <p className="text-2xl font-semibold text-text">{dash?.kpis?.frequencia == null ? <span className="text-base text-muted">sem aulas</span> : `${dash.kpis.frequencia}%`}</p>
                <div className="h-1.5 rounded bg-surface overflow-hidden mt-1.5"><div className="h-full bg-primary" style={{ width: (dash?.kpis?.frequencia ?? 0) + '%' }} /></div>
              </Kpi>
              {/* Média do servidor: consolidada como em Resultados (sem nota no curso ativo, "—"). */}
              <Kpi label="Média geral" value={fmtGradeValue(dash?.kpis?.media)} sub={`${dash?.kpis?.provasFeitas ?? subs.length} prova(s)`} />
              <Kpi label="Progresso"><div className="flex items-center gap-2.5"><ProgressRing value={dash?.kpis?.progresso ?? 0}>{(dash?.kpis?.progresso ?? 0)}%</ProgressRing></div></Kpi>
              <Kpi label="Provas" value={`${dash?.kpis?.provasFeitas ?? subs.length}/${dash?.kpis?.provasTotais ?? 0}`} sub={`${Math.max(0, (dash?.kpis?.provasTotais ?? 0) - (dash?.kpis?.provasFeitas ?? subs.length))} pendentes`} />
            </div>

            <Tabs tabs={tabs} active={tab} onChange={setTab} />

            {tab === 'geral' && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <Card title="Evolução das notas" className="lg:col-span-2" action={
                    <div className="flex gap-2">
                      <select value={filterSemester} onChange={(e) => setFilterSemester(e.target.value)} className="text-xs bg-surface border border-border rounded-md px-2 py-1 text-text">
                        <option value="all">Todos os semestres</option>
                        {semesters.map((sem) => <option key={sem} value={sem}>{sem}</option>)}
                      </select>
                      <select value={filterModule} onChange={(e) => setFilterModule(e.target.value)} className="text-xs bg-surface border border-border rounded-md px-2 py-1 text-text">
                        <option value="all">Todas as matérias</option>
                        {modules.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                  }><MiniLineChart points={notas} /></Card>
                  <Card title="Desempenho por módulo">
                    {modulos.length ? <div className="space-y-3">{modulos.map((m) => (
                      <div key={m.id || m.modulo}><div className="flex justify-between text-xs mb-1"><span className="text-text">{m.modulo}</span><span className="text-muted">{fmtGradeValue(m.media)}</span></div><div className="h-1.5 rounded bg-surface-2 overflow-hidden"><div className="h-full bg-primary" style={{ width: `${Math.min(100, Number(m.media) * 10)}%` }} /></div></div>
                    ))}</div> : <p className="text-sm text-muted">Sem notas ainda.</p>}
                  </Card>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Card title="Comparativo com a turma">
                    <div className="space-y-4">
                      <CompareBar label="Média" me={dash?.comparativo?.studentMedia ?? 0} them={dash?.comparativo?.turmaMedia ?? 0} max={10} format={(value) => fmtGradeValue(value, '0,0')} />
                      <CompareBar label="Frequência" me={dash?.comparativo?.studentFreq ?? 0} them={dash?.comparativo?.turmaFreq ?? 0} max={100} suffix="%" />
                      <p className="text-xs text-subtle">Comparado com {dash?.comparativo?.turmaSize ?? 0} aluno(s) da turma.</p>
                    </div>
                  </Card>
                  <Card title="Risco de evasão">
                    {dash ? (
                      <div className="space-y-2">
                        <Badge tone={dash.risco.level === 'alto' ? 'danger' : dash.risco.level === 'medio' ? 'warning' : 'success'}>Risco {dash.risco.level}</Badge>
                        {dash.risco.reasons.length ? (
                          <ul className="mt-1 space-y-1">{dash.risco.reasons.map((r, i) => <li key={i} className="text-sm text-muted flex gap-2"><span className="text-danger">•</span>{r}</li>)}</ul>
                        ) : <p className="text-sm text-muted">Nenhum sinal de alerta.</p>}
                      </div>
                    ) : <p className="text-sm text-muted">Carregando…</p>}
                  </Card>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Card title="Engajamento">
                    <div className="flex items-stretch gap-2 h-24 mb-2">
                      {(dash?.engajamento?.weeks || []).map((w) => {
                        const max = Math.max(1, ...(dash?.engajamento?.weeks || []).map((x) => x.count))
                        return (
                          <div key={w.label} className="flex-1 flex flex-col items-center gap-1">
                            <div className="w-full flex-1 flex items-end bg-surface-2 rounded overflow-hidden"><div className="w-full bg-primary rounded" style={{ height: ((w.count / max) * 100) + '%' }} /></div>
                            <span className="text-[10px] text-subtle">{w.label}</span>
                          </div>
                        )
                      })}
                    </div>
                    <p className="text-xs text-muted">{dash?.engajamento?.diasAtivos ?? 0} dias ativos nos últimos 30.</p>
                  </Card>
                  <Card title="Assiduidade e evolução">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-surface-2 rounded-lg p-3"><p className="text-xs text-muted mb-1">Sequência atual</p><p className="text-xl font-semibold text-text">{dash?.streak?.atual ?? 0} <span className="text-xs text-muted font-normal">dias</span></p></div>
                      <div className="bg-surface-2 rounded-lg p-3"><p className="text-xs text-muted mb-1">Recorde</p><p className="text-xl font-semibold text-text">{dash?.streak?.recorde ?? 0} <span className="text-xs text-muted font-normal">dias</span></p></div>
                    </div>
                    <div className="mt-3 space-y-1.5 text-sm">
                      <div className="flex justify-between"><span className="text-muted">Média (mês atual vs anterior)</span><span className="text-text">{fmtGradeValue(dash?.temporal?.mediaAtual ?? 0)} vs {fmtGradeValue(dash?.temporal?.mediaAnterior ?? 0)}</span></div>
                      <div className="flex justify-between"><span className="text-muted">Presenças (mês)</span><span className="text-text">{dash?.temporal?.presencaAtual ?? 0} vs {dash?.temporal?.presencaAnterior ?? 0}</span></div>
                    </div>
                  </Card>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Card title="Atividade recente"><Timeline items={timeline} /></Card>
                  <Card title="Responsável e contato">
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between border-b border-border/50 pb-2"><span className="text-muted">Telefone</span><span className="text-text">{student.phone || '—'}</span></div>
                      <div className="flex justify-between border-b border-border/50 pb-2"><span className="text-muted">Unidade</span><span className="text-text">{student.unidade || '—'}</span></div>
                      <div className="flex justify-between"><span className="text-muted">Responsável</span><span className="text-text">{student.guardian?.name ? `${student.guardian.name}${student.guardian.parentesco ? ' (' + student.guardian.parentesco + ')' : ''}` : '—'}</span></div>
                    </div>
                  </Card>
                </div>
              </div>
            )}

            {tab === 'academico' && (
              <Card title="Boletim">
                {subs.length ? (
                  <div className="divide-y divide-border">
                    {[...subs].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)).map((s) => (
                      <div key={s.id} className="flex items-center justify-between py-2.5 text-sm">
                        <div><p className="text-text">{s.examKey}</p><p className="text-xs text-subtle">{Number.isInteger(s.correctCount) && Number.isInteger(s.totalCount) ? `${s.correctCount}/${s.totalCount} acertos · ` : ''}{fmtDate(s.timestamp)}</p></div>
                        {gradeOf(s.score) === null
                          ? <Badge tone="neutral" title="Registro antigo com nota vazia ou fora de 0 a 10">nota inválida</Badge>
                          : <Badge tone={gradeOf(s.score) >= 6 ? 'success' : 'warning'}>{fmtGrade(s.score)}</Badge>}
                      </div>
                    ))}
                  </div>
                ) : <p className="text-sm text-muted">Nenhuma prova realizada.</p>}
              </Card>
            )}

            {tab === 'frequencia' && (
              <div className="space-y-4">
                <Card title="Frequência por disciplina">
                  {dash?.frequenciaDisciplinas?.length ? (
                    <div className="space-y-3">
                      {dash.frequenciaDisciplinas.map((d) => (
                        <div key={d.disciplinaId}>
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-text flex items-center gap-2">{d.nome}{d.emRisco && <Badge tone="danger">em risco</Badge>}</span>
                            <span className="text-muted">{d.frequencia == null ? '—' : `${d.frequencia}%`} · {d.presentes}/{d.total} aulas</span>
                          </div>
                          <div className="h-1.5 rounded bg-surface-2 overflow-hidden">
                            <div className={`h-full ${d.emRisco ? 'bg-danger' : 'bg-primary'}`} style={{ width: `${d.frequencia ?? 0}%` }} />
                          </div>
                        </div>
                      ))}
                      <p className="text-xs text-subtle">Limiar de risco desta turma: {dash.limiarRisco ?? 75}%. Faltas abonadas não entram no cálculo.</p>
                    </div>
                  ) : <p className="text-sm text-muted">Sem aulas lançadas ainda.</p>}
                </Card>
                <Card title="Calendário de frequência"><MonthCalendar email={student.email} /></Card>
              </div>
            )}

            <Modal open={!!boletimChoices} onClose={() => setBoletimChoices(null)} title="Boletim de qual curso?" description="O aluno tem matrícula em mais de um curso. Escolha a turma do boletim.">
              <div className="grid gap-2">
                {(boletimChoices || []).map((m) => (
                  <Button key={`${m.courseId}:${m.name}`} variant="secondary" disabled={!m.allowed} onClick={() => openBoletim({ courseId: m.courseId, studentClass: m.name })}>
                    Turma {m.name}{m.allowed ? (m.courseName ? ` · ${m.courseName}` : '') : ' · curso fora do seu acesso'}
                  </Button>
                ))}
              </div>
            </Modal>

            {tab === 'auditoria' && (
              <Card title="Auditoria do cadastro">
                <StudentAuditPanel rows={auditRows} />
              </Card>
            )}

            {tab === 'seguranca' && !isProfessor && (
              <Card title="Segurança e privacidade">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between border-b border-border/50 pb-2"><span className="text-muted">Último login</span><span className="text-text">{fmtDateTime(student.lastLoginAt)}</span></div>
                  <div className="flex justify-between border-b border-border/50 pb-2"><span className="text-muted">Último acesso</span><span className="text-text">{fmtDateTime(student.lastSeenAt)}</span></div>
                  <div className="flex justify-between border-b border-border/50 pb-2"><span className="text-muted">Aceite dos Termos</span><span className="text-text">{student.termsAcceptance ? `v${student.termsAcceptance.version} · ${fmtDate(student.termsAcceptance.at)}` : 'pendente'}</span></div>
                  <div className="flex justify-between"><span className="text-muted">Política de Privacidade</span><span className="text-text">{student.privacyAcceptance ? `v${student.privacyAcceptance.version} · ${fmtDate(student.privacyAcceptance.at)}` : 'pendente'}</span></div>
                </div>
              </Card>
            )}
          </div>
        )}
      </PageState>
    </div>
  )
}
