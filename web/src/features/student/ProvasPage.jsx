import { ClipboardList, Clock, CheckCircle2, Award, Target, TrendingUp, BarChart3, ArrowRight, Download, Search, RotateCcw, ChevronRight, LayoutGrid, List } from 'lucide-react'
import '../../styles/provas-board.css'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageState } from '../../components/ui/PageState'
import { Modal } from '../../components/ui/Modal'
import { MiniLineChart } from '../../components/ui/MiniLineChart'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useStudent } from './useStudent'
import { countByBand, criterioOf, fmtGradeValue, fmtMencao, gradeBand as faixaDaNota, gradeBandRanges, gradeRangeLabel, gradeTone as tomDaNota, situacaoTone } from '../../lib/grades'
import { createContext, useContext, useState, useEffect, useMemo, useRef } from 'react'
import { usePolling } from '../../hooks/usePolling'
import { Link, useNavigate } from 'react-router-dom'
import { matchesSearch } from '../../lib/textSearch'
import { ScheduledExams } from './ScheduledExams'

// Nota e armazenada em escala 0-100 e exibida em 0-10.
const toGrade = (score) => Number(score) / 10
// Critério de nota do curso, do resumo de notas do servidor (GET /api/student/grades-
// summary, C1 do P2); sem critérios configurados, o padrão (média mínima 6,0). A faixa vem
// de web/src/lib/grades.js, a mesma regra do servidor. Os cartões leem pelo contexto.
const CriterioCtx = createContext(criterioOf(null))
const useCriterio = () => useContext(CriterioCtx)
const TONE_TEXT = { success: 'text-success', warning: 'text-warning', danger: 'text-danger' }
const gradeText = (g, criterio) => TONE_TEXT[tomDaNota(g, criterio, 'aluno', 'danger')]
const isPublished = (s) => s.gradePublished === true && !Number.isNaN(Number(s.score))
const isConsidered = (s) => s.countsTowardResult && s.resultStatus !== 'archived'
// Nota de avaliação manual que o professor arquivou: fica na lista e sai da média (o
// servidor manda assessmentArchived, sem nota consolidada), como no Início e no boletim.
const isOutOfResult = (s) => s.resultStatus === 'archived' || s.assessmentArchived === true
// Avaliação manual da turma (trabalho, seminário...; id 'man_*'): o rótulo é o título
// (examTitle), nunca o id técnico.
const isManualKey = (key = '') => String(key).startsWith('man_')
const shortLabel = (key = '') => key.replace(/^Avaliacao_?/i, '').replace(/_/g, ' ').slice(0, 8)
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const labelOf = (s) => (isManualKey(s.examKey) ? clip(String(s.examTitle || 'Avaliação'), 12) : shortLabel(s.examKey))

// ----- Agrupamento por disciplina ou módulo e por tentativa -----
// A seção de cada avaliação é a disciplina (quando o curso calcula a situação por
// disciplina) ou o módulo da estrutura, como o servidor diz no resumo de notas; antes era
// o prefixo do examKey (FUTEC, FECOP...), que não diz nada em prova com outro nome. Nota
// ainda não publicada não está no resumo: fica em "Notas em revisão" até publicar. Nota
// publicada fora do resumo (avaliação da turma que o professor arquivou, fora da média)
// fica em "Outras avaliações". Sem o resumo (ainda carregando ou com erro), tudo fica numa
// seção só, "Avaliações", sem dizer que está em revisão.
const REVIEW_SECTION = { key: 'revisao', name: 'Notas em revisão', media: null }
const OTHER_SECTION_KEY = 'm:__outras__'
const ALL_SECTION = { key: 'todas', name: 'Avaliações', media: null }
// entry: a entrega (com gradePublished) ou só o examKey.
export function sectionsFromSummary(summary) {
  const porDisciplina = new Map((summary?.situacaoPorDisciplina || []).map((item) => [String(item.id), item]))
  const modulos = new Map((summary?.modulos || []).map((item) => [String(item.id), item]))
  const byKey = new Map()
  ;(summary?.itens || []).forEach((item) => {
    if (!item || !item.id || byKey.has(item.id)) return
    const disciplina = item.disciplinaId ? porDisciplina.get(String(item.disciplinaId)) : null
    if (disciplina) {
      byKey.set(item.id, { key: `d:${disciplina.id}`, name: disciplina.nome || item.disciplina || 'Disciplina', media: disciplina.mediaFinal ?? null })
      return
    }
    const moduleId = item.moduloId ? String(item.moduloId) : '__outras__'
    const modulo = modulos.get(moduleId)
    byKey.set(item.id, { key: `m:${moduleId}`, name: item.modulo || modulo?.nome || 'Outras avaliações', media: modulo ? modulo.media ?? null : null })
  })
  const other = { key: OTHER_SECTION_KEY, name: modulos.get('__outras__')?.nome || 'Outras avaliações', media: modulos.get('__outras__')?.media ?? null }
  return (entry) => {
    const examKey = entry && typeof entry === 'object' ? entry.examKey : entry
    const found = byKey.get(String(examKey || ''))
    if (found) return found
    if (!summary) return ALL_SECTION
    if (entry && typeof entry === 'object' && entry.gradePublished === true) return other
    return REVIEW_SECTION
  }
}
// Chave do grupo de tentativas: mesma aplicacao = mesmo grupo (espelha attemptGroupKey do backend).
const groupKeyOf = (s) => String(s.applicationId || s.examKey || '')
const POLICY_LABEL = { highest: 'Maior nota', latest: 'Última tentativa', average: 'Média das tentativas', selected: 'Selecionada pelo professor' }
const MOD_ACCENTS = ['var(--info)', 'var(--success)', 'var(--warning)', 'var(--primary)', 'var(--danger)']
// Mesmo arredondamento do boletim e de Resultados (7,35 -> 7,4).
const fmtGrade = (n) => fmtGradeValue(n)
const BAND_CLASS = { excelente: 'g-success', bom: 'g-info', suficiente: 'g-warning', abaixo: 'g-danger', muito_abaixo: 'g-danger' }
const gradeBand = (g, criterio) => (g == null ? '' : BAND_CLASS[faixaDaNota(g, criterio)] || '')
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString('pt-BR') : '')

// Gráfico "Distribuição": uma barra por faixa de gradeBand (a mesma cor do cartão da
// prova), da mais alta para a mais baixa, com as duas faixas abaixo da mínima juntas.
// Rótulos com vírgula decimal (pt-BR) e limites da nota como aparece (5,96 é 6,0).
const BUCKET_CLASS = { excelente: 'bg-success', bom: 'bg-info', suficiente: 'bg-warning', abaixo: 'bg-danger' }
function distributionBuckets(grades, criterio) {
  const counts = countByBand(grades, criterio)
  const ranges = gradeBandRanges(criterio)
  const below = ranges.filter((r) => r.band === 'abaixo' || r.band === 'muito_abaixo')
  const rows = ranges.filter((r) => !below.includes(r)).map((r) => ({ k: r.label, band: r.band, n: counts[r.band] }))
  if (below.length) {
    const label = gradeRangeLabel(below[0].min, below[below.length - 1].max)
    rows.unshift({ k: label, band: 'abaixo', n: below.reduce((sum, r) => sum + counts[r.band], 0) })
  }
  return rows.reverse().map((row) => ({ ...row, cls: BUCKET_CLASS[row.band] }))
}

// Card de uma prova avulsa (uma tentativa unica).
function ExamCard({ s, onOpen }) {
  const criterio = useCriterio()
  const published = isPublished(s)
  const g = published ? toGrade(s.score) : null
  const archived = s.resultStatus === 'archived'
  const counts = isConsidered(s)
  return (
    <button type="button" onClick={() => onOpen(s)} className="pvb-exam">
      <div>
        <div className="pvb-ename">{s.examTitle || s.examKey}{s.attemptNumber ? ` · Tentativa ${s.attemptNumber}` : ''}</div>
        <div className="pvb-ecode">{(s.type || 'online')}{s.timestamp ? ` · ${fmtDate(s.timestamp)}` : ''}</div>
      </div>
      <div className={`pvb-egrade ${gradeBand(g, criterio)}`}>{fmtGrade(g)}</div>
      <div className="pvb-etail">
        {archived
          ? <span className="pvb-st neutral"><span className="pvb-sdot" />Não considerada</span>
          : s.assessmentArchived === true
            ? <span className="pvb-st neutral"><span className="pvb-sdot" />Avaliação arquivada · fora da média</span>
          : counts
            ? <span className="pvb-st info"><span className="pvb-sdot" />Compõe o resultado</span>
            : !published ? <span className="pvb-st warning"><span className="pvb-sdot" />Em revisão</span> : null}
      </div>
    </button>
  )
}

// Explicacao textual de como o grupo forma a nota, por politica.
function AttemptFormula({ policy, considered, consolidated }) {
  if (policy === 'average') {
    const parts = considered.map((a) => fmtGrade(toGrade(a.score))).join(' + ')
    return <><b>Como entra na sua média:</b> regra da <b>média</b> — ({parts}) ÷ {considered.length} = <b>{fmtGrade(consolidated)}</b>. Esse resultado entra na sua média como uma prova só.</>
  }
  if (policy === 'latest') return <><b>Como entra na sua média:</b> vale a <b>última tentativa</b>. As anteriores ficam registradas, mas não entram no cálculo.</>
  if (policy === 'selected') return <><b>Como entra na sua média:</b> o professor <b>selecionou</b> a tentativa que vale. As demais ficam descartadas.</>
  return <><b>Como entra na sua média:</b> vale a <b>maior nota</b> entre as tentativas. As menores ficam registradas, mas não entram no cálculo.</>
}

// Bloco de multiplas tentativas da mesma prova, mostrando a composicao da nota.
function AttemptGroup({ attempts, onOpen }) {
  const criterio = useCriterio()
  const policy = attempts.map((a) => a.aggregationPolicy).find((p) => POLICY_LABEL[p]) || 'highest'
  const considered = attempts.filter(isConsidered)
  const backendScore = attempts.find((a) => a.consolidatedScore != null)?.consolidatedScore
  // A nota do grupo é a consolidada do servidor; o navegador não recalcula (D3 do P2).
  const consolidated = backendScore != null ? toGrade(backendScore) : null
  const last = attempts[attempts.length - 1]
  return (
    <div className="pvb-attgroup">
      <div className="ag-top">
        <span className="ag-icon"><RotateCcw size={17} /></span>
        <span className="ag-ttl">
          <span className="n">{attempts[0].examTitle || attempts[0].examKey}</span>
          <span className="m">{attempts.length} tentativas{last?.timestamp ? ` · ${fmtDate(last.timestamp)}` : ''}</span>
        </span>
        <span className="ag-policy">{POLICY_LABEL[policy]}</span>
      </div>
      <div className="ag-body">
        <div className="ag-attempts">
          {attempts.map((a) => {
            const g = isPublished(a) ? toGrade(a.score) : null
            const counts = isConsidered(a)
            return (
              <button type="button" key={a.id} onClick={() => onOpen(a)} className={`ag-att ${counts ? 'counts' : 'discard'}`}>
                <span className="an"><b>Tentativa {a.attemptNumber || '—'}</b>{a.timestamp ? ` — ${fmtDate(a.timestamp)}` : ''}</span>
                <span className={`as ${gradeBand(g, criterio)}`}>{fmtGrade(g)}</span>
                <span className="flag">{counts ? 'Conta' : 'Descartada'}</span>
              </button>
            )
          })}
        </div>
        <span className="ag-arrow"><ArrowRight size={22} /></span>
        <div className="ag-result">
          <span className={`rn ${gradeBand(consolidated, criterio)}`}>{fmtGrade(consolidated)}</span>
          <span className="rl">{policy === 'average' ? `Média das ${attempts.length} tentativas` : POLICY_LABEL[policy]}</span>
        </div>
      </div>
      <div className="ag-formula"><AttemptFormula policy={policy} considered={considered} consolidated={consolidated} /></div>
    </div>
  )
}

// Contador animado, respeitando prefers-reduced-motion.
function useCountUp(target, { duration = 900, decimals = 0 } = {}) {
  const [val, setVal] = useState(0)
  useEffect(() => {
    if (target == null || Number.isNaN(Number(target))) { setVal(0); return }
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    if (reduce) { setVal(Number(target)); return }
    let raf, start
    const step = (ts) => {
      if (!start) start = ts
      const p = Math.min((ts - start) / duration, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      setVal(Number(target) * eased)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  if (!decimals) return Math.round(val)
  // Nota com vírgula; o valor final usa o arredondamento do boletim (fmtGradeValue).
  return val === Number(target) ? fmtGradeValue(val) : Number(val).toFixed(decimals).replace('.', ',')
}

function MetricRing({ value }) {
  const criterio = useCriterio()
  const safe = Math.max(0, Math.min(100, (Number(value) || 0) * 10))
  const shown = useCountUp(value ?? 0, { duration: 1100, decimals: 1 })
  const tone = value != null ? gradeText(value, criterio) : 'text-muted'
  return (
    <div className="relative grid h-[68px] w-[68px] shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(var(--primary) ${safe * 3.6}deg, var(--surface-2) 0deg)` }} aria-hidden>
      <div className="grid h-[54px] w-[54px] place-items-center rounded-full bg-surface">
        <span className={`text-base font-bold tabular-nums ${tone}`}>{value != null ? shown : '--'}</span>
      </div>
    </div>
  )
}

function MetricCard({ label, icon: Icon, tone = 'text-primary', children, badge }) {
  return (
    <Card className="premium-card-interactive relative overflow-hidden p-5">
      <span className="absolute -right-6 -top-8 h-20 w-20 rounded-full bg-primary-soft blur-2xl" aria-hidden />
      <div className="flex items-center justify-between gap-3">
        <span className={`grid h-10 w-10 place-items-center rounded-xl bg-surface-2 ${tone}`}><Icon size={17} /></span>
        {badge}
      </div>
      <div className="mt-4">{children}</div>
      <p className="mt-2 text-xs text-subtle">{label}</p>
    </Card>
  )
}

function StatValue({ target, decimals = 0, className = '' }) {
  const shown = useCountUp(target ?? 0, { duration: 1000, decimals })
  return <p className={`text-[1.8rem] font-semibold leading-none tracking-[-0.04em] tabular-nums text-text ${className}`}>{target == null ? '--' : shown}</p>
}

const FILTERS = [
  { key: 'all', label: 'Todas' },
  { key: 'compoe', label: 'Compõem o resultado' },
  { key: 'nao', label: 'Não consideradas' },
]

// Escapa texto para montagem segura do HTML de impressao (PDF).
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Gera um documento imprimivel (print -> Salvar como PDF) com o cabecalho,
// as questoes completas e o gabarito-resumo. Roda 100% no cliente, sem libs.
// Nota com vírgula, como no resto do portal (fmtGrade).
export function buildExamPrintHtml(detail, questions, answerByNumber) {
  const nota = detail?.gradePublished === true ? fmtGrade(toGrade(detail.score || 0)) : '—'
  const acertos = detail?.gradePublished === true ? `${detail.correctCount ?? '-'}/${detail.totalCount ?? '-'}` : '-'
  const versao = detail?.assignedVersion || '-'
  const titulo = detail?.examTitle || detail?.examKey || 'Prova'

  const questoesHtml = (questions || []).map((q) => {
    const a = answerByNumber.get(Number(q.number)) || {}
    const sc = a.studentChoice ? String(a.studentChoice).toUpperCase() : null
    const ca = a.correctAnswer ? String(a.correctAnswer).toUpperCase() : null
    const alts = (q.alternatives || []).map((alt) => {
      const letter = String(alt.letter || '').toUpperCase()
      const correct = ca && letter === ca
      const wrong = sc && letter === sc && !correct
      const cls = correct ? 'alt correct' : wrong ? 'alt wrong' : 'alt'
      const tag = correct ? (sc === letter ? ' &middot; Sua resposta / Correta' : ' &middot; Resposta correta') : (wrong ? ' &middot; Sua resposta' : '')
      return `<div class="${cls}"><span class="ltr">${letter}</span><span>${escapeHtml(alt.text)}${tag ? `<i>${tag}</i>` : ''}</span></div>`
    }).join('')
    return `<div class="q"><div class="qh"><b>Questão ${escapeHtml(q.number)}</b><span class="${a.isCorrect ? 'ok' : 'err'}">${a.isCorrect ? 'Correta' : 'Errada'}</span></div>${q.text ? `<p>${escapeHtml(q.text)}</p>` : ''}${alts}</div>`
  }).join('')

  const resumoRows = (questions || []).map((q) => {
    const a = answerByNumber.get(Number(q.number)) || {}
    return `<tr><td>${escapeHtml(q.number)}</td><td>${escapeHtml(a.studentChoice || '-')}</td><td>${escapeHtml(a.correctAnswer || '-')}</td><td>${a.isCorrect ? 'Correta' : 'Errada'}</td></tr>`
  }).join('')

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(titulo)}</title><style>
    *{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;margin:32px;font-size:13px}
    h1{font-size:20px;margin:0 0 4px}.meta{color:#555;font-size:12px;margin-bottom:14px}
    .stats{display:flex;gap:22px;border-top:1px solid #ddd;border-bottom:1px solid #ddd;padding:10px 0;margin-bottom:18px}
    .stats div span{display:block;color:#777;font-size:11px}.stats div b{font-size:16px}
    .q{border:1px solid #e2e2e2;border-radius:8px;padding:12px 14px;margin-bottom:12px;page-break-inside:avoid}
    .qh{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:12px}
    .qh .ok{color:#127a4f;font-weight:bold}.qh .err{color:#c0293a;font-weight:bold}
    .q p{margin:0 0 10px;font-size:13px;line-height:1.45}
    .alt{display:flex;gap:9px;align-items:flex-start;border:1px solid #e6e6e6;border-radius:6px;padding:7px 9px;margin-bottom:6px}
    .alt .ltr{font-weight:bold;border:1px solid #ccc;border-radius:4px;min-width:20px;text-align:center;padding:0 2px}
    .alt.correct{border-color:#127a4f;background:#e9f7ef}.alt.correct .ltr{background:#127a4f;color:#fff;border-color:#127a4f}
    .alt.wrong{border-color:#c0293a;background:#fdecee}.alt.wrong .ltr{background:#c0293a;color:#fff;border-color:#c0293a}
    .alt i{color:#555;font-style:italic;font-size:11px}
    h2{font-size:14px;margin:22px 0 8px}table{width:100%;border-collapse:collapse;font-size:12px}
    th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}th{background:#f3f3f3}
    @media print{body{margin:14mm}}
  </style></head><body>
    <h1>${escapeHtml(titulo)}</h1>
    <div class="meta">Gabarito liberado &middot; Versão ${escapeHtml(versao)}</div>
    <div class="stats"><div><span>Nota</span><b>${nota}</b></div><div><span>Acertos</span><b>${acertos}</b></div><div><span>Versão</span><b>${escapeHtml(versao)}</b></div></div>
    ${questoesHtml}
    <h2>Gabarito &middot; resumo</h2>
    <table><thead><tr><th>Questão</th><th>Sua resposta</th><th>Correta</th><th>Status</th></tr></thead><tbody>${resumoRows}</tbody></table>
  </body></html>`
}

// Abre a janela de impressão da prova e chama win.print() daqui, da janela de origem,
// como as impressões do professor (examTools, boletim, grade). Sem <script> no HTML: a
// janela about:blank herda a CSP do IClass (script-src 'self', H5d), que bloqueia script
// inline, e a impressão não abriria. Devolve false se o navegador bloqueou o pop-up.
export function openExamPrintWindow(html, openWindow = (...args) => window.open(...args)) {
  const win = openWindow('', '_blank')
  if (!win) return false
  win.document.open()
  win.document.write(html)
  win.document.close()
  let printed = false
  const printNow = () => {
    if (printed) return
    printed = true
    setTimeout(() => {
      try { win.focus(); win.print() } catch { /* janela fechada antes de imprimir */ }
    }, 300)
  }
  // O load de um documento escrito com document.write pode já ter acontecido no close().
  if (win.document.readyState === 'complete') printNow()
  else win.addEventListener('load', printNow, { once: true })
  return true
}

// Visualizacao completa da prova: enunciado, alternativas, resposta do aluno,
// resposta correta e status por questao, com download em PDF e gabarito-resumo.
// Usada quando o gabarito foi liberado e examQuestions esta disponivel.
function FullExamView({ detail, questions, answers }) {
  const answerByNumber = useMemo(() => {
    const map = new Map()
    ;(answers || []).forEach((a) => map.set(Number(a.questionNumber), a))
    return map
  }, [answers])

  const handleDownload = () => {
    openExamPrintWindow(buildExamPrintHtml(detail, questions, answerByNumber))
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted">
          <span className="inline-flex items-center gap-2"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-success" aria-hidden /> Resposta correta</span>
          <span className="inline-flex items-center gap-2"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-danger" aria-hidden /> Sua resposta (errada)</span>
        </div>
        <Button size="sm" variant="primary" icon={Download} onClick={handleDownload}>
          Baixar prova (PDF)
        </Button>
      </div>

      <ol className="space-y-3">
        {questions.map((q, qi) => {
          const answer = answerByNumber.get(Number(q.number)) || {}
          const studentChoice = answer.studentChoice ? String(answer.studentChoice).toUpperCase() : null
          const correctAnswer = answer.correctAnswer ? String(answer.correctAnswer).toUpperCase() : null
          const isCorrect = answer.isCorrect === true
          return (
            <li key={q.number ?? qi} className="rounded-xl border border-border bg-surface-2 p-4">
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-xs font-semibold text-muted">
                  <span className="grid h-6 w-6 place-items-center rounded-md border border-border bg-surface text-text">{q.number}</span>
                  Questão {q.number}
                </span>
                <Badge tone={isCorrect ? 'success' : 'danger'}>{isCorrect ? 'Correta' : 'Errada'}</Badge>
              </div>
              {q.text && <p className="mb-3 text-sm leading-relaxed text-text">{q.text}</p>}
              <div className="space-y-2">
                {(q.alternatives || []).map((alt) => {
                  const letter = String(alt.letter || '').toUpperCase()
                  const isCorrectAlt = correctAnswer && letter === correctAnswer
                  const isChosen = studentChoice && letter === studentChoice
                  const isWrongChosen = isChosen && !isCorrectAlt
                  const box = isCorrectAlt
                    ? 'border-success bg-success-soft'
                    : isWrongChosen
                      ? 'border-danger bg-danger-soft'
                      : 'border-border bg-surface'
                  const letterBox = isCorrectAlt
                    ? 'bg-success text-surface border-success'
                    : isWrongChosen
                      ? 'bg-danger text-surface border-danger'
                      : 'bg-surface-2 text-muted border-border'
                  return (
                    <div key={letter} className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${box}`}>
                      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md border text-xs font-bold ${letterBox}`}>{letter}</span>
                      <span className="pt-0.5 text-text">{alt.text}</span>
                      {(isCorrectAlt || isWrongChosen) && (
                        <span className={`ml-auto shrink-0 self-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${isCorrectAlt ? 'text-success' : 'text-danger'}`}>
                          {isCorrectAlt ? (isChosen ? 'Sua resposta · Correta' : 'Resposta correta') : 'Sua resposta'}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </li>
          )
        })}
      </ol>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Gabarito · resumo</p>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead><tr className="bg-surface-2 text-muted"><th className="px-3 py-2 text-left">Questão</th><th className="px-3 py-2 text-left">Sua resposta</th><th className="px-3 py-2 text-left">Correta</th><th className="px-3 py-2 text-left">Status</th></tr></thead>
            <tbody>
              {questions.map((q, i) => {
                const a = answerByNumber.get(Number(q.number)) || {}
                return (
                  <tr key={q.number ?? i} className="border-t border-border">
                    <td className="px-3 py-2">{q.number}</td>
                    <td className="px-3 py-2">{a.studentChoice || '-'}</td>
                    <td className="px-3 py-2">{a.correctAnswer || '-'}</td>
                    <td className="px-3 py-2"><Badge tone={a.isCorrect ? 'success' : 'danger'}>{a.isCorrect ? 'Correta' : 'Errada'}</Badge></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// "Minhas notas" (B9 / P2-S4): o resultado do aluno na turma como o servidor calculou
// (GET /api/student/grades-summary, só o publicado): média final, situação ("Cursando"
// enquanto falta nota de etapa), menção, notas por etapa com as avaliações publicadas de
// cada uma (em acordeão: toque na etapa para ver) e a média mínima do curso. Nenhum texto
// abaixo de 14 px (text-sm), para ler no celular.
const fmtWeight = (value) => String(value ?? '').replace('.', ',')
// Selo da situação no cartão, em 14 px (o Badge comum é text-xs).
const SELO_TOM = { neutral: 'bg-surface-2 text-muted', success: 'bg-success-soft text-success', danger: 'bg-danger-soft text-danger', warning: 'bg-warning-soft text-warning', info: 'bg-info-soft text-info' }
function Selo({ tone = 'neutral', children }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium ${SELO_TOM[tone] || SELO_TOM.neutral}`}>{children}</span>
}

// Avaliações publicadas de cada etapa (a recuperação da etapa entra nela), da recuperação
// final e as que não entram na média (sem etapa ou "Não conta"). Só agrupa o que o servidor
// mandou; nenhuma conta.
export function gradesByStage(summary) {
  const itens = (Array.isArray(summary?.itens) ? summary.itens : []).filter((item) => item && item.publicada && item.nota !== null && item.nota !== undefined)
  const etapas = Array.isArray(summary?.etapas) ? summary.etapas : []
  const ordens = new Set(etapas.map((etapa) => etapa.ordem))
  const porEtapa = new Map(etapas.map((etapa) => [etapa.ordem, []]))
  const final = []
  const fora = []
  itens.forEach((item) => {
    const rec = /^etapa:(\d+)$/.exec(String(item.recuperacaoDe || ''))
    if (item.foraDaMedia) fora.push(item)
    else if (item.recuperacaoDe === 'final') final.push(item)
    else if (rec && ordens.has(Number(rec[1]))) porEtapa.get(Number(rec[1])).push(item)
    else if (!item.recuperacaoDe && ordens.has(item.etapa)) porEtapa.get(item.etapa).push(item)
    else fora.push(item)
  })
  return { porEtapa, final, fora }
}

function StageRow({ id, title, value, valueTone, note, itens, criterio }) {
  const [open, setOpen] = useState(false)
  const panelId = `etapa-${id}`
  return (
    <li className="rounded-lg border border-border">
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left">
        <ChevronRight size={16} className={`shrink-0 text-subtle transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium text-text">{title}</span>
          {note && <span className="block text-sm text-muted">{note}</span>}
        </span>
        <span className={`shrink-0 text-lg font-semibold tabular-nums ${valueTone}`}>{value}</span>
      </button>
      {open && (
        <div id={panelId} className="border-t border-border px-3 py-2">
          {itens.length === 0
            ? <p className="text-sm text-muted">Nenhuma avaliação com nota publicada nesta etapa ainda.</p>
            : (
              <ul className="divide-y divide-border">
                {itens.map((item) => (
                  <li key={item.id} className="flex items-start justify-between gap-3 py-1.5 text-sm">
                    <span className="min-w-0 break-words text-text">
                      {item.titulo}
                      {item.tipo ? <span className="text-muted"> · {item.tipo}</span> : null}
                      {item.recuperacaoDe ? <span className="text-muted"> · recuperação</span> : null}
                      {item.peso !== null && item.peso !== undefined && !item.recuperacaoDe && !item.foraDaMedia ? <span className="text-muted"> · peso {fmtWeight(item.peso)}</span> : null}
                    </span>
                    <span className={`shrink-0 font-semibold tabular-nums ${gradeText(item.nota, criterio) || 'text-text'}`}>{fmtGrade(item.nota)}</span>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </li>
  )
}

export function MyGradesCard({ summary }) {
  const criterio = useCriterio()
  const comCriterios = summary.regraAntiga === false
  const etapas = Array.isArray(summary.etapas) ? summary.etapas : []
  const disciplinas = Array.isArray(summary.situacaoPorDisciplina) ? summary.situacaoPorDisciplina : []
  const mencao = fmtMencao(summary.mencao)
  const semNotas = !summary.notasPublicadas
  const grupos = useMemo(() => gradesByStage(summary), [summary])
  // Notas devolvidas das tarefas (C18 / P1-j). Com critérios elas já aparecem na etapa;
  // na regra antiga, numa lista própria (as provas ficam no histórico abaixo).
  const tarefas = useMemo(() => (Array.isArray(summary?.itens) ? summary.itens : [])
    .filter((item) => item && item.origem === 'tarefa' && item.publicada && item.nota !== null && item.nota !== undefined), [summary])
  const tone = (value) => (value != null ? gradeText(value, criterio) || 'text-text' : 'text-subtle')
  return (
    <Card as="section" className="p-5" aria-labelledby="minhas-notas-titulo">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="minhas-notas-titulo" className="flex items-center gap-2 font-semibold text-text"><Award size={17} className="text-primary" /> Minhas notas</h2>
        {summary.situacaoRotulo && <Selo tone={situacaoTone(summary.situacao)}>{summary.situacaoRotulo}</Selo>}
      </div>
      {semNotas ? (
        <p className="mt-2 text-sm text-muted">Nenhuma nota publicada ainda. Quando o professor publicar, sua média aparece aqui.</p>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl bg-surface-2 p-3">
            <dt className="text-sm font-medium text-muted">{comCriterios ? 'Média final' : 'Média geral'}</dt>
            <dd className={`mt-1 text-2xl font-semibold tabular-nums ${summary.mediaFinal != null ? gradeText(summary.mediaFinal, criterio) || 'text-text' : 'text-text'}`}>{fmtGrade(summary.mediaFinal)}</dd>
          </div>
          {mencao && (
            <div className="rounded-xl bg-surface-2 p-3">
              <dt className="text-sm font-medium text-muted">Menção</dt>
              <dd className="mt-1 text-base font-semibold text-text">{mencao}{summary.mencao?.nome ? <span className="ml-1 text-sm font-normal text-muted">{summary.mencao.nome}</span> : null}</dd>
            </div>
          )}
          {summary.frequencia !== null && summary.frequencia !== undefined && (
            <div className="rounded-xl bg-surface-2 p-3">
              <dt className="text-sm font-medium text-muted">Frequência</dt>
              <dd className="mt-1 text-base font-semibold tabular-nums text-text">{summary.frequencia}%</dd>
            </div>
          )}
        </dl>
      )}
      {comCriterios && etapas.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-text">Notas por etapa</h3>
          <p className="text-sm text-muted">Toque na etapa para ver as avaliações dela.</p>
          <ul className="mt-2 space-y-2">
            {etapas.map((etapa) => (
              <StageRow key={etapa.ordem} id={etapa.ordem} criterio={criterio}
                title={`${etapa.nome}${etapas.length > 1 ? ` · peso ${fmtWeight(etapa.peso)}` : ''}`}
                value={etapa.semNota ? 'Sem nota' : fmtGrade(etapa.final)}
                valueTone={etapa.semNota ? 'text-subtle' : tone(etapa.final)}
                note={etapa.recuperacao != null ? `Média ${fmtGrade(etapa.media)} · recuperação ${fmtGrade(etapa.recuperacao)}` : ''}
                itens={grupos.porEtapa.get(etapa.ordem) || []} />
            ))}
            {(summary.recuperacaoFinal != null || grupos.final.length > 0) && (
              <StageRow id="final" title="Recuperação final" criterio={criterio}
                value={fmtGrade(summary.recuperacaoFinal)} valueTone={tone(summary.recuperacaoFinal)} itens={grupos.final} />
            )}
            {grupos.fora.length > 0 && (
              <StageRow id="fora" title="Fora da média" criterio={criterio}
                value={String(grupos.fora.length)} valueTone="text-subtle" note="Sem etapa ou marcadas para não contar" itens={grupos.fora} />
            )}
          </ul>
        </div>
      )}
      {!comCriterios && tarefas.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-text">Tarefas</h3>
          <ul className="mt-1 divide-y divide-border">
            {tarefas.map((item) => (
              <li key={item.id} className="flex min-h-[44px] items-center justify-between gap-3 text-sm">
                <Link to={`/aluno/atividades/${encodeURIComponent(item.id)}`} className="min-w-0 break-words py-2 text-text underline-offset-2 hover:underline">
                  {item.titulo}
                  {item.foraDaMedia ? <span className="text-muted"> · fora da média</span> : null}
                </Link>
                <span className={`shrink-0 font-semibold tabular-nums ${item.foraDaMedia ? 'text-muted' : tone(item.nota)}`}>{fmtGrade(item.nota)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {comCriterios && disciplinas.length > 1 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-text">Por disciplina</h3>
          <ul className="mt-2 divide-y divide-border">
            {disciplinas.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                <span className="min-w-0 truncate text-text">{item.nome}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="tabular-nums text-muted">{fmtGrade(item.mediaFinal)}</span>
                  {item.situacaoRotulo && <Selo tone={situacaoTone(item.situacao)}>{item.situacaoRotulo}</Selo>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-sm text-muted">
        Média mínima para aprovação: {summary.mediaMinimaTexto || fmtGrade(criterio.mediaMinima)}.
        {summary.faltasPermitidasRestantes !== null && summary.faltasPermitidasRestantes !== undefined ? ` Você ainda pode ter ${summary.faltasPermitidasRestantes} ${summary.faltasPermitidasRestantes === 1 ? 'falta' : 'faltas'} no período.` : ''}
        {' '}Só notas publicadas entram na média.
      </p>
    </Card>
  )
}

export default function ProvasPage() {
  const { email, studentClass, courseId } = useStudent()
  const nav = useNavigate()
  const status = useApi(`/api/status?studentClass=${encodeURIComponent(studentClass)}&courseId=${encodeURIComponent(courseId)}&email=${encodeURIComponent(email)}`, [], { pollMs: 5000 })
  const applications = useApi(email && studentClass
    ? `/api/student/exam-applications?studentClass=${encodeURIComponent(studentClass)}&courseId=${encodeURIComponent(courseId)}`
    : null, [email, studentClass, courseId], { pollMs: 5000 })
  // Resumo de notas do servidor (só o publicado): média final, situação, menção, notas por
  // etapa, o critério do curso e a disciplina ou o módulo de cada avaliação. A tela não
  // recalcula a média (D3 do P2).
  const summaryApi = useApi(email && studentClass
    ? `/api/student/grades-summary?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`
    : null, [email, studentClass, courseId], { pollMs: 15000 })
  const summary = summaryApi.data && typeof summaryApi.data === 'object' && !Array.isArray(summaryApi.data) ? summaryApi.data : null
  const criterio = useMemo(() => criterioOf(summary), [summary])
  const sectionOf = useMemo(() => sectionsFromSummary(summary), [summary])
  const [mine, setMine] = useState([])
  const [detail, setDetail] = useState(null)
  const [filter, setFilter] = useState('all')
  const [mat, setMat] = useState('all')
  const [view, setView] = useState('grid')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState({})
  const toggleMod = (m) => setCollapsed((c) => ({ ...c, [m]: !c[m] }))

  // Entregas do aluno: ao abrir e a cada 5 s, uma consulta por vez e só com a aba à vista
  // (usePolling). A resposta de outra turma (troca no meio da consulta) não vale.
  const mineKey = `${email}|${courseId}|${studentClass}`
  const mineKeyRef = useRef(mineKey)
  mineKeyRef.current = mineKey
  // Nota publicada nova (muda o que conta no resultado): o resumo de notas recarrega já.
  const publishedKeyRef = useRef('')
  const minePolling = usePolling(async (requestOptions) => {
    const key = mineKey
    try {
      const r = await api.post('/api/student/my-submissions', { email, courseId, studentClass }, requestOptions)
      if (mineKeyRef.current === key) {
        const list = r.submissions || []
        setMine(list)
        const publishedKey = list.filter((item) => item.gradePublished === true).map((item) => `${item.id}:${item.consolidatedScore}:${item.assessmentArchived === true}`).join('|')
        if (publishedKeyRef.current && publishedKeyRef.current !== publishedKey) summaryApi.pollNow?.()
        publishedKeyRef.current = publishedKey
      }
      return true
    } catch { return false }
  }, { intervalMs: 5000 })
  // Troca de turma: consulta já (a primeira consulta sai sozinha ao abrir).
  const mineKeySeenRef = useRef(mineKey)
  useEffect(() => {
    if (mineKeySeenRef.current === mineKey) return
    mineKeySeenRef.current = mineKey
    minePolling.runNow()
  }, [mineKey, minePolling.runNow])

  const availableApplications = applications.data?.applications || []

  // Metricas derivadas das submissoes concluidas.
  const metrics = useMemo(() => {
    // A nota de avaliação arquivada fica na lista, mas fora do gráfico, da melhor nota e da
    // distribuição, como no gráfico do Início.
    const published = mine.filter((s) => isPublished(s) && s.assessmentArchived !== true)
    const grades = published.map((s) => toGrade(s.score))
    // Média do servidor (resumo de notas): a mesma do boletim e do Início. Com os critérios
    // do curso, a média final pelas etapas; sem eles, uma nota por prova (a consolidada).
    const avg = summary && summary.mediaFinal !== null && summary.mediaFinal !== undefined && Number.isFinite(Number(summary.mediaFinal)) ? Number(summary.mediaFinal) : null
    const best = grades.length ? Math.max(...grades) : null
    const bestSub = best != null ? published.find((s) => toGrade(s.score) === best) : null
    const compoem = mine.filter(isConsidered).length
    const chartPoints = published
      .slice()
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      .map((s) => ({ value: Number(toGrade(s.score).toFixed(1)), label: labelOf(s) }))
    const buckets = distributionBuckets(grades, criterio)
    const maxBucket = Math.max(1, ...buckets.map((b) => b.n))
    return { avg, best, bestSub, compoem, total: mine.length, chartPoints, buckets, maxBucket, hasData: mine.length > 0 }
  }, [mine, summary, criterio])

  // Seções distintas (disciplina ou módulo, ordem estável) para cores e chips; "Notas em
  // revisão" por último.
  const materias = useMemo(() => {
    const seen = new Map()
    mine.forEach((s) => { const sec = sectionOf(s); if (!seen.has(sec.key)) seen.set(sec.key, sec) })
    const list = [...seen.values()]
    return [...list.filter((sec) => sec.key !== REVIEW_SECTION.key), ...list.filter((sec) => sec.key === REVIEW_SECTION.key)]
  }, [mine, sectionOf])
  const accentOf = (key) => MOD_ACCENTS[Math.max(0, materias.findIndex((sec) => sec.key === key)) % MOD_ACCENTS.length]

  // Filtro de status (existente) -> busca -> filtro de materia.
  const statusFiltered = useMemo(() => mine.filter((s) => {
    if (filter === 'compoe') return isConsidered(s)
    if (filter === 'nao') return isOutOfResult(s)
    return true
  }), [mine, filter])

  const matCounts = useMemo(() => {
    const map = {}
    statusFiltered.forEach((s) => { const m = sectionOf(s).key; map[m] = (map[m] || 0) + 1 })
    return map
  }, [statusFiltered, sectionOf])

  const visible = useMemo(() => {
    return statusFiltered.filter((s) => {
      if (mat !== 'all' && sectionOf(s).key !== mat) return false
      if (!matchesSearch([s.examTitle, s.examKey], query)) return false
      return true
    })
  }, [statusFiltered, mat, query, sectionOf])

  // Monta as seções: por disciplina ou módulo -> por grupo de tentativas.
  const board = useMemo(() => materias.map((sec) => {
    const m = sec.key
    const subs = visible.filter((s) => sectionOf(s).key === m)
    if (!subs.length) return null
    const groupsMap = new Map()
    subs.forEach((s) => { const k = groupKeyOf(s); if (!groupsMap.has(k)) groupsMap.set(k, []); groupsMap.get(k).push(s) })
    const groups = [...groupsMap.values()].map((atts) => atts.slice().sort((a, b) => (Number(a.attemptNumber || 0) - Number(b.attemptNumber || 0)) || ((a.timestamp || 0) - (b.timestamp || 0))))
    // Média da disciplina ou do módulo: a do servidor (resumo de notas).
    return { m, name: sec.name, accent: accentOf(m), groups, modAvg: sec.media, contam: subs.filter(isConsidered).length, tentativas: subs.length }
  }).filter(Boolean), [materias, visible, sectionOf])

  return (
    <CriterioCtx.Provider value={criterio}>
    <div className="app-enter mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">Provas</h1>
        <p className="text-sm text-muted">Sua visão geral de desempenho, avaliações liberadas e histórico de resultados.</p>
      </div>

      <PageState loading={status.loading || applications.loading} error={status.error || applications.error} onRetry={() => { status.refetch(); applications.refetch() }}>

        {summary && <MyGradesCard summary={summary} />}
        {!summary && summaryApi.error && (
          <p role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-warning-soft px-4 py-3 text-sm text-warning">
            <span className="min-w-0 flex-1">Não deu para carregar o resumo das suas notas agora. As provas aparecem abaixo, sem a média.</span>
            <Button size="sm" variant="secondary" onClick={() => summaryApi.refetch?.()}>Tentar de novo</Button>
          </p>
        )}

        {metrics.hasData && (
          <div className="space-y-4">
            <div className="stagger-grid grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Card className="premium-card-interactive relative overflow-hidden p-5">
                <span className="absolute -right-6 -top-8 h-20 w-20 rounded-full bg-primary-soft blur-2xl" aria-hidden />
                <div className="flex items-center gap-4">
                  <MetricRing value={metrics.avg} />
                  <div>
                    <StatValue target={metrics.avg} decimals={1} className={metrics.avg != null ? gradeText(metrics.avg, criterio) : ''} />
                    <p className="mt-2 text-xs text-subtle">{summary && summary.regraAntiga === false ? 'Média final' : 'Média geral'}</p>
                  </div>
                </div>
              </Card>

              <MetricCard label="Provas concluídas" icon={ClipboardList} tone="text-primary" badge={<Badge tone="neutral">{metrics.total} tentativas</Badge>}>
                <StatValue target={metrics.total} />
              </MetricCard>

              <MetricCard label="Melhor nota" icon={Award} tone="text-success" badge={metrics.bestSub ? <Badge tone="success" dot>{labelOf(metrics.bestSub)}</Badge> : null}>
                <StatValue target={metrics.best} decimals={1} className={metrics.best != null ? gradeText(metrics.best, criterio) : ''} />
              </MetricCard>

              <MetricCard label="Compõem o resultado" icon={Target} tone="text-info" badge={<Badge tone="info">de {metrics.total}</Badge>}>
                <StatValue target={metrics.compoem} />
              </MetricCard>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              <Card className="p-5 lg:col-span-3">
                <h2 className="flex items-center gap-2 font-semibold text-text"><TrendingUp size={17} className="text-primary" /> Evolução das notas</h2>
                <p className="mt-0.5 text-xs text-muted">Desempenho ao longo das avaliações</p>
                <div className="mt-3">
                  {metrics.chartPoints.length ? <MiniLineChart points={metrics.chartPoints} min={0} max={10} height={170} /> : <p className="grid h-[170px] place-items-center text-sm text-muted">Notas ainda em revisão.</p>}
                </div>
              </Card>

              <Card className="p-5 lg:col-span-2">
                <h2 className="flex items-center gap-2 font-semibold text-text"><BarChart3 size={17} className="text-primary" /> Distribuição</h2>
                <p className="mt-0.5 text-xs text-muted">Por faixa de nota</p>
                <div className="mt-4 space-y-3.5">
                  {metrics.buckets.map((b) => (
                    <div key={b.k} className="flex items-center gap-3">
                      <span className="w-14 shrink-0 text-xs font-medium text-muted">{b.k}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                        <div className={`progress-reveal h-full rounded-full ${b.cls}`} style={{ width: `${(b.n / metrics.maxBucket) * 100}%` }} />
                      </div>
                      <span className="w-5 shrink-0 text-right text-xs font-semibold tabular-nums text-muted">{b.n}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        )}

        <div className="mt-6 space-y-3">
          <ScheduledExams items={applications.data?.agendadas} />
          {availableApplications.length === 0 && !applications.data?.agendadas?.length && <Card><EmptyState icon={ClipboardList} title="Nenhuma prova disponível" description="Quando o instrutor iniciar uma aplicação, ela aparecerá aqui em destaque." /></Card>}
          {availableApplications.map((application) => {
            const k = application.examKey
            const cfg = application.config || {}
            const active = ['running', 'waiting', 'paused'].includes(application.status)
            const inWaitingRoom = application.status === 'waiting' && Number(application.startsAt || cfg.startTime || 0) > Date.now()
            const configuredMaxAttempts = Number(application.maxAttempts ?? cfg.maxAttempts)
            const maxAttempts = Number.isInteger(configuredMaxAttempts) && configuredMaxAttempts >= 1 ? configuredMaxAttempts : null
            const attemptsFromSubmissions = mine.filter((submission) => (
              submission.examKey === k
              && submission.applicationId === application.id
              && submission.resultStatus !== 'invalidated'
              && (!submission.student?.courseId || !courseId || String(submission.student.courseId) === String(courseId))
            )).length
            const attemptsUsed = Number.isInteger(Number(application.attemptsUsed))
              ? Number(application.attemptsUsed)
              : attemptsFromSubmissions
            const attemptsExhausted = maxAttempts !== null && attemptsUsed >= maxAttempts
            const nextAttempt = maxAttempts !== null ? Math.min(attemptsUsed + 1, maxAttempts) : null
            return (
              <Card key={application.id} onClick={attemptsExhausted ? undefined : () => nav(`/aluno/prova/${encodeURIComponent(k)}?applicationId=${encodeURIComponent(application.id)}`)} className={`p-4 flex items-center gap-3 transition ${attemptsExhausted ? '' : 'premium-card-interactive cursor-pointer hover:border-primary/50'}`}>
                <span className="w-10 h-10 grid place-items-center rounded-md bg-primary-soft text-primary"><ClipboardList size={18} /></span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-text truncate">{application.examTitle || k.replace(/_/g, ' ')}</p>
                  <p className="text-xs text-muted flex items-center gap-1"><Clock size={12} /> {application.durationMinutes ? `${application.durationMinutes} min` : 'sem tempo'} {application.tokenEnabled ? '- requer token' : ''}{maxAttempts !== null ? ` - Tentativa ${nextAttempt} de ${maxAttempts}` : ''}</p>
                </div>
                {attemptsExhausted
                  ? <Badge tone="neutral">Tentativas esgotadas</Badge>
                  : <Badge tone={application.status === 'paused' || inWaitingRoom ? 'warning' : active ? 'success' : 'neutral'}>{inWaitingRoom ? 'Sala de espera' : application.status === 'paused' ? 'Pausada' : 'Liberada'}</Badge>}
              </Card>
            )
          })}
        </div>

        {mine.length > 0 && (
          <div className="mt-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-text"><CheckCircle2 size={18} className="text-success" /> Provas concluídas</h2>
              <div className="flex flex-wrap gap-2">
                {FILTERS.map((f) => (
                  <button key={f.key} type="button" onClick={() => setFilter(f.key)}
                    className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${filter === f.key ? 'bg-primary text-primary-fg shadow-sm' : 'bg-surface-2 text-muted hover:text-text'}`}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="pvb">
              <div className="pvb-toolbar">
                <label className="pvb-search">
                  <Search size={15} />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar avaliação..." aria-label="Buscar avaliação" />
                </label>
                <div className="pvb-filter">
                  <span className="pvb-flabel">{summary?.situacaoPorDisciplina?.length ? 'Disciplina' : 'Módulo'}</span>
                  <button type="button" className={`pvb-chip ${mat === 'all' ? 'active' : ''}`} onClick={() => setMat('all')}>Todas <span className="pvb-count">{statusFiltered.length}</span></button>
                  {materias.map((sec) => (
                    <button type="button" key={sec.key} className={`pvb-chip ${mat === sec.key ? 'active' : ''}`} style={{ '--sc': accentOf(sec.key) }} onClick={() => setMat(sec.key)}>
                      <span className="pvb-cdot" />{sec.name} <span className="pvb-count">{matCounts[sec.key] || 0}</span>
                    </button>
                  ))}
                </div>
                <div className="pvb-view">
                  <button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} title="Grade" aria-label="Ver em grade"><LayoutGrid size={15} /></button>
                  <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} title="Lista" aria-label="Ver em lista"><List size={15} /></button>
                </div>
              </div>

              <div className="pvb-resultmeta">Mostrando <b>{visible.length}</b> tentativa{visible.length !== 1 ? 's' : ''} em <b>{board.length}</b> {board.length !== 1 ? 'grupos' : 'grupo'}</div>

              {board.length === 0 ? (
                <Card><EmptyState icon={ClipboardList} title="Nenhuma prova nesta categoria" description="Ajuste os filtros para ver outras avaliações." /></Card>
              ) : (
                <div className={`pvb-board ${view}`}>
                  {board.map((sec) => (
                    <section key={sec.m} className={`pvb-mod ${collapsed[sec.m] ? 'collapsed' : ''}`} style={{ '--mc': sec.accent }}>
                      <button type="button" className="pvb-mod-head" onClick={() => toggleMod(sec.m)} aria-expanded={!collapsed[sec.m]}>
                        <span className="pvb-mbadge">{sec.name.slice(0, 2).toUpperCase()}</span>
                        <span className="pvb-mtitle">
                          <span className="pvb-mname">{sec.name}</span>
                          <span className="pvb-msub">{sec.tentativas} tentativa{sec.tentativas !== 1 ? 's' : ''}</span>
                        </span>
                        <span className="pvb-msummary">
                          <span className="pvb-mstat"><span className="pvb-mv">{fmtGrade(sec.modAvg)}</span><span className="pvb-mk">média</span></span>
                          <span className="pvb-mcount">{sec.contam} conta{sec.contam !== 1 ? 'm' : ''}</span>
                          <span className="pvb-chev"><ChevronRight size={16} /></span>
                        </span>
                      </button>
                      <div className="pvb-mod-body">
                        {sec.groups.map((atts) => atts.length > 1
                          ? <AttemptGroup key={groupKeyOf(atts[0])} attempts={atts} onOpen={setDetail} />
                          : <ExamCard key={atts[0].id || groupKeyOf(atts[0])} s={atts[0]} onOpen={setDetail} />)}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </PageState>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.examTitle || detail?.examKey || 'Resultado'} description={detail?.resultStatus === 'archived' ? 'Tentativa arquivada e fora do resultado' : detail?.assessmentArchived === true ? 'Avaliação arquivada pelo professor: a nota fica guardada e não entra na média' : detail?.answerKeyReleased ? 'Gabarito liberado pelo instrutor' : 'Resumo da tentativa'}>
        {detail && (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-border py-3 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted">Nota</dt>
                <dd className="mt-0.5 text-lg font-semibold text-text">{detail.gradePublished === true ? fmtGrade(toGrade(detail.score || 0)) : 'Em revisão'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Resultado</dt>
                <dd className="mt-0.5 text-lg font-semibold text-text">{detail.gradePublished === true && detail.consolidatedScore != null ? fmtGrade(toGrade(detail.consolidatedScore)) : '-'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Acertos</dt>
                <dd className="mt-0.5 text-lg font-semibold text-text">{detail.gradePublished === true ? `${detail.correctCount ?? '-'}/${detail.totalCount ?? '-'}` : '-'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Versão</dt>
                <dd className="mt-0.5 text-lg font-semibold text-text">{detail.assignedVersion || '-'}</dd>
              </div>
            </dl>
            {Array.isArray(detail.gradedAnswers) && detail.gradedAnswers.length > 0 ? (
              detail.answerKeyReleased && Array.isArray(detail.examQuestions) && detail.examQuestions.length > 0 ? (
                <FullExamView detail={detail} questions={detail.examQuestions} answers={detail.gradedAnswers} />
              ) : (
                <div className="overflow-x-auto border border-border rounded-lg">
                  <table className="w-full text-sm">
                    <thead><tr className="bg-surface-2 text-muted"><th className="text-left px-3 py-2">Questão</th><th className="text-left px-3 py-2">Sua resposta</th>{detail.answerKeyReleased && <><th className="text-left px-3 py-2">Correta</th><th className="text-left px-3 py-2">Status</th></>}</tr></thead>
                    <tbody>
                      {detail.gradedAnswers.map((a, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="px-3 py-2">{a.questionNumber}</td>
                          <td className="px-3 py-2">{a.studentChoice || '-'}</td>
                          {detail.answerKeyReleased && <><td className="px-3 py-2">{a.correctAnswer || '-'}</td><td className="px-3 py-2"><Badge tone={a.isCorrect ? 'success' : 'danger'}>{a.isCorrect ? 'Correta' : 'Errada'}</Badge></td></>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : <p className="text-sm text-muted">O detalhamento do gabarito ainda não está liberado.</p>}
          </div>
        )}
      </Modal>
    </div>
    </CriterioCtx.Provider>
  )
}
