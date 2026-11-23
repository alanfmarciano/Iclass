import { describe, expect, it } from 'vitest'
import { ASSIGNMENT_DIALOGS } from './assignmentDialogs'

// Pergunta de arquivar a tarefa (fase 3, C18 / P1-j): a nota da tarefa arquivada sai da
// média, como a da avaliação manual arquivada.
describe('Arquivar a tarefa', () => {
  it('[UC-TAREFAS-002] tarefa publicada que conta na média avisa que as notas saem da média enquanto estiver arquivada', () => {
    const { message } = ASSIGNMENT_DIALOGS.archive({ title: 'Relatório', publishedAt: 1795000000000, countsInAverage: true })
    expect(message).toContain('"Relatório" some para os alunos.')
    expect(message).toContain('Enquanto estiver arquivada, as notas dela não entram na média.')
  })

  it('[UC-TAREFAS-002] rascunho ou tarefa fora da média não fala de média', () => {
    expect(ASSIGNMENT_DIALOGS.archive({ title: 'Rascunho', publishedAt: null, countsInAverage: true }).message).not.toMatch(/média/)
    expect(ASSIGNMENT_DIALOGS.archive({ title: 'Extra', publishedAt: 1795000000000, countsInAverage: false }).message).not.toMatch(/média/)
  })
})
