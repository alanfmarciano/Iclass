// Notas na interface do IClass.
// O servidor guarda `score` de 0 a 100; as telas mostram 0 a 10 com uma casa
// decimal e vírgula. Nota vazia, texto ou fora da faixa (registros antigos do
// lançamento manual sem validação) nunca aparece como nota: vira "—".

export const GRADE_MAX = 10

// 0-100 -> número 0-10, ou null quando não há nota válida.
export function gradeOf(score) {
  if (score === null || score === undefined || score === '' || typeof score === 'boolean') return null
  const n = Number(score)
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return n / 10
}

export function isValidScore(score) {
  return gradeOf(score) !== null
}

// "8,5" (ou "—" sem nota válida).
export function fmtGrade(score, empty = '—') {
  const g = gradeOf(score)
  return g === null ? empty : g.toFixed(1).replace('.', ',')
}

// Texto digitado pelo professor (0 a 10, vírgula ou ponto) -> número, ou NaN.
export function parseGradeInput(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  if (!/^\d{1,2}(?:[.,]\d{1,2})?$/.test(raw)) return NaN
  const n = Number(raw.replace(',', '.'))
  return n >= 0 && n <= GRADE_MAX ? n : NaN
}

function parseCount(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  return /^\d{1,4}$/.test(raw) ? Number(raw) : NaN
}

// Validação do lançamento rápido (mesmas regras do servidor). Devolve
// { errors: { campo: mensagem }, payload } — payload só quando não há erro.
export function validateQuickGrade({ grade, correctCount, totalCount }, { maxQuestions = null } = {}) {
  const errors = {}
  const g = parseGradeInput(grade)
  const c = parseCount(correctCount)
  const t = parseCount(totalCount)
  if (Number.isNaN(g)) errors.grade = 'Use um número de 0 a 10 (ex.: 8,5).'
  if (Number.isNaN(c)) errors.correctCount = 'Use um número inteiro (0 ou mais).'
  if (Number.isNaN(t) || t === 0) errors.totalCount = 'Use um número inteiro maior que zero.'
  else if (t != null && maxQuestions && t > maxQuestions) errors.totalCount = `A prova tem ${maxQuestions} questões.`
  if (!errors.correctCount && !errors.totalCount && c != null && t != null && c > t) errors.correctCount = `Não pode passar do total (${t}).`
  if (!errors.correctCount && !errors.totalCount && c != null && t == null && maxQuestions && c > maxQuestions) errors.correctCount = `A prova tem ${maxQuestions} questões.`
  if (g == null && c == null && !errors.grade && !errors.correctCount) errors.grade = 'Informe a nota (0 a 10) ou os acertos.'
  if (Object.keys(errors).length) return { errors }
  const payload = {}
  if (g != null) payload.grade = g
  if (c != null) payload.correctCount = c
  if (t != null) payload.totalCount = t
  return { errors: {}, payload }
}

// Nota que o lançamento vai gravar (para mostrar antes de salvar).
export function previewQuickGrade(payload, defaultTotal = null) {
  if (!payload) return null
  if (payload.grade != null) return payload.grade
  const total = payload.totalCount ?? defaultTotal
  if (payload.correctCount != null && total) return Math.round((payload.correctCount / total) * 100) / 10
  return null
}

// Matrículas do aluno como { name, courseId }.
export function studentMemberships(student) {
  const raw = student?.classes?.length ? student.classes : (student?.studentClass ? [student.studentClass] : [])
  return raw
    .map((item) => (typeof item === 'string'
      ? { name: item, courseId: String(student?.courseId || '') }
      : { name: item?.name || item?.className || '', courseId: String(item?.courseId || student?.courseId || '') }))
    .filter((item) => item.name)
}

// Curso/turma do boletim: o do workspace ativo quando o aluno está nele; senão a
// única matrícula; com várias matrículas fora do workspace, o professor escolhe.
export function boletimContext(student, { courseId = '', className = '' } = {}) {
  const memberships = studentMemberships(student)
  const inActiveCourse = memberships.filter((m) => courseId && (!m.courseId || m.courseId === courseId))
  const exact = inActiveCourse.find((m) => m.name === className) || inActiveCourse[0]
  if (exact) return { courseId: exact.courseId || courseId, studentClass: exact.name }
  if (memberships.length === 1) return { courseId: memberships[0].courseId, studentClass: memberships[0].name }
  if (memberships.length > 1) return { choose: memberships }
  return { courseId, studentClass: className }
}
