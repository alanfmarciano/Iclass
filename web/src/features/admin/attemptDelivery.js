// Como a entrega da prova chegou: o professor vê quando foi automática no fim do
// tempo, quando chegou atrasada (e quanto) e quando foi salva no encerramento.
export function formatLateness(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  if (total < 60) return `${total} s`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`
}

export function deliveryLabel(item) {
  const source = item?.submissionSource
  const late = Number(item?.lateBySeconds || 0)
  if (item?.recoveredAfterFinish === true) return 'Recuperada depois do encerramento: entregue com as respostas salvas no fim do tempo'
  if (item?.focusLockedAtDeadline === true) return 'Tempo esgotado com a prova bloqueada por perda de foco: entregue com as respostas salvas antes do bloqueio'
  if (source === 'deadline_server_auto_submit') return 'Tempo esgotado: entregue automaticamente com as respostas salvas'
  if (late > 0) return `Enviada após o prazo (${formatLateness(late)})`
  if (source === 'timer_auto_submit') return 'Enviada automaticamente no fim do tempo'
  if (source === 'instructor_finish') return 'Salva pelo professor ao encerrar'
  return ''
}

export function deliveryTone(item) {
  if (item?.recoveredAfterFinish === true || item?.focusLockedAtDeadline === true) return 'warning'
  if (Number(item?.lateBySeconds || 0) > 0) return 'warning'
  return item?.submissionSource === 'deadline_server_auto_submit' ? 'warning' : 'muted'
}
