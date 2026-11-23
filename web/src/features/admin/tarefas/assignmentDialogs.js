// Perguntas antes de publicar, arquivar, reativar e excluir uma tarefa (fase 3, C7 e C8 /
// P1-e e P1-f): as mesmas frases na lista (TarefasPage) e no detalhe (TarefaDetalhePage).
// Cada uma recebe a tarefa como o servidor a manda (e { forceReason } quando o servidor
// já pediu o motivo) e devolve { title, message, confirmLabel, tone, requireReason,
// reasonLabel, reasonPlaceholder } para o ConfirmDialog.
//
// Motivo (C18, rodada 1): com nota devolvida que conta na média (averageReasonRequired do
// servidor), arquivar tira a nota da média e reativar ou publicar de novo a põe de volta,
// como a avaliação manual arquivada em Resultados: o servidor pede o motivo (400
// reason_required) e a pergunta já mostra o campo. Sem o campo na resposta, vale o pedido
// do servidor (forceReason).
const REASON_PLACEHOLDER = 'Os alunos já viram a nota desta tarefa na média. O motivo fica na Auditoria.'

function averageReason(assignment, affectsAverage, { forceReason = false } = {}) {
  const required = forceReason || (affectsAverage && assignment.averageReasonRequired === true && assignment.countsInAverage !== false)
  return required ? { requireReason: true, reasonLabel: 'Motivo da mudança na média', reasonPlaceholder: REASON_PLACEHOLDER } : {}
}

export const ASSIGNMENT_DIALOGS = Object.freeze({
  publish: (assignment, options) => ({
    title: 'Publicar a tarefa?',
    message: assignment.opensAt && assignment.local?.opensDate
      ? `"${assignment.title}" aparece para os alunos da turma na data de abertura, com o aviso no sino.`
      : `"${assignment.title}" aparece agora para os alunos da turma, com o aviso no sino.`,
    confirmLabel: 'Publicar',
    tone: 'primary',
    // Rascunho que já foi publicado: a nota devolvida volta para a média.
    ...averageReason(assignment, !!assignment.publishedAt, options),
  }),
  archive: (assignment, options) => ({
    title: 'Arquivar a tarefa?',
    // A nota da tarefa arquivada sai da média (C18 / P1-j), como a da avaliação manual
    // arquivada; o quadro de notas mostra a coluna marcada.
    message: `"${assignment.title}" some para os alunos. As entregas e as notas ficam guardadas, e a tarefa pode voltar pela aba Arquivadas.${assignment.publishedAt && assignment.countsInAverage !== false ? ' Enquanto estiver arquivada, as notas dela não entram na média.' : ''}`,
    confirmLabel: 'Arquivar',
    tone: 'primary',
    ...averageReason(assignment, assignment.status === 'publicada', options),
  }),
  unarchive: (assignment, options) => ({
    title: 'Reativar a tarefa?',
    message: assignment.publishedAt
      ? `"${assignment.title}" volta a aparecer para os alunos da turma.${assignment.countsInAverage !== false && assignment.averageReasonRequired === true ? ' As notas devolvidas voltam para a média.' : ''}`
      : `"${assignment.title}" volta como rascunho.`,
    confirmLabel: 'Reativar',
    tone: 'primary',
    ...averageReason(assignment, !!assignment.publishedAt, options),
  }),
  delete: (assignment) => ({
    title: 'Excluir a tarefa?',
    message: `"${assignment.title}" é apagada de vez. Só dá para excluir tarefa sem nenhum registro de aluno; com entrega ou nota, arquive.`,
    confirmLabel: 'Excluir',
    tone: 'danger',
  }),
})
