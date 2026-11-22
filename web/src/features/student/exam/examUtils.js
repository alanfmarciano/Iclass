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
// Tipos de questão (fase 3, P3-S2; o servidor manda type, points, unit e maxLength pela
// lista branca studentQuestion). Questão sem type, ou com um type que esta tela não
// conhece, é "uma correta", como sempre foi.
export const QUESTION_TYPES = Object.freeze(['multiple_choice', 'multiple_answer', 'true_false', 'numeric', 'short_answer', 'essay'])
const CHOICE_TYPES = new Set(['multiple_choice', 'multiple_answer', 'true_false'])
// Tamanho máximo da resposta digitada, se o servidor não disser (o mesmo de examScoring.js).
export const DEFAULT_ANSWER_LIMITS = Object.freeze({ numeric: 32, short_answer: 300, essay: 10000 })

export function questionTypeOf(q) {
  const type = typeof q?.type === 'string' ? q.type.trim() : ''
  return QUESTION_TYPES.includes(type) ? type : 'multiple_choice'
}

export function isChoiceQuestion(q) {
  return CHOICE_TYPES.has(questionTypeOf(q))
}

function questionPoints(raw) {
  const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() ? Number(raw) : NaN)
  return Number.isFinite(value) && value > 0 && value <= 100 ? Math.round(value * 100) / 100 : 1
}

// "1 ponto", "0,5 ponto", "2 pontos", "2,5 pontos".
export function formatQuestionPoints(points) {
  const value = questionPoints(points)
  return `${String(value).replace('.', ',')} ${value < 2 ? 'ponto' : 'pontos'}`
}

export function normQuestion(q, i) {
  const number = Number(q.originalNumber ?? q.number ?? i + 1)
  const type = questionTypeOf(q)
  const rawAlternatives = Array.isArray(q.alternatives)
    ? q.alternatives
    : Object.entries(q.alternatives || {}).map(([letter, text]) => ({ letter, text }))
  const alternatives = CHOICE_TYPES.has(type)
    ? rawAlternatives.map((a, j) => ({
      id: String(a?.id || positionLabel(j)).toUpperCase(),
      label: positionLabel(j),
      text: a?.text ?? a?.label ?? String(a),
    }))
    : []
  const maxLength = Number(q.maxLength)
  return {
    number,
    type,
    points: questionPoints(q.points),
    unit: type === 'numeric' && typeof q.unit === 'string' ? q.unit.trim().slice(0, 20) : '',
    maxLength: DEFAULT_ANSWER_LIMITS[type]
      ? (Number.isInteger(maxLength) && maxLength > 0 ? Math.min(maxLength, DEFAULT_ANSWER_LIMITS[type]) : DEFAULT_ANSWER_LIMITS[type])
      : null,
    text: q.questionText || q.text || `Questão ${number}`,
    alternatives,
    isAdditional: q.isAdditional === true,
    replacedQuestionNumber: q.replacedQuestionNumber || null,
  }
}

// Posições (1, 2, 3... na ordem da prova) das questões sem resposta, para a confirmação
// do envio.
export function blankQuestionPositions(questions, answers, hasAnswer) {
  return (Array.isArray(questions) ? questions : [])
    .map((q, index) => (hasAnswer((answers || {})[q.number]) ? null : index + 1))
    .filter((position) => position !== null)
}

// "2", "2 e 5", "2, 5 e 7".
export function joinPositions(positions) {
  const list = positions.map(String)
  if (list.length <= 1) return list.join('')
  return `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`
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
