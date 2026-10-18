import { useMemo, useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Save, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Card } from '../../components/ui/Card'
import { Tabs } from '../../components/ui/Tabs'
import { PageState } from '../../components/ui/PageState'
import { PageHeader } from '../../components/ui/PageHeader'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { useAuth } from '../../context/AuthProvider'
import { StudentFormTabs } from './AlunosPage'
import { StudentAuditPanel } from './StudentAuditPanel'

const STATUS_TONE = { Ativo: 'success', Inativo: 'neutral', Bloqueado: 'danger', 'Concluído': 'success', Transferido: 'warning', Evadido: 'warning' }

function scn(s) {
  const raw = s.classes && s.classes.length ? s.classes : (s.studentClass ? [s.studentClass] : [])
  return raw.map((c) => typeof c === 'string' ? c : c.name).filter(Boolean)
}
function displayName(s) { return (s.nomeSocial && s.nomeSocial.trim()) || s.name || '' }
function initials(n) { return (n || '?').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase() }
function emptyForm() {
  return {
    name: '', nomeSocial: '', email: '', matricula: '', phone: '', status: 'Ativo',
    studentPassword: '', unidade: '', courseId: '', classes: [],
    guardian: { name: '', phone: '', email: '', parentesco: '', observacao: '' },
    accessibility: { fonteAmpliada: false, altoContraste: false, reducaoAnimacoes: false, leitorTela: false, tempoAdicional: false, tempoAdicionalPercent: 0, observacao: '' },
  }
}

export default function AlunoGlobalEditPage() {
  const { email } = useParams()
  const isNew = email === 'novo'
  const nav = useNavigate()
  const toast = useToast()
  const { auth } = useAuth()
  const isProfessor = auth?.accountRole === 'professor'
  const students = useApi('/api/admin/students')
  const { data: classes } = useApi('/api/admin/classes')
  const { data: courses } = useApi('/api/courses')
  const { data: schools } = useApi('/api/admin/schools')
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [auditRows, setAuditRows] = useState([])
  const [tab, setTab] = useState('cadastro')

  const student = useMemo(() => isNew ? null : (students.data || []).find((s) => (s.email || '').toLowerCase() === decodeURIComponent(email || '').toLowerCase()), [students.data, email, isNew])

  useEffect(() => {
    if (form) return
    if (isNew) { setForm(emptyForm()); return }
    if (student) setForm({ ...emptyForm(), ...student, originalEmail: student.email, classes: scn(student), guardian: student.guardian || { name: '', phone: '', email: '', parentesco: '' } })
  }, [student, isNew, form])

  useEffect(() => {
    if (isNew || !student) return
    api.get(`/api/admin/student/audit?email=${encodeURIComponent(student.email)}`).then((r) => setAuditRows(Array.isArray(r) ? r : [])).catch(() => setAuditRows([]))
  }, [student, isNew])

  function toggleClass(name) {
    setForm((f) => ({ ...f, classes: f.classes.includes(name) ? f.classes.filter((x) => x !== name) : [...f.classes, name] }))
  }
  function payload(v, isEdit) {
    const base = {
      name: v.name, nomeSocial: v.nomeSocial, email: v.email, matricula: v.matricula,
      phone: v.phone, guardianPhone: v.guardian?.phone || '', status: v.status,
      unidade: v.unidade, classes: v.classes, studentClass: v.classes[0], guardian: v.guardian, accessibility: v.accessibility,
    }
    if (isEdit) { base.originalEmail = v.originalEmail; base.password = v.password; base.period = v.period }
    else { base.studentPassword = v.studentPassword }
    return base
  }
  async function save() {
    if (!form.name || !form.email || form.classes.length === 0) return toast.error('Informe nome, e-mail e ao menos uma turma')
    if (isNew && !form.studentPassword) return toast.error('Defina a senha inicial')
    setSaving(true)
    try {
      if (isNew) await api.post('/api/admin/student/create', payload(form, false))
      else await api.post('/api/admin/student/update', payload(form, true))
      toast.success(isNew ? 'Aluno cadastrado' : 'Aluno atualizado')
      nav('/diretorio')
    } catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }
  async function remove() {
    try { await api.post('/api/admin/delete-student', { email: form.originalEmail }); toast.success('Aluno removido'); nav('/diretorio') }
    catch (e) { toast.error(e.message) }
  }

  const enrollCount = form ? form.classes.length : 0
  const tabs = [
    { id: 'cadastro', label: 'Cadastro' },
    { id: 'auditoria', label: 'Auditoria' },
  ]

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <button onClick={() => nav('/diretorio')} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-text"><ArrowLeft size={16} />Voltar aos alunos</button>

      <PageState loading={students.loading && !form} error={students.error} onRetry={students.refetch}>
        {!isNew && !student && !students.loading ? (
          <Card className="p-6"><p className="text-sm text-muted">Aluno não encontrado.</p></Card>
        ) : form ? (
          <div className="space-y-5">
            <PageHeader title={isNew ? 'Novo aluno' : (displayName(form) || form.name || 'Aluno')} subtitle={isNew ? 'Cadastro global — turmas de qualquer curso' : form.originalEmail}>
              <div className="flex gap-2">
                {!isNew && <Button variant="destructive" icon={Trash2} onClick={() => setConfirmDel(true)}>Excluir</Button>}
                <Button icon={Save} loading={saving} onClick={save}>{isNew ? 'Cadastrar' : 'Salvar'}</Button>
              </div>
            </PageHeader>

            {!isNew && (
              <div className="flex items-center gap-3">
                <span className="w-11 h-11 rounded-full bg-primary-soft text-primary grid place-items-center text-sm font-semibold">{initials(displayName(form))}</span>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge tone={STATUS_TONE[form.status] || 'neutral'}>{form.status || 'Ativo'}</Badge>
                  <span className="text-sm text-muted">{enrollCount} matrícula{enrollCount === 1 ? '' : 's'}</span>
                </div>
              </div>
            )}

            {confirmDel && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3">
                <p className="text-sm text-text">Excluir {displayName(form)}? A conta e submissões vinculadas podem ser afetadas.</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDel(false)}>Cancelar</Button>
                  <Button size="sm" variant="destructive" onClick={remove}>Excluir definitivo</Button>
                </div>
              </div>
            )}

            {!isNew && <Tabs tabs={tabs} active={tab} onChange={setTab} />}

            {(isNew || tab === 'cadastro') && (
              <>
                <Card className="p-5">
                  <StudentFormTabs value={form} onChange={setForm} classes={classes || []} courses={courses || []} schools={schools || []} multiCourse onToggleClass={toggleClass} passwordField={isNew ? 'studentPassword' : 'password'} passwordLabel={isNew ? 'Senha inicial' : 'Senha/hash atual'} passwordHelper={isNew ? undefined : 'Mantenha como está para não trocar.'} accessibilityReadOnly={isProfessor} />
                </Card>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => nav('/diretorio')}>Cancelar</Button>
                  <Button icon={Save} loading={saving} onClick={save}>{isNew ? 'Cadastrar' : 'Salvar'}</Button>
                </div>
              </>
            )}

            {!isNew && tab === 'auditoria' && (
              <Card title="Auditoria do cadastro">
                <StudentAuditPanel rows={auditRows} />
              </Card>
            )}
          </div>
        ) : null}
      </PageState>
    </div>
  )
}
