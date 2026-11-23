// Formulário da tela Corrigir (fase 3, P3-S4b / A18: AVA-07; contrato C1 do desenho P3).
// Sem React, para o teste do contrato da tela (test/backend/manual-correction.test.js)
// montar o pedido exatamente como a tela.
//
// A entrega vem de GET /api/admin/submissions/:id/correction (adminCorrections.js):
// questoes[] com { questionNumber, type, points, precisaDoProfessor, automatico
// { pointsEarned, pointsPossible, isCorrect, pending }, annulled, item { pontos,
// comentario, rubrica, motivo } | null, rubric[{ id, nome, pontos }] }. O pedido é o do
// POST da mesma rota: { versao, itens: { [n]: { pontos, comentario, rubrica, motivo } |
// null }, comentarioGeral, concluir, motivo }.
//
// A conta da nota é do servidor (examCorrection.js + regradeFromOwnSnapshot); aqui só
// os pontos digitados de cada questão, conferidos como o servidor confere (de 0 aos
// pontos da questão, cada critério de 0 aos pontos dele), para o erro aparecer no campo
// antes de mandar.

// Os mesmos tetos do servidor (examCorrection.js).
export const CORRECTION_LIMITS = Object.freeze({ commentMax: 2000, generalMax: 3000, reasonMax: 500, reasonMin: 3 })

const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))

// "1,5" → 1.5 · "" → null · "abc" → NaN.
export function parsePoints(text) {
  const value = String(text ?? '').trim().replace(',', '.')
  if (!value) return null
  if (!/^\d+(\.\d+)?$/.test(value)) return Number.NaN
  return Number(value)
}

// 1.5 → "1,5" (o campo mostra com vírgula).
export function pointsText(value) {
  if (!finite(value)) return ''
  return String(Math.round(Number(value) * 100) / 100).replace('.', ',')
}

const roundPoints = (value) => Math.round(Number(value) * 100) / 100

export function questionKey(question) {
  return String(question?.questionNumber)
}

// Questão que a tela abre para o professor lançar: a que espera por ele (dissertativa,
// resposta curta sem gabarito ou a do papel) e a objetiva que ele já ajustou. A objetiva
// sem ajuste fica com a conta do sistema e um "Ajustar pontos".
export function needsTeacher(question) {
  return question?.precisaDoProfessor === true
}

export function hasRubric(question) {
  return Array.isArray(question?.rubric) && question.rubric.length > 0
}

// Rascunho da tela a partir da entrega: um item por questão, com o que já está gravado.
export function initialDraft(questoes) {
  const draft = {}
  ;(questoes || []).forEach((question) => {
    const item = question?.item || null
    const rubrica = {}
    if (item?.rubrica && typeof item.rubrica === 'object') {
      Object.entries(item.rubrica).forEach(([id, value]) => { rubrica[id] = pointsText(value) })
    }
    draft[questionKey(question)] = {
      pontos: item && finite(item.pontos) ? pointsText(item.pontos) : '',
      comentario: item?.comentario ? String(item.comentario) : '',
      rubrica,
      motivo: item?.motivo ? String(item.motivo) : '',
      // Objetiva com ajuste já gravado: o campo dos pontos fica aberto.
      ajustando: !needsTeacher(question) && !!item && finite(item.pontos),
    }
  })
  return draft
}

function sameRubric(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
  for (const key of keys) {
    if (String(a?.[key] ?? '').trim() !== String(b?.[key] ?? '').trim()) return false
  }
  return true
}

export function itemChanged(current = {}, initial = {}) {
  return String(current.pontos ?? '').trim() !== String(initial.pontos ?? '').trim()
    || String(current.comentario ?? '') !== String(initial.comentario ?? '')
    || String(current.motivo ?? '').trim() !== String(initial.motivo ?? '').trim()
    || !sameRubric(current.rubrica, initial.rubrica)
}

// Soma dos critérios digitados (null quando nenhum foi preenchido; NaN com um inválido).
export function rubricTotal(question, entry) {
  if (!hasRubric(question)) return null
  const values = question.rubric
    .map((criterion) => parsePoints(entry?.rubrica?.[criterion.id]))
    .filter((value) => value !== null)
  if (!values.length) return null
  if (values.some((value) => Number.isNaN(value))) return Number.NaN
  return roundPoints(values.reduce((sum, value) => sum + value, 0))
}

// Os pontos que valem para a questão no rascunho: os digitados (ou a soma da rubrica);
// null quando o professor ainda não lançou.
export function draftPoints(question, entry) {
  const total = rubricTotal(question, entry)
  if (total !== null) return total
  return parsePoints(entry?.pontos)
}

// Erros por campo, como o servidor diria: { 'itens.2.pontos': '...', ... }.
export function validateDraft(questoes, draft) {
  const errors = {}
  ;(questoes || []).forEach((question) => {
    const key = questionKey(question)
    const entry = draft?.[key]
    if (!entry) return
    const possible = Number(question.points ?? question.automatico?.pointsPossible ?? 1)
    if (hasRubric(question)) {
      question.rubric.forEach((criterion) => {
        const value = parsePoints(entry.rubrica?.[criterion.id])
        if (value === null) return
        if (Number.isNaN(value) || value < 0 || value > Number(criterion.pontos) + 1e-9) {
          errors[`itens.${key}.rubrica.${criterion.id}`] = `De 0 a ${pointsText(criterion.pontos)} ${Number(criterion.pontos) === 1 ? 'ponto' : 'pontos'}.`
        }
      })
    }
    const total = rubricTotal(question, entry)
    const points = total !== null ? total : parsePoints(entry.pontos)
    if (points === null) return
    if (Number.isNaN(points) || points < 0) {
      errors[`itens.${key}.pontos`] = 'Use um número a partir de 0 (por exemplo, 1,5).'
      return
    }
    if (points > possible + 1e-9) {
      errors[`itens.${key}.pontos`] = `No máximo ${pointsText(possible)} ${possible === 1 ? 'ponto' : 'pontos'}.`
      return
    }
    // Objetiva que o sistema corrigiu: mudar os pontos pede o motivo.
    const automatic = question.automatico?.pointsEarned
    if (!needsTeacher(question) && finite(automatic) && Math.abs(points - Number(automatic)) > 1e-9 && String(entry.motivo || '').trim().length < CORRECTION_LIMITS.reasonMin) {
      errors[`itens.${key}.motivo`] = 'Informe o motivo: o sistema corrigiu esta questão pelo gabarito.'
    }
  })
  return errors
}

// Questões que esperam o professor e ainda estão sem pontos no rascunho (o servidor
// recusa concluir com elas: correction_incomplete).
export function missingQuestions(questoes, draft) {
  return (questoes || [])
    .filter((question) => needsTeacher(question) && question.annulled !== true)
    .filter((question) => draftPoints(question, draft?.[questionKey(question)]) === null)
    .map((question) => Number(question.questionNumber))
}

// O corpo do POST: só as questões que mudaram. A questão com rubrica manda a rubrica (os
// pontos são a soma, feita no servidor); a sem rubrica manda os pontos. Pontos apagados
// vão como null.
export function correctionBody({ questoes, draft, initial, versao, comentarioGeral, comentarioGeralInicial = '', concluir = false, motivo = '' }) {
  const itens = {}
  ;(questoes || []).forEach((question) => {
    const key = questionKey(question)
    const entry = draft?.[key]
    if (!entry || !itemChanged(entry, initial?.[key])) return
    const item = { comentario: String(entry.comentario || '').slice(0, CORRECTION_LIMITS.commentMax) }
    const total = rubricTotal(question, entry)
    if (hasRubric(question) && total !== null) {
      const rubrica = {}
      question.rubric.forEach((criterion) => {
        const value = parsePoints(entry.rubrica?.[criterion.id])
        if (value !== null) rubrica[criterion.id] = value
      })
      item.rubrica = rubrica
    } else {
      item.pontos = parsePoints(entry.pontos)
      if (hasRubric(question)) item.rubrica = null
    }
    const reason = String(entry.motivo || '').trim()
    if (reason) item.motivo = reason.slice(0, CORRECTION_LIMITS.reasonMax)
    itens[key] = item
  })
  const body = { versao: Number(versao) || 0, itens }
  if (String(comentarioGeral ?? '') !== String(comentarioGeralInicial ?? '')) body.comentarioGeral = String(comentarioGeral || '').slice(0, CORRECTION_LIMITS.generalMax)
  if (concluir) body.concluir = true
  const reason = String(motivo || '').trim()
  if (reason) body.motivo = reason.slice(0, CORRECTION_LIMITS.reasonMax)
  return body
}

// Nome na fila: o do aluno, ou "Aluno N" na correção sem ver o nome (a ordem da fila,
// que é a de envio).
export function queueLabel(entry, index, { anonymous = false } = {}) {
  if (anonymous) return `Aluno ${index + 1}`
  return entry?.aluno?.name || entry?.aluno?.email || `Aluno ${index + 1}`
}
