const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
export const VERSION_LABELS = LETTERS.slice(0, 10)

function seededRandom(seed) {
  const text = String(seed)
  let state = 2166136261
  for (let i = 0; i < text.length; i++) {
    state ^= text.charCodeAt(i)
    state = Math.imul(state, 16777619)
  }
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffle(list, random = Math.random) {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export function generateExamCode(random = Math.random) {
  return random().toString(36).slice(2, 6).padEnd(4, '0').toUpperCase()
}

export function normalizeQuestion(question, index = 0) {
  const originalNumber = Number(question?.originalNumber || question?.number || index + 1)
  const correct = String(question?.correctAnswer || question?.correct || question?.answer || '').toUpperCase()
  const rawAlternatives = Array.isArray(question?.alternatives)
    ? question.alternatives
    : Object.entries(question?.alternatives || {}).map(([letter, text]) => ({ letter, text }))
  const alternatives = rawAlternatives.map((alt, altIndex) => {
    const letter = String(alt.letter || LETTERS[altIndex] || '').toUpperCase()
    return {
      letter,
      displayLetter: String(alt.displayLetter || letter).toUpperCase(),
      text: alt.text || alt.label || String(alt),
      isCorrect: alt.isCorrect === true || (!!correct && letter === correct),
    }
  })
  const correctAlt = alternatives.find((alt) => alt.isCorrect) || alternatives.find((alt) => alt.letter === correct)
  return {
    ...question,
    originalNumber: Number.isFinite(originalNumber) ? originalNumber : index + 1,
    text: question?.text || question?.questionText || `Questão ${index + 1}`,
    questionText: question?.questionText || question?.text || `Questão ${index + 1}`,
    correctAnswer: correctAlt?.letter || correct,
    alternatives,
  }
}

export function normalizeEvaluation(evaluation) {
  return {
    ...evaluation,
    questions: (evaluation?.questions || []).map(normalizeQuestion),
  }
}

export function getQuestionUsageMap(history = []) {
  return history.reduce((acc, entry, index) => {
    const label = entry.label || (entry.type === 'impressa' ? `Impressa #${index + 1}` : `Online #${index + 1}`)
    ;(entry.questionNumbers || []).forEach((number) => {
      const key = Number(number)
      if (!acc[key]) acc[key] = []
      acc[key].push({ label, type: entry.type || 'online', createdAt: entry.createdAt })
    })
    return acc
  }, {})
}

function withDisplayLetters(question, shuffleAnswers, random = Math.random) {
  const alternatives = shuffleAnswers ? shuffle(question.alternatives || [], random) : [...(question.alternatives || [])]
  return {
    ...question,
    alternatives: alternatives.map((alt, index) => ({
      ...alt,
      displayLetter: LETTERS[index],
    })),
  }
}

function getDisplayAnswer(question) {
  const correct = question.alternatives.find((alt) => alt.isCorrect || alt.letter === question.correctAnswer)
  return String(correct?.displayLetter || correct?.letter || question.correctAnswer || '').toUpperCase()
}

export function buildExamVersions(evaluation, options = {}) {
  const normalized = normalizeEvaluation(evaluation)
  const excluded = new Set((options.excludedNumbers || []).map(Number))
  const available = normalized.questions.filter((q) => !excluded.has(Number(q.originalNumber)))
  const requestedCount = Number(options.questionCount) || available.length
  const count = Math.max(0, Math.min(requestedCount, available.length))
  const seed = options.seed ?? Math.random()
  const randomFor = (scope) => seededRandom(`${seed}:${scope}`)
  const baseSet = (options.shuffleQuestions && count < available.length ? shuffle(available, randomFor('base')) : available).slice(0, count)
  const versionCount = Math.max(1, Math.min(Number(options.versionCount) || 1, VERSION_LABELS.length))

  return VERSION_LABELS.slice(0, versionCount).map((version, versionIndex) => {
    const ordered = options.shuffleQuestions && versionCount > 1 ? shuffle(baseSet, randomFor(`questions:${versionIndex}`)) : [...baseSet]
    const questions = ordered.map((question, index) => {
      const q = withDisplayLetters(question, options.shuffleAnswers, randomFor(`answers:${versionIndex}:${question.originalNumber}`))
      return {
        originalNumber: q.originalNumber,
        examNumber: index + 1,
        text: q.text,
        questionText: q.questionText || q.text,
        correctAnswer: q.correctAnswer,
        alternatives: q.alternatives,
      }
    })
    const answerKey = {}
    questions.forEach((question, index) => {
      answerKey[index + 1] = getDisplayAnswer(question)
    })
    return {
      version,
      examCode: options.codes?.[versionIndex] || generateExamCode(randomFor(`code:${versionIndex}`)),
      count: questions.length,
      answerKey,
      questions,
    }
  })
}

// Aplicação em andamento (sala de espera, rodando ou pausada) entre as aplicações da
// prova na turma. Enquanto ela existir não se prepara outra: o servidor recusa (409)
// e a tela aponta para o Monitor, onde o professor decide o que fazer com as respostas.
const RUNNING_APPLICATION_STATUSES = new Set(['waiting', 'running', 'paused'])
export function runningApplicationOf(applications = []) {
  return (Array.isArray(applications) ? applications : []).find((item) => item && RUNNING_APPLICATION_STATUSES.has(item.status)) || null
}

export function snapshotsFromHistory(entry) {
  const raw = Array.isArray(entry?.printSnapshot)
    ? entry.printSnapshot
    : (entry?.printSnapshot?.questions ? [entry.printSnapshot] : [])
  return raw
    .filter((snapshot) => Array.isArray(snapshot?.questions) && snapshot.questions.length > 0)
    .map((snapshot, index) => ({
      version: snapshot.version || VERSION_LABELS[index],
      examCode: snapshot.examCode || entry.examCode || generateExamCode(),
      count: snapshot.count || snapshot.questions.length,
      answerKey: snapshot.answerKey || {},
      questions: snapshot.questions.map(normalizeQuestion),
    }))
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function printDocumentHtml({ title, snapshots, answerKey, includeAnswerKey = false }) {
  const date = new Date().toLocaleDateString('pt-BR')
  const renderPages = (answerKey) => snapshots.map((snapshot, versionIndex) => {
    const code = snapshot.examCode || snapshot.version || VERSION_LABELS[versionIndex]
    const count = snapshot.count || snapshot.questions.length
    const bubbleRows = answerKey
      ? snapshot.questions.slice(0, count).map((_, index) => {
        const correct = snapshot.answerKey?.[index + 1]
        return `<div class="bubble-row"><b>${index + 1}.</b>${LETTERS.slice(0, 5).map((letter) => `<span class="bubble ${correct === letter ? 'filled' : ''}">${letter}</span>`).join('')}</div>`
      }).join('')
      : Array.from({ length: count }).map((_, index) => `<div class="bubble-row"><b>${index + 1}.</b>${LETTERS.slice(0, 5).map((letter) => `<span class="bubble">${letter}</span>`).join('')}</div>`).join('')
    const questionsHtml = answerKey
      ? `<h2>Gabarito detalhado</h2>${snapshot.questions.slice(0, count).map((q, index) => `<p><b>${index + 1}. ${escapeHtml(snapshot.answerKey?.[index + 1] || '-')}</b> - ${escapeHtml(q.text)}</p>`).join('')}`
      : snapshot.questions.slice(0, count).map((q, index) => `<div class="question"><p><b>${index + 1}.</b> ${escapeHtml(q.text)}</p>${(q.alternatives || []).map((alt) => `<p class="alt">${escapeHtml((alt.displayLetter || alt.letter || '').toLowerCase())}) ${escapeHtml(alt.text)}</p>`).join('')}</div>`).join('')

    return `<section class="page">
      <header><strong>${answerKey ? 'GABARITO DO PROFESSOR' : 'AVALIAÇÃO'}</strong><span>Código ${escapeHtml(code)} - ${date}</span></header>
      ${answerKey ? '' : '<div class="student"><span>Nome:</span><span>Turma:</span><span>Data:</span><span>Nota:</span></div>'}
      <div class="meta">${escapeHtml(title)} - Versão ${escapeHtml(snapshot.version || VERSION_LABELS[versionIndex])} - ${count} questões</div>
      <div class="sheet"><b>${answerKey ? 'Gabarito rápido' : 'Cartão-resposta'}</b><div class="sheet-grid">${bubbleRows}</div></div>
      ${questionsHtml}
    </section>`
  }).join('')
  const pages = includeAnswerKey
    ? `${renderPages(false)}${renderPages(true)}`
    : renderPages(answerKey)

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    *{box-sizing:border-box} body{font-family:Arial,sans-serif;color:#182033;margin:0;background:white}
    .page{min-height:98vh;padding:0 38px 28px;page-break-after:always}.page:last-child{page-break-after:auto}
    header{display:flex;justify-content:space-between;align-items:center;background:#182033;color:white;margin:0 -38px 18px;padding:22px 38px}
    header strong{font-size:18px} header span{font-size:12px;color:#d7e3ff}.meta{background:#eef3ff;border-left:5px solid #2563eb;padding:10px 12px;margin-bottom:14px;font-weight:700}
    .student{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:16px;border:2px solid #182033;padding:14px;margin-bottom:14px}.student span{border-bottom:1px solid #182033;padding-bottom:14px}
    .sheet{border:2px solid #182033;background:#f8faff;padding:12px;margin-bottom:18px;page-break-inside:avoid}.sheet>b{display:block;text-align:center;margin-bottom:8px}.sheet-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:7px 14px}
    .bubble-row{display:flex;gap:5px;align-items:center;font-family:monospace;font-size:11px}.bubble-row b{width:24px;text-align:right}.bubble{width:16px;height:16px;border:1px solid #182033;border-radius:50%;display:inline-grid;place-items:center;font-size:9px}.bubble.filled{background:#182033!important;color:white!important}
    .question{margin:0 0 16px;page-break-inside:avoid}.question p{margin:5px 0}.alt{padding-left:18px}
    h2{font-size:16px;margin:14px 0 8px}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.page{page-break-after:always}.page:last-child{page-break-after:auto}}
  </style></head><body>${pages}</body></html>`
}

export function openPrintWindow({ title, snapshots, answerKey = false, includeAnswerKey = false }) {
  const win = window.open('', '_blank')
  if (!win) return false
  win.document.write(printDocumentHtml({ title, snapshots, answerKey, includeAnswerKey }))
  win.document.close()
  win.onload = () => setTimeout(() => win.print(), 300)
  return true
}
