import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipboardList, Eye, History, KeyRound, MessageSquare, Pencil, ShieldAlert, ShieldCheck, Trash2, Unlock, UserPlus } from 'lucide-react'
import { DataTable } from '../../components/ui/Table'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Textarea } from '../../components/ui/Textarea'
import { Modal, ConfirmDialog } from '../../components/ui/Modal'
import { PageState } from '../../components/ui/PageState'
import { Switch } from '../../components/ui/Switch'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { fmtGrade, gradeOf } from '../../lib/grades'
import { useToast } from '../../context/ToastProvider'
import { useAuth } from '../../context/AuthProvider'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'

const STATUS_OPTIONS = ['Ativo', 'Inativo', 'Bloqueado', 'Concluído', 'Transferido', 'Evadido']
const STATUS_TONE = {
  Ativo: 'success', Inativo: 'neutral', Bloqueado: 'danger',
  'Concluído': 'success', Transferido: 'warning', Evadido: 'warning',
}

const OBS_CATEGORIES = ['Dificuldade de aprendizagem', 'Participação', 'Frequência', 'Entregas atrasadas', 'Acompanhamento pedagógico', 'Acessibilidade pedagógica', 'Comportamento acadêmico', 'Observação geral']
const OBS_VISIBILITY = ['Restrita (coordenação)', 'Equipe pedagógica', 'Compartilhada']
const OBS_RESTRICTED = 'Restrita (coordenação)'
// Dado de saúde: sempre restrito à coordenação (o servidor aplica a mesma regra).
const OBS_SENSITIVE = new Set(['Acessibilidade pedagógica'])

function studentClassNames(student) {
  const raw = student.classes && student.classes.length ? student.classes : (student.studentClass ? [student.studentClass] : [])
  return raw.map((c) => typeof c === 'string' ? c : c.name).filter(Boolean)
}

// Prioriza o nome social quando preenchido, sem perder o nome completo.
function displayName(s) {
  return (s.nomeSocial && s.nomeSocial.trim()) || s.name || ''
}

function emptyForm() {
  return {
    name: '', nomeSocial: '', email: '', matricula: '', phone: '', status: 'Ativo',
    studentPassword: '', unidade: '', courseId: '', classes: [],
    guardian: { name: '', phone: '', email: '', parentesco: '', observacao: '' },
    accessibility: { fonteAmpliada: false, altoContraste: false, reducaoAnimacoes: false, leitorTela: false, tempoAdicional: false, tempoAdicionalPercent: 0, observacao: '' },
  }
}

export default function AlunosPage() {
  const { auth } = useAuth()
  const { courseId: activeCourseId, courseName, className: activeClassName } = useAdminWorkspace()
  const nav = useNavigate()
  const isProfessor = auth.accountRole === 'professor'
  const contextQuery = new URLSearchParams({ courseId: activeCourseId, studentClass: activeClassName }).toString()
  const { data: students, loading, error, refetch } = useApi(`/api/admin/students?${contextQuery}`)
  const { data: classes } = useApi(`/api/admin/classes?${contextQuery}`)
  const { data: courses } = useApi('/api/courses')
  const submissions = useApi(`/api/admin/submissions?${contextQuery}`)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(emptyForm())
  const [menuRow, setMenuRow] = useState(null)
  const [profile, setProfile] = useState(null)
  const [academic, setAcademic] = useState(null)
  const [edit, setEdit] = useState(null)
  const [del, setDel] = useState(null)
  const [reset, setReset] = useState(null)
  const [history, setHistory] = useState(null)
  const [audit, setAudit] = useState(null)
  const [auditRows, setAuditRows] = useState([])
  const [security, setSecurity] = useState(null)
  const [secLogs, setSecLogs] = useState([])
  const [obs, setObs] = useState(null)
  const [obsRows, setObsRows] = useState([])
  const [obsForm, setObsForm] = useState({ category: 'Observação geral', visibility: 'Equipe pedagógica', text: '' })
  const [obsSaving, setObsSaving] = useState(false)
  const [release, setRelease] = useState(null)
  const [releaseItems, setReleaseItems] = useState([])
  const [released, setReleased] = useState({})
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  const courseClasses = useMemo(() => (classes || []).filter((c) => c.courseId === activeCourseId && c.name === activeClassName), [classes, activeCourseId, activeClassName])
  const courseClassNames = useMemo(() => new Set(courseClasses.map((c) => c.name)), [courseClasses])
  const filteredStudents = useMemo(() => (students || []).filter((student) => {
    if (!activeCourseId) return true
    return studentClassNames(student).some((name) => courseClassNames.has(name))
  }), [students, activeCourseId, courseClassNames])
  const filteredSubmissions = useMemo(() => (submissions.data || []).filter((submission) => {
    if (!activeCourseId) return true
    const cls = submission.studentClass || submission.student?.studentClass
    return submission.courseId === activeCourseId || courseClassNames.has(cls)
  }), [submissions.data, activeCourseId, courseClassNames])
  const profileCourseName = useMemo(() => {
    if (!profile) return ''
    const cls = (classes || []).find((c) => studentClassNames(profile).includes(c.name))
    const course = (courses || []).find((c) => c.id === cls?.courseId)
    return course?.name || ''
  }, [profile, classes, courses])

  function toggleClass(target, className) {
    const current = target === 'form' ? form.classes : edit.classes
    const next = current.includes(className) ? current.filter((x) => x !== className) : [...current, className]
    if (target === 'form') setForm({ ...form, classes: next })
    else setEdit({ ...edit, classes: next })
  }

  function payloadFrom(v, isEdit) {
    const base = {
      name: v.name, nomeSocial: v.nomeSocial, email: v.email, matricula: v.matricula,
      phone: v.phone, guardianPhone: v.guardian?.phone || '', status: v.status,
      unidade: v.unidade, classes: v.classes, studentClass: v.classes[0], guardian: v.guardian, accessibility: v.accessibility,
    }
    if (isEdit) { base.originalEmail = v.originalEmail; base.password = v.password; base.period = v.period }
    else { base.studentPassword = v.studentPassword }
    return base
  }

  async function create() {
    if (!form.name || !form.email || !form.studentPassword || form.classes.length === 0) return toast.error('Preencha nome, e-mail, senha e ao menos uma turma')
    setSaving(true)
    try {
      await api.post('/api/admin/student/create', payloadFrom(form, false))
      toast.success('Aluno cadastrado')
      setOpen(false)
      setForm(emptyForm())
      refetch()
    } catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }

  async function saveEdit() {
    if (!edit.name || !edit.email || edit.classes.length === 0) return toast.error('Informe nome, e-mail e turmas')
    setSaving(true)
    try {
      await api.post('/api/admin/student/update', payloadFrom(edit, true))
      toast.success('Aluno atualizado')
      setEdit(null)
      refetch()
    } catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }

  async function remove() {
    try { await api.post('/api/admin/delete-student', { email: del.email }); toast.success('Aluno removido'); setDel(null); refetch() }
    catch (e) { toast.error(e.message) }
  }

  async function doReset() {
    try { await api.post('/api/admin/reset-password', { email: reset.email, newPassword: reset.pw }); toast.success('Senha redefinida'); setReset(null); refetch() }
    catch (e) { toast.error(e.message) }
  }

  async function openAudit(row) {
    setAudit(row)
    setAuditRows([])
    try {
      const rows = await api.get(`/api/admin/student/audit?email=${encodeURIComponent(row.email)}`)
      setAuditRows(Array.isArray(rows) ? rows : [])
    } catch (e) { toast.error(e.message) }
  }

  async function openSecurity(row) {
    setSecurity(row)
    setSecLogs([])
    try {
      const rows = await api.get(`/api/admin/student/login-logs?email=${encodeURIComponent(row.email)}`)
      setSecLogs(Array.isArray(rows) ? rows : [])
    } catch (e) { toast.error(e.message) }
  }

  async function refreshAcademic(email) {
    try {
      const data = await api.get(`/api/admin/student/academic?email=${encodeURIComponent(email)}`)
      setAcademic(data && typeof data === 'object' ? data : { submissions: [], progress: { completedCount: 0 } })
    } catch (e) { setAcademic({ submissions: [], progress: { completedCount: 0 } }) }
  }

  async function openProfile(row) {
    setProfile(row)
    setAcademic(null)
    refreshAcademic(row.email)
  }

  async function markPresence() {
    try { await api.post('/api/admin/student/attendance/mark', { email: profile.email, studentClass: studentClassNames(profile)[0] || '' }); toast.success('Presença registrada'); refreshAcademic(profile.email) }
    catch (e) { toast.error(e.message) }
  }

  async function issueCert() {
    if (!profileCourseName) return toast.error('Aluno sem curso definido para o certificado')
    try { await api.post('/api/admin/student/certificates/issue', { email: profile.email, courseName: profileCourseName }); toast.success('Certificado emitido'); refreshAcademic(profile.email) }
    catch (e) { toast.error(e.message) }
  }

  async function revokeCert(id) {
    try { await api.post('/api/admin/student/certificates/revoke', { id }); toast.success('Certificado cancelado'); refreshAcademic(profile.email) }
    catch (e) { toast.error(e.message) }
  }

  async function openObs(row) {
    setObs(row)
    setObsRows([])
    setObsForm({ category: 'Observação geral', visibility: 'Equipe pedagógica', text: '' })
    try {
      const rows = await api.get(`/api/admin/student/observations?email=${encodeURIComponent(row.email)}`)
      setObsRows(Array.isArray(rows) ? rows : [])
    } catch (e) { toast.error(e.message) }
  }

  async function addObs() {
    if (!obsForm.text.trim()) return toast.error('Escreva a observação')
    setObsSaving(true)
    try {
      await api.post('/api/admin/student/observations/create', { email: obs.email, ...obsForm })
      const rows = await api.get(`/api/admin/student/observations?email=${encodeURIComponent(obs.email)}`)
      setObsRows(Array.isArray(rows) ? rows : [])
      setObsForm({ category: 'Observação geral', visibility: 'Equipe pedagógica', text: '' })
      toast.success('Observação registrada')
    } catch (e) { toast.error(e.message) } finally { setObsSaving(false) }
  }

  async function delObs(id) {
    try {
      await api.post('/api/admin/student/observations/delete', { id })
      setObsRows((rows) => rows.filter((o) => o.id !== id))
      toast.success('Observação excluída')
    } catch (e) { toast.error(e.message) }
  }

  async function openRelease(row) {
    const className = studentClassNames(row).find((name) => courseClassNames.has(name)) || studentClassNames(row)[0]
    const cls = courseClasses.find((c) => c.name === className) || {}
    setRelease({ ...row, className, courseId: cls.courseId })
    setReleaseItems([])
    setReleased({})
    try {
      const structure = await api.get(`/api/admin/courses/${encodeURIComponent(cls.courseId)}/structure`)
      const status = await api.get(`/api/status?studentClass=${encodeURIComponent(className)}&courseId=${encodeURIComponent(cls.courseId)}&email=${encodeURIComponent(row.email)}`)
      setReleased(status.releasedItems || {})
      setReleaseItems((structure.structure || []).flatMap((mod) => (mod.units || mod.items || []).flatMap((u) => [
        u.apostilaKey && { key: u.apostilaKey, label: `${mod.name || mod.title} - ${u.name || u.title || u.apostilaKey}`, type: 'Apostila' },
        u.avaliacaoKey && { key: u.avaliacaoKey, label: `${mod.name || mod.title} - ${u.name || u.title || u.avaliacaoKey}`, type: 'Prova' },
      ].filter(Boolean))))
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function toggleRelease(itemKey, value) {
    setReleased((r) => ({ ...r, [itemKey]: value }))
    try {
      await api.post('/api/admin/release-item', { studentClass: release.className, courseId: release.courseId, itemKey, released: value, studentEmail: release.email })
      toast.success(value ? 'Liberado para o aluno' : 'Bloqueado para o aluno')
    } catch (e) {
      toast.error(e.message)
      setReleased((r) => ({ ...r, [itemKey]: !value }))
    }
  }

  const columns = [
    { key: 'name', label: 'Nome', render: (r) => (
      <div className="flex items-center gap-2">
        <span className="w-7 h-7 rounded-full bg-primary-soft text-primary grid place-items-center text-xs font-semibold">{(displayName(r) || '?').split(' ').map((x) => x[0]).slice(0, 2).join('')}</span>
        <span>{displayName(r)}</span>
        {r.nomeSocial && r.nomeSocial.trim() && <span className="text-xs text-subtle">({r.name})</span>}
        {r.recoveryRequested && <Badge tone="warning">senha</Badge>}
      </div>) },
    { key: 'email', label: 'E-mail', render: (r) => <span className="text-muted">{r.email}</span> },
    { key: 'matricula', label: 'Matrícula', render: (r) => <span className="text-muted">{r.matricula || '-'}</span> },
    { key: 'studentClass', label: 'Turmas', render: (r) => studentClassNames(r).filter((name) => !activeCourseId || courseClassNames.has(name)).join(', ') || '-' },
    { key: 'status', label: 'Situação', render: (r) => <Badge tone={STATUS_TONE[r.status] || 'neutral'}>{r.status || 'Ativo'}</Badge> },
    { key: 'isOnline', label: 'Conexão', render: (r) => <Badge tone={r.isOnline ? 'success' : 'neutral'} dot>{r.isOnline ? 'online' : 'offline'}</Badge> },
  ]

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div><h1 className="text-2xl font-bold text-text">Alunos</h1><p className="text-sm text-muted">{filteredStudents.length} contas em {courseName || activeCourseId} · {activeClassName}</p></div>
        <Button icon={UserPlus} onClick={() => { setForm({ ...emptyForm(), courseId: activeCourseId, classes: [activeClassName] }); setOpen(true) }}>Novo aluno</Button>
      </div>
      <PageState loading={loading} error={error} onRetry={refetch}>
        <DataTable columns={columns} rows={filteredStudents.map((s, i) => ({ id: s.email || i, ...s }))}
          searchKeys={['name', 'nomeSocial', 'email', 'matricula', 'studentClass']} rowActions={(r) => setMenuRow(r)} onRowClick={(r) => nav('/alunos/' + encodeURIComponent(r.email))}
          emptyTitle="Nenhum aluno" emptyDesc="Cadastre o primeiro aluno." />
      </PageState>

      <Modal open={open} onClose={() => setOpen(false)} title="Novo aluno" description="Cadastre uma conta de aluno."
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button><Button loading={saving} onClick={create}>Salvar aluno</Button></>}>
        <StudentFormTabs value={form} onChange={setForm} classes={classes || []} courses={courses || []} onToggleClass={(name) => toggleClass('form', name)} passwordField="studentPassword" passwordLabel="Senha inicial" accessibilityReadOnly={isProfessor} />
      </Modal>

      <Modal open={!!edit} onClose={() => setEdit(null)} title="Editar aluno" description={edit?.originalEmail}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancelar</Button><Button loading={saving} onClick={saveEdit}>Salvar alterações</Button></>}>
        {edit && <StudentFormTabs value={edit} onChange={setEdit} classes={classes || []} courses={courses || []} onToggleClass={(name) => toggleClass('edit', name)} passwordField="password" passwordLabel="Senha/hash atual" passwordHelper="Mantenha como está para não trocar." accessibilityReadOnly={isProfessor} />}
      </Modal>

      <Modal open={!!menuRow} onClose={() => setMenuRow(null)} title={menuRow ? displayName(menuRow) : ''} description={menuRow?.email}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Button variant="secondary" icon={Pencil} onClick={() => { setEdit({ ...emptyForm(), ...menuRow, originalEmail: menuRow.email, classes: studentClassNames(menuRow), courseId: ((classes || []).find((c) => studentClassNames(menuRow).includes(c.name))?.courseId) || activeCourseId, guardian: menuRow.guardian || { name: '', phone: '', email: '', parentesco: '' } }); setMenuRow(null) }}>Editar</Button>
          <Button variant="secondary" icon={History} onClick={() => { setHistory(menuRow); setMenuRow(null) }}>Histórico</Button>
          {!isProfessor && <Button variant="secondary" icon={ShieldAlert} onClick={() => { openAudit(menuRow); setMenuRow(null) }}>Auditoria</Button>}
          {!isProfessor && <Button variant="secondary" icon={ShieldCheck} onClick={() => { openSecurity(menuRow); setMenuRow(null) }}>Segurança</Button>}
          <Button variant="secondary" icon={MessageSquare} onClick={() => { openObs(menuRow); setMenuRow(null) }}>Observações</Button>
          <Button variant="secondary" icon={Unlock} onClick={() => { openRelease(menuRow); setMenuRow(null) }}>Liberações</Button>
          <Button variant="secondary" icon={KeyRound} onClick={() => { setReset({ email: menuRow.email, pw: '' }); setMenuRow(null) }}>Resetar senha</Button>
          {!isProfessor && <Button variant="destructive" icon={Trash2} onClick={() => { setDel(menuRow); setMenuRow(null) }}>Excluir aluno</Button>}
        </div>
      </Modal>

      <Modal open={!!history} onClose={() => setHistory(null)} title="Histórico do aluno" description={history?.email}>
        <div className="space-y-2">
          {filteredSubmissions.filter((s) => (s.studentEmail || s.student?.email || s.email)?.toLowerCase() === history?.email?.toLowerCase()).map((s, i) => (
            <div key={s.id || i} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
              <span className="text-text">{s.examKey}</span>
              <Badge tone={gradeOf(s.score) >= 6 ? 'success' : 'warning'}>{fmtGrade(s.score)}</Badge>
            </div>
          ))}
          {!submissions.loading && filteredSubmissions.filter((s) => (s.studentEmail || s.student?.email || s.email)?.toLowerCase() === history?.email?.toLowerCase()).length === 0 && <p className="text-sm text-muted">Nenhum resultado encontrado.</p>}
        </div>
      </Modal>

      <Modal open={!!audit} onClose={() => setAudit(null)} title="Auditoria do perfil" description={audit?.email}>
        <div className="space-y-2 max-h-96 overflow-auto">
          {auditRows.map((a) => (
            <div key={a.id} className="rounded-md border border-border p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium text-text">{a.field}</span>
                <span className="text-xs text-subtle">{new Date(a.timestamp).toLocaleString('pt-BR')}</span>
              </div>
              {a.action !== 'create' && <p className="text-xs text-muted mt-1"><span className="line-through text-subtle">{a.oldValue || '(vazio)'}</span> → <span className="text-text">{a.newValue || '(vazio)'}</span></p>}
              <p className="text-xs text-subtle mt-1">por {a.actor}{a.ip ? ` · ${a.ip}` : ''}</p>
            </div>
          ))}
          {auditRows.length === 0 && <p className="text-sm text-muted">Nenhuma alteração registrada.</p>}
        </div>
      </Modal>

      <Modal open={!!profile} onClose={() => setProfile(null)} title={profile ? displayName(profile) : 'Perfil'} description={profile?.email}>
        {profile && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="w-12 h-12 rounded-full bg-primary-soft text-primary grid place-items-center text-sm font-semibold">{(displayName(profile) || '?').split(' ').map((x) => x[0]).slice(0, 2).join('')}</span>
              <div className="min-w-0">
                <p className="text-text font-semibold">{displayName(profile)}</p>
                {profile.nomeSocial && profile.nomeSocial.trim() && <p className="text-xs text-subtle">Nome completo: {profile.name}</p>}
                <div className="mt-1 flex items-center gap-2"><Badge tone={STATUS_TONE[profile.status] || 'neutral'}>{profile.status || 'Ativo'}</Badge>{profile.isOnline && <Badge tone="success" dot>online</Badge>}</div>
              </div>
            </div>

            <Section title="Dados básicos">
              <Row label="Nome completo" value={profile.name} />
              <Row label="Nome social" value={profile.nomeSocial} />
              <Row label="E-mail/login" value={profile.email} />
              <Row label="Matrícula" value={profile.matricula} />
              <Row label="Telefone" value={profile.phone} />
            </Section>

            <Section title="Vínculo acadêmico">
              <Row label="Unidade/instituição" value={profile.unidade} />
              <Row label="Curso" value={profileCourseName} />
              <Row label="Turmas" value={studentClassNames(profile).join(', ')} />
              <Row label="Situação" value={profile.status} />
            </Section>

            <Section title="Responsável">
              {profile.guardian && (profile.guardian.name || profile.guardian.phone || profile.guardian.email) ? (
                <>
                  <Row label="Nome" value={profile.guardian.name} />
                  <Row label="Telefone" value={profile.guardian.phone} />
                  <Row label="E-mail" value={profile.guardian.email} />
                  <Row label="Parentesco" value={profile.guardian.parentesco} />
                  {profile.guardian.observacao && <Row label="Observação" value={profile.guardian.observacao} />}
                </>
              ) : <p className="text-sm text-muted">Não informado.</p>}
            </Section>

            <Section title="Acessibilidade">
              {accessLabels(profile.accessibility).length ? (
                <div className="flex flex-wrap gap-1.5 mb-1">{accessLabels(profile.accessibility).map((l) => <Badge key={l} tone="info">{l}</Badge>)}</div>
              ) : <p className="text-sm text-muted">Nenhuma preferência registrada.</p>}
              {profile.accessibility?.tempoAdicional && <Row label="Tempo adicional em provas" value={`${profile.accessibility.tempoAdicionalPercent || 0}%`} />}
              {profile.accessibility?.observacao && <Row label="Observação" value={profile.accessibility.observacao} />}
              {profile.accessibilityNoteRestricted && <Row label="Observação" value="Restrita à coordenação" />}
            </Section>

            {!isProfessor && (
            <Section title="Segurança e privacidade">
              <Row label="Último login" value={profile.lastLoginAt ? new Date(profile.lastLoginAt).toLocaleString('pt-BR') : ''} />
              <Row label="Último acesso" value={profile.lastSeenAt ? new Date(profile.lastSeenAt).toLocaleString('pt-BR') : ''} />
              <Row label="Aceite dos Termos" value={profile.termsAcceptance ? `v${profile.termsAcceptance.version} · ${new Date(profile.termsAcceptance.at).toLocaleDateString('pt-BR')}` : 'pendente'} />
              <Row label="Política de Privacidade" value={profile.privacyAcceptance ? `v${profile.privacyAcceptance.version} · ${new Date(profile.privacyAcceptance.at).toLocaleDateString('pt-BR')}` : 'pendente'} />
            </Section>
            )}

            <Section title="Histórico acadêmico">
              {!academic ? <p className="text-sm text-muted">Carregando…</p> : (
                <>
                  <Row label="Unidades concluídas" value={String(academic.progress?.completedCount ?? 0)} />
                  <p className="text-xs text-subtle mt-2 mb-1">Provas realizadas</p>
                  {academic.submissions?.length ? (
                    <div className="space-y-1">
                      {academic.submissions.map((sb) => (
                        <div key={sb.id} className="flex items-center justify-between gap-2 text-xs rounded-md border border-border p-2">
                          <span className="text-text truncate">{sb.examKey}</span>
                          <span className="text-subtle whitespace-nowrap">{Number.isInteger(sb.correctCount) && Number.isInteger(sb.totalCount) ? `${sb.correctCount}/${sb.totalCount} · ` : ''}{sb.timestamp ? new Date(sb.timestamp).toLocaleDateString('pt-BR') : ''}</span>
                          <Badge tone={gradeOf(sb.score) >= 6 ? 'success' : 'warning'}>{fmtGrade(sb.score)}</Badge>
                        </div>
                      ))}
                    </div>
                  ) : <p className="text-xs text-muted">Nenhuma prova realizada.</p>}
                </>
              )}
            </Section>

            <Section title="Presença">
              <div className="flex items-center justify-between">
                <span className="text-sm text-text">{academic?.attendance?.count ?? 0} registro(s)</span>
                <Button size="sm" variant="secondary" onClick={markPresence}>Marcar presença hoje</Button>
              </div>
              {academic?.attendance?.recent?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {academic.attendance.recent.slice(0, 12).map((at) => {
                    const aulas = Array.isArray(at.aulas) ? at.aulas : []
                    const faltas = aulas.filter((a) => a.status === 'falta' || a.status === 'justificada').length
                    const tone = faltas === 0 ? 'success' : faltas === aulas.length ? 'danger' : 'warning'
                    const resumo = aulas.length ? (faltas === 0 ? 'presente' : `${faltas}/${aulas.length} falta`) : (at.origin === 'login' ? 'automática' : 'manual')
                    return <Badge key={at.id} tone={aulas.length ? tone : 'neutral'}>{at.date} · {resumo}</Badge>
                  })}
                </div>
              )}
            </Section>

            <Section title="Certificados">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-subtle">{academic?.certificates?.length || 0} emitido(s)</span>
                {!isProfessor && <Button size="sm" variant="secondary" onClick={issueCert}>Emitir certificado</Button>}
              </div>
              {academic?.certificates?.length ? (
                <div className="space-y-1">
                  {academic.certificates.map((c) => (
                    <div key={c.id} className="flex items-center justify-between gap-2 text-xs rounded-md border border-border p-2">
                      <div className="min-w-0"><p className="text-text truncate">{c.courseName}</p><p className="text-subtle">{c.code}</p></div>
                      <div className="flex items-center gap-2">
                        <Badge tone={c.status === 'Emitido' ? 'success' : 'danger'}>{c.status}</Badge>
                        {!isProfessor && c.status === 'Emitido' && <button onClick={() => revokeCert(c.id)} className="text-danger" title="Cancelar"><Trash2 size={14} /></button>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : <p className="text-xs text-muted">Nenhum certificado.</p>}
            </Section>

            <Section title="Módulos acessados">
              {academic?.moduleAccess?.length ? (
                <div className="space-y-1 max-h-40 overflow-auto">
                  {academic.moduleAccess.slice(0, 20).map((m) => (
                    <div key={m.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-text truncate">{m.key.replace(/_/g, ' ')}</span>
                      <span className="text-subtle whitespace-nowrap">{m.timestamp ? new Date(m.timestamp).toLocaleString('pt-BR') : ''}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="text-xs text-muted">Nenhum acesso registrado.</p>}
            </Section>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
              <Button variant="secondary" icon={Pencil} onClick={() => { setEdit({ ...emptyForm(), ...profile, originalEmail: profile.email, classes: studentClassNames(profile), courseId: ((classes || []).find((c) => studentClassNames(profile).includes(c.name))?.courseId) || activeCourseId, guardian: profile.guardian || { name: '', phone: '', email: '', parentesco: '' } }); setProfile(null) }}>Editar</Button>
              <Button variant="secondary" icon={MessageSquare} onClick={() => { openObs(profile); setProfile(null) }}>Observações</Button>
              {!isProfessor && <Button variant="secondary" icon={ShieldCheck} onClick={() => { openSecurity(profile); setProfile(null) }}>Segurança</Button>}
              {!isProfessor && <Button variant="secondary" icon={ShieldAlert} onClick={() => { openAudit(profile); setProfile(null) }}>Auditoria</Button>}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!obs} onClose={() => setObs(null)} title="Observações pedagógicas" description={obs?.email}>
        <div className="space-y-4">
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Select label="Categoria" value={obsForm.category} onChange={(e) => setObsForm({ ...obsForm, category: e.target.value, ...(OBS_SENSITIVE.has(e.target.value) ? { visibility: OBS_RESTRICTED } : {}) })}>
                {OBS_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
              <Select label="Visibilidade" value={obsForm.visibility} disabled={OBS_SENSITIVE.has(obsForm.category)} onChange={(e) => setObsForm({ ...obsForm, visibility: e.target.value })}>
                {OBS_VISIBILITY.map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            </div>
            <p className="text-xs text-subtle">Observações restritas à coordenação e as de acessibilidade só aparecem para o administrador e para quem as escreveu. Editar e excluir: o autor ou o administrador.</p>
            <Textarea label="Observação" value={obsForm.text} onChange={(e) => setObsForm({ ...obsForm, text: e.target.value })} />
            <div className="flex justify-end"><Button loading={obsSaving} onClick={addObs}>Registrar</Button></div>
          </div>
          <div className="space-y-2 max-h-72 overflow-auto">
            {obsRows.map((o) => (
              <div key={o.id} className="rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="info">{o.category}</Badge>
                    {o.restricted && <Badge tone="warning">Restrita</Badge>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-subtle">{new Date(o.timestamp).toLocaleDateString('pt-BR')}</span>
                    {o.canEdit !== false && <button onClick={() => delObs(o.id)} className="text-danger" title="Excluir" aria-label="Excluir observação"><Trash2 size={14} /></button>}
                  </div>
                </div>
                <p className="text-sm text-text mt-2 whitespace-pre-wrap">{o.text}</p>
                <p className="text-xs text-subtle mt-1">{o.visibility} · por {o.author}</p>
              </div>
            ))}
            {obsRows.length === 0 && <p className="text-sm text-muted">Nenhuma observação registrada.</p>}
          </div>
        </div>
      </Modal>

      <Modal open={!!security} onClose={() => setSecurity(null)} title="Segurança e privacidade" description={security?.email}>
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-subtle">Último login</p>
              <p className="text-text">{security?.lastLoginAt ? new Date(security.lastLoginAt).toLocaleString('pt-BR') : '-'}</p>
              {security?.lastLoginIp && <p className="text-xs text-subtle mt-1">IP: {security.lastLoginIp}</p>}
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-subtle">Último acesso</p>
              <p className="text-text">{security?.lastSeenAt ? new Date(security.lastSeenAt).toLocaleString('pt-BR') : '-'}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-subtle">Aceite dos Termos</p>
              {security?.termsAcceptance ? <p className="text-text">v{security.termsAcceptance.version} · {new Date(security.termsAcceptance.at).toLocaleDateString('pt-BR')}</p> : <Badge tone="warning">pendente</Badge>}
              {security?.termsAcceptance?.ip && <p className="text-xs text-subtle mt-1">IP: {security.termsAcceptance.ip}</p>}
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-subtle">Política de Privacidade</p>
              {security?.privacyAcceptance ? <p className="text-text">v{security.privacyAcceptance.version} · {new Date(security.privacyAcceptance.at).toLocaleDateString('pt-BR')}</p> : <Badge tone="warning">pendente</Badge>}
            </div>
          </div>
          <div>
            <p className="text-xs text-subtle mb-2">Logs de login (últimos)</p>
            <div className="space-y-2 max-h-64 overflow-auto">
              {secLogs.map((l) => (
                <div key={l.id} className="flex items-center justify-between rounded-md border border-border p-2 text-xs">
                  <div className="min-w-0">
                    <span className="text-text">{new Date(l.timestamp).toLocaleString('pt-BR')}</span>
                    <span className="text-subtle"> · {l.browser}/{l.os} · {l.ip}</span>
                  </div>
                  <Badge tone={l.status === 'success' ? 'success' : 'danger'}>{l.status === 'success' ? 'ok' : 'falha'}</Badge>
                </div>
              ))}
              {secLogs.length === 0 && <p className="text-xs text-muted">Nenhum login registrado.</p>}
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={!!release} onClose={() => setRelease(null)} title="Liberação individual" description={`${release?.name || ''} - ${release?.className || ''}`}>
        <div className="space-y-2">
          {releaseItems.map((item) => (
            <div key={item.key} className="flex items-center gap-3 rounded-md border border-border p-3">
              <ClipboardList size={16} className="text-muted" />
              <div className="flex-1 min-w-0"><p className="text-sm text-text truncate">{item.label}</p><p className="text-xs text-subtle">{item.type}</p></div>
              <Switch checked={!!released[item.key]} onChange={(v) => toggleRelease(item.key, v)} />
            </div>
          ))}
          {releaseItems.length === 0 && <p className="text-sm text-muted">Selecione um aluno com turma e curso válidos.</p>}
        </div>
      </Modal>

      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={remove} danger confirmLabel="Excluir"
        title={`Excluir ${del ? displayName(del) : ''}?`} description="A conta e submissões vinculadas podem ser afetadas." />

      <Modal open={!!reset} onClose={() => setReset(null)} title="Resetar senha" description={reset?.email}
        footer={<><Button variant="ghost" onClick={() => setReset(null)}>Cancelar</Button><Button onClick={doReset}>Redefinir</Button></>}>
        <Input label="Nova senha" type="password" value={reset?.pw || ''} onChange={(e) => setReset({ ...reset, pw: e.target.value })} />
      </Modal>
    </div>
  )
}

export function StudentFormTabs({ value, onChange, classes, courses, schools, onToggleClass, passwordField, passwordLabel, passwordHelper, multiCourse, accessibilityReadOnly = false }) {
  const [tab, setTab] = useState('basic')
  const set = (patch) => onChange({ ...value, ...patch })
  const setGuardian = (patch) => onChange({ ...value, guardian: { ...(value.guardian || {}), ...patch } })
  const setAccess = (patch) => onChange({ ...value, accessibility: { ...(value.accessibility || {}), ...patch } })
  const g = value.guardian || {}
  const a = value.accessibility || {}
  const tabs = [
    { id: 'basic', label: 'Dados básicos' },
    { id: 'link', label: 'Vínculo' },
    { id: 'guardian', label: 'Responsável' },
    { id: 'access', label: 'Acessibilidade' },
  ]
  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-medium -mb-px border-b-2 ${tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-text'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'basic' && (
        <div className="space-y-3">
          <Input label="Nome completo" value={value.name} onChange={(e) => set({ name: e.target.value })} />
          <Input label="Nome social (opcional)" value={value.nomeSocial} onChange={(e) => set({ nomeSocial: e.target.value })} helper="Se preenchido, é exibido no lugar do nome completo." />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="E-mail/login" type="email" value={value.email} onChange={(e) => set({ email: e.target.value })} />
            <Input label="Matrícula/código" value={value.matricula} onChange={(e) => set({ matricula: e.target.value })} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Telefone" value={value.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="(11) 90000-0000" />
            <Select label="Status" value={value.status || 'Ativo'} onChange={(e) => set({ status: e.target.value })}>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
          <Input label={passwordLabel} type={passwordField === 'studentPassword' ? 'password' : 'text'} value={value[passwordField] || ''} onChange={(e) => set({ [passwordField]: e.target.value })} helper={passwordHelper} />
        </div>
      )}

      {tab === 'link' && (multiCourse ? (
        <div className="space-y-3">
          <Input label="Unidade/instituição" value={value.unidade} onChange={(e) => set({ unidade: e.target.value })} />
          <p className="text-sm font-medium text-text">Matrículas — turmas por curso</p>
          <div className="space-y-3 max-h-72 overflow-auto pr-1">
            {(courses || []).map((course) => {
              const turmas = (classes || []).filter((c) => c.courseId === course.id)
              if (turmas.length === 0) return null
              const school = (schools || []).find((sc) => sc.id === (course.schoolId || 'escola_default'))
              return (
                <div key={course.id}>
                  <p className="text-xs font-semibold text-muted">{course.name}{school ? ` · ${school.name}` : ''}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                    {turmas.map((c, i) => (
                      <label key={`${c.name}-${i}`} className="flex items-center gap-2 rounded-md border border-border p-2 text-sm text-text">
                        <input type="checkbox" checked={value.classes.includes(c.name)} onChange={() => onToggleClass(c.name)} />
                        <span className="min-w-0 truncate">{c.name}{c.period ? ` - ${c.period}` : ''}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })}
            {(courses || []).length === 0 && <p className="text-sm text-muted">Nenhum curso cadastrado.</p>}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Select label="Curso" value={value.courseId || ''} onChange={(e) => onChange({ ...value, courseId: e.target.value, classes: [] })}>
            <option value="">Selecione o curso...</option>
            {(courses || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Input label="Unidade/instituição" value={value.unidade} onChange={(e) => set({ unidade: e.target.value })} />
          {value.courseId
            ? <ClassPicker classes={(classes || []).filter((c) => c.courseId === value.courseId)} selected={value.classes} onToggle={onToggleClass} />
            : <p className="text-sm text-muted">Selecione um curso para ver as turmas ativas.</p>}
        </div>
      ))}

      {tab === 'guardian' && (
        <div className="space-y-3">
          <p className="text-xs text-subtle">Opcional. Preencha quando a instituição exigir (ex.: alunos menores de idade).</p>
          <Input label="Nome do responsável" value={g.name || ''} onChange={(e) => setGuardian({ name: e.target.value })} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Telefone" value={g.phone || ''} onChange={(e) => setGuardian({ phone: e.target.value })} placeholder="(11) 90000-0000" />
            <Input label="E-mail" type="email" value={g.email || ''} onChange={(e) => setGuardian({ email: e.target.value })} />
          </div>
          <Input label="Parentesco" value={g.parentesco || ''} onChange={(e) => setGuardian({ parentesco: e.target.value })} placeholder="Mãe, pai, tutor..." />
          <Textarea label="Observação (opcional)" value={g.observacao || ''} onChange={(e) => setGuardian({ observacao: e.target.value })} />
        </div>
      )}

      {tab === 'access' && (
        <div className="space-y-3">
          {accessibilityReadOnly
            ? <p className="text-xs text-subtle">Somente o administrador altera os dados de acessibilidade. Você vê as adaptações para aplicar em aula e nas provas.</p>
            : <p className="text-xs text-subtle">Registre apenas configurações funcionais. Não registre diagnósticos médicos.</p>}
          <div className="space-y-2">
            <Switch checked={!!a.fonteAmpliada} disabled={accessibilityReadOnly} onChange={(v) => setAccess({ fonteAmpliada: v })} label="Fonte ampliada" />
            <Switch checked={!!a.altoContraste} disabled={accessibilityReadOnly} onChange={(v) => setAccess({ altoContraste: v })} label="Alto contraste" />
            <Switch checked={!!a.reducaoAnimacoes} disabled={accessibilityReadOnly} onChange={(v) => setAccess({ reducaoAnimacoes: v })} label="Redução de animações" />
            <Switch checked={!!a.leitorTela} disabled={accessibilityReadOnly} onChange={(v) => setAccess({ leitorTela: v })} label="Compatível com leitor de tela" />
            <Switch checked={!!a.tempoAdicional} disabled={accessibilityReadOnly} onChange={(v) => setAccess({ tempoAdicional: v })} label="Tempo adicional em provas" />
          </div>
          {a.tempoAdicional && (
            <Select label="Percentual de tempo adicional" disabled={accessibilityReadOnly} value={String(a.tempoAdicionalPercent || 0)} onChange={(e) => setAccess({ tempoAdicionalPercent: Number(e.target.value) })}>
              <option value="0">Selecione...</option>
              <option value="25">25%</option>
              <option value="50">50%</option>
              <option value="100">100%</option>
            </Select>
          )}
          {accessibilityReadOnly
            ? (value.accessibilityNoteRestricted && <p className="text-sm text-muted">Há uma observação de acessibilidade restrita à coordenação.</p>)
            : <Textarea label="Observação de acessibilidade (opcional)" value={a.observacao || ''} onChange={(e) => setAccess({ observacao: e.target.value })} />}
        </div>
      )}
    </div>
  )
}

function accessLabels(a) {
  if (!a) return []
  const out = []
  if (a.fonteAmpliada) out.push('Fonte ampliada')
  if (a.altoContraste) out.push('Alto contraste')
  if (a.reducaoAnimacoes) out.push('Redução de animações')
  if (a.leitorTela) out.push('Leitor de tela')
  if (a.tempoAdicional) out.push('Tempo adicional')
  return out
}

function Section({ title, children }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">{title}</p>
      {children}
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-subtle shrink-0">{label}</span>
      <span className="text-sm text-text text-right break-words">{value || '—'}</span>
    </div>
  )
}

function ClassPicker({ classes, selected, onToggle }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text">Turmas</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-auto">
        {classes.map((c, i) => (
          <label key={`${c.name}-${i}`} className="flex items-center gap-2 rounded-md border border-border p-2 text-sm text-text">
            <input type="checkbox" checked={selected.includes(c.name)} onChange={() => onToggle(c.name)} />
            <span className="min-w-0 truncate">{c.name} {c.period ? `- ${c.period}` : ''}</span>
          </label>
        ))}
      </div>
    </div>
  )
}
