import { useMemo, useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, KeyRound, Save, UserMinus } from 'lucide-react'
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
import { StudentPasswordResetDialog, TemporaryPasswordNotice } from './StudentPasswordDialogs'
import { StudentCloseDialog } from './StudentCloseDialog'
import { isAnonymizedStatus, isClosedStatus } from './studentDeletion'

const STATUS_TONE = { Ativo: 'success', Inativo: 'neutral', Bloqueado: 'danger', 'Concluído': 'success', Transferido: 'warning', Evadido: 'warning', Anonimizado: 'neutral' }

function scn(s) {
  const raw = s.classes && s.classes.length ? s.classes : (s.studentClass ? [s.studentClass] : [])
  return raw.map((c) => typeof c === 'string' ? c : c.name).filter(Boolean)
}
function displayName(s) { return (s.nomeSocial && s.nomeSocial.trim()) || s.name || '' }
function initials(n) { return (n || '?').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase() }
function emptyForm() {
  return {
    name: '', nomeSocial: '', email: '', matricula: '', phone: '', status: 'Ativo',
    studentPassword: '', requirePasswordChange: true, unidade: '', courseId: '', classes: [],
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
  const [closing, setClosing] = useState(null)
  const [auditRows, setAuditRows] = useState([])
  const [tab, setTab] = useState('cadastro')
  const [resetOpen, setResetOpen] = useState(false)
  const [createdPassword, setCreatedPassword] = useState(null)

  const student = useMemo(() => isNew ? null : (students.data || []).find((s) => (s.email || '').toLowerCase() === decodeURIComponent(email || '').toLowerCase()), [students.data, email, isNew])

  useEffect(() => {
    if (form) return
    if (isNew) { setForm(emptyForm()); return }
    if (student) setForm({ ...emptyForm(), ...student, originalEmail: student.email, classes: scn(student), guardian: student.guardian || { name: '', phone: '', email: '', parentesco: '' } })
  }, [student, isNew, form])

  // Aba Auditoria: só o administrador (audit.view, decisão P5); o professor nem pede a
  // trilha (o servidor responde 403).
  useEffect(() => {
    if (isNew || !student || isProfessor) return
    api.get(`/api/admin/student/audit?email=${encodeURIComponent(student.email)}`).then((r) => setAuditRows(Array.isArray(r) ? r : [])).catch(() => setAuditRows([]))
  }, [student, isNew, isProfessor])

  function toggleClass(name) {
    setForm((f) => ({ ...f, classes: f.classes.includes(name) ? f.classes.filter((x) => x !== name) : [...f.classes, name] }))
  }
  function payload(v, isEdit) {
    const base = {
      name: v.name, nomeSocial: v.nomeSocial, email: v.email, matricula: v.matricula,
      phone: v.phone, guardianPhone: v.guardian?.phone || '', status: v.status,
      unidade: v.unidade, classes: v.classes, studentClass: v.classes[0], guardian: v.guardian, accessibility: v.accessibility,
    }
    // A senha não vai na edição (H5a): troca de senha só pelo "Redefinir senha".
    if (isEdit) { base.originalEmail = v.originalEmail; base.period = v.period }
    else { base.studentPassword = v.studentPassword; base.requirePasswordChange = v.requirePasswordChange !== false }
    return base
  }
  async function save() {
    if (!form.name || !form.email || form.classes.length === 0) return toast.error('Informe nome, e-mail e ao menos uma turma')
    setSaving(true)
    try {
      if (isNew) {
        const created = await api.post('/api/admin/student/create', payload(form, false))
        toast.success('Aluno cadastrado')
        // Senha temporária gerada pelo servidor: mostra uma vez antes de voltar à lista.
        if (created?.temporaryPassword) { setCreatedPassword({ email: form.email, password: created.temporaryPassword, mustChangePassword: created.mustChangePassword !== false, deferred: created.passwordChangeDeferred === true }); return }
      } else {
        await api.post('/api/admin/student/update', payload(form, true))
        toast.success('Aluno atualizado')
      }
      nav('/diretorio')
    } catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }
  // Desligar aluno (H7c): a situação muda no servidor; a ficha relê o cadastro.
  function afterClose(status) {
    if (status) setForm((f) => (f ? { ...f, status } : f))
    students.refetch()
  }

  const enrollCount = form ? form.classes.length : 0
  // Cadastro anonimizado não se edita (o servidor responde 409); encerrado não se desliga de novo.
  const anonymized = !isNew && !!form && isAnonymizedStatus(form.status)
  const canClose = !isNew && !!form && !isProfessor && !isClosedStatus(student?.status)
  const tabs = [
    { id: 'cadastro', label: 'Cadastro' },
    ...(!isProfessor ? [{ id: 'auditoria', label: 'Auditoria' }] : []),
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
                {!isNew && !anonymized && <Button variant="secondary" icon={KeyRound} onClick={() => setResetOpen(true)}>Redefinir senha</Button>}
                {canClose && <Button variant="destructive" icon={UserMinus} onClick={() => setClosing({ email: form.originalEmail, name: form.name, nomeSocial: form.nomeSocial })}>Desligar aluno</Button>}
                {!anonymized && <Button icon={Save} loading={saving} onClick={save}>{isNew ? 'Cadastrar' : 'Salvar'}</Button>}
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

            {anonymized && (
              <p className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-muted">Cadastro anonimizado: os dados pessoais saíram e ele não pode ser editado. As notas, a presença e os certificados continuam com este código.</p>
            )}

            {!isNew && <Tabs tabs={tabs} active={tab} onChange={setTab} />}

            {(isNew || tab === 'cadastro') && (
              <>
                <Card className="p-5">
                  <StudentFormTabs value={form} onChange={setForm} classes={classes || []} courses={courses || []} schools={schools || []} multiCourse onToggleClass={toggleClass} passwordField={isNew ? 'studentPassword' : null} passwordLabel="Senha inicial (opcional)" accessibilityReadOnly={isProfessor} />
                </Card>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => nav('/diretorio')}>Cancelar</Button>
                  {!anonymized && <Button icon={Save} loading={saving} onClick={save}>{isNew ? 'Cadastrar' : 'Salvar'}</Button>}
                </div>
              </>
            )}

            {!isNew && tab === 'auditoria' && !isProfessor && (
              <Card title="Auditoria do aluno">
                <StudentAuditPanel rows={auditRows} />
              </Card>
            )}
          </div>
        ) : null}
      </PageState>
      <StudentCloseDialog student={closing} onClose={() => setClosing(null)} onDone={afterClose} />
      {!isNew && form && <StudentPasswordResetDialog email={resetOpen ? form.originalEmail : null} onClose={() => setResetOpen(false)} />}
      <TemporaryPasswordNotice open={!!createdPassword} email={createdPassword?.email} password={createdPassword?.password} mustChangePassword={createdPassword?.mustChangePassword} deferred={createdPassword?.deferred} onClose={() => { setCreatedPassword(null); nav('/diretorio') }} />
    </div>
  )
}
