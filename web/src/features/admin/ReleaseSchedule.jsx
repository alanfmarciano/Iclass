import { useEffect, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Modal } from '../../components/ui/Modal'
import { api } from '../../lib/api'

// Liberação agendada de material (fase 3, P3-S12: D27). Em Materiais, a apostila e o
// gabarito ainda bloqueados ganham "Agendar": o professor escolhe dia e hora (no relógio
// da escola) e o servidor libera sozinho para a turma inteira. O gabarito de uma prova com
// aplicação aberta espera o encerramento ("Adiado"). A prova online não entra aqui: ela é
// agendada no "Quando" da aplicação, em Provas.

// Texto da linha do item com liberação agendada (ou null).
export function releaseScheduleText(entry) {
  if (!entry) return null
  if (entry.adiado) return 'Adiado: sai quando a prova for encerrada.'
  return `Libera sozinho em ${entry.atLabel || 'horário agendado'}.`
}

// Problema do formulário antes de mandar (o servidor confere de novo), ou null.
export function releaseScheduleProblem(value) {
  if (!value?.date) return 'Escolha o dia da liberação.'
  if (!value?.time) return 'Escolha a hora da liberação.'
  return null
}

function splitLocal(local) {
  const [date = '', time = ''] = String(local || '').split('T')
  return { date, time }
}

export function ReleaseScheduleDialog({ open, item, entry, studentClass, courseId, onClose, onSaved, toast }) {
  const [value, setValue] = useState({ date: '', time: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (open) { setValue(splitLocal(entry?.atLocal)); setError('') }
  }, [open, entry])
  const problem = releaseScheduleProblem(value)

  async function save() {
    if (problem) { setError(problem); return }
    setBusy(true)
    setError('')
    try {
      const response = await api.post('/api/admin/release-item', { studentClass, courseId, itemKey: item.key, releaseAtLocal: `${value.date}T${value.time}` })
      const label = response?.releaseSchedule?.[item.key]?.atLabel
      toast?.success(label ? `${item.type} agendado: libera em ${label}.` : 'Liberação agendada.')
      for (const aviso of response?.avisos || []) toast?.info(aviso.texto)
      onSaved?.(response?.releaseSchedule || {})
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={entry ? `Mudar a liberação: ${item?.type || ''}` : `Agendar a liberação: ${item?.type || ''}`}
      description="No relógio da escola. O item é liberado sozinho para a turma inteira."
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button icon={CalendarClock} loading={busy} onClick={save}>Salvar horário</Button>
      </>}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Dia" type="date" value={value.date} onChange={(e) => setValue((v) => ({ ...v, date: e.target.value }))} />
          <Input label="Hora" type="time" value={value.time} onChange={(e) => setValue((v) => ({ ...v, time: e.target.value }))} />
        </div>
        {item?.type === 'Gabarito' && <p className="text-xs text-muted">Se a prova ainda estiver aberta no horário, o gabarito espera e sai assim que ela for encerrada.</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}

// Cancelar a liberação agendada; devolve o releaseSchedule novo da turma.
export async function cancelReleaseSchedule({ studentClass, courseId, itemKey }) {
  const response = await api.post('/api/admin/release-item', { studentClass, courseId, itemKey, cancelSchedule: true })
  return response?.releaseSchedule || {}
}
