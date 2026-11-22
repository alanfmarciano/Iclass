import { Badge } from '../../components/ui/Badge'
import { fmtGrade, gradeOf, gradeTone } from '../../lib/grades'

// Nota de uma tentativa na ficha do aluno (GET /api/admin/student/academic). Fase 3
// (P3-S4a): a prova que aguarda a correção do professor não mostra a nota parcial das
// objetivas; a anulada por integridade diz a decisão ('zero' conta com 0; 'desconsiderar'
// não conta). Sem isso, as duas apareciam com a nota gravada ou como "nota inválida".
export function academicGradeText(submission) {
  if (submission?.awaitingCorrection) return 'aguardando correção'
  if (submission?.integrity === 'desconsiderar') return 'anulada, não conta'
  if (submission?.integrity === 'zero') return `nota ${fmtGrade(submission.score)} (anulada)`
  return `nota ${fmtGrade(submission?.score)}`
}

// A mesma leitura para a lista de Resultados (GET /api/admin/submissions, já com
// enrichSubmissionsWithAttemptResult): a nota gravada fica, e a decisão vem em
// integrityDecision.
export function historyGrade(submission) {
  const s = submission || {}
  return {
    ...s,
    integrity: s.integrityDecision || null,
    awaitingCorrection: s.awaitingCorrection === true,
    score: s.integrityDecision === 'zero' ? 0 : s.score,
  }
}

// criterio: o da ficha (GET /api/admin/student/dashboard); a lista sem critério passa o
// padrão de antes (média mínima 6,0).
export function AcademicGradeBadge({ submission, criterio }) {
  const s = submission || {}
  if (s.awaitingCorrection) return <Badge tone="warning" className="shrink-0 whitespace-nowrap">aguardando correção</Badge>
  if (s.integrity === 'desconsiderar') return <Badge tone="neutral" className="shrink-0 whitespace-nowrap">anulada · não conta</Badge>
  if (gradeOf(s.score) === null) return <Badge tone="neutral">nota inválida</Badge>
  if (s.integrity === 'zero') return <Badge tone="danger" className="shrink-0 whitespace-nowrap">{fmtGrade(s.score)} · anulada</Badge>
  return <Badge tone={gradeTone(gradeOf(s.score), criterio, 'simples', 'warning')}>{fmtGrade(s.score)}</Badge>
}
