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
import { consolidatedAverage, fmtGradeValue } from '../../lib/grades'
import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'

// Nota e armazenada em escala 0-100 e exibida em 0-10.
const toGrade = (score) => Number(score) / 10
const gradeTone = (g) => (g >= 7 ? 'success' : g >= 6 ? 'warning' : 'danger')
const gradeText = (g) => (g >= 7 ? 'text-success' : g >= 6 ? 'text-warning' : 'text-danger')
const isPublished = (s) => s.gradePublished === true && !Number.isNaN(Number(s.score))
const isConsidered = (s) => s.countsTowardResult && s.resultStatus !== 'archived'
const shortLabel = (key = '') => key.replace(/^Avaliacao_?/i, '').replace(/_/g, ' ').slice(0, 8)

// ----- Agrupamento por materia e por tentativa -----
// Materia = prefixo alfabetico do examKey (FUTEC, FECOP, IRCOM...).
const materiaOf = (key = '') => (String(key).replace(/^Avaliacao_?/i, '').match(/^[A-Za-z]+/) || ['—'])[0].toUpperCase()
// Chave do grupo de tentativas: mesma aplicacao = mesmo grupo (espelha attemptGroupKey do backend).
const groupKeyOf = (s) => String(s.applicationId || s.examKey || '')
const POLICY_LABEL = { highest: 'Maior nota', latest: 'Última tentativa', average: 'Média das tentativas', selected: 'Selecionada pelo professor' }
const MOD_ACCENTS = ['var(--info)', 'var(--success)', 'var(--warning)', 'var(--primary)', 'var(--danger)']
// Mesmo arredondamento do boletim e de Resultados (7,35 -> 7,4).
const fmtGrade = (n) => fmtGradeValue(n)
const gradeBand = (g) => (g == null ? '' : g >= 9 ? 'g-success' : g >= 7 ? 'g-info' : g >= 6 ? 'g-warning' : 'g-danger')
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString('pt-BR') : '')

// Card de uma prova avulsa (uma tentativa unica).
function ExamCard({ s, onOpen }) {
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
      <div className={`pvb-egrade ${gradeBand(g)}`}>{fmtGrade(g)}</div>
      <div className="pvb-etail">
        {archived
          ? <span className="pvb-st neutral"><span className="pvb-sdot" />Não considerada</span>
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
  const policy = attempts.map((a) => a.aggregationPolicy).find((p) => POLICY_LABEL[p]) || 'highest'
  const considered = attempts.filter(isConsidered)
  const backendScore = attempts.find((a) => a.consolidatedScore != null)?.consolidatedScore
  const consolidated = backendScore != null
    ? toGrade(backendScore)
    : (considered.length ? considered.reduce((sum, a) => sum + toGrade(a.score), 0) / considered.length : null)
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
                <span className={`as ${gradeBand(g)}`}>{fmtGrade(g)}</span>
                <span className="flag">{counts ? 'Conta' : 'Descartada'}</span>
              </button>
            )
          })}
        </div>
        <span className="ag-arrow"><ArrowRight size={22} /></span>
        <div className="ag-result">
          <span className={`rn ${gradeBand(consolidated)}`}>{fmtGrade(consolidated)}</span>
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
  const safe = Math.max(0, Math.min(100, (Number(value) || 0) * 10))
  const shown = useCountUp(value ?? 0, { duration: 1100, decimals: 1 })
  const tone = value != null ? gradeText(value) : 'text-muted'
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
function buildExamPrintHtml(detail, questions, answerByNumber) {
  const nota = detail?.gradePublished === true ? (Number(detail.score || 0) / 10).toFixed(1) : '—'
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
    <script>window.onload=function(){setTimeout(function(){window.print()},150)}</script>
  </body></html>`
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
    const html = buildExamPrintHtml(detail, questions, answerByNumber)
    const win = window.open('', '_blank')
    if (!win) return
    win.document.open()
    win.document.write(html)
    win.document.close()
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
                  Questao {q.number}
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

export default function ProvasPage() {
  const { email, studentClass, courseId } = useStudent()
  const nav = useNavigate()
  const status = useApi(`/api/status?studentClass=${encodeURIComponent(studentClass)}&courseId=${encodeURIComponent(courseId)}&email=${encodeURIComponent(email)}`, [], { pollMs: 5000 })
  const applications = useApi(email && studentClass
    ? `/api/student/exam-applications?studentClass=${encodeURIComponent(studentClass)}&courseId=${encodeURIComponent(courseId)}`
    : null, [email, studentClass, courseId], { pollMs: 5000 })
  const [mine, setMine] = useState([])
  const [detail, setDetail] = useState(null)
  const [filter, setFilter] = useState('all')
  const [mat, setMat] = useState('all')
  const [view, setView] = useState('grid')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState({})
  const toggleMod = (m) => setCollapsed((c) => ({ ...c, [m]: !c[m] }))

  useEffect(() => {
    let active = true
    const load = () => api.post('/api/student/my-submissions', { email, courseId, studentClass }).then((r) => active && setMine(r.submissions || [])).catch(() => {})
    load()
    const id = setInterval(load, 5000)
    return () => { active = false; clearInterval(id) }
  }, [email, courseId, studentClass])

  const availableApplications = applications.data?.applications || []

  // Metricas derivadas das submissoes concluidas.
  const metrics = useMemo(() => {
    const published = mine.filter(isPublished)
    const grades = published.map((s) => toGrade(s.score))
    // Uma nota por prova (a consolidada pela regra do professor), como no painel e no
    // boletim: com a regra "média", duas tentativas contam como uma prova só.
    const avgScore = consolidatedAverage(mine)
    const avg = avgScore == null ? null : avgScore / 10
    const best = grades.length ? Math.max(...grades) : null
    const bestSub = best != null ? published.find((s) => toGrade(s.score) === best) : null
    const compoem = mine.filter(isConsidered).length
    const chartPoints = published
      .slice()
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      .map((s) => ({ value: Number(toGrade(s.score).toFixed(1)), label: shortLabel(s.examKey) }))
    const buckets = [
      { k: '9-10', lo: 9, hi: 10.01, cls: 'bg-success' },
      { k: '7-8.9', lo: 7, hi: 9, cls: 'bg-info' },
      { k: '6-6.9', lo: 6, hi: 7, cls: 'bg-warning' },
      { k: '0-5.9', lo: 0, hi: 6, cls: 'bg-danger' },
    ].map((b) => ({ ...b, n: grades.filter((g) => g >= b.lo && b.hi > g).length }))
    const maxBucket = Math.max(1, ...buckets.map((b) => b.n))
    return { avg, best, bestSub, compoem, total: mine.length, chartPoints, buckets, maxBucket, hasData: mine.length > 0 }
  }, [mine])

  // Materias distintas (ordem estavel) para cores e chips.
  const materias = useMemo(() => {
    const seen = []
    mine.forEach((s) => { const m = materiaOf(s.examKey); if (!seen.includes(m)) seen.push(m) })
    return seen
  }, [mine])
  const accentOf = (m) => MOD_ACCENTS[Math.max(0, materias.indexOf(m)) % MOD_ACCENTS.length]

  // Filtro de status (existente) -> busca -> filtro de materia.
  const statusFiltered = useMemo(() => mine.filter((s) => {
    if (filter === 'compoe') return isConsidered(s)
    if (filter === 'nao') return s.resultStatus === 'archived'
    return true
  }), [mine, filter])

  const matCounts = useMemo(() => {
    const map = {}
    statusFiltered.forEach((s) => { const m = materiaOf(s.examKey); map[m] = (map[m] || 0) + 1 })
    return map
  }, [statusFiltered])

  const visible = useMemo(() => {
    const t = query.trim().toLowerCase()
    return statusFiltered.filter((s) => {
      if (mat !== 'all' && materiaOf(s.examKey) !== mat) return false
      if (t && !`${s.examTitle || ''} ${s.examKey || ''}`.toLowerCase().includes(t)) return false
      return true
    })
  }, [statusFiltered, mat, query])

  // Monta as secoes: por materia -> por grupo de tentativas.
  const board = useMemo(() => materias.map((m) => {
    const subs = visible.filter((s) => materiaOf(s.examKey) === m)
    if (!subs.length) return null
    const groupsMap = new Map()
    subs.forEach((s) => { const k = groupKeyOf(s); if (!groupsMap.has(k)) groupsMap.set(k, []); groupsMap.get(k).push(s) })
    const groups = [...groupsMap.values()].map((atts) => atts.slice().sort((a, b) => (Number(a.attemptNumber || 0) - Number(b.attemptNumber || 0)) || ((a.timestamp || 0) - (b.timestamp || 0))))
    // Media da materia = uma nota por prova (a consolidada), mesma regra da metrica
    // geral — tentativas descartadas ou refeitas nao contam em dobro.
    const modScore = consolidatedAverage(subs)
    const modAvg = modScore == null ? null : modScore / 10
    return { m, accent: accentOf(m), groups, modAvg, contam: subs.filter(isConsidered).length, tentativas: subs.length }
  }).filter(Boolean), [materias, visible])

  return (
    <div className="app-enter mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">Provas</h1>
        <p className="text-sm text-muted">Sua visão geral de desempenho, avaliações liberadas e histórico de resultados.</p>
      </div>

      <PageState loading={status.loading || applications.loading} error={status.error || applications.error} onRetry={() => { status.refetch(); applications.refetch() }}>

        {metrics.hasData && (
          <div className="space-y-4">
            <div className="stagger-grid grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Card className="premium-card-interactive relative overflow-hidden p-5">
                <span className="absolute -right-6 -top-8 h-20 w-20 rounded-full bg-primary-soft blur-2xl" aria-hidden />
                <div className="flex items-center gap-4">
                  <MetricRing value={metrics.avg} />
                  <div>
                    <StatValue target={metrics.avg} decimals={1} className={metrics.avg != null ? gradeText(metrics.avg) : ''} />
                    <p className="mt-2 text-xs text-subtle">Média das consideradas</p>
                  </div>
                </div>
              </Card>

              <MetricCard label="Provas concluídas" icon={ClipboardList} tone="text-primary" badge={<Badge tone="neutral">{metrics.total} tentativas</Badge>}>
                <StatValue target={metrics.total} />
              </MetricCard>

              <MetricCard label="Melhor nota" icon={Award} tone="text-success" badge={metrics.bestSub ? <Badge tone="success" dot>{shortLabel(metrics.bestSub.examKey)}</Badge> : null}>
                <StatValue target={metrics.best} decimals={1} className={metrics.best != null ? gradeText(metrics.best) : ''} />
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
          {availableApplications.length === 0 && <Card><EmptyState icon={ClipboardList} title="Nenhuma prova disponível" description="Quando o instrutor iniciar uma aplicação, ela aparecerá aqui em destaque." /></Card>}
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
                  <span className="pvb-flabel">Materia</span>
                  <button type="button" className={`pvb-chip ${mat === 'all' ? 'active' : ''}`} onClick={() => setMat('all')}>Todas <span className="pvb-count">{statusFiltered.length}</span></button>
                  {materias.map((m) => (
                    <button type="button" key={m} className={`pvb-chip ${mat === m ? 'active' : ''}`} style={{ '--sc': accentOf(m) }} onClick={() => setMat(m)}>
                      <span className="pvb-cdot" />{m} <span className="pvb-count">{matCounts[m] || 0}</span>
                    </button>
                  ))}
                </div>
                <div className="pvb-view">
                  <button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} title="Grade" aria-label="Ver em grade"><LayoutGrid size={15} /></button>
                  <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} title="Lista" aria-label="Ver em lista"><List size={15} /></button>
                </div>
              </div>

              <div className="pvb-resultmeta">Mostrando <b>{visible.length}</b> tentativa{visible.length !== 1 ? 's' : ''} em <b>{board.length}</b> materia{board.length !== 1 ? 's' : ''}</div>

              {board.length === 0 ? (
                <Card><EmptyState icon={ClipboardList} title="Nenhuma prova nesta categoria" description="Ajuste os filtros para ver outras avaliações." /></Card>
              ) : (
                <div className={`pvb-board ${view}`}>
                  {board.map((sec) => (
                    <section key={sec.m} className={`pvb-mod ${collapsed[sec.m] ? 'collapsed' : ''}`} style={{ '--mc': sec.accent }}>
                      <button type="button" className="pvb-mod-head" onClick={() => toggleMod(sec.m)} aria-expanded={!collapsed[sec.m]}>
                        <span className="pvb-mbadge">{sec.m.slice(0, 2)}</span>
                        <span className="pvb-mtitle">
                          <span className="pvb-mname">{sec.m}</span>
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

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.examTitle || detail?.examKey || 'Resultado'} description={detail?.resultStatus === 'archived' ? 'Tentativa arquivada e fora do resultado' : detail?.answerKeyReleased ? 'Gabarito liberado pelo instrutor' : 'Resumo da tentativa'}>
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
  )
}
