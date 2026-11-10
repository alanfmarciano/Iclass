import { useEffect, useState } from 'react'
import { Modal } from '../../components/ui/Modal'
import { Button } from '../../components/ui/Button'
import { Textarea } from '../../components/ui/Textarea'

// Motivo ao mudar nota já publicada (H7a-2, CONF-09): ocultar, excluir, mudar a regra,
// escolher, desconsiderar ou reconsiderar tentativa de nota que o aluno já viu pede um
// motivo de pelo menos 3 letras, que fica na auditoria e no histórico da nota. O
// servidor confere de novo (400 com code 'reason_required'); a tela pede antes.
export const GRADE_REASON_MIN = 3
export const GRADE_REASON_MAX = 500

export function isReasonRequiredError(error) {
  return error?.status === 400 && error?.data?.code === 'reason_required'
}

export function gradeReasonError(text, required) {
  const value = String(text || '').trim()
  if (!required) return ''
  if (!value) return 'Informe o motivo: esta nota já foi publicada para o aluno.'
  if (value.length < GRADE_REASON_MIN) return `O motivo precisa ter pelo menos ${GRADE_REASON_MIN} letras.`
  return ''
}

// reason: 'required' (nota publicada), 'optional' (o motivo vai junto se escrito) ou
// 'none' (só a confirmação). onConfirm(reason) devolve uma promessa; se o servidor
// responder reason_required (a nota foi publicada nesse meio-tempo), o diálogo fica
// aberto, passa a exigir o motivo e mostra a mensagem.
export function GradeReasonDialog({ open, onClose, onConfirm, title, description, note, confirmLabel = 'Confirmar', danger = false, reason = 'optional' }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [forced, setForced] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setText('')
    setError('')
    setForced(false)
    setBusy(false)
  }, [open])
  const mode = forced ? 'required' : reason
  const required = mode === 'required'

  async function submit(event) {
    event?.preventDefault?.()
    const problem = gradeReasonError(text, required)
    if (problem) { setError(problem); return }
    setBusy(true)
    try {
      await onConfirm(mode === 'none' ? '' : text.trim())
    } catch (failure) {
      if (isReasonRequiredError(failure)) {
        setForced(true)
        setError(failure.message)
      } else {
        setError(failure?.message || 'Não foi possível concluir.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={title} description={description}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button variant={danger ? 'destructive' : 'primary'} loading={busy} onClick={submit}>{confirmLabel}</Button>
      </>}>
      <form className="space-y-3" onSubmit={submit}>
        {note && <p className="text-sm text-muted">{note}</p>}
        {mode !== 'none' && (
          <Textarea
            label={required ? 'Motivo (obrigatório: a nota já foi publicada)' : 'Motivo (opcional)'}
            value={text}
            maxLength={GRADE_REASON_MAX}
            onChange={(event) => { setText(event.target.value); if (error) setError('') }}
            placeholder="Ex.: correção revisada a pedido do aluno"
            error={error || undefined}
            required={required}
          />
        )}
        {mode === 'none' && error && <p role="alert" className="text-xs text-danger">{error}</p>}
        {required && <p className="text-xs text-subtle">O motivo fica na auditoria e no histórico da nota.</p>}
      </form>
    </Modal>
  )
}
