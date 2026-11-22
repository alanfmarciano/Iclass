// Como a entrega da prova chegou: o professor vê quando foi automática no fim do
// tempo, quando chegou atrasada (e quanto) e quando foi salva no encerramento.
export function formatLateness(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  if (total < 60) return `${total} s`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`
}

function sourceLabel(item) {
  const source = item?.submissionSource
  const late = Number(item?.lateBySeconds || 0)
  if (item?.recoveredAfterFinish === true) return 'Recuperada depois do encerramento: entregue com as respostas salvas no fim do tempo'
  if (item?.focusLockedAtDeadline === true) return 'Tempo esgotado com a prova bloqueada por perda de foco: entregue com as respostas salvas antes do bloqueio'
  if (source === 'deadline_server_auto_submit') return 'Tempo esgotado: entregue automaticamente com as respostas salvas'
  if (late > 0) return `Enviada após o prazo (${formatLateness(late)})`
  if (source === 'timer_auto_submit') return 'Enviada automaticamente no fim do tempo'
  if (source === 'instructor_finish') return 'Salva pelo professor ao encerrar'
  if (source === 'instructor_collect') return 'Recolhida pelo professor com as respostas salvas'
  return ''
}

// Tentativa reaberta pelo "+N min" da turma depois da entrega do fim do tempo, ou pelo
// professor no Monitor (P3-S8: reopenedByInstructor na linha do Monitor, byInstructor na
// última reabertura da entrega): a entrega mostra que houve reabertura (e quantas vezes).
// Quando o professor desconsiderou as tentativas em andamento ao encerrar, vale a entrega
// que o aluno já tinha.
export function reopenedByInstructor(item) {
  if (item?.reopenedByInstructor === true) return true
  const list = Array.isArray(item?.reopenedFrom) ? item.reopenedFrom : []
  return list.length > 0 && list[list.length - 1]?.byInstructor === true
}

function reopenLabel(item) {
  const byInstructor = reopenedByInstructor(item) || item?.restoredAfterDiscard?.byInstructor === true
  if (item?.restoredAfterDiscard) {
    return byInstructor
      ? 'Reaberta pelo professor e desconsiderada no encerramento: vale a entrega anterior'
      : 'Reaberta com o tempo extra da turma e desconsiderada no encerramento: vale a entrega do fim do tempo'
  }
  if (!item?.reopenedAt) return ''
  const times = Array.isArray(item.reopenedFrom) ? item.reopenedFrom.length : 0
  if (byInstructor) return times > 1 ? `Reaberta ${times} vezes (a última pelo professor)` : 'Reaberta pelo professor'
  return times > 1 ? `Reaberta ${times} vezes com o tempo extra da turma` : 'Reaberta com o tempo extra da turma'
}

export function deliveryLabel(item) {
  return [sourceLabel(item), reopenLabel(item)].filter(Boolean).join(' · ')
}

export function deliveryTone(item) {
  if (item?.recoveredAfterFinish === true || item?.focusLockedAtDeadline === true || item?.restoredAfterDiscard) return 'warning'
  if (Number(item?.lateBySeconds || 0) > 0) return 'warning'
  return item?.submissionSource === 'deadline_server_auto_submit' ? 'warning' : 'muted'
}

// Tentativa que a linha do Monitor mostra quando a aplicação permite mais de uma
// ("Tentativa 2 de 3"). Com uma tentativa só, nada a dizer.
export function attemptCountLabel(row) {
  const number = Number(row?.attemptNumber) || 0
  const max = Number(row?.maxAttempts) || 0
  if (!number) return ''
  if (max > 1) return `Tentativa ${number} de ${max}`
  if (!max && number > 1) return `Tentativa ${number}`
  return ''
}
