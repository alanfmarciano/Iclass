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

// C18, rodada 1: arquivar, reativar e publicar de novo com nota devolvida que conta na média
// pedem o motivo (o servidor recusa sem ele: 400 reason_required).
describe('Motivo da mudança na média', () => {
  const publicada = { title: 'Relatório', status: 'publicada', publishedAt: 1795000000000, countsInAverage: true, averageReasonRequired: true }

  it('[UC-TAREFAS-002] arquivar a publicada com nota devolvida pede o motivo', () => {
    const dialog = ASSIGNMENT_DIALOGS.archive(publicada)
    expect(dialog.requireReason).toBe(true)
    expect(dialog.reasonLabel).toBe('Motivo da mudança na média')
  })

  it('[UC-TAREFAS-002] reativar e publicar de novo pedem o motivo; reativar avisa que as notas voltam para a média', () => {
    const arquivada = { ...publicada, status: 'arquivada' }
    expect(ASSIGNMENT_DIALOGS.unarchive(arquivada).requireReason).toBe(true)
    expect(ASSIGNMENT_DIALOGS.unarchive(arquivada).message).toContain('As notas devolvidas voltam para a média.')
    expect(ASSIGNMENT_DIALOGS.publish({ ...publicada, status: 'rascunho' }).requireReason).toBe(true)
  })

  it('[UC-TAREFAS-002] sem nota devolvida, fora da média ou rascunho novo: sem motivo; o pedido do servidor (forceReason) liga o campo', () => {
    expect(ASSIGNMENT_DIALOGS.archive({ ...publicada, averageReasonRequired: false }).requireReason).toBeUndefined()
    expect(ASSIGNMENT_DIALOGS.archive({ ...publicada, countsInAverage: false }).requireReason).toBeUndefined()
    expect(ASSIGNMENT_DIALOGS.publish({ ...publicada, status: 'rascunho', publishedAt: null }).requireReason).toBeUndefined()
    expect(ASSIGNMENT_DIALOGS.archive({ ...publicada, averageReasonRequired: false }, { forceReason: true }).requireReason).toBe(true)
  })
})
