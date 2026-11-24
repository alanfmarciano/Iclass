import { MessageSquareText, Send } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Textarea } from '../../components/ui/Textarea'

// Pedidos de revisão da nota na tela Corrigir (fase 3, P3-S5 / A19: AVA-07; D13 do
// desenho do P3). Dois pedaços:
// - ReviewQueueList: os pedidos abertos da turma (GET /api/admin/corrections,
//   pedidosRevisao), do mais antigo para o mais novo; tocar abre a entrega.
// - ReviewRequestsBox: os pedidos da entrega aberta (GET .../correction, pedidosRevisao),
//   com o texto do aluno e, no aberto, a resposta para ele. A mudança de nota, quando há,
//   vem antes: ajuste os pontos abaixo e salve; o servidor marca "a nota mudou" pelo
//   histórico da nota.
// A questão aparece pela posição na prova do aluno (a mesma "Questão N" dos cartões de
// correção); o pedido guarda o número da questão.

export const REVIEW_ANSWER_MAX = 2000

const fmtWhen = (value) => {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''
}

export function reviewQuestionLabel(questionNumber, questoes) {
  if (questionNumber === null || questionNumber === undefined || questionNumber === '') return 'A prova toda'
  const row = (Array.isArray(questoes) ? questoes : []).find((question) => Number(question.questionNumber) === Number(questionNumber))
  return `Questão ${row?.position ?? questionNumber}`
}

export function ReviewQueueList({ rows, selectedId, anonymous, onSelect }) {
  if (!Array.isArray(rows) || !rows.length) return null
  return (
    <section aria-label="Pedidos de revisão" className="rounded-xl border border-warning/40 bg-warning-soft/40 p-3">
      <h2 className="mb-2 inline-flex items-center gap-2 text-sm font-semibold text-text">
        <MessageSquareText size={16} className="text-warning" aria-hidden />
        {rows.length === 1 ? '1 pedido de revisão de nota' : `${rows.length} pedidos de revisão de nota`}
      </h2>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {rows.map((row) => {
          const active = String(row.submissionId) === String(selectedId)
          return (
            <li key={row.requestId}>
              <button
                type="button"
                onClick={() => onSelect(row.submissionId)}
                aria-current={active ? 'true' : undefined}
                className={`min-h-11 w-full rounded-lg border px-3 py-2 text-left text-sm ${active ? 'border-primary bg-primary-soft font-semibold text-primary' : 'border-border bg-surface text-text hover:bg-surface-2'}`}
              >
                <span className="block truncate">{anonymous ? 'Aluno (pedido de revisão)' : (row.aluno?.name || row.aluno?.email || 'Aluno')}</span>
                <span className="block truncate text-xs font-normal text-muted">{row.prova} · {row.questionNumber ? `questão nº ${row.questionNumber}` : 'a prova toda'} · {fmtWhen(row.criadoEm)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function ReviewRequestsBox({ requests, questoes, readOnly, replies, errors, sending, onReplyChange, onAnswer }) {
  const list = Array.isArray(requests) ? requests : []
  if (!list.length) return null
  const ordered = [...list].reverse()
  return (
    <section aria-label="Pedidos de revisão do aluno" className="space-y-3 rounded-xl border border-warning/40 bg-surface p-4">
      <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-text"><MessageSquareText size={16} className="text-warning" aria-hidden /> Pedidos de revisão do aluno</h3>
      <ol className="space-y-3">
        {ordered.map((request) => {
          const open = request.situacao !== 'respondido'
          return (
            <li key={request.id} className="rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-muted">{reviewQuestionLabel(request.questionNumber, questoes)} · pedido em {fmtWhen(request.criadoEm)}</span>
                <Badge tone={open ? 'warning' : (request.notaMudou ? 'success' : 'neutral')}>{open ? 'Aguardando resposta' : (request.notaMudou ? 'Respondido · a nota mudou' : 'Respondido · nota mantida')}</Badge>
              </div>
              {request.texto
                ? <p className="mt-1.5 whitespace-pre-wrap break-words text-text">{request.texto}</p>
                : <p className="mt-1.5 text-muted">{request.studentAnonymized ? 'Texto removido na anonimização do aluno.' : 'Sem texto.'}</p>}
              {!open && (
                <div className="mt-2 rounded-md border border-info/30 bg-info-soft px-3 py-2">
                  <p className="text-xs font-semibold text-muted">Resposta{request.respondidoPor ? ` de ${request.respondidoPor}` : ''}{request.respondidoEm ? ` · ${fmtWhen(request.respondidoEm)}` : ''}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-text">{request.resposta}</p>
                </div>
              )}
              {open && !readOnly && (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-muted">Se a nota precisar mudar, ajuste os pontos nas questões abaixo e salve antes de responder: o aluno vê se a nota mudou.</p>
                  <Textarea
                    label="Resposta para o aluno"
                    value={replies?.[request.id] || ''}
                    maxLength={REVIEW_ANSWER_MAX}
                    counterFrom={REVIEW_ANSWER_MAX - 300}
                    onChange={(event) => onReplyChange(request.id, event.target.value)}
                    error={errors?.[request.id]}
                    className="min-h-[88px]"
                  />
                  <div className="flex justify-end">
                    <Button icon={Send} className="h-11" loading={sending === request.id} disabled={!!sending || !String(replies?.[request.id] || '').trim()} onClick={() => onAnswer(request)}>Responder ao aluno</Button>
                  </div>
                </div>
              )}
              {open && readOnly && <p className="mt-2 text-xs text-muted">Quem responde é o professor da turma.</p>}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
