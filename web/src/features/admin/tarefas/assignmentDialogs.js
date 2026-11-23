// Perguntas antes de publicar, arquivar, reativar e excluir uma tarefa (fase 3, C7 e C8 /
// P1-e e P1-f): as mesmas frases na lista (TarefasPage) e no detalhe (TarefaDetalhePage).
// Cada uma recebe a tarefa como o servidor a manda e devolve { title, message,
// confirmLabel, tone } para o ConfirmDialog.
export const ASSIGNMENT_DIALOGS = Object.freeze({
  publish: (assignment) => ({
    title: 'Publicar a tarefa?',
    message: assignment.opensAt && assignment.local?.opensDate
      ? `"${assignment.title}" aparece para os alunos da turma na data de abertura, com o aviso no sino.`
      : `"${assignment.title}" aparece agora para os alunos da turma, com o aviso no sino.`,
    confirmLabel: 'Publicar',
    tone: 'primary',
  }),
  archive: (assignment) => ({
    title: 'Arquivar a tarefa?',
    // A nota da tarefa arquivada sai da média (C18 / P1-j), como a da avaliação manual
    // arquivada; o quadro de notas mostra a coluna marcada.
    message: `"${assignment.title}" some para os alunos. As entregas e as notas ficam guardadas, e a tarefa pode voltar pela aba Arquivadas.${assignment.publishedAt && assignment.countsInAverage !== false ? ' Enquanto estiver arquivada, as notas dela não entram na média.' : ''}`,
    confirmLabel: 'Arquivar',
    tone: 'primary',
  }),
  unarchive: (assignment) => ({
    title: 'Reativar a tarefa?',
    message: assignment.publishedAt
      ? `"${assignment.title}" volta a aparecer para os alunos da turma.`
      : `"${assignment.title}" volta como rascunho.`,
    confirmLabel: 'Reativar',
    tone: 'primary',
  }),
  delete: (assignment) => ({
    title: 'Excluir a tarefa?',
    message: `"${assignment.title}" é apagada de vez. Só dá para excluir tarefa sem nenhum registro de aluno; com entrega ou nota, arquive.`,
    confirmLabel: 'Excluir',
    tone: 'danger',
  }),
})
