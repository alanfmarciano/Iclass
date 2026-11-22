import { useMemo, useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, KeyRound, Save, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Card } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { passwordHint } from '../../lib/passwordPolicy'
import { PageState } from '../../components/ui/PageState'
import { PageHeader } from '../../components/ui/PageHeader'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { useAuth } from '../../context/AuthProvider'
import { ADMIN_PERMISSIONS, ADMIN_ROLE_FALLBACK, accountRoleId, canAccessAdminPermission, findRole, grantableOptionsForRole, roleScopeOf, toggleAdditionalPermission } from '../../lib/adminPermissions'
import { AccountPasswordResetDialog } from './AccountPasswordDialogs'

// Papéis que a tela oferece (FUN-13): os do catálogo do servidor que não estão ocultos
// (o Professor auxiliar fica fora por enquanto, decisão do plano); a conta que já tem um
// papel oculto continua vendo o dela, para editar sem trocar.
export function roleChoices(roles, currentRole) {
  const list = Array.isArray(roles) && roles.length ? roles : ADMIN_ROLE_FALLBACK.filter((role) => role.id !== 'monitor')
  return list.filter((role) => !role.oculto || role.id === currentRole)
}

export default function AdminEditPage() {
  const { email } = useParams()
  const isNew = email === 'novo'
  const nav = useNavigate()
  const toast = useToast()
  const { auth } = useAuth()
  const canManage = canAccessAdminPermission(auth, ADMIN_PERMISSIONS.ACCOUNTS_MANAGE)
  const accounts = useApi('/api/admin/accounts')
  const { data: classes } = useApi('/api/admin/classes')
  const { data: courses } = useApi('/api/courses')
  const { data: schools } = useApi('/api/admin/schools')
  // Catálogo dos papéis (GET /api/admin/roles): rótulo, descrição, escopo e concedíveis.
  const rolesApi = useApi('/api/admin/roles')
  const roles = rolesApi.data?.roles || []
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)

  const account = useMemo(() => isNew ? null : (accounts.data || []).find((a) => (a.email || '').toLowerCase() === decodeURIComponent(email || '').toLowerCase()), [accounts.data, email, isNew])

  useEffect(() => {
    if (form) return
    if (isNew) { setForm({ name: '', email: '', password: '', requirePasswordChange: true, role: 'admin', assignedClasses: [], assignedSchoolIds: [], additionalPermissions: [] }); return }
    if (account) setForm({ name: account.name || '', email: account.email, role: accountRoleId(account), assignedClasses: account.assignedClasses || [], assignedSchoolIds: account.assignedSchoolIds || [], additionalPermissions: account.additionalPermissions || [] })
  }, [account, isNew, form])

  const isSelf = !isNew && !!account && String(account.email || '').toLowerCase() === String(auth.email || '').toLowerCase()
  const originalRole = account ? accountRoleId(account) : null
  const choices = roleChoices(roles, originalRole)
  const scope = form ? roleScopeOf(roles, form.role) : 'tudo'
  const grantable = form ? grantableOptionsForRole(roles, form.role) : []

  // Trocar de papel: as extras que o papel novo não aceita saem (o servidor recusaria).
  function chooseRole(roleId) {
    setForm((f) => {
      const allowed = new Set(grantableOptionsForRole(roles, roleId).map((item) => item.permission))
      const defaults = new Set(findRole(roles, roleId)?.permissoesPadrao || [])
      return { ...f, role: roleId, additionalPermissions: roleId === 'admin' ? [] : f.additionalPermissions.filter((permission) => allowed.has(permission) || defaults.has(permission)) }
    })
  }
  function toggleSchool(schoolId) {
    setForm((f) => {
      const has = f.assignedSchoolIds.includes(schoolId)
      return { ...f, assignedSchoolIds: has ? f.assignedSchoolIds.filter((id) => id !== schoolId) : [...f.assignedSchoolIds, schoolId] }
    })
  }

  const grouped = useMemo(() => {
    const map = new Map()
    ;(classes || []).forEach((c) => {
      const key = c.courseId || 'sem'
      if (!map.has(key)) {
        const course = (courses || []).find((co) => co.id === c.courseId)
        const school = course && (schools || []).find((s) => s.id === (course.schoolId || 'escola_default'))
        map.set(key, { courseId: c.courseId, courseName: course?.name || c.courseId || 'Sem curso', schoolName: school?.name || '', turmas: [] })
      }
      map.get(key).turmas.push(c)
    })
    return [...map.values()]
  }, [classes, courses, schools])

  function toggleClass(courseId, className) {
    setForm((f) => {
      const has = f.assignedClasses.some((x) => x.courseId === courseId && x.className === className)
      return { ...f, assignedClasses: has ? f.assignedClasses.filter((x) => x.courseId !== courseId || x.className !== className) : [...f.assignedClasses, { courseId, className }] }
    })
  }
  function togglePermission(permission) {
    setForm((f) => ({ ...f, additionalPermissions: toggleAdditionalPermission(f.additionalPermissions, permission) }))
  }
  async function save() {
    if (!form.email) return toast.error('Informe o e-mail')
    if (isNew && !form.password) return toast.error('Defina a senha')
    setSaving(true)
    // Escopo pelo papel: turmas para professor (e professor auxiliar), escolas para
    // Secretaria e Coordenação; o administrador vê tudo.
    const scopeFields = scope === 'turmas' ? { assignedClasses: form.assignedClasses } : scope === 'escolas' ? { assignedSchoolIds: form.assignedSchoolIds } : {}
    const common = { email: form.email, name: form.name, role: form.role, additionalPermissions: form.role === 'admin' ? [] : form.additionalPermissions, ...scopeFields }
    try {
      if (isNew) await api.post('/api/admin/accounts/create', { ...common, password: form.password, requirePasswordChange: form.requirePasswordChange })
      else await api.post('/api/admin/accounts/update', common)
      toast.success(isNew ? 'Conta criada' : 'Conta atualizada')
      nav('/admins')
    } catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }
  async function remove() {
    try { await api.post('/api/admin/accounts/delete', { email: form.email }); toast.success('Conta removida'); nav('/admins') }
    catch (e) { toast.error(e.message) }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <button onClick={() => nav('/admins')} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-text"><ArrowLeft size={16} />Voltar aos administradores</button>

      <PageState loading={accounts.loading && !form} error={accounts.error} onRetry={accounts.refetch}>
        {!isNew && !account && !accounts.loading ? (
          <Card className="p-6"><p className="text-sm text-muted">Conta não encontrada.</p></Card>
        ) : form ? (
          <div className="space-y-5">
            <PageHeader title={isNew ? 'Nova conta' : (form.name || form.email)} subtitle={isNew ? 'Conta com acesso ao painel: escolha o papel e o que ela enxerga' : form.email}>
              <div className="flex flex-wrap gap-2">
                {/* Redefinir a senha de outra conta (UXI-07); a própria troca em Minha conta. */}
                {!isNew && canManage && !isSelf && <Button variant="secondary" icon={KeyRound} onClick={() => setResetOpen(true)}>Redefinir senha</Button>}
                {!isNew && canManage && <Button variant="destructive" icon={Trash2} onClick={() => setConfirmDel(true)}>Excluir</Button>}
                {canManage && <Button icon={Save} loading={saving} onClick={save}>{isNew ? 'Cadastrar' : 'Salvar'}</Button>}
              </div>
            </PageHeader>

            {!canManage && <div className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-text">Somente consulta — sua conta não pode gerenciar acessos.</div>}

            {confirmDel && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3">
                <p className="text-sm text-text">Remover {form.name || form.email}? Esta conta perderá o acesso ao painel.</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDel(false)}>Cancelar</Button>
                  <Button size="sm" variant="destructive" onClick={remove}>Remover</Button>
                </div>
              </div>
            )}

            <Card className="p-5 space-y-3">
              <Input label="Nome" value={form.name} disabled={!canManage} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Input label="E-mail" type="email" value={form.email} disabled={!canManage || !isNew} onChange={(e) => setForm({ ...form, email: e.target.value })} helper={!isNew ? 'O e-mail identifica a conta e não é alterado aqui.' : undefined} />
              {isNew && <Input label="Senha" type="password" autoComplete="new-password" value={form.password} disabled={!canManage} onChange={(e) => setForm({ ...form, password: e.target.value })} helper={passwordHint('instructor')} />}
              {isNew && (
                <label className="flex items-center gap-2 text-sm text-text">
                  <input type="checkbox" checked={form.requirePasswordChange !== false} disabled={!canManage} onChange={(e) => setForm({ ...form, requirePasswordChange: e.target.checked })} />
                  Pedir troca no primeiro acesso
                </label>
              )}
            </Card>

            {/* Papel (FUN-13): lista de rádio com a frase de cada papel, do catálogo. */}
            <Card className="p-5 space-y-3">
              <fieldset className="space-y-2" disabled={!canManage}>
                <legend className="text-sm font-medium text-text">Papel</legend>
                {choices.map((role) => (
                  <label key={role.id} className="flex min-h-[44px] items-start gap-3 rounded-lg border border-border p-3 text-sm text-text has-[:checked]:border-primary/60 has-[:checked]:bg-primary-soft">
                    <input className="mt-1" type="radio" name="account-role" value={role.id} checked={form.role === role.id} onChange={() => chooseRole(role.id)} />
                    <span className="min-w-0">
                      <span className="block font-medium">{role.rotulo}{role.somenteLeitura ? ' (só consulta)' : ''}</span>
                      {role.descricao && <span className="mt-0.5 block text-xs text-subtle">{role.descricao}</span>}
                    </span>
                  </label>
                ))}
              </fieldset>
              {scope === 'tudo' && <p className="text-xs text-subtle">Administradores enxergam todas as escolas, cursos e turmas.</p>}
            </Card>

            {scope === 'escolas' && (
              <Card className="p-5 space-y-3">
                <div>
                  <p className="text-sm font-medium text-text">Escolas atribuídas</p>
                  <p className="text-xs text-subtle">A conta enxerga os cursos, as turmas e os alunos das escolas marcadas.</p>
                </div>
                {(schools || []).length === 0 && <p className="text-xs text-subtle">Nenhuma escola cadastrada.</p>}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(schools || []).map((school) => (
                    <label key={school.id} className="flex min-h-[44px] items-center gap-2 rounded-md border border-border p-2 text-sm text-text">
                      <input type="checkbox" disabled={!canManage} checked={form.assignedSchoolIds.includes(String(school.id))} onChange={() => toggleSchool(String(school.id))} />
                      <span className="min-w-0 truncate">{school.name || school.id}</span>
                    </label>
                  ))}
                </div>
              </Card>
            )}

            {scope === 'turmas' && (
              <Card className="p-5 space-y-3">
                <div>
                  <p className="text-sm font-medium text-text">Turmas atribuídas</p>
                  <p className="text-xs text-subtle">A conta enxerga os cursos e as escolas das turmas marcadas.</p>
                </div>
                {grouped.length === 0 && <p className="text-xs text-subtle">Nenhuma turma cadastrada.</p>}
                <div className="space-y-3 max-h-80 overflow-auto pr-1">
                  {grouped.map((g, gi) => (
                    <div key={gi}>
                      <p className="text-xs font-semibold text-muted">{g.courseName}{g.schoolName ? ` · ${g.schoolName}` : ''}</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                        {g.turmas.map((c, i) => (
                          <label key={`${c.name}-${i}`} className="flex items-center gap-2 rounded-md border border-border p-2 text-sm text-text">
                            <input type="checkbox" disabled={!canManage} checked={form.assignedClasses.some((x) => x.courseId === g.courseId && x.className === c.name)} onChange={() => toggleClass(g.courseId, c.name)} />
                            <span className="min-w-0 truncate">{c.name}{c.period ? ` - ${c.period}` : ''}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {form.role !== 'admin' && grantable.length > 0 && (
              <Card className="p-5 space-y-3">
                <div>
                  <p className="text-sm font-medium text-text">Acessos adicionais</p>
                  <p className="text-xs text-subtle">Libere exceções individuais além do que o papel já tem. Só aparecem as que o papel aceita.</p>
                </div>
                <div className="grid grid-cols-1 gap-2 max-h-80 overflow-auto pr-1">
                  {grantable.map((item) => (
                    <label key={item.permission} className="flex items-start gap-2 rounded-md border border-border p-3 text-sm text-text">
                      <input className="mt-0.5" type="checkbox" disabled={!canManage} checked={form.additionalPermissions.includes(item.permission)} onChange={() => togglePermission(item.permission)} />
                      <span>
                        <span className="block font-medium">{item.group} · {item.label}</span>
                        <span className="block text-xs text-subtle mt-0.5">{item.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </Card>
            )}

            {canManage && (
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => nav('/admins')}>Cancelar</Button>
                <Button icon={Save} loading={saving} onClick={save}>{isNew ? 'Cadastrar' : 'Salvar'}</Button>
              </div>
            )}
          </div>
        ) : null}
      </PageState>
      <AccountPasswordResetDialog email={resetOpen && form ? form.email : null} onClose={() => setResetOpen(false)} onDone={() => accounts.refetch()} />
    </div>
  )
}
