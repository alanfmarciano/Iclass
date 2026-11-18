import { useState } from 'react'
import { Input } from './ui/Input'
import { Button } from './ui/Button'
import { api } from '../lib/api'
import { checkNewPassword, passwordHint } from '../lib/passwordPolicy'

// Formulário único de troca de senha (H5a; UXA-13, SEG-06): a troca obrigatória do aluno
// e do instrutor e o "Alterar senha" de /aluno/conta. A regra de verdade é a do servidor
// (lib/passwordPolicy.js só confere o tamanho e a confirmação antes de enviar).
//
// - kind: 'student' (mínimo de 8) ou 'instructor' (mínimo de 10);
// - endpoint: '/api/student/change-password' ou '/api/admin/change-password';
// - askCurrent: mostra o campo da senha atual desde o início. Sem ele, o campo aparece
//   quando o servidor pede (400 currentPasswordRequired);
// - currentLabel: 'Senha atual' ou, na troca depois de uma senha dada pelo professor,
//   'Senha temporária';
// - onChanged(): chamada depois do 200.
export function PasswordChangeForm({
  kind = 'student',
  endpoint,
  askCurrent = true,
  currentLabel = 'Senha atual',
  submitLabel = 'Salvar nova senha',
  onChanged,
  onCancel,
}) {
  const [showCurrent, setShowCurrent] = useState(askCurrent)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault()
    if (showCurrent && !currentPassword) return setErrors({ current: `Informe a ${currentLabel.toLowerCase()}.` })
    const problem = checkNewPassword(newPassword, confirmation, kind)
    if (problem) return setErrors(problem === 'As senhas não coincidem.' ? { confirmation: problem } : { password: problem })
    setBusy(true); setErrors({})
    try {
      await api.post(endpoint, { ...(showCurrent ? { currentPassword } : {}), newPassword })
      setCurrentPassword(''); setNewPassword(''); setConfirmation('')
      if (onChanged) onChanged()
    } catch (error) {
      const data = error?.data || {}
      if (data.currentPasswordRequired) {
        setShowCurrent(true)
        setErrors({ current: error.message })
      } else if (data.field === 'currentPassword' || /senha atual/i.test(error.message || '')) {
        setErrors({ current: error.message })
      } else {
        setErrors({ password: error.message })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {showCurrent && (
        <Input label={currentLabel} type="password" autoComplete="current-password" value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)} error={errors.current} />
      )}
      <Input label="Nova senha" type="password" autoComplete="new-password" value={newPassword}
        onChange={(event) => setNewPassword(event.target.value)} error={errors.password} helper={passwordHint(kind)} />
      <Input label="Confirmar nova senha" type="password" autoComplete="new-password" value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)} error={errors.confirmation} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="flex-1" loading={busy}>{submitLabel}</Button>
        {onCancel && <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancelar</Button>}
      </div>
    </form>
  )
}
