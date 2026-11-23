import { useMemo, useState } from 'react'
import { CalendarDays, CalendarOff, Download, Flag, Plus, Save, Trash2 } from 'lucide-react'
import { MonthCalendar, firstOfMonth, eventInMonth, parseDateKey } from '../../components/calendar/MonthCalendar'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageState } from '../../components/ui/PageState'
import { EmptyState } from '../../components/ui/EmptyState'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Textarea } from '../../components/ui/Textarea'
import { Select } from '../../components/ui/Select'
import { useApi } from '../../hooks/useApi'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'
import { useToast } from '../../context/ToastProvider'
import { api, downloadFile } from '../../lib/api'
import { useAuth } from '../../context/AuthProvider'
import { ADMIN_PERMISSIONS, canAccessAdminPermission, canWriteAdminPermission } from '../../lib/adminPermissions'
import { groupOptionLabel, useClassGroupOptions } from './useClassGroupOptions'
import { NonSchoolDayDialog, NationalHolidaysDialog } from './NonSchoolDayDialog'

// Calendário do painel: eventos do curso e da turma e, desde a fase 3 (B7 / P2-S6,
// FUN-15), os dias não letivos que valem para a turma (feriado, recesso, ponto
// facultativo, evento escolar), pintados no mês e listados em "Feriados e recessos deste
// mês". "Dia não letivo" cadastra um dia para a turma, o curso, a escola ou a instituição,
// conforme o que o servidor diz que a conta pode (escopos); "Feriados nacionais" adiciona
// os do ano de uma vez; "Baixar agenda (.ics)" leva tudo para o Google Agenda, o Outlook
// ou o celular. A Coordenação (só consulta) vê e baixa, sem criar nem alterar.
const TYPE_LABELS = { aula: 'Aula', prova: 'Prova', entrega: 'Entrega', aviso: 'Aviso', reuniao: 'Reunião', outro: 'Outro' }
const blank = (date = '', courseId = '', className = '') => ({ title: '', description: '', eventDate: date, startTime: '', endTime: '', eventType: 'aula', target: 'turma', targetValue: className, courseId })

export default function CalendarioPage() {
  const toast = useToast()
  const { courseId, courseName, className } = useAdminWorkspace()
  const auth = useAuth()?.auth
  // A Coordenação (só consulta) vê o calendário e abre cada evento para ler, sem criar,
  // alterar nem excluir (o servidor recusaria com 403; B4).
  const canEdit = canWriteAdminPermission(auth, ADMIN_PERMISSIONS.PAGE_FORUM)
  // Evento para um grupo da turma (P5-S5): os grupos ativos vêm de Alunos › Grupos.
  const { groups } = useClassGroupOptions({ courseId, studentClass: className, enabled: canEdit && canAccessAdminPermission(auth, ADMIN_PERMISSIONS.PAGE_STUDENTS) })
  const query = courseId ? `courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(className)}` : ''
  const eventsApi = useApi(courseId ? `/api/admin/announcements/calendar?${query}` : null)
  const daysApi = useApi(courseId ? `/api/admin/calendar/non-school-days?${query}` : null)
  const [month, setMonth] = useState(firstOfMonth())
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  // Dia não letivo que a conta não altera (da instituição, para o professor; qualquer um,
  // para a Coordenação): abre só para leitura.
  const [readOnlyDetail, setReadOnlyDetail] = useState(null)
  // { day: registro do servidor ou null, date: 'AAAA-MM-DD' } com o diálogo aberto.
  const [dayDialog, setDayDialog] = useState(null)
  const [holidaysOpen, setHolidaysOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const dias = daysApi.data?.dias || []
  const escopos = daysApi.data?.escopos || []
  const canCreateDay = canEdit && escopos.length > 0
  const canAddHolidays = canEdit && !!daysApi.data?.podeAdicionarFeriadosNacionais
  const context = { courseId, courseName: courseName || courseId, studentClass: className, schoolId: daysApi.data?.contexto?.schoolId || '', escolaNome: daysApi.data?.contexto?.escolaNome || '' }
  const monthDays = useMemo(() => dias
    .filter((day) => eventInMonth({ eventDate: day.inicio, endDate: day.fim }, month))
    .sort((a, b) => a.inicio.localeCompare(b.inicio, 'pt-BR')), [dias, month])

  const refetchAll = () => { eventsApi.refetch(); daysApi.refetch() }
  const openNew = (date = '') => setForm(blank(date || `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-01`, courseId, className))
  const openNonSchoolDay = (id, fallback) => {
    const day = dias.find((item) => item.id === id)
    if (day && day.podeAlterar && canEdit) return setDayDialog({ day, date: day.inicio })
    return setReadOnlyDetail(fallback || (day ? dayAsEvent(day) : null))
  }
  const openEdit = (event) => {
    if (event.kind === 'nonSchoolDay') return openNonSchoolDay(event.id, event)
    if (event.readOnly || !canEdit) return setReadOnlyDetail(event)
    setForm({ ...event, description: event.message || event.description || '' })
  }
  const set = (patch) => setForm((current) => ({ ...current, ...patch }))

  async function save() {
    if (!form.title.trim() || !form.eventDate) return toast.error('Informe título e data')
    if (form.target === 'turma' && !form.targetValue) return toast.error('Selecione a turma')
    if (form.target === 'grupo' && !form.targetValue) return toast.error('Escolha o grupo')
    setBusy(true)
    try {
      const payload = { ...form, courseId, targetValue: form.target === 'curso' ? courseId : form.targetValue, ...(form.target === 'grupo' ? { studentClass: form.studentClass || className } : {}) }
      if (form.id) await api.post('/api/admin/announcements/calendar/update', payload)
      else await api.post('/api/admin/announcements/calendar', payload)
      toast.success(form.id ? 'Evento atualizado' : 'Evento criado')
      setForm(null)
      eventsApi.refetch()
    } catch (error) { toast.error(error.message) } finally { setBusy(false) }
  }

  // Excluir pelo diálogo da tela (o erro aparece nele, que continua aberto).
  async function remove() {
    if (!form?.id) return
    setBusy(true)
    try {
      await api.post('/api/admin/announcements/calendar/delete', { id: form.id })
      toast.success('Evento removido')
      setConfirmRemove(false)
      setForm(null)
      eventsApi.refetch()
    } finally { setBusy(false) }
  }

  async function downloadIcs() {
    setDownloading(true)
    try {
      await downloadFile(`/api/admin/calendar/ics?${query}`, `agenda_${className || courseId}.ics`)
    } catch (error) { toast.error(error.message) } finally { setDownloading(false) }
  }

  if (!courseId) return <Card className="p-6"><EmptyState icon={CalendarDays} title="Escolha um curso" description="Entre em um curso para organizar o calendário." /></Card>

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader title="Calendário" helpTopic="calendario" subtitle={`Aulas, provas, entregas, avisos e dias sem aula · ${courseName || courseId} · ${className}`}>
        {canEdit && <Button icon={Plus} onClick={() => openNew()}>Novo evento</Button>}
        {canCreateDay && <Button variant="secondary" icon={CalendarOff} onClick={() => setDayDialog({ day: null, date: '' })}>Dia não letivo</Button>}
        {canAddHolidays && <Button variant="secondary" icon={Flag} onClick={() => setHolidaysOpen(true)}>{`Feriados nacionais de ${month.getFullYear()}`}</Button>}
        <Button variant="secondary" icon={Download} loading={downloading} onClick={downloadIcs}>Baixar agenda (.ics)</Button>
      </PageHeader>

      {monthDays.length > 0 && (
        <Card className="p-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-text"><CalendarOff size={16} className="text-warning" aria-hidden="true" />Feriados e recessos deste mês</h2>
          <ul aria-label="Feriados e recessos deste mês" className="divide-y divide-border">
            {monthDays.map((day) => (
              <li key={day.id}>
                <button type="button" onClick={() => openNonSchoolDay(day.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2.5 text-left transition hover:bg-surface-2">
                  <span className="min-w-[9rem] text-sm font-semibold text-text">{formatRange(day.inicio, day.fim)}</span>
                  <span className="min-w-0 flex-1 text-sm text-text">{day.nome}</span>
                  <span className="flex flex-wrap gap-1.5">
                    <Badge tone="warning">{day.tipoRotulo || 'Sem aula'}</Badge>
                    <Badge tone="neutral">{scopeLabel(day, context)}</Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <PageState loading={eventsApi.loading} error={eventsApi.error} onRetry={refetchAll}>
        <MonthCalendar month={month} onMonthChange={setMonth} events={eventsApi.data || []} onDayClick={canEdit ? openNew : undefined} onEventClick={openEdit} />
      </PageState>

      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? 'Editar evento' : 'Novo evento'}
        description="O aluno verá este compromisso no calendário do curso."
        footer={<>
          {form?.id && <Button variant="destructive" icon={Trash2} disabled={busy} onClick={() => setConfirmRemove(true)}>Excluir</Button>}
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
              {(groups.length > 0 || form.target === 'grupo') && <option value="grupo">Um grupo da turma</option>}
            </Select>
          </div>
          {form.target === 'grupo' && (
            <Select label="Grupo" value={form.targetValue} onChange={(event) => set({ targetValue: event.target.value })}>
              <option value="">Escolha o grupo…</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
              {form.targetValue && !groups.some((group) => group.id === form.targetValue) && (
                <option value={form.targetValue}>{form.grupo ? `${groupOptionLabel(form.grupo)}${form.grupo.arquivado ? ' (arquivado)' : ''}` : 'Grupo atual'}</option>
              )}
            </Select>
          )}
          {form.target === 'turma' && <div><p className="mb-1 text-sm font-medium text-text">Turma</p><div className="h-[38px] rounded-md border border-border bg-surface-2 px-3 py-2 text-sm font-semibold text-text">{className}</div></div>}
          <Textarea id="cal-description" label="Descrição ou instruções" value={form.description} onChange={(event) => set({ description: event.target.value })} placeholder="Informações que o aluno precisa saber..." className="min-h-24" />
          {!form.id && canCreateDay && <p className="text-xs text-muted">Feriado, recesso ou outro dia sem aula? Use <strong>Dia não letivo</strong>: assim a chamada não é cobrada nesse dia.</p>}
        </div>}
      </Modal>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={remove}
        title="Excluir este evento?"
        message="O evento sai do calendário do curso e do calendário dos alunos."
        confirmLabel="Excluir"
        tone="danger"
      />

      <NonSchoolDayDialog
        open={!!dayDialog}
        onClose={() => setDayDialog(null)}
        onSaved={refetchAll}
        day={dayDialog?.day || null}
        initialDate={dayDialog?.date || ''}
        context={context}
        escopos={escopos}
        tipos={daysApi.data?.tipos || []}
        toast={toast}
      />

      <NationalHolidaysDialog
        open={holidaysOpen}
        onClose={() => setHolidaysOpen(false)}
        onSaved={refetchAll}
        initialYear={month.getFullYear()}
        toast={toast}
      />

      <Modal
        open={!!readOnlyDetail}
        onClose={() => setReadOnlyDetail(null)}
        title={readOnlyDetail?.title || (readOnlyDetail?.kind === 'nonSchoolDay' ? 'Dia não letivo' : 'Evento')}
        description={readOnlyDetail ? eventWhen(readOnlyDetail) : ''}
        footer={<Button variant="ghost" onClick={() => setReadOnlyDetail(null)}>Fechar</Button>}
      >
        {readOnlyDetail && (readOnlyDetail.kind === 'nonSchoolDay' || readOnlyDetail.readOnly
          ? <div className="space-y-2 text-sm text-text">
              <p>{readOnlyDetail.message || 'Não há aula neste dia.'} A chamada não é cobrada e a presença automática do acesso não conta na frequência.</p>
              {readOnlyDetail.kind === 'nonSchoolDay' && canEdit && <p className="text-xs text-muted">{readOnlyDetail.escopo === 'instituicao' ? 'Este dia vale para toda a instituição: só o administrador ou quem gerencia as turmas altera.' : 'Sua conta não altera este dia: peça a quem o cadastrou.'}</p>}
            </div>
          : <div className="space-y-2 text-sm text-text">
              <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{TYPE_LABELS[readOnlyDetail.eventType] || 'Evento'}{readOnlyDetail.target === 'curso' ? ' · todas as turmas do curso' : readOnlyDetail.target === 'grupo' && readOnlyDetail.grupo ? ` · grupo ${groupOptionLabel(readOnlyDetail.grupo)}` : ''}</p>
              <p className="whitespace-pre-wrap">{readOnlyDetail.message || readOnlyDetail.description || 'Sem descrição.'}</p>
            </div>)}
      </Modal>
    </div>
  )
}

// O dia da lista do servidor no formato de evento do calendário (para ler).
function dayAsEvent(day) {
  return { kind: 'nonSchoolDay', id: day.id, title: day.nome, eventDate: day.inicio, endDate: day.fim, escopo: day.escopo, message: `${day.tipoRotulo || 'Dia sem aula'}: não há aula.`, readOnly: true }
}

function scopeLabel(day, context) {
  if (day.escopo === 'turma') return `Turma ${day.studentClass || context.studentClass}`
  if (day.escopo === 'curso') return 'Todo o curso'
  if (day.escopo === 'escola') return 'Toda a escola'
  return 'Toda a instituição'
}

// Data e horário do evento para ler: '15/11/2027 · 08:00 às 09:40'.
function eventWhen(event) {
  const range = formatRange(event.eventDate, event.endDate)
  if (!event.startTime) return range
  return `${range} · ${event.startTime}${event.endTime ? ` às ${event.endTime}` : ''}`
}

// '2027-11-15' → '15/11/2027'; com fim diferente, 'de 13/07/2027 a 24/07/2027'.
function formatRange(start, end) {
  const br = (value) => { const date = parseDateKey(value); return date ? date.toLocaleDateString('pt-BR') : '' }
  if (!end || end === start) return br(start)
  return `de ${br(start)} a ${br(end)}`
}
