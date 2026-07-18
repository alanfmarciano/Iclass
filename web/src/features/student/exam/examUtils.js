// Seleciona o snapshot de questões correspondente à versão sorteada para o aluno.
export function pickSnapshot(cfg, assignedVersion) {
  const snaps = Array.isArray(cfg?.versionSnapshots) ? cfg.versionSnapshots : []
  if (snaps.length === 0) return null
  const v = String(assignedVersion || 'A')
  return snaps.find((s) => String(s.version || s.label || s.name) === v) || snaps[0]
}
// Normaliza uma questão para render (número, enunciado, alternativas com letra).
export function normQuestion(q, i) {
  const number = Number(q.originalNumber ?? q.number ?? i + 1)
  const rawAlternatives = Array.isArray(q.alternatives)
    ? q.alternatives
    : Object.entries(q.alternatives || {}).map(([letter, text]) => ({ letter, text }))
  const alternatives = rawAlternatives.map((a, j) => ({
    letter: (a.letter || String.fromCharCode(65 + j)).toUpperCase(),
    text: a.text ?? a.label ?? String(a),
  }))
  return {
    number,
    text: q.questionText || q.text || `Questão ${number}`,
    alternatives,
    isAdditional: q.isAdditional === true,
    replacedQuestionNumber: q.replacedQuestionNumber || null,
  }
}
export function fmtTime(sec) {
  if (sec == null || sec < 0) return '--:--'
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
