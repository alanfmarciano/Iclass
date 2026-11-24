import { useState } from 'react'
import { MessageSquareText } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { Textarea } from '../../components/ui/Textarea'
import { api } from '../../lib/api'

// Pedido de revisão da nota (fase 3, P3-S5 / A19: AVA-07; D13 do desenho do P3). Fica no
// resultado da prova (tela Provas do aluno). O servidor diz se o aluno pode pedir agora
// (submission.revisao = { podePedir, motivo, mensagem, prazoAte }) e manda os pedidos
// dele (submission.pedidosRevisao, sem quem respondeu). Regras do servidor: nota
// publicada, até 7 dias depois da publicação, um pedido aberto por vez; a questão é
// opcional (o número é o da revisão da prova, "Questão N").
//
// No celular de 375 px: uma coluna, campos de 44 px, sem caixa dentro de caixa (o
// formulário abre no próprio resultado, não em outra janela por cima).

export const REVIEW_TEXT_MIN = 10
export const REVIEW_TEXT_MAX = 1000

const fmtWhen = (value) => {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''
}

const fmtDay = (value) => {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : ''
}

const questionLabel = (number) => (number ? `Questão ${number}` : 'A prova toda')

// Números das questões da entrega, na ordem da revisão.
export function reviewQuestionNumbers(submission) {
  const seen = new Set()
  ;(Array.isArray(submission?.gradedAnswers) ? submission.gradedAnswers : []).forEach((answer) => {
    const number = Number(answer?.questionNumber)
    if (Number.isInteger(number) && number > 0) seen.add(number)
  })
  return [...seen]
}

function RequestItem({ request }) {
  const answered = request.situacao === 'respondido'
  return (
    <li className="rounded-lg border border-border bg-surface px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted">{questionLabel(request.questionNumber)} · pedido em {fmtWhen(request.criadoEm)}</span>
        <Badge tone={answered ? (request.notaMudou ? 'success' : 'neutral') : 'warning'}>
          {answered ? (request.notaMudou ? 'Respondido · a nota mudou' : 'Respondido · nota mantida') : 'Aguardando o professor'}
        </Badge>
      </div>
      {request.texto && <p className="mt-1.5 whitespace-pre-wrap break-words text-text">{request.texto}</p>}
      {answered && (
        <div className="mt-2 rounded-md border border-info/30 bg-info-soft px-3 py-2">
          <p className="text-xs font-semibold text-muted">Resposta do professor{request.respondidoEm ? ` · ${fmtWhen(request.respondidoEm)}` : ''}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-text">{request.resposta}</p>
        </div>
      )}
    </li>
  )
}

export function ReviewRequestPanel({ submission, onSent }) {
  const requests = Array.isArray(submission?.pedidosRevisao) ? submission.pedidosRevisao : []
  const revisao = submission?.revisao && typeof submission.revisao === 'object' ? submission.revisao : null
  const [open, setOpen] = useState(false)
  const [questionNumber, setQuestionNumber] = useState('')
  const [texto, setTexto] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const numbers = reviewQuestionNumbers(submission)

  // Nada a mostrar: nota não publicada (o aluno ainda não tem o que contestar) e nenhum
  // pedido antigo.
  if (!requests.length && (!revisao || revisao.motivo === 'not_published')) return null

  const canAsk = revisao?.podePedir === true

  async function send(event) {
    event.preventDefault()
    if (sending) return
    const text = texto.trim()
    if (text.length < REVIEW_TEXT_MIN) {
      setError(`Explique o pedido com pelo menos ${REVIEW_TEXT_MIN} letras.`)
      return
    }
    setSending(true)
    setError('')
    try {
      const result = await api.post(`/api/student/submissions/${encodeURIComponent(submission.id)}/review-request`, {
        questionNumber: questionNumber ? Number(questionNumber) : null,
        texto: text,
      })
      setOpen(false)
      setTexto('')
      setQuestionNumber('')
      setSent(true)
      if (typeof onSent === 'function') onSent(result)
    } catch (failure) {
      setError(failure?.message || 'Não foi possível enviar o pedido. Tente de novo.')
    } finally {
      setSending(false)
    }
  }

  return (
    <section aria-label="Pedido de revisão" className="space-y-3 rounded-lg border border-border bg-surface-2 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-text"><MessageSquareText size={16} className="text-muted" aria-hidden /> Pedido de revisão</h3>
        {canAsk && !open && (
          <Button size="sm" variant="secondary" className="h-11 sm:h-8" onClick={() => { setOpen(true); setSent(false) }}>Pedir revisão</Button>
        )}
      </div>

      {sent && <p role="status" className="text-sm text-success">Pedido enviado. O professor vai responder aqui e você recebe um aviso no sino.</p>}

      {canAsk && !open && !sent && (
        <p className="text-sm text-muted">Acha que algo na correção está errado? Você pode pedir revisão até {fmtDay(revisao.prazoAte)}, um pedido por vez.</p>
      )}
      {!canAsk && revisao?.mensagem && revisao.motivo !== 'not_published' && revisao.motivo !== 'already_open' && (
        <p className="text-sm text-muted">{revisao.mensagem}</p>
      )}

      {open && (
        <form onSubmit={send} className="space-y-3" noValidate>
          <Select label="Sobre o quê?" value={questionNumber} onChange={(event) => setQuestionNumber(event.target.value)} className="h-11">
            <option value="">A prova toda</option>
            {numbers.map((number) => <option key={number} value={String(number)}>{questionLabel(number)}</option>)}
          </Select>
          <Textarea
            label="Explique o que deve ser revisto"
            value={texto}
            maxLength={REVIEW_TEXT_MAX}
            counterFrom={0}
            onChange={(event) => { setTexto(event.target.value); if (error) setError('') }}
            error={error || undefined}
            placeholder="Exemplo: na questão 3 a alternativa B também está certa, porque..."
          />
          <p className="text-xs text-muted">O professor lê o pedido na tela de correção e responde. Até {fmtDay(revisao?.prazoAte)}.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" className="h-11" onClick={() => { setOpen(false); setError('') }} disabled={sending}>Cancelar</Button>
            <Button type="submit" className="h-11" loading={sending}>Enviar pedido</Button>
          </div>
        </form>
      )}

      {requests.length > 0 && (
        <ol className="space-y-2">
          {[...requests].reverse().map((request) => <RequestItem key={request.id} request={request} />)}
        </ol>
      )}
    </section>
  )
}

export default ReviewRequestPanel
