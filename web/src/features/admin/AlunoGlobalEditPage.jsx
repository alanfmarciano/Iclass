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
import { ADMIN_PERMISSIONS, canAccessAdminPermission, isFullAdmin } from '../../lib/adminPermissions'
import { displayEmail, isStudentIdParam, studentFormIdentity, studentFormProblem, studentIdentityPayload, studentLoginLabel } from '../../lib/studentProfile'

const STATUS_TONE = { Ativo: 'success', Inativo: 'neutral', Bloqueado: 'danger', 'Concluído': 'success', Transferido: 'warning', Evadido: 'warning', Anonimizado: 'neutral' }

function scn(s) {
  const raw = s.classes && s.classes.length ? s.classes : (s.studentClass ? [s.studentClass] : [])
  return raw.map((c) => typeof c === 'string' ? c : c.name).filter(Boolean)
}
function displayName(s) { return (s.nomeSocial && s.nomeSocial.trim()) || s.name || '' }
function initials(n) { return (n || '?').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase() }
function emptyForm() {
  return {
    name: '', nomeSocial: '', email: '', semEmail: false, matricula: '', phone: '', status: 'Ativo', birthDate: '',
    studentPassword: '', requirePasswordChange: true, unidade: '', courseId: '', classes: [],
    guardian: { name: '', phone: '', email: '', parentesco: '', observacao: '' },
    accessibility: { fonteAmpliada: false, altoContraste: false, reducaoAnimacoes: false, leitorTela: false, tempoAdicional: false, tempoAdicionalPercent: 0, observacao: '' },
  }
}

export default function AlunoGlobalEditPage() {
  // /diretorio/:id (C1 / P4-S3): o id estável do aluno; o formato antigo, com o e-mail no
  // endereço (favorito, tela em cache), ainda abre e troca o endereço pelo do id.
  const { id: param = '' } = useParams()
  const isNew = param === 'novo'
  const nav = useNavigate()
  const toast = useToast()
  const { auth } = useAuth()
  // Conta com escopo (não é administrador pleno): acessibilidade só leitura e sem
  // desligar, como o professor de antes; a Auditoria segue audit.view (contrato C2 do P4).
  const isProfessor = !isFullAdmin(auth)
  const canAudit = canAccessAdminPermission(auth, ADMIN_PERMISSIONS.AUDIT_VIEW)
  // Salvar, cadastrar e redefinir a senha pedem students.edit (D16 do P4). Quem só
  // consulta (Coordenação, Professor auxiliar) abre a ficha sem esses botões.
  const canEditStudent = canAccessAdminPermission(auth, ADMIN_PERMISSIONS.STUDENTS_EDIT)
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

  const student = useMemo(() => {
    if (isNew) return null
    const list = students.data || []
    if (isStudentIdParam(param)) return list.find((s) => s.id === param) || null
    let wanted = param
    try { wanted = decodeURIComponent(param) } catch { /* endereço já decodificado */ }
    return list.find((s) => (s.email || '').toLowerCase() === wanted.toLowerCase()) || null
  }, [students.data, param, isNew])

  useEffect(() => {
    if (student && student.id && !isStudentIdParam(param)) nav(`/diretorio/${student.id}`, { replace: true })
  }, [student, param, nav])

  useEffect(() => {
    if (form) return
    if (isNew) { setForm(emptyForm()); return }
    if (student) setForm({ ...emptyForm(), ...student, ...studentFormIdentity(student), classes: scn(student), guardian: student.guardian || { name: '', phone: '', email: '', parentesco: '' } })
  }, [student, isNew, form])

  // Aba Auditoria: só o administrador (audit.view, decisão P5); o professor nem pede a
  // trilha (o servidor responde 403).
  useEffect(() => {
    if (isNew || !student || !canAudit) return
    api.get(`/api/admin/student/audit?email=${encodeURIComponent(student.email)}`).then((r) => setAuditRows(Array.isArray(r) ? r : [])).catch(() => setAuditRows([]))
  }, [student, isNew, canAudit])

  function toggleClass(name) {
    setForm((f) => ({ ...f, classes: f.classes.includes(name) ? f.classes.filter((x) => x !== name) : [...f.classes, name] }))
  }
  function payload(v, isEdit) {
    const base = {
      name: v.name, nomeSocial: v.nomeSocial, ...studentIdentityPayload(v), matricula: v.matricula,
      phone: v.phone, guardianPhone: v.guardian?.phone || '', status: v.status, birthDate: v.birthDate || '',
      unidade: v.unidade, classes: v.classes, studentClass: v.classes[0], guardian: v.guardian, accessibility: v.accessibility,
    }
    // A senha não vai na edição (H5a): troca de senha só pelo "Redefinir senha".
    if (isEdit) { base.originalEmail = v.originalEmail; base.period = v.period }
    else { base.studentPassword = v.studentPassword; base.requirePasswordChange = v.requirePasswordChange !== false }
    return base
  }
  async function save() {
    const problem = studentFormProblem(form)
    if (problem) return toast.error(problem)
    setSaving(true)
    try {
      if (isNew) {
        const created = await api.post('/api/admin/student/create', payload(form, false))
        toast.success('Aluno cadastrado')
        // Senha temporária gerada pelo servidor: mostra uma vez antes de voltar à lista.
        if (created?.temporaryPassword) { setCreatedPassword({ email: studentLoginLabel(form), password: created.temporaryPassword, mustChangePassword: created.mustChangePassword !== false, deferred: created.passwordChangeDeferred === true }); return }
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
  const canSave = canEditStudent && !anonymized
  const canClose = !isNew && !!form && !isProfessor && !isClosedStatus(student?.status)
  const tabs = [
    { id: 'cadastro', label: 'Cadastro' },
    ...(canAudit ? [{ id: 'auditoria', label: 'Auditoria' }] : []),
  ]

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <button onClick={() => nav('/diretorio')} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-text"><ArrowLeft size={16} />Voltar aos alunos</button>

      <PageState loading={students.loading && !form} error={students.error} onRetry={students.refetch}>
        {!isNew && !student && !students.loading ? (
          <Card className="p-6"><p className="text-sm text-muted">Aluno não encontrado.</p></Card>
        ) : form ? (
          <div className="space-y-5">
            <PageHeader title={isNew ? 'Novo aluno' : (displayName(form) || form.name || 'Aluno')} subtitle={isNew ? 'Cadastro global — turmas de qualquer curso' : displayEmail(form.originalEmail)}>
              <div className="flex gap-2">
                {!isNew && canSave && <Button variant="secondary" icon={KeyRound} onClick={() => setResetOpen(true)}>Redefinir senha</Button>}
                {canClose && <Button variant="destructive" icon={UserMinus} onClick={() => setClosing({ email: form.originalEmail, name: form.name, nomeSocial: form.nomeSocial })}>Desligar aluno</Button>}
                {canSave && <Button icon={Save} loading={saving} onClick={save}>{isNew ? 'Cadastrar' : 'Salvar'}</Button>}
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

            {!canEditStudent && !anonymized && (
              <p className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-muted">{isNew ? 'Sua conta não cadastra alunos.' : 'Sua conta consulta o cadastro do aluno, sem alterar.'}</p>
            )}

            {anonymized && (
              <p className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-muted">Cadastro anonimizado: os dados pessoais saíram e ele não pode ser editado. As notas, a presença e os certificados continuam com este código.</p>
            )}

            {!isNew && <Tabs tabs={tabs} active={tab} onChange={setTab} />}

            {((isNew && canEditStudent) || (!isNew && tab === 'cadastro')) && (
              <>
                <Card className="p-5">
                  <StudentFormTabs value={form} onChange={setForm} classes={classes || []} courses={courses || []} schools={schools || []} multiCourse onToggleClass={toggleClass} passwordField={isNew ? 'studentPassword' : null} passwordLabel="Senha inicial (opcional)" accessibilityReadOnly={isProfessor} />
                </Card>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => nav('/diretorio')}>{canSave ? 'Cancelar' : 'Voltar'}</Button>
                  {canSave && <Button icon={Save} loading={saving} onClick={save}>{isNew ? 'Cadastrar' : 'Salvar'}</Button>}
                </div>
              </>
            )}

            {!isNew && tab === 'auditoria' && canAudit && (
              <Card title="Auditoria do aluno">
                <StudentAuditPanel rows={auditRows} />
              </Card>
            )}
          </div>
        ) : null}
      </PageState>
      <StudentCloseDialog student={closing} onClose={() => setClosing(null)} onDone={afterClose} />
      {!isNew && form && <StudentPasswordResetDialog email={resetOpen ? form.originalEmail : null} matricula={student?.matricula || ''} onClose={() => setResetOpen(false)} />}
      <TemporaryPasswordNotice open={!!createdPassword} email={createdPassword?.email} password={createdPassword?.password} mustChangePassword={createdPassword?.mustChangePassword} deferred={createdPassword?.deferred} onClose={() => { setCreatedPassword(null); nav('/diretorio') }} />
    </div>
  )
}
