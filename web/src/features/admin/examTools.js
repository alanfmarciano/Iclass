import { compareText } from '../../lib/textSearch'
import { questionMarkdownHtml } from '../exam/QuestionMarkdown'
import { answerSummary, formatPointsLabel, questionTypeLabel } from './questionEditorModel'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
export const VERSION_LABELS = LETTERS.slice(0, 10)
// Versões online: o servidor guarda no máximo 4 (A a D, VERSION_LABELS de
// adminExamConfig.js); a tela diz o limite em vez de cortar sem avisar (AVA-16).
export const ONLINE_VERSIONS_MAX = 4
const QUESTION_TYPES = ['multiple_choice', 'multiple_answer', 'true_false', 'numeric', 'short_answer', 'essay']
const CHOICE_TYPES = new Set(['multiple_choice', 'multiple_answer', 'true_false'])

function typeOf(question) {
  const type = typeof question?.type === 'string' ? question.type.trim() : ''
  return QUESTION_TYPES.includes(type) ? type : 'multiple_choice'
}

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

// Verdadeiro ou falso nunca embaralha (Verdadeiro sempre antes de Falso).
function withDisplayLetters(question, shuffleAnswers, random = Math.random) {
  const keepOrder = typeOf(question) === 'true_false'
  const alternatives = shuffleAnswers && !keepOrder ? shuffle(question.alternatives || [], random) : [...(question.alternatives || [])]
  return {
    ...question,
    alternatives: alternatives.map((alt, index) => ({
      ...alt,
      displayLetter: LETTERS[index],
    })),
  }
}

// Letra(s) da versão: 'B' ou, em várias corretas, 'AC' (como o servidor grava na correção
// ao vivo). Questão sem alternativas (numérica, resposta curta, dissertativa) não tem letra.
function getDisplayAnswer(question) {
  const type = typeOf(question)
  if (!CHOICE_TYPES.has(type)) return ''
  if (type === 'multiple_answer') {
    return question.alternatives.filter((alt) => alt.isCorrect).map((alt) => String(alt.displayLetter || alt.letter || '').toUpperCase()).join('')
  }
  const correct = question.alternatives.find((alt) => alt.isCorrect || alt.letter === question.correctAnswer)
  return String(correct?.displayLetter || correct?.letter || question.correctAnswer || '').toUpperCase()
}

// Campos que vão com a questão da versão: o tipo e os pontos (prévia e impressão) e o
// gabarito dos tipos novos (gabarito impresso). Quem corrige é o servidor, que troca
// esses campos pelos da avaliação ao registrar (freezeSnapshotGrading).
const VERSION_QUESTION_FIELDS = ['type', 'points', 'partialCredit', 'numeric', 'acceptedAnswers', 'review', 'expectedAnswer', 'rubric']
function versionQuestionFields(question) {
  return VERSION_QUESTION_FIELDS.reduce((fields, field) => {
    if (question[field] !== undefined && question[field] !== null) fields[field] = question[field]
    return fields
  }, {})
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
        ...versionQuestionFields(q),
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
      const letters = getDisplayAnswer(question)
      if (letters) answerKey[index + 1] = letters
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

// Formulário "Corrigir questão" do Monitor: alternativas na ordem original (A, B, C, D),
// pelas letras do gabarito, qualquer que seja a versão em que a contestação chegou (a
// versão embaralhada mostrava C, A, D, B). O servidor aplica a correção mantendo a
// ordem de cada versão.
export function liveCorrectionDraft(question = {}) {
  const source = Array.isArray(question?.alternatives) ? question.alternatives : []
  const alternatives = source
    .map((alternative, index) => ({
      letter: String(alternative?.letter || LETTERS[index] || '').toUpperCase(),
      text: alternative?.text || '',
      isCorrect: alternative?.isCorrect === true,
    }))
    .sort((a, b) => compareText(a.letter, b.letter))
  const correctAnswer = String(question?.correctAnswer || alternatives.find((alternative) => alternative.isCorrect)?.letter || alternatives[0]?.letter || 'A').toUpperCase()
  return {
    text: question?.questionText || question?.text || '',
    alternatives: alternatives.map(({ letter, text }) => ({ letter, text })),
    correctAnswer,
  }
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

// Markdown da questão no papel (contrato C4 do P3: pelo QuestionMarkdown). A imagem sai
// sem 'loading="lazy"': na janela de impressão, a imagem fora da tela não carregaria a
// tempo da caixa de impressão.
function printMarkdown(text, options = {}) {
  return questionMarkdownHtml(String(text ?? ''), { links: false, zoom: false, ...options }).replace(/\sloading="lazy"/g, '')
}

function questionPointsValue(question) {
  const value = Number(question?.points)
  return Number.isFinite(value) && value > 0 ? value : 1
}

// Linhas para a resposta escrita no papel: dissertativa com 12, resposta curta com 2.
function answerLines(count) {
  return `<div class="answer-lines">${Array.from({ length: count }).map(() => '<div class="line"></div>').join('')}</div>`
}

// Letras do cartão-resposta de uma questão de escolha (V e F no verdadeiro ou falso).
function bubbleLetters(question) {
  if (typeOf(question) === 'true_false') return [{ label: 'V', letter: 'A' }, { label: 'F', letter: 'B' }]
  const count = Math.max(2, Math.min(8, (question.alternatives || []).length || 5))
  return LETTERS.slice(0, count).map((letter) => ({ label: letter, letter }))
}

// Letras certas na versão (as de exibição), para pintar o gabarito rápido.
function correctDisplayLetters(question, keyValue) {
  if (typeOf(question) === 'true_false') {
    const correct = (question.alternatives || []).find((alt) => alt.isCorrect)
    const original = String(correct?.letter || question.correctAnswer || '').toUpperCase()
    return new Set(original ? [original] : [])
  }
  return new Set(String(keyValue || '').toUpperCase().split('').filter(Boolean))
}

function questionBodyHtml(question) {
  const type = typeOf(question)
  if (type === 'true_false') return '<p class="tf">(&nbsp;&nbsp;) Verdadeiro &nbsp;&nbsp;&nbsp; (&nbsp;&nbsp;) Falso</p>'
  if (type === 'multiple_choice' || type === 'multiple_answer') {
    return (question.alternatives || []).map((alt) => `<div class="alt"><span class="alt-letter">${escapeHtml((alt.displayLetter || alt.letter || '').toLowerCase())})</span><div class="md">${printMarkdown(alt.text, { choice: true })}</div></div>`).join('')
  }
  if (type === 'numeric') {
    const unit = question.numeric?.unit ? ` ${escapeHtml(question.numeric.unit)}` : ''
    return `<p class="answer-inline">Resposta: <span class="blank"></span>${unit}</p>`
  }
  if (type === 'short_answer') return `<p class="answer-label">Resposta:</p>${answerLines(2)}`
  return `<p class="answer-label">Resposta:</p>${answerLines(12)}`
}

function rubricHtml(question) {
  const rubric = Array.isArray(question.rubric) ? question.rubric : []
  if (!rubric.length) return ''
  return `<ul class="rubric">${rubric.map((criterion) => `<li>${escapeHtml(criterion.nome || criterion.name || '')}: ${escapeHtml(formatPointsLabel(criterion.pontos ?? criterion.points ?? 0))}</li>`).join('')}</ul>`
}

// Resposta certa no gabarito detalhado: letras da versão, Verdadeiro ou Falso, o número
// com a tolerância, as respostas aceitas ou "Dissertativa" com a resposta esperada e a
// rubrica.
function answerKeyItemHtml(question, index, keyValue, showPoints) {
  const type = typeOf(question)
  const key = CHOICE_TYPES.has(type) && type !== 'true_false'
    ? (type === 'multiple_answer' ? String(keyValue || '').split('').join(', ') : String(keyValue || '-'))
    : (type === 'essay' ? 'Dissertativa: correção pelo professor' : answerSummary(question) || '-')
  const meta = [questionTypeLabel(type), showPoints ? formatPointsLabel(questionPointsValue(question)) : null].filter(Boolean).join(' · ')
  const expected = type === 'essay' && question.expectedAnswer
    ? `<p class="expected"><b>Resposta esperada:</b> ${escapeHtml(question.expectedAnswer)}</p>`
    : ''
  return `<div class="key-item"><p><b>${index + 1}. ${escapeHtml(key)}</b> <span class="kmeta">(${escapeHtml(meta)})</span></p><div class="md small">${printMarkdown(question.text)}</div>${expected}${type === 'essay' ? rubricHtml(question) : ''}</div>`
}

function printDocumentHtml({ title, snapshots, answerKey, includeAnswerKey = false }) {
  const date = new Date().toLocaleDateString('pt-BR')
  const renderPages = (answerKey) => snapshots.map((snapshot, versionIndex) => {
    const code = snapshot.examCode || snapshot.version || VERSION_LABELS[versionIndex]
    const count = snapshot.count || snapshot.questions.length
    const questions = snapshot.questions.slice(0, count)
    // Pontos de cada questão só aparecem quando a prova tem pontos diferentes de 1 ou
    // tipos novos (a prova de antes sai como sempre saiu).
    const showPoints = questions.some((q) => questionPointsValue(q) !== 1 || typeOf(q) !== 'multiple_choice')
    const totalPoints = Math.round(questions.reduce((sum, q) => sum + questionPointsValue(q), 0) * 100) / 100
    // Cartão-resposta só com as questões de escolha; a resposta escrita vai na questão.
    const hasChoice = questions.some((q) => CHOICE_TYPES.has(typeOf(q)))
    // Até 5 letras por questão, 5 colunas (como sempre); com 6 a 8 alternativas, 3.
    const wideRows = questions.some((q) => CHOICE_TYPES.has(typeOf(q)) && bubbleLetters(q).length > 5)
    const bubbleRows = questions.map((q, index) => {
      if (!CHOICE_TYPES.has(typeOf(q))) return `<div class="bubble-row"><b>${index + 1}.</b><span class="write">resposta escrita</span></div>`
      const filled = answerKey ? correctDisplayLetters(q, snapshot.answerKey?.[index + 1]) : new Set()
      return `<div class="bubble-row"><b>${index + 1}.</b>${bubbleLetters(q).map(({ label, letter }) => `<span class="bubble ${filled.has(letter) ? 'filled' : ''}">${label}</span>`).join('')}</div>`
    }).join('')
    const questionsHtml = answerKey
      ? `<h2>Gabarito detalhado</h2>${questions.map((q, index) => answerKeyItemHtml(q, index, snapshot.answerKey?.[index + 1], showPoints)).join('')}`
      : questions.map((q, index) => {
        const type = typeOf(q)
        const points = showPoints ? ` <span class="pts">(${escapeHtml(formatPointsLabel(questionPointsValue(q)))})</span>` : ''
        const hint = type === 'multiple_answer' ? ' <span class="hint">Marque todas as corretas.</span>' : ''
        return `<div class="question ${type === 'essay' ? 'essay' : ''}"><div class="qhead"><b>${index + 1}.</b>${points}${hint}</div><div class="md">${printMarkdown(q.text)}</div>${questionBodyHtml(q)}</div>`
      }).join('')
    const meta = `${escapeHtml(title)} - Versão ${escapeHtml(snapshot.version || VERSION_LABELS[versionIndex])} - ${count} questões${showPoints ? ` - ${escapeHtml(formatPointsLabel(totalPoints))}` : ''}`

    return `<section class="page">
      <header><strong>${answerKey ? 'GABARITO DO PROFESSOR' : 'AVALIAÇÃO'}</strong><span>Código ${escapeHtml(code)} - ${date}</span></header>
      ${answerKey ? '' : '<div class="student"><span>Nome:</span><span>Turma:</span><span>Data:</span><span>Nota:</span></div>'}
      <div class="meta">${meta}</div>
      ${hasChoice ? `<div class="sheet"><b>${answerKey ? 'Gabarito rápido' : 'Cartão-resposta'}</b><div class="sheet-grid${wideRows ? ' wide' : ''}">${bubbleRows}</div></div>` : ''}
      ${questionsHtml}
    </section>`
  }).join('')
  const pages = includeAnswerKey
    ? `${renderPages(false)}${renderPages(true)}`
    : renderPages(answerKey)

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    *{box-sizing:border-box} body{font-family:Arial,sans-serif;color:#182033;margin:0;background:white}
    .page{min-height:98vh;padding:0 38px 28px;page-break-after:always}.page:last-child{page-break-after:auto}
    header{display:flex;justify-content:space-between;align-items:center;background:#182033;color:white;margin:0 -38px 18px;padding:22px 38px}
    header strong{font-size:18px} header span{font-size:12px;color:#d7e3ff}.meta{background:#eef3ff;border-left:5px solid #2563eb;padding:10px 12px;margin-bottom:14px;font-weight:700}
    .student{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:16px;border:2px solid #182033;padding:14px;margin-bottom:14px}.student span{border-bottom:1px solid #182033;padding-bottom:14px}
    .sheet{border:2px solid #182033;background:#f8faff;padding:12px;margin-bottom:18px;page-break-inside:avoid}.sheet>b{display:block;text-align:center;margin-bottom:8px}.sheet-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:7px 14px}.sheet-grid.wide{grid-template-columns:repeat(3,1fr)}
    .bubble-row{display:flex;gap:4px;align-items:center;font-family:monospace;font-size:11px}.bubble-row b{width:24px;text-align:right}.bubble{width:16px;height:16px;border:1px solid #182033;border-radius:50%;display:inline-grid;place-items:center;font-size:9px}.bubble.filled{background:#182033!important;color:white!important}.bubble-row .write{font-family:Arial,sans-serif;font-size:10px;color:#596273}
    .question{margin:0 0 16px;page-break-inside:avoid}.question.essay{page-break-inside:auto}.question p{margin:5px 0}.qhead{margin:0 0 2px}.pts{font-size:12px;color:#596273}.hint{font-size:12px;font-style:italic;color:#596273}
    .alt{display:flex;gap:6px;align-items:flex-start;padding-left:18px;margin:4px 0}.alt-letter{flex:0 0 auto}.alt .md{flex:1 1 auto;min-width:0}
    .md{line-height:1.45;overflow-wrap:anywhere}.md p{margin:4px 0}.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}.md img{max-width:100%;height:auto}.md pre{white-space:pre-wrap;background:#f3f5f9;border:1px solid #d7dbe3;padding:6px 8px;font-size:12px}.md code{font-family:monospace}
    .md table{border-collapse:collapse;margin:6px 0;font-size:12px}.md th,.md td{border:1px solid #8a93a6;padding:3px 6px;text-align:left}.md.small{font-size:12px;color:#40495a}
    .tf{padding-left:18px}.answer-inline{padding-left:18px}.answer-inline .blank{display:inline-block;width:180px;border-bottom:1px solid #182033;margin:0 4px}
    .answer-label{margin:8px 0 0;font-size:12px;color:#596273}.answer-lines .line{border-bottom:1px solid #8a93a6;height:28px}
    .key-item{margin:0 0 12px;page-break-inside:avoid}.key-item p{margin:3px 0}.key-item .kmeta{font-weight:400;font-size:12px;color:#596273}.expected{font-size:12px}.rubric{margin:2px 0 0;padding-left:20px;font-size:12px}
    h2{font-size:16px;margin:14px 0 8px}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.page{page-break-after:always}.page:last-child{page-break-after:auto}}
  </style></head><body>${pages}</body></html>`
}

// Só para os testes: o HTML da impressão sem abrir janela.
export const examPrintHtml = printDocumentHtml

export function openPrintWindow({ title, snapshots, answerKey = false, includeAnswerKey = false }) {
  const win = window.open('', '_blank')
  if (!win) return false
  win.document.write(printDocumentHtml({ title, snapshots, answerKey, includeAnswerKey }))
  win.document.close()
  win.onload = () => setTimeout(() => win.print(), 300)
  return true
}
