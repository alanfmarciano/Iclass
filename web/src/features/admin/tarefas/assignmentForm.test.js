import { describe, expect, it } from 'vitest'
import { createBody, deadlineChanged, emptyForm, formFieldOf, formFromAssignment, readExtensions, updateBody, validateForm } from './assignmentForm'

// Opções como GET /api/admin/assignments/form-options devolve.
const OPTIONS = {
  fileTypes: [{ key: 'pdf', label: 'PDF', extensions: ['.pdf'] }, { key: 'image', label: 'Imagem (foto)', extensions: ['.jpg'] }, { key: 'code', label: 'Código e texto', extensions: ['.py'] }],
  blockedExtensions: ['.exe', '.bat'],
  limits: { titleMin: 3, titleMax: 160, instructionsMax: 10000, libraryIdsMax: 10, maxFilesMin: 1, maxFilesMax: 10, maxSizeMbMin: 1, maxSizeMbMax: 6, extraExtensionsMax: 10, reasonMin: 3, reasonMax: 500 },
  defaults: { response: { files: true, text: false, link: false }, files: { maxFiles: 5, maxSizeMb: 6, types: ['pdf', 'image'], extraExtensions: [] }, latePolicy: { mode: 'aceitar', penaltyPerDayPct: 10, penaltyMaxPct: 50 }, countsInAverage: true, dueTime: '23:59' },
  modules: [
    { id: 'm1', name: 'Módulo 1', units: [{ key: 'Apostila_m1_1', keys: ['Apostila_m1_1', 'Avaliacao_m1_1'], name: 'Redes' }] },
    { id: 'm2', name: 'Módulo 2', units: [] },
  ],
  library: [],
}

const SAVED = {
  id: 'asg_1_abcdef',
  title: 'Relatório',
  instructions: 'Envie o PDF.',
  moduleId: 'm1',
  unitKey: 'Avaliacao_m1_1',
  libraryIds: ['lib_1'],
  status: 'publicada',
  response: { files: true, text: true, link: false },
  files: { maxFiles: 3, maxSizeMb: 5, types: ['pdf'], extraExtensions: ['.pkt'] },
  latePolicy: { mode: 'desconto', penaltyPerDayPct: 10, penaltyMaxPct: 30 },
  countsInAverage: false,
  dueAt: 1, opensAt: null, closeAt: 2,
  local: { opensDate: '', opensTime: '', dueDate: '2026-12-04', dueTime: '23:00', closeDate: '2026-12-06', closeTime: '12:00' },
}

describe('formulário da tarefa', () => {
  it('tarefa nova começa com os padrões do servidor e vai como rascunho sem prazo', () => {
    const form = emptyForm(OPTIONS)
    expect(form).toMatchObject({ maxFiles: '5', maxSizeMb: '6', types: ['pdf', 'image'], dueTime: '23:59', lateMode: 'aceitar', countsInAverage: true })
    const body = createBody({ ...form, title: '  Relatório  ' }, OPTIONS, { courseId: 'c1', studentClass: '1DES' })
    expect(body).toMatchObject({ courseId: 'c1', studentClass: '1DES', title: 'Relatório', moduleId: null, unitKey: null, publish: false })
    // A hora do prazo já vem preenchida: sem a data, ela não vai (o rascunho fica sem prazo).
    expect([body.dueDate, body.dueTime, body.opensDate, body.closeDate]).toEqual([null, null, null, null])
    expect(body.files).toEqual({ maxFiles: 5, maxSizeMb: 6, types: ['pdf', 'image'], extraExtensions: [] })
  })

  it('unidade gravada com a chave da avaliação aparece como a unidade e não vai de novo sem mudança', () => {
    const initial = formFromAssignment(SAVED, OPTIONS)
    expect(initial.unitKey).toBe('Apostila_m1_1')
    expect(initial.extraExtensions).toBe('.pkt')
    expect(updateBody(initial, { ...initial }, OPTIONS)).toEqual({})
    expect(updateBody(initial, { ...initial, title: 'Relatório final' }, OPTIONS)).toEqual({ title: 'Relatório final' })
  })

  it('tirar o módulo manda o módulo e a unidade vazios juntos (pendência da J1: só o módulo vazio não tirava a unidade)', () => {
    const initial = formFromAssignment(SAVED, OPTIONS)
    expect(updateBody(initial, { ...initial, moduleId: '', unitKey: '' }, OPTIONS)).toEqual({ moduleId: null, unitKey: null })
    // Trocar só a unidade leva o módulo dela junto.
    expect(updateBody({ ...initial, moduleId: '', unitKey: '' }, { ...initial, moduleId: '', unitKey: 'Apostila_m1_1' }, OPTIONS)).toEqual({ moduleId: 'm1', unitKey: 'Apostila_m1_1' })
  })

  it('na alteração vão só os grupos que mudaram: par de data e hora, files e regra de atraso inteiros', () => {
    const initial = formFromAssignment(SAVED, OPTIONS)
    expect(updateBody(initial, { ...initial, dueTime: '22:00' }, OPTIONS)).toEqual({ dueDate: '2026-12-04', dueTime: '22:00' })
    expect(updateBody(initial, { ...initial, closeDate: '', closeTime: '' }, OPTIONS)).toEqual({ closeDate: null, closeTime: null })
    expect(updateBody(initial, { ...initial, maxFiles: '4' }, OPTIONS)).toEqual({ files: { maxFiles: 4, maxSizeMb: 5, types: ['pdf'], extraExtensions: ['.pkt'] } })
    expect(updateBody(initial, { ...initial, penaltyMaxPct: '40' }, OPTIONS)).toEqual({ latePolicy: { mode: 'desconto', penaltyPerDayPct: 10, penaltyMaxPct: 40 } })
    expect(updateBody(initial, { ...initial, countsInAverage: true }, OPTIONS)).toEqual({ countsInAverage: true })
    const moved = { ...initial, dueDate: '2026-12-08', reason: '  Laboratório fechado  ' }
    expect(deadlineChanged(initial, moved)).toBe(true)
    expect(deadlineChanged(initial, { ...initial, title: 'x' })).toBe(false)
    expect(updateBody(initial, moved, OPTIONS, { withReason: true })).toEqual({ dueDate: '2026-12-08', dueTime: '23:00', reason: 'Laboratório fechado' })
  })

  it('confere antes de mandar com as frases do servidor, no campo do formulário', () => {
    const form = { ...emptyForm(OPTIONS), title: 'Relatório', dueDate: '2026-12-04', dueTime: '23:00' }
    expect(validateForm(form, OPTIONS, { publish: true })).toBeNull()
    expect(validateForm({ ...form, dueDate: '' }, OPTIONS, { publish: true })).toEqual({ field: 'dueDate', error: 'Informe o prazo da tarefa (data e hora) antes de publicar.' })
    expect(validateForm({ ...form, dueDate: '' }, OPTIONS)).toBeNull()
    expect(validateForm({ ...form, title: 'ab' }, OPTIONS)).toEqual({ field: 'title', error: 'O título da tarefa precisa ter de 3 a 160 caracteres.' })
    expect(validateForm({ ...form, maxSizeMb: '7' }, OPTIONS).error).toBe('O tamanho máximo por arquivo vai até 6 MB (o limite das entregas em Sistema).')
    expect(validateForm({ ...form, types: [] }, OPTIONS).field).toBe('files.types')
    expect(validateForm({ ...form, types: [], extraExtensions: '.pkt' }, OPTIONS)).toBeNull()
    expect(validateForm({ ...form, closeDate: '2026-12-03', closeTime: '10:00' }, OPTIONS)).toEqual({ field: 'closeDate', error: 'O encerramento precisa ser no prazo ou depois dele.' })
    expect(validateForm({ ...form, lateMode: 'desconto', penaltyPerDayPct: '0' }, OPTIONS).field).toBe('latePolicy.penaltyPerDayPct')
    expect(validateForm({ ...form, dueDate: '2026-12-08' }, OPTIONS, { needsReason: true }).field).toBe('reason')
    // Sem "Arquivo", os números do arquivo não são conferidos e vão com o padrão.
    const textOnly = { ...form, response: { files: false, text: true, link: false }, maxFiles: '', maxSizeMb: '99' }
    expect(validateForm(textOnly, OPTIONS)).toBeNull()
    expect(createBody(textOnly, OPTIONS, { courseId: 'c', studentClass: 't' }).files).toMatchObject({ maxFiles: 5, maxSizeMb: 6 })
  })

  it('formatos do curso: ponto opcional, sem repetição, executável recusado com a frase do servidor', () => {
    expect(readExtensions('PKT, .fzz  .pkt;dwg', OPTIONS)).toEqual({ value: ['.pkt', '.fzz', '.dwg'] })
    expect(readExtensions('bat', OPTIONS)).toEqual({ error: 'O formato .bat não pode ser aceito: arquivos executáveis são sempre recusados.' })
    expect(readExtensions('abc!', OPTIONS).error).toBe('Formato do curso inválido: "abc!". Use o ponto e até 8 letras ou números (ex.: .pkt).')
    expect(formFieldOf('libraryIds[2]')).toBe('libraryIds')
    expect(formFieldOf('files.maxSizeMb')).toBe('files.maxSizeMb')
  })
})
