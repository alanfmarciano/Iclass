import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Modal } from '../../components/ui/Modal'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { passwordHint } from '../../lib/passwordPolicy'
import { TemporaryPasswordNotice } from './StudentPasswordDialogs'

// "Redefinir senha" de outra conta do painel, pelo administrador (UXI-07; POST
// /api/admin/accounts/reset-password): senha temporária gerada pelo servidor (o padrão) ou
// definida pelo administrador, com o mesmo aviso de senha temporária do aluno (mostrada
// uma vez, com Copiar). A conta troca a senha no próximo acesso e sai dos aparelhos onde
// estava aberta.
export const ACCOUNT_TEMPORARY_PASSWORD_TEXT = 'Entregue esta senha à pessoa. No próximo acesso ela vai escolher uma senha nova.'
export const ACCOUNT_TEMPORARY_PASSWORD_KEPT_TEXT = 'Entregue esta senha à pessoa. Ela continua valendo até a pessoa trocar em Minha conta.'
export const ACCOUNT_RESET_HINT_TEXT = 'A senha atual desta conta deixa de valer na hora, e ela sai dos aparelhos onde estava aberta.'

// email: a conta (null fecha). onDone(): depois do 200.
export function AccountPasswordResetDialog({ email, onClose, onDone }) {
  const toast = useToast()
  const [mode, setMode] = useState('generated')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [temporary, setTemporary] = useState(null)

  function close() {
    setMode('generated'); setTyped(''); setError(''); setTemporary(null)
    onClose()
  }

  async function submit() {
    if (mode === 'typed' && !typed.trim()) return setError('Digite a senha nova ou escolha gerar uma senha temporária.')
    setBusy(true); setError('')
    try {
      const response = await api.post('/api/admin/accounts/reset-password', mode === 'typed' ? { email, newPassword: typed } : { email })
      if (onDone) onDone()
      if (response?.temporaryPassword) {
        setTemporary({ email, password: response.temporaryPassword, mustChangePassword: response.mustChangePassword !== false })
      } else {
        if (toast) toast.success(response?.message || 'Senha redefinida.')
        close()
      }
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setBusy(false)
    }
  }

  if (temporary) {
    return (
      <TemporaryPasswordNotice open email={temporary.email} password={temporary.password}
        text={temporary.mustChangePassword ? ACCOUNT_TEMPORARY_PASSWORD_TEXT : ACCOUNT_TEMPORARY_PASSWORD_KEPT_TEXT} onClose={close} />
    )
  }
  return (
    <Modal open={!!email} onClose={close} title="Redefinir senha" description={email}
      footer={<><Button variant="ghost" onClick={close}>Cancelar</Button><Button icon={KeyRound} loading={busy} onClick={submit}>Redefinir</Button></>}>
      <fieldset className="space-y-3">
        <legend className="sr-only">Como definir a senha nova</legend>
        <label className="flex items-start gap-2 text-sm text-text">
          <input type="radio" name="account-reset-mode" value="generated" checked={mode === 'generated'} onChange={() => { setMode('generated'); setError('') }} className="mt-1" />
          <span><span className="font-medium">Gerar senha temporária</span><span className="block text-xs text-muted">O IClass cria a senha e mostra para você entregar à pessoa.</span></span>
        </label>
        <label className="flex items-start gap-2 text-sm text-text">
          <input type="radio" name="account-reset-mode" value="typed" checked={mode === 'typed'} onChange={() => { setMode('typed'); setError('') }} className="mt-1" />
          <span className="font-medium">Definir eu mesmo</span>
        </label>
        {mode === 'typed' && (
          <Input label="Senha nova" type="password" autoComplete="new-password" value={typed}
            onChange={(event) => setTyped(event.target.value)} helper={passwordHint('instructor')} />
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <p className="text-xs text-subtle">{ACCOUNT_RESET_HINT_TEXT}</p>
      </fieldset>
    </Modal>
  )
}
