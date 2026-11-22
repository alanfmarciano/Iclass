// Formulário da tarefa no painel (fase 3, C7 / P1-e; FUN-01, D6, D8 e D17 do P1). Funções
// puras: o estado do formulário, a conferência antes de mandar e o corpo do pedido para
// POST /api/admin/assignments (criar) e POST /api/admin/assignments/:id/update (alterar).
//
// - As mensagens são as mesmas do servidor (backend/routes/adminAssignments.js MESSAGES,
//   utils/assignments.js deadlineFields e windowOrderError, utils/assignmentFiles.js
//   normalizeExtraExtensions; o caso "a tela e o servidor recusam com a mesma mensagem" de
//   test/backend/assignments-admin-routes.test.js confere que continuam iguais). A tela
//   confere antes só para avisar no campo certo; quem decide é o servidor, e a recusa dele
//   também aparece no campo (field da resposta).
// - Limites, padrões e o catálogo de tipos vêm de GET /api/admin/assignments/form-options
//   (options), nunca copiados aqui.
// - Prazos digitados como data + hora no relógio da escola (dueDate/dueTime...); o servidor
//   grava o instante em ms (schoolTime.deadlineFromLocal). Data vazia vai como null.
// - Na alteração só vão os grupos que mudaram (o servidor muda só o que recebe): módulo e
//   unidade sempre juntos (mandar só o módulo vazio não tira a unidade gravada, pendência
//   da J1), cada par data + hora junto, files e latePolicy inteiros.

export const DEADLINES = Object.freeze([
  { prefix: 'opens', key: 'opensAt', label: 'da abertura', defaultTime: '00:00' },
  { prefix: 'due', key: 'dueAt', label: 'do prazo', defaultTime: '23:59' },
  { prefix: 'close', key: 'closeAt', label: 'do encerramento', defaultTime: '23:59' },
])

export const MESSAGES = Object.freeze({
  title: (min, max) => `O título da tarefa precisa ter de ${min} a ${max} caracteres.`,
  response: 'Escolha ao menos uma forma de resposta: arquivo, texto ou link.',
  types: 'Escolha ao menos um tipo de arquivo ou informe um formato do curso.',
  dueRequired: 'Informe o prazo da tarefa (data e hora) antes de publicar.',
  penaltyPerDay: 'Com desconto por atraso, informe o desconto por dia (de 1% a 100%).',
  penaltyMax: 'Com desconto por atraso, o desconto máximo precisa ser de 1% a 100%.',
  reason: (min, max) => `Esta tarefa já tem entrega ou nota de aluno. Para mudar a abertura, o prazo ou o encerramento, informe o motivo (de ${min} a ${max} caracteres).`,
  maxSize: (ceiling) => `O tamanho máximo por arquivo vai até ${ceiling} MB (o limite das entregas em Sistema).`,
  range: (label, min, max) => `O campo "${label}" deve estar entre ${min} e ${max}.`,
  dateMissing: (label) => `Informe a data ${label}.`,
  dateInvalid: (label) => `Data ${label} inválida. Use o formato AAAA-MM-DD.`,
  timeInvalid: (label) => `Hora ${label} inválida. Use o formato HH:MM (00:00 a 23:59).`,
  opensAfterDue: 'A abertura precisa ser antes do prazo.',
  closeWithoutDue: 'Informe o prazo antes do encerramento.',
  closeBeforeDue: 'O encerramento precisa ser no prazo ou depois dele.',
  extensionInvalid: (shown) => `Formato do curso inválido: "${shown}". Use o ponto e até 8 letras ou números (ex.: .pkt).`,
  extensionBlocked: (ext) => `O formato ${ext} não pode ser aceito: arquivos executáveis são sempre recusados.`,
  extensionsMax: (max) => `Informe no máximo ${max} formatos do curso.`,
})

const EXTENSION_PATTERN = /^\.[a-z0-9]{1,8}$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

const FALLBACK_LIMITS = Object.freeze({
  titleMin: 3, titleMax: 160, instructionsMax: 10000, libraryIdsMax: 10,
  maxFilesMin: 1, maxFilesMax: 10, maxSizeMbMin: 1, maxSizeMbMax: 20, extraExtensionsMax: 10,
  reasonMin: 3, reasonMax: 500,
})

export function limitsOf(options) {
  return { ...FALLBACK_LIMITS, ...(options?.limits || {}) }
}

function isValidDate(value) {
  const match = DATE_PATTERN.exec(String(value || ''))
  if (!match) return false
  const [, year, month, day] = match.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

// A unidade gravada com outra chave aceita (avaliação no lugar da apostila) aparece como a
// opção da unidade: a tela compara sempre pela chave principal.
export function canonicalUnitKey(options, moduleId, unitKey) {
  const key = String(unitKey || '')
  if (!key) return ''
  const modules = Array.isArray(options?.modules) ? options.modules : []
  const pool = moduleId ? modules.filter((module) => module.id === moduleId) : modules
  for (const module of pool) {
    const unit = (module.units || []).find((item) => item.key === key || (item.keys || []).includes(key))
    if (unit) return unit.key
  }
  return key
}

// A unidade escolhida sem módulo leva o módulo dela (a mesma regra do servidor).
export function moduleOfUnit(options, unitKey) {
  if (!unitKey) return ''
  const module = (options?.modules || []).find((item) => (item.units || []).some((unit) => unit.key === unitKey || (unit.keys || []).includes(unitKey)))
  return module ? module.id : ''
}

export function extensionsText(list) {
  return (Array.isArray(list) ? list : []).join(', ')
}

// Texto digitado em "Formatos do curso" ('.pkt, fzz  .dwg') -> lista de itens.
export function splitExtensions(text) {
  return String(text || '').split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean)
}

// Normaliza como o servidor (normalizeExtraExtensions estrito): { value } ou { error }.
export function readExtensions(text, options) {
  const blocked = new Set(Array.isArray(options?.blockedExtensions) ? options.blockedExtensions : [])
  const max = limitsOf(options).extraExtensionsMax
  const out = []
  for (const item of splitExtensions(text)) {
    const shown = item.slice(0, 20)
    let ext = item.toLowerCase()
    if (!ext.startsWith('.')) ext = `.${ext}`
    if (blocked.has(ext)) return { error: MESSAGES.extensionBlocked(ext) }
    if (!EXTENSION_PATTERN.test(ext)) return { error: MESSAGES.extensionInvalid(shown) }
    if (!out.includes(ext)) out.push(ext)
  }
  if (out.length > max) return { error: MESSAGES.extensionsMax(max) }
  return { value: out }
}

// Formulário de uma tarefa nova, com os padrões do servidor.
export function emptyForm(options) {
  const defaults = options?.defaults || {}
  const files = defaults.files || {}
  const late = defaults.latePolicy || {}
  return {
    title: '',
    instructions: '',
    moduleId: '',
    unitKey: '',
    libraryIds: [],
    response: { files: true, text: false, link: false, ...(defaults.response || {}) },
    maxFiles: String(files.maxFiles ?? 5),
    maxSizeMb: String(files.maxSizeMb ?? 10),
    types: Array.isArray(files.types) ? [...files.types] : ['pdf', 'image', 'doc'],
    extraExtensions: extensionsText(files.extraExtensions),
    opensDate: '',
    opensTime: '',
    dueDate: '',
    dueTime: defaults.dueTime || '23:59',
    closeDate: '',
    closeTime: '',
    lateMode: late.mode || 'aceitar',
    penaltyPerDayPct: String(late.penaltyPerDayPct ?? 10),
    penaltyMaxPct: String(late.penaltyMaxPct ?? 50),
    countsInAverage: defaults.countsInAverage !== false,
    reason: '',
  }
}

// Formulário de uma tarefa gravada (resposta do servidor: assignment com local).
export function formFromAssignment(assignment, options) {
  const local = assignment?.local || {}
  const files = assignment?.files || {}
  const late = assignment?.latePolicy || {}
  const moduleId = String(assignment?.moduleId || '')
  return {
    title: String(assignment?.title || ''),
    instructions: String(assignment?.instructions || ''),
    moduleId,
    unitKey: canonicalUnitKey(options, moduleId, assignment?.unitKey),
    libraryIds: Array.isArray(assignment?.libraryIds) ? [...assignment.libraryIds] : [],
    response: { files: assignment?.response?.files === true, text: assignment?.response?.text === true, link: assignment?.response?.link === true },
    maxFiles: String(files.maxFiles ?? ''),
    maxSizeMb: String(files.maxSizeMb ?? ''),
    types: Array.isArray(files.types) ? [...files.types] : [],
    extraExtensions: extensionsText(files.extraExtensions),
    opensDate: local.opensDate || '',
    opensTime: local.opensDate ? (local.opensTime || '') : '',
    dueDate: local.dueDate || '',
    dueTime: local.dueDate ? (local.dueTime || '') : '23:59',
    closeDate: local.closeDate || '',
    closeTime: local.closeDate ? (local.closeTime || '') : '',
    lateMode: late.mode || 'aceitar',
    penaltyPerDayPct: String(late.penaltyPerDayPct ?? 0),
    penaltyMaxPct: String(late.penaltyMaxPct ?? 0),
    countsInAverage: assignment?.countsInAverage !== false,
    reason: '',
  }
}

function intOf(value) {
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) return NaN
  return Number(text)
}

function deadlinePair(form, prefix) {
  const date = String(form[`${prefix}Date`] || '').trim()
  const time = String(form[`${prefix}Time`] || '').trim()
  return { date, time }
}

// 'AAAA-MM-DDTHH:MM' para comparar a ordem das datas no relógio da escola ('' sem data).
function localStamp(form, deadline) {
  const { date, time } = deadlinePair(form, deadline.prefix)
  if (!date) return ''
  return `${date}T${time || deadline.defaultTime}`
}

export function deadlineChanged(initial, form) {
  return DEADLINES.some(({ prefix }) => {
    const before = deadlinePair(initial, prefix)
    const after = deadlinePair(form, prefix)
    // Sem data, a hora não conta (o servidor grava sem prazo).
    if (!before.date && !after.date) return false
    return before.date !== after.date || before.time !== after.time
  })
}

// Confere o formulário como o servidor: { field, error } do primeiro problema ou null.
// publish: a tarefa vai ficar publicada (exige prazo). needsReason: a tarefa já tem
// entrega e o prazo mudou.
export function validateForm(form, options, { publish = false, needsReason = false } = {}) {
  const limits = limitsOf(options)
  const title = String(form.title || '').trim()
  if (title.length < limits.titleMin || title.length > limits.titleMax) return { field: 'title', error: MESSAGES.title(limits.titleMin, limits.titleMax) }
  if (!form.response.files && !form.response.text && !form.response.link) return { field: 'response', error: MESSAGES.response }
  if (form.response.files) {
    const maxFiles = intOf(form.maxFiles)
    if (!(maxFiles >= limits.maxFilesMin && maxFiles <= limits.maxFilesMax)) {
      return { field: 'files.maxFiles', error: MESSAGES.range('número de arquivos por envio', limits.maxFilesMin, limits.maxFilesMax) }
    }
    const maxSizeMb = intOf(form.maxSizeMb)
    if (!(maxSizeMb >= limits.maxSizeMbMin)) return { field: 'files.maxSizeMb', error: MESSAGES.range('tamanho máximo por arquivo (MB)', limits.maxSizeMbMin, limits.maxSizeMbMax) }
    if (maxSizeMb > limits.maxSizeMbMax) return { field: 'files.maxSizeMb', error: MESSAGES.maxSize(limits.maxSizeMbMax) }
  }
  const extras = readExtensions(form.extraExtensions, options)
  if (extras.error) return { field: 'files.extraExtensions', error: extras.error }
  for (const deadline of DEADLINES) {
    const { date, time } = deadlinePair(form, deadline.prefix)
    if (!date && !time) continue
    if (!date) {
      // A hora do prazo já vem preenchida (23:59): sem data, o prazo fica vazio.
      if (deadline.prefix === 'due') continue
      return { field: `${deadline.prefix}Date`, error: MESSAGES.dateMissing(deadline.label) }
    }
    if (!isValidDate(date)) return { field: `${deadline.prefix}Date`, error: MESSAGES.dateInvalid(deadline.label) }
    if (time && !TIME_PATTERN.test(time)) return { field: `${deadline.prefix}Time`, error: MESSAGES.timeInvalid(deadline.label) }
  }
  if (form.lateMode === 'desconto') {
    const perDay = intOf(form.penaltyPerDayPct)
    if (!(perDay >= 1 && perDay <= 100)) return { field: 'latePolicy.penaltyPerDayPct', error: MESSAGES.penaltyPerDay }
    const max = intOf(form.penaltyMaxPct)
    if (!(max >= 1 && max <= 100)) return { field: 'latePolicy.penaltyMaxPct', error: MESSAGES.penaltyMax }
  }
  const [opens, due, close] = DEADLINES.map((deadline) => localStamp(form, deadline))
  if (publish && !due) return { field: 'dueDate', error: MESSAGES.dueRequired }
  if (due && opens && opens > due) return { field: 'opensDate', error: MESSAGES.opensAfterDue }
  if (close && !due) return { field: 'dueDate', error: MESSAGES.closeWithoutDue }
  if (close && due && close < due) return { field: 'closeDate', error: MESSAGES.closeBeforeDue }
  if (form.response.files && form.types.length === 0 && extras.value.length === 0) return { field: 'files.types', error: MESSAGES.types }
  if (needsReason) {
    const reason = String(form.reason || '').trim()
    if (reason.length < limits.reasonMin || reason.length > limits.reasonMax) return { field: 'reason', error: MESSAGES.reason(limits.reasonMin, limits.reasonMax) }
  }
  return null
}

function pct(value, fallback = 0) {
  const number = intOf(value)
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : fallback
}

// Com "Arquivo" desmarcado, os números do arquivo não aparecem na tela: o que estiver
// vazio ou fora do limite vai com o padrão (o servidor confere o bloco files sempre).
function fileNumber(form, options, key, min, max) {
  const value = intOf(form[key])
  if (form.response.files || (value >= min && value <= max)) return value
  const fallback = Number(options?.defaults?.files?.[key])
  return Number.isFinite(fallback) && fallback >= min && fallback <= max ? fallback : min
}

function filesBody(form, options) {
  const limits = limitsOf(options)
  const extras = readExtensions(form.extraExtensions, options)
  return {
    maxFiles: fileNumber(form, options, 'maxFiles', limits.maxFilesMin, limits.maxFilesMax),
    maxSizeMb: fileNumber(form, options, 'maxSizeMb', limits.maxSizeMbMin, limits.maxSizeMbMax),
    types: [...form.types],
    // Com algum formato inválido, vai o que foi digitado (o servidor recusa com a mesma frase).
    extraExtensions: extras.value || splitExtensions(form.extraExtensions).map((item) => item.slice(0, 20)),
  }
}

function latePolicyBody(form) {
  return { mode: form.lateMode, penaltyPerDayPct: pct(form.penaltyPerDayPct), penaltyMaxPct: pct(form.penaltyMaxPct) }
}

// A hora do prazo já vem preenchida (23:59): sem a data, ela não vai (rascunho sem prazo).
// Na abertura e no encerramento, a hora sem a data vai, e o servidor pede a data.
function deadlineBody(form, prefix) {
  const { date, time } = deadlinePair(form, prefix)
  const sendTime = date || prefix !== 'due'
  return { [`${prefix}Date`]: date || null, [`${prefix}Time`]: sendTime ? (time || null) : null }
}

function moduleUnitBody(form, options) {
  const unitKey = String(form.unitKey || '')
  const moduleId = String(form.moduleId || '') || moduleOfUnit(options, unitKey)
  return { moduleId: moduleId || null, unitKey: unitKey || null }
}

// Corpo do POST /api/admin/assignments.
export function createBody(form, options, { courseId, studentClass, publish = false }) {
  return {
    courseId,
    studentClass,
    title: String(form.title || '').trim(),
    instructions: String(form.instructions || ''),
    ...moduleUnitBody(form, options),
    libraryIds: [...form.libraryIds],
    response: { ...form.response },
    files: filesBody(form, options),
    ...deadlineBody(form, 'opens'),
    ...deadlineBody(form, 'due'),
    ...deadlineBody(form, 'close'),
    latePolicy: latePolicyBody(form),
    countsInAverage: form.countsInAverage === true,
    publish: publish === true,
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Corpo do POST /api/admin/assignments/:id/update: só o que mudou desde initial (o
// formulário como abriu). Vazio quando nada mudou.
export function updateBody(initial, form, options, { withReason = false } = {}) {
  const body = {}
  if (String(form.title || '').trim() !== String(initial.title || '').trim()) body.title = String(form.title || '').trim()
  if (form.instructions !== initial.instructions) body.instructions = String(form.instructions || '')
  if (form.moduleId !== initial.moduleId || form.unitKey !== initial.unitKey) Object.assign(body, moduleUnitBody(form, options))
  if (!same(form.libraryIds, initial.libraryIds)) body.libraryIds = [...form.libraryIds]
  if (!same(form.response, initial.response)) body.response = { ...form.response }
  const filesNow = filesBody(form, options)
  const filesBefore = filesBody(initial, options)
  if (!same(filesNow, filesBefore)) body.files = filesNow
  DEADLINES.forEach(({ prefix }) => {
    const before = deadlinePair(initial, prefix)
    const after = deadlinePair(form, prefix)
    if (!before.date && !after.date) return
    if (before.date !== after.date || before.time !== after.time) Object.assign(body, deadlineBody(form, prefix))
  })
  if (!same(latePolicyBody(form), latePolicyBody(initial))) body.latePolicy = latePolicyBody(form)
  if (form.countsInAverage !== initial.countsInAverage) body.countsInAverage = form.countsInAverage === true
  if (withReason && String(form.reason || '').trim()) body.reason = String(form.reason).trim()
  return body
}

// Campo da tela para o field que o servidor devolveu na recusa (libraryIds[2] -> libraryIds).
export function formFieldOf(serverField) {
  const field = String(serverField || '')
  if (!field) return ''
  if (/^libraryIds\[/.test(field)) return 'libraryIds'
  if (field === 'files') return 'files.types'
  if (field === 'latePolicy') return 'latePolicy.mode'
  return field
}
