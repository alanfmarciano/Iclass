import { useState } from 'react'
import { Copy, KeyRound } from 'lucide-react'
import { Modal } from '../../components/ui/Modal'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { passwordHint } from '../../lib/passwordPolicy'

// Senha do aluno pelo professor (H5a; SEG-06, UXA-13): o "Redefinir senha" com senha
// temporária gerada pelo servidor (o padrão) ou definida pelo professor, e o aviso que
// mostra a senha temporária uma vez, com o botão Copiar. A senha não fica guardada na
// tela: fechou o aviso, só redefinindo de novo.

export const TEMPORARY_PASSWORD_TEXT = 'Entregue esta senha ao aluno. No próximo acesso ele vai escolher uma senha nova.'
// Sem a troca pedida (caixa "Pedir troca no primeiro acesso" desmarcada): a senha
// temporária continua valendo até o aluno trocar em Minha conta.
export const TEMPORARY_PASSWORD_KEPT_TEXT = 'Entregue esta senha ao aluno. Ela continua valendo até ele trocar em Minha conta.'

// Copiar sem depender de navigator.clipboard, que o navegador só libera na conexão segura
// (o IClass na rede da escola abre em http): cai para o execCommand('copy').
export async function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* tenta o caminho antigo */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

// mustChangePassword: o que o servidor respondeu (false = a troca não foi pedida).
export function TemporaryPasswordNotice({ open, email, password, mustChangePassword = true, onClose }) {
  const toast = useToast()
  async function copy() {
    const ok = await copyText(password || '')
    if (!toast) return
    if (ok) toast.success('Senha copiada')
    else toast.error('Não foi possível copiar. Anote a senha.')
  }
  return (
    <Modal open={open} onClose={onClose} title="Senha temporária" description={email}
      footer={<Button onClick={onClose}>Pronto</Button>}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <code data-testid="temporary-password" className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-lg font-semibold tracking-wider text-text select-all">{password}</code>
          <Button variant="secondary" icon={Copy} onClick={copy}>Copiar</Button>
        </div>
        <p className="text-sm text-muted">{mustChangePassword === false ? TEMPORARY_PASSWORD_KEPT_TEXT : TEMPORARY_PASSWORD_TEXT}</p>
      </div>
    </Modal>
  )
}

// Redefinir a senha de um aluno. email: a conta (null fecha). onDone(): depois do 200.
export function StudentPasswordResetDialog({ email, onClose, onDone }) {
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
      const response = await api.post('/api/admin/reset-password', mode === 'typed' ? { email, newPassword: typed } : { email })
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

  if (temporary) return <TemporaryPasswordNotice open email={temporary.email} password={temporary.password} mustChangePassword={temporary.mustChangePassword} onClose={close} />
  return (
    <Modal open={!!email} onClose={close} title="Redefinir senha" description={email}
      footer={<><Button variant="ghost" onClick={close}>Cancelar</Button><Button icon={KeyRound} loading={busy} onClick={submit}>Redefinir</Button></>}>
      <fieldset className="space-y-3">
        <legend className="sr-only">Como definir a senha nova</legend>
        <label className="flex items-start gap-2 text-sm text-text">
          <input type="radio" name="reset-mode" value="generated" checked={mode === 'generated'} onChange={() => { setMode('generated'); setError('') }} className="mt-1" />
          <span><span className="font-medium">Gerar senha temporária</span><span className="block text-xs text-muted">O IClass cria a senha e mostra para você entregar ao aluno.</span></span>
        </label>
        <label className="flex items-start gap-2 text-sm text-text">
          <input type="radio" name="reset-mode" value="typed" checked={mode === 'typed'} onChange={() => { setMode('typed'); setError('') }} className="mt-1" />
          <span className="font-medium">Definir eu mesmo</span>
        </label>
        {mode === 'typed' && (
          <Input label="Senha nova" type="password" autoComplete="new-password" value={typed}
            onChange={(event) => setTyped(event.target.value)} helper={passwordHint('student')} />
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <p className="text-xs text-subtle">No próximo acesso o aluno vai escolher uma senha nova.</p>
      </fieldset>
    </Modal>
  )
}
