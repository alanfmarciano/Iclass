import { useEffect, useId, useRef, useState } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import { Textarea } from './Textarea'

// Diálogo de confirmação do painel e do portal (fase 3, contrato C12 do P3; fundação
// C0a). Substitui window.confirm, window.prompt e window.alert, que congelam a página (o
// polling do Monitor parava enquanto a caixa do navegador estava aberta) e não dizem o
// que vai acontecer. Tela tocada na fase 3 não usa as caixas do navegador (guarda em
// test/backend/contrato-telas.test.js).
//
// - title: a pergunta ("Excluir o tema salvo?"); message: o que acontece, em uma ou
//   duas frases (texto ou elemento); description: linha curta abaixo do título.
// - confirmLabel (padrão "Confirmar") e cancelLabel (padrão "Cancelar").
// - tone: 'danger' (botão vermelho, para o que apaga ou não tem volta) ou 'primary'.
// - requireReason: pede o motivo e só confirma com ele preenchido; askReason: pede o
//   motivo sem obrigar. reasonLabel, reasonPlaceholder e reasonMaxLength (padrão 500).
// - children: campos a mais no corpo (ex.: os minutos do ajuste de tempo no Monitor);
//   confirmDisabled trava só o botão de confirmar enquanto esses campos não valem
//   (Cancelar e Esc continuam fechando). Com children, o foco vai para o campo com
//   autoFocus, e não para o Cancelar.
// - onConfirm(motivo): pode ser assíncrona. Enquanto roda, os botões ficam travados
//   (não há clique duplo) e o diálogo não fecha; se der erro, a mensagem aparece no
//   diálogo e ele continua aberto para tentar de novo. Quem fecha depois do sucesso é a
//   tela (onClose), como já faziam as telas de hoje.
//
// Compatível com as chamadas antigas do Modal.jsx: danger vira tone 'danger' e note,
// quando vem, é o texto do corpo.
export const REASON_MAX_DEFAULT = 500

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  description,
  children,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone,
  danger,
  note,
  requireReason = false,
  askReason = false,
  reasonLabel = 'Motivo',
  reasonPlaceholder,
  reasonMaxLength = REASON_MAX_DEFAULT,
  busy = false,
  confirmDisabled = false,
}) {
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const runningRef = useRef(false)
  const mountedRef = useRef(true)
  const messageId = useId()
  const reasonId = useId()

  useEffect(() => () => { mountedRef.current = false }, [])
  // Cada abertura começa limpa (motivo e erro da vez anterior não ficam).
  useEffect(() => {
    if (!open) return
    setReason('')
    setError('')
  }, [open])

  const resolvedTone = tone === 'danger' || tone === 'primary' ? tone : (danger ? 'danger' : 'primary')
  const showReason = !!(requireReason || askReason)
  const trimmedReason = reason.trim()
  const locked = pending || busy
  const missingReason = !!requireReason && !trimmedReason
  const body = message ?? note ?? null

  function close() {
    if (locked) return
    onClose?.()
  }

  async function confirm() {
    if (runningRef.current || locked || missingReason || confirmDisabled) return
    runningRef.current = true
    setPending(true)
    setError('')
    try {
      await onConfirm?.(showReason ? trimmedReason : undefined)
    } catch (err) {
      if (mountedRef.current) setError((err && err.message) || 'Não foi possível concluir. Tente de novo.')
    } finally {
      runningRef.current = false
      if (mountedRef.current) setPending(false)
    }
  }

  return (
    <Modal open={open} onClose={close} title={title} description={description}
      footer={<>
        <Button variant="ghost" onClick={close} disabled={locked} autoFocus={!showReason && !children}>{cancelLabel}</Button>
        <Button variant={resolvedTone === 'danger' ? 'destructive' : 'primary'} onClick={confirm}
          loading={pending} disabled={busy || missingReason || confirmDisabled}>{confirmLabel}</Button>
      </>}>
      <div className="space-y-3">
        {body !== null && body !== undefined && body !== '' && (
          typeof body === 'string'
            ? <p id={messageId} className="text-sm text-muted whitespace-pre-line">{body}</p>
            : <div id={messageId} className="text-sm text-muted">{body}</div>
        )}
        {children}
        {showReason && (
          <Textarea
            id={reasonId}
            label={requireReason ? reasonLabel : `${reasonLabel} (opcional)`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={reasonMaxLength}
            counterFrom={Math.floor(reasonMaxLength * 0.9)}
            placeholder={reasonPlaceholder}
            disabled={locked}
            autoFocus
            className="min-h-[80px]"
          />
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
