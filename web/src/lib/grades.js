// Notas na interface do IClass.
// O servidor guarda `score` de 0 a 100; as telas mostram 0 a 10 com uma casa
// decimal e vírgula. Nota vazia, texto ou fora da faixa (registros antigos do
// lançamento manual sem validação) nunca aparece como nota: vira "—".

export const GRADE_MAX = 10

function validScore(score) {
  if (score === null || score === undefined || score === '' || typeof score === 'boolean') return null
  const n = Number(score)
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return n
}

// 0-100 -> número 0-10, ou null quando não há nota válida.
export function gradeOf(score) {
  const n = validScore(score)
  return n === null ? null : n / 10
}

export function isValidScore(score) {
  return gradeOf(score) !== null
}

// 0-100 -> 0 a 10 com uma casa, "metade para cima" (73,5 -> 7,4). É a mesma conta
// de roundGrade (backend/utils/submissionAttempts.js), usada no boletim, no quadro,
// nas planilhas e no portal do aluno: a mesma média aparece igual em todo lugar.
// O toFixed(6) tira o ruído de ponto flutuante das médias (7,35 virava 7,3).
export function roundGrade(score) {
  const n = validScore(score)
  return n === null ? null : Math.round(Number(n.toFixed(6))) / 10
}

// "8,5" (ou "—" sem nota válida).
export function fmtGrade(score, empty = '—') {
  const g = roundGrade(score)
  return g === null ? empty : g.toFixed(1).replace('.', ',')
}

// Nota já na escala 0 a 10 (ex.: média calculada pelo servidor) -> "8,5".
export function fmtGradeValue(grade, empty = '—') {
  if (grade === null || grade === undefined || grade === '') return empty
  const n = Number(grade)
  return Number.isFinite(n) ? fmtGrade(n * 10, empty) : empty
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

// Nota digitada (0 a 10, até duas casas) -> score gravado (0 a 100, inteiro).
// Mesma conta do servidor (scoreFromGrade em backend/utils/gradebook.js).
export function scoreFromGrade(grade) {
  return Math.round(Number((grade * GRADE_MAX).toFixed(6)))
}

// Nota digitada e acertos juntos precisam conferir: só o arredondamento (menos de
// 0,1) pode separar a nota GRAVADA da conta acertos/total — 7,41 com 3 de 4 vira
// 7,4 e é recusada como 7,4. Mesma regra do servidor (gradeCountsMismatch em
// backend/utils/gradebook.js).
export function gradeMatchesCounts(grade, correctCount, totalCount) {
  if (grade == null || correctCount == null || !totalCount) return true
  return Math.abs(scoreFromGrade(grade) - (correctCount / totalCount) * 100) < 1 - 1e-9
}

// Validação do lançamento rápido (mesmas regras do servidor). Devolve
// { errors: { campo: mensagem }, payload } — payload só quando não há erro.
// maxQuestions: questões da prova (limite do "Total de questões").
// defaultTotal: total que o servidor usa quando o campo fica vazio — a
// "Quantidade de questões" da turma, sem as excluídas (rota manual-context).
export function validateQuickGrade({ grade, correctCount, totalCount }, { maxQuestions = null, defaultTotal = null } = {}) {
  const errors = {}
  const g = parseGradeInput(grade)
  const c = parseCount(correctCount)
  const t = parseCount(totalCount)
  const fallbackTotal = defaultTotal || maxQuestions || null
  if (Number.isNaN(g)) errors.grade = 'Use um número de 0 a 10 (ex.: 8,5).'
  if (Number.isNaN(c)) errors.correctCount = 'Use um número inteiro (0 ou mais).'
  if (Number.isNaN(t) || t === 0) errors.totalCount = 'Use um número inteiro maior que zero.'
  else if (t != null && maxQuestions && t > maxQuestions) errors.totalCount = `A prova tem ${maxQuestions} questões.`
  if (!errors.correctCount && !errors.totalCount && c != null && t != null && c > t) errors.correctCount = `Não pode passar do total (${t}).`
  if (!errors.correctCount && !errors.totalCount && c != null && t == null && fallbackTotal && c > fallbackTotal) {
    errors.correctCount = maxQuestions && fallbackTotal < maxQuestions
      ? `Nesta turma a prova tem ${fallbackTotal} questões.`
      : `A prova tem ${fallbackTotal} questões.`
  }
  if (g == null && c == null && !errors.grade && !errors.correctCount) errors.grade = 'Informe a nota (0 a 10) ou os acertos.'
  const total = t ?? fallbackTotal
  if (!errors.grade && !errors.correctCount && !errors.totalCount && !gradeMatchesCounts(g, c, total)) {
    // Nota com duas casas é gravada com uma: diz qual nota foi comparada.
    const asStored = Math.abs(scoreFromGrade(g) - g * 10) < 1e-6 ? '' : ` (gravada como ${fmtGrade(scoreFromGrade(g))})`
    errors.grade = `Não confere${asStored} com ${c} de ${total} acertos (${fmtGrade((c / total) * 100)}). Deixe a nota em branco para calcular pelos acertos, ou apague os acertos.`
  }
  if (Object.keys(errors).length) return { errors }
  const payload = {}
  if (g != null) payload.grade = g
  if (c != null) payload.correctCount = c
  if (t != null) payload.totalCount = t
  return { errors: {}, payload }
}

// Nota (0 a 10) que o lançamento vai gravar, para mostrar antes de salvar. Sem
// total digitado, usa o total da turma (defaultTotal), como o servidor.
export function previewQuickGrade(payload, defaultTotal = null) {
  if (!payload) return null
  if (payload.grade != null) return scoreFromGrade(payload.grade) / 10
  const total = payload.totalCount ?? defaultTotal
  if (payload.correctCount != null && total) return Math.round((payload.correctCount / total) * 100) / 10
  return null
}

// Chave do grupo de tentativas dentro de uma turma (aplicação; sem aplicação, a
// prova), como attemptGroupKey do servidor.
export function attemptGroupOf(submission) {
  return submission?.applicationId ? `application:${submission.applicationId}` : `legacy-exam:${submission?.examKey || ''}`
}

// Média das provas publicadas como no painel do aluno, no boletim e em Resultados:
// uma nota por grupo de tentativas (a consolidada pela regra do professor) e a média
// simples dos grupos. Fazer a média por tentativa contava duas vezes a prova
// refeita. Devolve 0 a 100, ou null sem nota válida.
export function consolidatedAverage(submissions) {
  const groups = new Map()
  ;(submissions || []).forEach((submission) => {
    if (submission?.gradePublished !== true) return
    const score = validScore(submission.consolidatedScore)
    const key = attemptGroupOf(submission)
    if (score !== null && !groups.has(key)) groups.set(key, score)
  })
  const scores = [...groups.values()]
  return scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null
}

// Opções do seletor de boletim (aluno em mais de um curso): o nome do curso, nunca
// o id técnico, e, para o professor (restricted), só as matrículas que ele pode
// abrir. A lista de cursos dele (course-summaries) traz só os cursos e as turmas
// do seu escopo; as outras opções aparecem desativadas.
export function boletimChoiceOptions(memberships, summaries, { restricted = false, workspace = {} } = {}) {
  const courses = new Map((Array.isArray(summaries) ? summaries : []).map((course) => [String(course?.id), course]))
  return (memberships || []).map((membership) => {
    const course = courses.get(String(membership.courseId))
    const courseName = course?.name || (membership.courseId && membership.courseId === workspace.courseId ? workspace.courseName || '' : '')
    const allowed = !restricted || (!!course && (!Array.isArray(course.classes) || course.classes.some((cls) => cls?.name === membership.name)))
    return { ...membership, courseName, allowed }
  })
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
