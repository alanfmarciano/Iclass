import { useEffect, useState } from 'react'
import { CalendarClock, AlertTriangle, X } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Modal } from '../../components/ui/Modal'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { api } from '../../lib/api'

// "Quando" da aplicação da prova (fase 3, P3-S12: AVA-20; D25 e D26 do desenho do P3).
// Agora: a aplicação fica preparada e o professor inicia pelo Monitor, como sempre.
// Agendar: data, hora de abrir e hora de fechar (no relógio da escola; o servidor faz a
// conta de fuso). A prova abre sozinha no horário e fecha sozinha entregando o que cada
// aluno salvou. Dia não letivo e janela menor que a duração só avisam (GET
// .../schedule-check); quem confere de verdade é o servidor.
//
// Também aqui: o aviso do Monitor ("Abre sozinha às 08:00", "Fecha sozinha às 09:30", a
// prova que não abriu porque o computador estava desligado) e o diálogo de mudar o horário.

export function initialSchedule() {
  return { mode: 'agora', date: '', opensAt: '', closesAt: '' }
}

// Estado do formulário a partir do agendamento que a aplicação já tem (agendaView).
export function scheduleFromView(view) {
  if (!view?.abreEmLocal) return { ...initialSchedule(), mode: 'agendar' }
  const [date, opensAt] = view.abreEmLocal.split('T')
  const [closeDate, closesAt] = String(view.fechaEmLocal || '').split('T')
  return { mode: 'agendar', date, opensAt, closesAt, closeDate: closeDate !== date ? closeDate : '' }
}

function closeLocal(schedule) {
  return `${schedule.closeDate || schedule.date}T${schedule.closesAt}`
}

// Problema do "Quando" antes de mandar (o servidor confere de novo), ou null.
export function scheduleProblem(schedule) {
  if (!schedule || schedule.mode !== 'agendar') return null
  if (!schedule.date) return 'Escolha o dia da prova agendada.'
  if (!schedule.opensAt) return 'Escolha a hora de abrir a prova.'
  if (!schedule.closesAt) return 'Escolha a hora de fechar a prova.'
  if (!schedule.closeDate && schedule.closesAt <= schedule.opensAt) return 'O horário de fechar precisa ser depois do de abrir.'
  return null
}

// O pedido do "Quando": { agenda: { abreEmLocal, fechaEmLocal } } ou nada (agora).
export function schedulePayload(schedule) {
  if (!schedule || schedule.mode !== 'agendar') return {}
  return { agenda: { abreEmLocal: `${schedule.date}T${schedule.opensAt}`, fechaEmLocal: closeLocal(schedule) } }
}

// Avisos do servidor para o horário escolhido (dia sem aula, janela menor que a prova).
function useScheduleCheck({ schedule, studentClass, courseId, durationMinutes, timerEnabled }) {
  const [state, setState] = useState({ avisos: [], janela: '' })
  const ready = schedule?.mode === 'agendar' && !scheduleProblem(schedule) && studentClass
  const query = ready
    ? new URLSearchParams({
      studentClass: studentClass || '',
      courseId: courseId || '',
      abreEmLocal: `${schedule.date}T${schedule.opensAt}`,
      fechaEmLocal: closeLocal(schedule),
      durationMinutes: String(Number(durationMinutes) || ''),
      timerEnabled: timerEnabled === false ? 'false' : 'true',
    }).toString()
    : ''
  useEffect(() => {
    if (!query) { setState({ avisos: [], janela: '' }); return undefined }
    let alive = true
    const timer = setTimeout(() => {
      api.get(`/api/admin/exam-applications/schedule-check?${query}`)
        .then((data) => { if (alive) setState({ avisos: data?.avisos || [], janela: data?.janela || '' }) })
        .catch(() => { if (alive) setState({ avisos: [], janela: '' }) })
    }, 300)
    return () => { alive = false; clearTimeout(timer) }
  }, [query])
  return state
}

function ScheduleWarnings({ avisos }) {
  if (!avisos?.length) return null
  return (
    <ul className="space-y-1" data-testid="schedule-warnings">
      {avisos.map((aviso) => (
        <li key={aviso.code} role="status" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft p-2 text-xs text-text">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
          <span>{aviso.texto}</span>
        </li>
      ))}
    </ul>
  )
}

// Campos de data e hora (usados no formulário de preparar e no diálogo de mudar).
function ScheduleTimeFields({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch })
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Input label="Dia" type="date" value={value.date} onChange={(e) => set({ date: e.target.value })} />
      <Input label="Abre às" type="time" value={value.opensAt} onChange={(e) => set({ opensAt: e.target.value })} />
      <Input
        label="Fecha às"
        type="time"
        value={value.closesAt}
        helper={value.closeDate ? `no dia ${value.closeDate.split('-').reverse().join('/')}` : undefined}
        onChange={(e) => set({ closesAt: e.target.value })}
      />
    </div>
  )
}

// "Quando" na preparação. value/onChange: o estado de initialSchedule.
export function ApplicationScheduleFields({ value, onChange, studentClass, courseId, durationMinutes, timerEnabled }) {
  const schedule = value || initialSchedule()
  const check = useScheduleCheck({ schedule, studentClass, courseId, durationMinutes, timerEnabled })
  const problem = schedule.mode === 'agendar' ? scheduleProblem(schedule) : null
  const choose = (mode) => onChange({ ...schedule, mode })
  return (
    <div className="space-y-3" data-testid="application-schedule">
      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium text-muted">Quando</legend>
        <div role="radiogroup" aria-label="Quando" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[
            { mode: 'agora', label: 'Eu abro pelo Monitor' },
            { mode: 'agendar', label: 'Agendar dia e horário' },
          ].map((option) => (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={schedule.mode === option.mode}
              onClick={() => choose(option.mode)}
              className={`min-h-[44px] rounded-lg border px-3 py-2 text-left text-sm font-semibold transition ${schedule.mode === option.mode ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-text hover:bg-surface-2'}`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-subtle">
          {schedule.mode === 'agendar'
            ? 'A prova abre sozinha no horário e fecha sozinha, entregando o que cada aluno salvou. O computador precisa estar ligado: se estiver desligado na hora de abrir, ela abre quando ele ligar (dentro do horário) ou não abre, e você é avisado.'
            : 'A aplicação fica preparada, sem aparecer para os alunos, até você iniciar pelo Monitor.'}
        </p>
      </fieldset>
      {schedule.mode === 'agendar' && (
        <div className="space-y-2">
          <ScheduleTimeFields value={schedule} onChange={onChange} />
          {problem && <p className="text-xs text-muted">{problem}</p>}
          {!problem && check.janela && <p className="text-xs text-text" data-testid="schedule-summary">A prova {check.janela}.</p>}
          <ScheduleWarnings avisos={check.avisos} />
        </div>
      )}
    </div>
  )
}

// Diálogo "Mudar horário" do Monitor (aplicação preparada, agendada ou perdida).
export function ScheduleDialog({ open, application, onClose, onSaved, toast }) {
  const [schedule, setSchedule] = useState(() => scheduleFromView(application?.agendaView))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (open) {
      const view = application?.agendaView
      const base = scheduleFromView(view)
      // A perdida volta com os mesmos horários e sem o dia, que já passou: o professor escolhe.
      setSchedule(view && view.estado === 'perdida' ? { ...base, date: '', closeDate: '' } : base)
      setError('')
    }
  }, [open, application])
  const check = useScheduleCheck({ schedule, studentClass: application?.studentClass, courseId: application?.courseId, durationMinutes: application?.durationMinutes, timerEnabled: application?.timerEnabled })
  const problem = scheduleProblem(schedule)

  async function save() {
    if (problem) { setError(problem); return }
    setBusy(true)
    setError('')
    try {
      const response = await api.post(`/api/admin/exam-applications/${encodeURIComponent(application.id)}/schedule`, schedulePayload(schedule).agenda)
      toast?.success(response?.unchanged ? 'O horário continua o mesmo.' : `Prova agendada: ${response?.application?.agendaView?.janela || 'horário salvo'}.`)
      onSaved?.(response?.application)
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
      title={application?.agendaView ? 'Mudar o horário da prova' : 'Agendar a prova'}
      description="No relógio da escola. A prova abre e fecha sozinha."
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button icon={CalendarClock} loading={busy} onClick={save}>Salvar horário</Button>
      </>}
    >
      <div className="space-y-3">
        <ScheduleTimeFields value={schedule} onChange={setSchedule} />
        {!problem && check.janela && <p className="text-xs text-text">A prova {check.janela}.</p>}
        <ScheduleWarnings avisos={check.avisos} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}

function lateText(view) {
  const minutes = Math.round((Number(view.atrasoSegundos) || 0) / 60)
  return `Abriu às ${String(view.abertaEmLabel || '').replace(/^.* às /, '')}, ${minutes} min depois do horário: o computador estava desligado ou suspenso.`
}

// Aviso do agendamento no Monitor. application: a da lista do Monitor (com agendaView).
// onChanged: recarregar depois de mudar. A abertura na hora ("Abrir agora") é o botão de
// iniciar que o Monitor já tem.
export function ApplicationScheduleBanner({ application, onChanged, toast }) {
  const [dialog, setDialog] = useState(false)
  const [confirm, setConfirm] = useState(null) // 'cancelar' | 'fechamento'
  const view = application?.agendaView
  if (!view) return null
  const estado = view.estado

  async function cancel() {
    const response = await api.post(`/api/admin/exam-applications/${encodeURIComponent(application.id)}/schedule`, { cancelar: true })
    toast?.success(confirm === 'fechamento' ? 'A prova não encerra mais sozinha. Encerre pelo Monitor.' : 'Agendamento cancelado. A aplicação continua preparada.')
    setConfirm(null)
    onChanged?.(response?.application)
  }

  let tone = 'info'
  let title = ''
  let detail = ''
  const actions = []
  if (estado === 'agendada') {
    title = `Abre sozinha em ${view.abreEmLabel}`
    detail = `E fecha sozinha ${view.janela.replace(/^abre em .* e fecha /, '')}, entregando o que cada aluno salvou. Para começar antes, use “Iniciar prova e avisar alunos”.`
    actions.push(<Button key="mudar" size="sm" variant="secondary" icon={CalendarClock} onClick={() => setDialog(true)}>Mudar horário</Button>)
    actions.push(<Button key="cancelar" size="sm" variant="ghost" icon={X} onClick={() => setConfirm('cancelar')}>Cancelar agendamento</Button>)
  } else if (estado === 'perdida') {
    tone = 'danger'
    title = 'A prova agendada não abriu'
    detail = `O computador estava desligado entre ${view.abreEmLabel} e ${view.fechaEmLabel}. A prova não abre mais sozinha: agende de novo ou inicie agora.`
    actions.push(<Button key="mudar" size="sm" variant="secondary" icon={CalendarClock} onClick={() => setDialog(true)}>Agendar de novo</Button>)
  } else if (estado === 'aberta') {
    tone = view.abertaAtrasada ? 'warning' : 'info'
    title = `Fecha sozinha em ${view.fechaEfetivaLabel || view.fechaEmLabel}`
    detail = `${view.abertaAtrasada ? `${lateText(view)} ` : ''}No fechamento, quem ainda estiver fazendo a prova tem a prova entregue com o que salvou.${view.fechaEfetivaEm && view.fechaEfetivaEm !== view.fechaEm ? ' O horário foi empurrado pelo tempo de pausa ou pelos minutos dados à turma.' : ''}`
    actions.push(<Button key="fechamento" size="sm" variant="ghost" icon={X} onClick={() => setConfirm('fechamento')}>Não encerrar sozinha</Button>)
  } else if (estado === 'fechamento_cancelado' || estado === 'sem_fechamento') {
    tone = 'neutral'
    title = 'Sem fechamento automático'
    detail = view.abertaAtrasada ? lateText(view) : 'Encerre pelo Monitor quando a turma terminar.'
  } else {
    return null
  }

  const toneClass = {
    info: 'border-info/40 bg-info-soft/40',
    warning: 'border-warning/40 bg-warning-soft',
    danger: 'border-danger/40 bg-danger-soft/40',
    neutral: 'border-border bg-surface-2',
  }[tone]

  return (
    <div className={`flex flex-wrap items-start gap-3 rounded-xl border p-3 ${toneClass}`} data-testid="schedule-banner" data-estado={estado}>
      <CalendarClock size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-[12rem] flex-1">
        <p className="text-sm font-semibold text-text">{title}</p>
        <p className="mt-0.5 text-xs text-muted">{detail}</p>
      </div>
      {actions.length > 0 && <div className="flex flex-wrap gap-2">{actions}</div>}
      <ScheduleDialog open={dialog} application={application} onClose={() => setDialog(false)} onSaved={onChanged} toast={toast} />
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={cancel}
        tone="primary"
        title={confirm === 'fechamento' ? 'Não encerrar a prova sozinha?' : 'Cancelar o agendamento?'}
        message={confirm === 'fechamento'
          ? 'A prova continua aberta depois do horário de fechar, até você encerrar pelo Monitor.'
          : 'A prova não abre mais sozinha. A aplicação continua preparada: inicie pelo Monitor quando quiser.'}
        confirmLabel={confirm === 'fechamento' ? 'Não encerrar sozinha' : 'Cancelar agendamento'}
        cancelLabel="Voltar"
      />
    </div>
  )
}
