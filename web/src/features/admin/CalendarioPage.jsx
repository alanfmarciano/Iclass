import { useState } from 'react'
import { CalendarDays, Plus, Save, Trash2 } from 'lucide-react'
import { MonthCalendar, firstOfMonth } from '../../components/calendar/MonthCalendar'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageState } from '../../components/ui/PageState'
import { EmptyState } from '../../components/ui/EmptyState'
import { Card } from '../../components/ui/Card'
import { Modal } from '../../components/ui/Modal'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Textarea } from '../../components/ui/Textarea'
import { Select } from '../../components/ui/Select'
import { useApi } from '../../hooks/useApi'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'
import { useToast } from '../../context/ToastProvider'
import { api } from '../../lib/api'

const TYPE_LABELS = { aula: 'Aula', prova: 'Prova', entrega: 'Entrega', aviso: 'Aviso', reuniao: 'Reunião', outro: 'Outro' }
const blank = (date = '', courseId = '', className = '') => ({ title: '', description: '', eventDate: date, startTime: '', endTime: '', eventType: 'aula', target: 'turma', targetValue: className, courseId })

export default function CalendarioPage() {
  const toast = useToast()
  const { courseId, courseName, className } = useAdminWorkspace()
  const eventsApi = useApi(courseId ? `/api/admin/announcements/calendar?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(className)}` : null)
  const [month, setMonth] = useState(firstOfMonth())
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)

  const openNew = (date = '') => setForm(blank(date || `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-01`, courseId, className))
  const openEdit = (event) => setForm({ ...event, description: event.message || event.description || '' })
  const set = (patch) => setForm((current) => ({ ...current, ...patch }))

  async function save() {
    if (!form.title.trim() || !form.eventDate) return toast.error('Informe título e data')
    if (form.target === 'turma' && !form.targetValue) return toast.error('Selecione a turma')
    setBusy(true)
    try {
      const payload = { ...form, courseId, targetValue: form.target === 'curso' ? courseId : form.targetValue }
      if (form.id) await api.post('/api/admin/announcements/calendar/update', payload)
      else await api.post('/api/admin/announcements/calendar', payload)
      toast.success(form.id ? 'Evento atualizado' : 'Evento criado')
      setForm(null)
      eventsApi.refetch()
    } catch (error) { toast.error(error.message) } finally { setBusy(false) }
  }

  async function remove() {
    if (!form?.id || !window.confirm('Excluir este evento?')) return
    setBusy(true)
    try {
      await api.post('/api/admin/announcements/calendar/delete', { id: form.id })
      toast.success('Evento removido')
      setForm(null)
      eventsApi.refetch()
    } catch (error) { toast.error(error.message) } finally { setBusy(false) }
  }

  if (!courseId) return <Card className="p-6"><EmptyState icon={CalendarDays} title="Escolha um curso" description="Entre em um curso para organizar o calendário." /></Card>

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader title="Calendário" subtitle={`Aulas, provas, entregas e avisos · ${courseName || courseId} · ${className}`}>
        <Button icon={Plus} onClick={() => openNew()}>Novo evento</Button>
      </PageHeader>
      <PageState loading={eventsApi.loading} error={eventsApi.error} onRetry={eventsApi.refetch}>
        <MonthCalendar month={month} onMonthChange={setMonth} events={eventsApi.data || []} onDayClick={openNew} onEventClick={openEdit} />
      </PageState>

      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? 'Editar evento' : 'Novo evento'}
        description="O aluno verá este compromisso no calendário do curso."
        footer={<>
          {form?.id && <Button variant="destructive" icon={Trash2} disabled={busy} onClick={remove}>Excluir</Button>}
          <Button variant="ghost" disabled={busy} onClick={() => setForm(null)}>Cancelar</Button>
          <Button icon={Save} loading={busy} onClick={save}>Salvar</Button>
        </>}
      >
        {form && <div className="space-y-3">
          <Input id="cal-title" label="Título" value={form.title} onChange={(event) => set({ title: event.target.value })} placeholder="Ex.: Avaliação de FECOP" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5"><label htmlFor="cal-date" className="text-sm font-medium text-text">Data</label><input id="cal-date" type="date" value={form.eventDate} onChange={(event) => set({ eventDate: event.target.value })} className="h-[38px] rounded-md border border-border bg-surface px-3 text-sm text-text" /></div>
            <div className="flex flex-col gap-1.5"><label htmlFor="cal-start" className="text-sm font-medium text-text">Início</label><input id="cal-start" type="time" value={form.startTime} onChange={(event) => set({ startTime: event.target.value })} className="h-[38px] rounded-md border border-border bg-surface px-3 text-sm text-text" /></div>
            <div className="flex flex-col gap-1.5"><label htmlFor="cal-end" className="text-sm font-medium text-text">Fim</label><input id="cal-end" type="time" value={form.endTime} onChange={(event) => set({ endTime: event.target.value })} className="h-[38px] rounded-md border border-border bg-surface px-3 text-sm text-text" /></div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select label="Tipo" value={form.eventType} onChange={(event) => set({ eventType: event.target.value })}>
              {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
            <Select label="Destino" value={form.target} onChange={(event) => set({ target: event.target.value, targetValue: event.target.value === 'turma' ? className : '' })}>
              <option value="turma">Somente esta turma</option>
              <option value="curso">Todas as turmas do curso</option>
            </Select>
          </div>
          {form.target === 'turma' && <div><p className="mb-1 text-sm font-medium text-text">Turma</p><div className="h-[38px] rounded-md border border-border bg-surface-2 px-3 py-2 text-sm font-semibold text-text">{className}</div></div>}
          <Textarea id="cal-description" label="Descrição ou instruções" value={form.description} onChange={(event) => set({ description: event.target.value })} placeholder="Informações que o aluno precisa saber..." className="min-h-24" />
        </div>}
      </Modal>
    </div>
  )
}
