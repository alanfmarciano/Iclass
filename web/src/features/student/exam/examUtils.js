// Seleciona o snapshot de questões correspondente à versão sorteada para o aluno.
export function pickSnapshot(cfg, assignedVersion) {
  const snaps = Array.isArray(cfg?.versionSnapshots) ? cfg.versionSnapshots : []
  if (snaps.length === 0) return null
  const v = String(assignedVersion || 'A')
  return snaps.find((s) => String(s.version || s.label || s.name) === v) || snaps[0]
}

// Letra da posição: A, B, C... na ordem em que a alternativa aparece na tela.
export function positionLabel(index) {
  return String.fromCharCode(65 + index)
}

// Normaliza uma questão para render (número, enunciado e alternativas). O aluno vê a
// letra da POSIÇÃO (label) e a resposta guarda o identificador opaco da alternativa
// (id), que o servidor converte na letra original (AVA-05). Alternativa sem id (lista de
// questões que não passou por studentAlternatives no servidor) responde com a letra da
// POSIÇÃO, nunca com a letter que veio: o servidor lê a letra avulsa de uma tentativa
// nova como posição, e mandar a original corrigiria outra alternativa sem aviso.
export function normQuestion(q, i) {
  const number = Number(q.originalNumber ?? q.number ?? i + 1)
  const rawAlternatives = Array.isArray(q.alternatives)
    ? q.alternatives
    : Object.entries(q.alternatives || {}).map(([letter, text]) => ({ letter, text }))
  const alternatives = rawAlternatives.map((a, j) => ({
    id: String(a?.id || positionLabel(j)).toUpperCase(),
    label: positionLabel(j),
    text: a?.text ?? a?.label ?? String(a),
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

// Tela cheia do navegador (padrão e prefixo webkit do Safari antigo do iPad).
export function fullscreenElement(doc = document) {
  return doc.fullscreenElement || doc.webkitFullscreenElement || null
}

// O navegador permite colocar a página em tela cheia? No iPhone (Safari e navegadores
// de aplicativos) não existe tela cheia para a página, só para vídeo (UXA-02).
export function fullscreenSupported(doc = document) {
  const el = doc.documentElement
  if (!el || (typeof el.requestFullscreen !== 'function' && typeof el.webkitRequestFullscreen !== 'function')) return false
  const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled
  return enabled !== false
}
