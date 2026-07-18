import { ArrowRight, ShieldCheck } from 'lucide-react'
import { Badge } from '../../../components/ui/Badge'
import { EmptyLine } from '../../../components/ui/EmptyLine'
import { ReasonChips } from './ReasonChips'

const initials = (n) => (n || '?').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase()
const RISK_TONE = { alto: 'danger', medio: 'warning', baixo: 'neutral' }

// Monta os motivos em texto a partir do overview — a falta vira motivo dentro
// da lista única, não uma segunda lista. "Sem dado" nunca aparece como 0.
export function riskReasons(o, limiar = 75) {
  const reasons = []
  if (o.frequencia != null && o.frequencia < limiar) {
    reasons.push({ text: `${o.presentes} ${o.presentes === 1 ? 'presença' : 'presenças'} em ${o.totalAulas} aulas · ${o.frequencia}%`, tone: 'danger' })
  } else if (o.faltas > 0) {
    reasons.push({ text: `${o.faltas} ${o.faltas === 1 ? 'falta' : 'faltas'} · frequência ${o.frequencia == null ? 'sem dado' : `${o.frequencia}%`}`, tone: 'neutral' })
  }
  if (o.media == null) reasons.push({ text: 'nenhuma prova entregue', tone: 'neutral' })
  else if (o.media < 6) reasons.push({ text: `média ${String(o.media).replace('.', ',')} — abaixo de 6,0`, tone: 'warning' })
  if (o.disciplinasEmRisco > 0) {
    reasons.push({ text: `${o.disciplinasEmRisco} ${o.disciplinasEmRisco === 1 ? 'disciplina' : 'disciplinas'} abaixo do limiar`, tone: 'warning' })
  }
  return reasons
}

// Lista única "Alunos que precisam de atenção", com motivos reais — o backend
// sempre devolveu risco + dados; a tela antiga mostrava "alto" sem dizer por quê.
export function RiskList({ students = [], semDado = 0, limiar = 75, onOpen }) {
  if (!students.length) {
    return (
      <div className="premium-card rounded-2xl">
        <EmptyLine icon={ShieldCheck} title="Nenhum aluno em risco" description="Frequência, notas e acesso dentro do esperado." />
      </div>
    )
  }
  return (
    <div className="premium-card flex flex-col rounded-2xl p-0">
      {students.map((o) => (
        <button key={o.email} onClick={() => onOpen(o.email)}
          className="flex items-start gap-3.5 border-b border-border px-5 py-3.5 text-left transition-colors last:border-0 hover:bg-surface-2">
          <span className="mt-0.5 grid h-9 w-9 flex-none place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary">{initials(o.name)}</span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-text">{o.name}</span>
              <Badge tone={RISK_TONE[o.riscoLevel]}>{o.riscoLevel}</Badge>
            </span>
            <ReasonChips reasons={riskReasons(o, limiar)} />
          </span>
          <ArrowRight size={14} className="mt-2 flex-none text-subtle" aria-hidden="true" />
        </button>
      ))}
      {semDado > 0 && (
        <EmptyLine className="border-t border-border"
          title={`${semDado} ${semDado === 1 ? 'aluno não pôde ser avaliado' : 'alunos não puderam ser avaliados'}`}
          description="sem chamada lançada — não entram como 0%, entram como sem dado" />
      )}
    </div>
  )
}
