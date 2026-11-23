import { CalendarClock } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'

// Provas agendadas da turma que ainda não abriram (fase 3, P3-S12: D25). Vêm de
// /api/student/exam-applications em "agendadas", separadas de "applications" para que a
// lista de provas disponíveis continue igual. O cartão só informa: a prova abre sozinha no
// horário e aí aparece em "applications", com o botão de começar.
export function ScheduledExams({ items }) {
  const list = Array.isArray(items) ? items.filter((item) => item && item.id) : []
  if (!list.length) return null
  return (
    <div className="space-y-3" data-testid="scheduled-exams">
      {list.map((item) => (
        <Card key={item.id} className="p-5" data-testid={`scheduled-exam-${item.id}`}>
          <div className="flex flex-wrap items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary" aria-hidden>
              <CalendarClock size={18} />
            </span>
            <div className="min-w-[12rem] flex-1">
              <p className="font-semibold text-text">{item.examTitle || item.examKey}</p>
              <p className="mt-0.5 text-sm text-muted">A prova {item.janela || `abre em ${item.abreEmLabel}`}.</p>
              <p className="mt-1 text-xs text-subtle">
                Ela abre sozinha no horário: volte aqui para começar.
                {item.timerEnabled && Number(item.durationMinutes) > 0 ? ` Duração: ${item.durationMinutes} min.` : ''}
                {item.tokenEnabled ? ' Vai pedir o token que o professor passar.' : ''}
              </p>
            </div>
            <Badge tone="info">Agendada</Badge>
          </div>
        </Card>
      ))}
    </div>
  )
}
