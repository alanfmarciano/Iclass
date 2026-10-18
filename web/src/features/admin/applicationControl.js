// Mensagem mostrada ao professor depois de uma ação de controle da aplicação (Monitor e
// Provas). Quando o servidor responde unchanged, a aplicação já estava encerrada (por
// exemplo, em outra aba): a escolha desta tela não foi aplicada e vale a decisão do
// primeiro encerramento, o que o professor precisa saber.
const ACTION_MESSAGES = {
  start: 'Prova iniciada. O aviso já está disponível para os alunos.',
  running: 'Prova em andamento.',
  resume: 'Prova retomada. O aviso aos alunos continua ativo.',
  pause: 'Prova pausada. Os alunos verão o estado de pausa.',
  paused: 'Prova pausada. Os alunos verão o estado de pausa.',
  waiting: 'Sala de espera aberta. Os alunos já podem entrar.',
  adjust_waiting: 'Tempo da sala de espera ajustado.',
  cancel: 'Aplicação cancelada.',
}

const FINISH_ACTIONS = new Set(['finish', 'stop', 'finished'])

function previousDecision(policy) {
  if (policy === 'submit') return ', com as respostas em andamento salvas como entrega'
  if (policy === 'discard') return ', com as respostas em andamento desconsideradas'
  return ''
}

export function controlResultMessage(action, response, fallback = 'Estado atualizado.') {
  if (response?.unchanged) {
    const application = response.application || {}
    if (application.status === 'cancelled') {
      return { tone: 'info', text: 'Esta aplicação já estava cancelada. Nada foi alterado.' }
    }
    return {
      tone: 'info',
      text: `Esta aplicação já tinha sido encerrada${previousDecision(application.finishResolution?.policy)}. Nada foi alterado: vale a decisão do primeiro encerramento.`,
    }
  }
  if (FINISH_ACTIONS.has(action)) {
    const finish = response?.finish || {}
    if (Number(finish.submitted) > 0) return { tone: 'success', text: 'Aplicação encerrada. As respostas em andamento foram salvas como entrega.' }
    if (Number(finish.discarded) > 0) return { tone: 'success', text: 'Aplicação encerrada. As tentativas em andamento foram desconsideradas.' }
    return { tone: 'success', text: 'Aplicação encerrada.' }
  }
  return { tone: 'success', text: ACTION_MESSAGES[action] || fallback }
}
