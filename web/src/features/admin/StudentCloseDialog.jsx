import { useEffect, useState } from 'react'
import { Modal } from '../../components/ui/Modal'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { Textarea } from '../../components/ui/Textarea'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { CLOSE_STATUS_OPTIONS, STATUS_REASON_MAX, STUDENT_CLOSE_WARNING } from './studentDeletion'

// "Desligar aluno" (H7c; FUN-03, decisão 4 do Alan), no lugar do antigo "Excluir aluno":
// muda a situação para Inativo (padrão), Transferido, Evadido ou Concluído com um motivo
// opcional, pelo bulk-status, que grava quando, quem e por quê. Nada é apagado: anonimizar
// ou apagar de vez fica em Cadastros encerrados (/encerrados), caso a caso.
// student: { email, name, nomeSocial } ou null (fechado).
export function StudentCloseDialog({ student, onClose, onDone }) {
  const toast = useToast()
  const [status, setStatus] = useState(CLOSE_STATUS_OPTIONS[0])
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const open = !!student

  useEffect(() => {
    if (!open) return
    setStatus(CLOSE_STATUS_OPTIONS[0])
    setReason('')
  }, [open, student?.email])

  const name = student ? ((student.nomeSocial && student.nomeSocial.trim()) || student.name || student.email) : ''
  const tooLong = reason.trim().length > STATUS_REASON_MAX

  async function confirm() {
    if (!student || saving || tooLong) return
    setSaving(true)
    try {
      const res = await api.post('/api/admin/student/bulk-status', { emails: [student.email], status, reason: reason.trim() })
      const skipped = Array.isArray(res?.skipped) ? res.skipped[0] : null
      if (res && res.updated === 0 && skipped) toast.error(skipped.reason || 'Nada mudou.')
      else toast.success(`${name}: situação ${status}.`)
      if (onDone) onDone(res && res.updated === 0 ? null : status)
      onClose && onClose()
    } catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={() => !saving && onClose && onClose()} title={`Desligar ${name}?`} description={STUDENT_CLOSE_WARNING}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button variant="destructive" onClick={confirm} loading={saving} disabled={tooLong}>Desligar</Button>
      </>}>
      <div className="space-y-3">
        <Select label="Nova situação" value={status} onChange={(event) => setStatus(event.target.value)}>
          {CLOSE_STATUS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </Select>
        <Textarea label="Motivo (opcional)" value={reason} maxLength={STATUS_REASON_MAX + 50} onChange={(event) => setReason(event.target.value)}
          error={tooLong ? `No máximo ${STATUS_REASON_MAX} caracteres.` : undefined} className="min-h-[72px]" placeholder="Ex.: transferido para outra escola" />
      </div>
    </Modal>
  )
}
