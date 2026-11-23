// Contas e corpos da correção que o servidor também confere (fase 3, C8 / P1-f; FUN-01):
// os limites dos campos, os dias de atraso do desconto, a nota final e os corpos das rotas
// de correção. Sem import nenhum, para que os testes do servidor carreguem este arquivo no
// Node: test/backend/assignments-correction-screen.test.js compara as contas com
// backend/utils/assignments.js e test/backend/contrato-telas.test.js manda os corpos às
// rotas. As telas usam por tarefas/correction.js.

const DAY_MS = 24 * 60 * 60 * 1000

// Os mesmos limites de backend/utils/assignments.js (LIMITS); conferidos por
// test/backend/assignments-correction-screen.test.js.
export const CORRECTION_LIMITS = Object.freeze({
  commentMax: 5000,
  manualNoteMax: 500,
  reasonMin: 3,
  reasonMax: 500,
  versionsMax: 20,
})

// Dias de atraso como o desconto conta (dia iniciado: 1 minuto já é 1 dia), a mesma conta
// de assignments.latePenaltyPct.
export function lateDaysStarted(lateMs) {
  const late = Math.max(0, Number(lateMs) || 0)
  return late > 0 ? Math.ceil(late / DAY_MS) : 0
}

// Nota final (0 a 100) depois do desconto, a mesma conta de assignments.finalScoreFor
// (nota fora de 0 a 100 é levada ao limite; desconto inteiro de 0 a 100).
export function finalScorePreview(score, penaltyPct) {
  if (score === null || score === undefined || score === '' || typeof score === 'boolean') return null
  const number = Number(score)
  if (!Number.isFinite(number)) return null
  const value = Math.min(100, Math.max(0, number))
  let pct = 0
  if (penaltyPct !== null && penaltyPct !== undefined && penaltyPct !== '' && typeof penaltyPct !== 'boolean') {
    const raw = Math.floor(Number(penaltyPct))
    if (Number.isFinite(raw)) pct = Math.min(100, Math.max(0, raw))
  }
  return Math.max(0, Math.min(100, Math.round(Number((value * (100 - pct) / 100).toFixed(6)))))
}

// ------------------------------------------------------------ corpos das rotas
// POST /api/admin/assignments/:id/grade (salvar e devolver). version só quando a entrega
// tem versões (sem elas, o servidor corrige a entrega em mãos ou o zero sem entrega).
export function gradeBody({ studentEmail, action, gradeText, comment, version = null, waivePenalty = false, reason = '' }) {
  const body = { studentEmail, action, grade: String(gradeText ?? '').trim(), comment: String(comment ?? ''), waivePenalty: !!waivePenalty }
  if (typeof version === 'number' && version > 0) body.version = version
  if (reason) body.reason = reason
  return body
}

// POST .../grade com action 'refazer': comentário (o que refazer) e o prazo novo.
export function redoBody({ studentEmail, gradeText, comment, version = null, waivePenalty = false, dueDate, dueTime, closeDate = '', closeTime = '', reason = '' }) {
  const body = { ...gradeBody({ studentEmail, action: 'refazer', gradeText, comment, version, waivePenalty, reason }), redoDueDate: dueDate, redoDueTime: dueTime }
  if (closeDate) {
    body.redoCloseDate = closeDate
    body.redoCloseTime = closeTime || '23:59'
  }
  return body
}

// POST .../extension: prazo individual e motivo.
export function extensionBody({ studentEmail, dueDate, dueTime, closeDate = '', closeTime = '', reason }) {
  const body = { studentEmail, dueDate, dueTime, reason: String(reason ?? '').trim() }
  if (closeDate) {
    body.closeDate = closeDate
    body.closeTime = closeTime || '23:59'
  }
  return body
}

// POST .../manual-entry: observação e, se o professor quiser, a nota (e devolver já).
export function manualEntryBody({ studentEmail, note, gradeText = '', comment = '', returnNow = false }) {
  const body = { studentEmail, note: String(note ?? '').trim(), returnNow: !!returnNow }
  const grade = String(gradeText ?? '').trim()
  if (grade) body.grade = grade
  if (String(comment ?? '').trim()) body.comment = String(comment)
  return body
}
