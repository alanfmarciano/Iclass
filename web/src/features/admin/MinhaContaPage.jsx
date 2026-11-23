import { useEffect, useState } from 'react'
import { KeyRound, LogOut, Save } from 'lucide-react'
import { Switch } from '../../components/ui/Switch'
import { usePreferences } from '../../context/PreferencesProvider'
import { Card, CardHeader, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { PageHeader } from '../../components/ui/PageHeader'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { PasswordChangeForm } from '../../components/PasswordChangeForm'
import { useAuth } from '../../context/AuthProvider'
import { useToast } from '../../context/ToastProvider'
import { api } from '../../lib/api'
import { ADMIN_PERMISSIONS, accountRoleLabel, canAccessAdminPermission } from '../../lib/adminPermissions'

export const NAME_MAX_LENGTH = 120
export const END_OTHER_SESSIONS_TEXT = 'Os outros navegadores e computadores onde esta conta está aberta saem na hora. Este aparelho continua conectado.'
// Preferência da conta (fase 3, C14 / P5-S7b; D8 do P5): desligada, o professor sai da
// lista de quem o aluno escolhe para começar uma conversa (as conversas já abertas
// continuam). Ausente vale ligada.
export const RECEIVE_MESSAGES_PREF = 'messages.receive'
export const RECEIVE_MESSAGES_HELP = 'Desligado, os alunos não conseguem começar conversa nova com você. As conversas que já existem continuam, e você ainda pode escrever para os alunos.'

// Minha conta do instrutor (/minha-conta, UXI-07), para todos os papéis do painel:
// - Seus dados: nome editável (POST /api/admin/account/profile); e-mail e papel só para
//   ler (quem muda é o administrador, em Contas);
// - Senha: o mesmo formulário da troca obrigatória, com a senha atual
//   (POST /api/admin/change-password; as outras sessões da conta saem);
// - Aparelhos: "Sair dos outros aparelhos" (POST /api/admin/account/end-other-sessions);
// - Mensagens (quem tem page.messages e altera): "Receber mensagens de alunos"
//   (preferência messages.receive, POST /api/admin/preferences pelo PreferencesProvider).
// A Coordenação (só consulta) também usa: é autoatendimento (o servidor deixa passar).
export default function MinhaContaPage() {
  const { auth, setAuth } = useAuth()
  const toast = useToast()
  const [name, setName] = useState(auth.name || '')
  const [nameError, setNameError] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const { pref, setPref } = usePreferences()
  const showMessages = canAccessAdminPermission(auth, ADMIN_PERMISSIONS.PAGE_MESSAGES) && auth.readOnly !== true
  const receiveMessages = pref(RECEIVE_MESSAGES_PREF, true) !== false

  // O nome da sessão chega pelo whoami (abertura e revalidação).
  useEffect(() => { setName(auth.name || '') }, [auth.name])

  const trimmed = name.trim()
  const nameChanged = trimmed !== (auth.name || '').trim()

  async function saveName(event) {
    event.preventDefault()
    if (!trimmed) return setNameError('Informe o seu nome.')
    setSavingName(true); setNameError('')
    try {
      const response = await api.post('/api/admin/account/profile', { name: trimmed })
      const saved = typeof response?.name === 'string' ? response.name : trimmed
      setAuth((current) => (current.role === 'admin' ? { ...current, name: saved } : current))
      setName(saved)
      if (toast) toast.success('Nome atualizado.')
    } catch (error) {
      setNameError(error.message)
    } finally {
      setSavingName(false)
    }
  }

  async function endOtherSessions() {
    const response = await api.post('/api/admin/account/end-other-sessions', {})
    setConfirmEnd(false)
    if (toast) toast.success(response?.message || 'Os outros aparelhos saíram desta conta.')
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Minha conta" subtitle="Seu nome, sua senha e os aparelhos onde a conta está aberta." />

      <Card>
        <CardHeader title="Seus dados" subtitle="O e-mail e o papel são definidos pelo administrador, em Contas." />
        <CardBody>
          <form onSubmit={saveName} className="space-y-4" noValidate>
            <Input label="Nome" value={name} maxLength={NAME_MAX_LENGTH} autoComplete="name"
              onChange={(event) => { setName(event.target.value); setNameError('') }} error={nameError} />
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="min-w-0 rounded-lg border border-border px-3 py-2">
                <dt className="text-xs text-muted">E-mail</dt>
                <dd className="truncate text-text">{auth.email || '—'}</dd>
              </div>
              <div className="min-w-0 rounded-lg border border-border px-3 py-2">
                <dt className="text-xs text-muted">Papel</dt>
                <dd className="text-text">{accountRoleLabel(auth)}{auth.readOnly ? ' (só consulta)' : ''}</dd>
              </div>
            </dl>
            <Button type="submit" icon={Save} loading={savingName} disabled={!nameChanged} className="w-full sm:w-auto">Salvar nome</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Senha" subtitle="Para trocar, informe a senha atual. Os outros aparelhos saem da conta." />
        <CardBody>
          {changingPassword ? (
            <PasswordChangeForm
              kind="instructor"
              endpoint="/api/admin/change-password"
              askCurrent
              onChanged={() => { setChangingPassword(false); if (toast) toast.success('Senha atualizada.') }}
              onCancel={() => setChangingPassword(false)}
            />
          ) : (
            <Button variant="secondary" icon={KeyRound} onClick={() => setChangingPassword(true)} className="w-full sm:w-auto">Alterar senha</Button>
          )}
        </CardBody>
      </Card>

      {showMessages && (
        <Card>
          <CardHeader title="Mensagens" subtitle="Conversas particulares com os alunos das suas turmas." />
          <CardBody className="space-y-2">
            <Switch id="receber-mensagens" checked={receiveMessages} onChange={(value) => setPref(RECEIVE_MESSAGES_PREF, value === true)} label="Receber mensagens de alunos" />
            <p className="text-xs text-muted">{RECEIVE_MESSAGES_HELP}</p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Aparelhos" subtitle="Esqueceu a conta aberta em outro computador? Encerre as outras sessões daqui." />
        <CardBody>
          <Button variant="secondary" icon={LogOut} onClick={() => setConfirmEnd(true)} className="w-full sm:w-auto">Sair dos outros aparelhos</Button>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        onConfirm={endOtherSessions}
        title="Sair dos outros aparelhos?"
        message={END_OTHER_SESSIONS_TEXT}
        confirmLabel="Sair dos outros"
        tone="primary"
      />
    </div>
  )
}
