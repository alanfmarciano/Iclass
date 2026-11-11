// Cópia dos dados pessoais para imprimir ou salvar (H8c reduzido; SEG-14, art. 18 da
// LGPD): "Meus dados" do aluno (GET /api/student/my-data) e a exportação do
// administrador na ficha do aluno (GET /api/admin/lgpd/students/export).
//
// O servidor monta o arquivo (backend/utils/studentDataExport.js) e decide o que entra; a
// tela só o mostra legível. Mesmo padrão das outras impressões (boletimPrint.js): HTML
// próprio numa janela nova e window.print chamado daqui, sem <script> na janela (a CSP do
// H5d bloqueia script inline na janela about:blank). Listas longas mostram as primeiras
// linhas e dizem quantas ficaram só no arquivo JSON.
import { fmtGrade } from './grades'
import { acceptanceText, birthDateText } from './legalAcceptance'

export const PRINT_ROW_LIMIT = 200

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

function toTime(value) {
  if (value === null || value === undefined || value === '') return null
  const time = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(time) ? time : null
}

function fmtDate(value) {
  const time = toTime(value)
  if (time === null) return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value).split('-').reverse().join('/') : '—'
  return new Date(time).toLocaleDateString('pt-BR')
}

function fmtDateTime(value) {
  const time = toTime(value)
  return time === null ? '—' : new Date(time).toLocaleString('pt-BR')
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function text(value) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function section(title, body, note = '') {
  return `<section><h2>${escapeHtml(title)}</h2>${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}${body}</section>`
}

function pairs(rows) {
  const filled = rows.filter(([, value]) => value !== undefined)
  return `<table class="pairs"><tbody>${filled.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(text(value))}</td></tr>`).join('')}</tbody></table>`
}

// Tabela com no máximo PRINT_ROW_LIMIT linhas; o resto fica só no arquivo JSON.
function table(headers, rows, empty) {
  if (!rows.length) return `<p class="empty">${escapeHtml(empty)}</p>`
  const shown = rows.slice(0, PRINT_ROW_LIMIT)
  const rest = rows.length - shown.length
  const head = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`
  const body = shown.map((cells) => `<tr>${cells.map((cell) => `<td>${escapeHtml(text(cell))}</td>`).join('')}</tr>`).join('')
  const more = rest > 0 ? `<p class="note">E mais ${rest} ${rest === 1 ? 'registro' : 'registros'}, só no arquivo JSON.</p>` : ''
  return `<table>${head}<tbody>${body}</tbody></table>${more}`
}

const ACCOMMODATIONS = [
  ['fonteAmpliada', 'Fonte ampliada'],
  ['altoContraste', 'Alto contraste'],
  ['reducaoAnimacoes', 'Menos animações'],
  ['leitorTela', 'Leitor de tela'],
]

function accessibilityText(profile) {
  const a = profile.accessibility && typeof profile.accessibility === 'object' ? profile.accessibility : null
  if (!a) return 'Nenhum recurso registrado'
  const parts = ACCOMMODATIONS.filter(([key]) => a[key]).map(([, label]) => label)
  if (a.tempoAdicional) parts.push(`Tempo adicional${a.tempoAdicionalPercent ? ` de ${a.tempoAdicionalPercent}%` : ''}`)
  return parts.length ? parts.join(', ') : 'Nenhum recurso registrado'
}

function guardianText(profile) {
  const g = profile.guardian && typeof profile.guardian === 'object' ? profile.guardian : null
  if (!g || !g.name) return '—'
  const contact = [g.phone, g.email].filter(Boolean).join(' · ')
  return `${g.name}${g.parentesco ? ` (${g.parentesco})` : ''}${contact ? ` · ${contact}` : ''}`
}

function profileRows(profile, admin) {
  const rows = [
    ['Nome', profile.name],
    ['Nome social', profile.nomeSocial || undefined],
    ['E-mail', profile.email],
    ['Matrícula', profile.matricula],
    ['Data de nascimento', birthDateText(profile.birthDate) || 'Não informada'],
    ['Telefone', profile.phone],
    ['Situação', profile.status || 'Ativo'],
    ['Unidade', profile.unidade || undefined],
    ['Responsável', guardianText(profile)],
    ['Telefone do responsável', profile.guardianPhone || undefined],
    ['Recursos de acessibilidade', accessibilityText(profile)],
  ]
  if (admin && profile.accessibility && profile.accessibility.observacao) rows.push(['Observação de acessibilidade (restrita)', profile.accessibility.observacao])
  if (!admin && profile.accessibilityNoteRestricted) rows.push(['Observação de acessibilidade', 'Existe uma observação restrita à coordenação. Peça a cópia completa à escola.'])
  rows.push(['Cadastrado em', profile.createdAt ? fmtDateTime(profile.createdAt) : undefined])
  rows.push(['Último acesso', profile.lastLoginAt ? fmtDateTime(profile.lastLoginAt) : undefined])
  return rows
}

function submissionStatus(item) {
  if (item.gradePublished === true) return 'Publicada'
  if (item.resultStatus === 'em_revisao') return 'Em revisão'
  return 'Não publicada'
}

function attendanceSummary(item) {
  const aulas = list(item.aulas)
  if (!aulas.length) return item.status || '—'
  const count = (status) => aulas.filter((aula) => aula && aula.status === status).length
  const parts = [['presente', 'presente'], ['falta', 'falta'], ['justificada', 'justificada']]
    .map(([status, label]) => { const n = count(status); return n ? `${n} ${label}${n === 1 ? '' : 's'}` : '' })
    .filter(Boolean)
  return parts.join(', ') || `${aulas.length} aula(s)`
}

function keystrokeSummary(rows) {
  const byExam = new Map()
  rows.forEach((row) => {
    const key = row.examKey || '—'
    const entry = byExam.get(key) || { examKey: key, total: 0, suspicious: 0, last: null }
    entry.total += 1
    if (row.suspicious || row.blocked) entry.suspicious += 1
    const time = toTime(row.serverTs)
    if (time !== null && (entry.last === null || time > entry.last)) entry.last = time
    byExam.set(key, entry)
  })
  return [...byExam.values()].map((entry) => [entry.examKey, entry.total, entry.suspicious, fmtDateTime(entry.last)])
}

const ORIGIN_LABELS = { login: 'Automática (acesso)', chamada: 'Chamada', manual: 'Manual' }

export function dataExportHtml(data) {
  const admin = data && data.audience === 'admin'
  const profile = (data && data.profile) || {}
  const name = (profile.nomeSocial && String(profile.nomeSocial).trim()) || profile.name || profile.email || 'Aluno'
  const institution = (data && data.institution) || {}
  const enrollments = data.enrollments || {}
  const acceptances = data.acceptances || {}
  const forum = data.forum || {}
  const proctoring = data.proctoring || {}
  const title = admin ? `Dados pessoais — ${name}` : `Meus dados — ${name}`

  const sections = []
  sections.push(section('Identificação', pairs(profileRows(profile, admin))))
  sections.push(section('Matrículas', [
    table(['Turma', 'Curso'], list(enrollments.classes).map((item) => [item.className, item.courseName || item.courseId || '—']), 'Nenhuma turma.'),
    list(enrollments.requests).length ? table(['Pedido de matrícula', 'Turma', 'Situação', 'Data'], list(enrollments.requests).map((item) => [item.courseName || item.courseId, item.className || item.studentClass, item.status, fmtDate(item.createdAt)]), '') : '',
  ].join('')))
  sections.push(section('Termos de Uso e Política de Privacidade', pairs([
    ['Termos de Uso', acceptanceText(acceptances.terms)],
    ['Política de Privacidade', acceptanceText(acceptances.privacy)],
    ['Aceites anteriores', String(list(acceptances.previous).length)],
  ])))
  sections.push(section('Notas e entregas', table(['Prova', 'Data', 'Nota', 'Situação'], list(data.submissions).map((item) => [
    item.examTitle || item.examKey, fmtDate(item.timestamp), item.gradePublished === true || admin ? fmtGrade(item.score) : '—', submissionStatus(item),
  ]), 'Nenhuma entrega.'), admin ? '' : 'A nota em revisão só aparece depois de publicada pelo professor.'))
  sections.push(section('Frequência', table(['Data', 'Turma', 'Origem', 'Aulas', 'Justificativa'], list(data.attendance).map((item) => [
    fmtDate(item.date), item.studentClass, ORIGIN_LABELS[item.origin] || item.origin, attendanceSummary(item),
    item.justificativa && item.justificativa.tipo ? `${item.justificativa.tipo}${item.justificativa.abonado ? ' (abonada)' : ''}` : '—',
  ]), 'Nenhum registro de presença.')))
  sections.push(section('Certificados', table(['Código', 'Curso', 'Situação', 'Emitido em'], list(data.certificates).map((item) => [item.code, item.courseName || item.courseId, item.status, fmtDate(item.issuedAt)]), 'Nenhum certificado.')))
  sections.push(section(admin ? 'Observações pedagógicas' : 'Observações compartilhadas com você',
    table(admin ? ['Data', 'Categoria', 'Visibilidade', 'Quem escreveu', 'Texto'] : ['Data', 'Categoria', 'Texto'], list(data.observations).map((item) => (admin
      ? [fmtDate(item.timestamp), item.category, item.visibility, item.author, item.text]
      : [fmtDate(item.timestamp), item.category, item.text])), 'Nenhuma observação.')))
  sections.push(section('Fórum de dúvidas', [
    table(['Data', 'Material', 'Dúvida', 'Respostas'], list(forum.questions).map((item) => [fmtDate(item.timestamp), item.key, item.text, list(item.replies).length]), 'Nenhuma dúvida.'),
    list(forum.replies).length ? table(['Data', 'Material', 'Sua resposta'], list(forum.replies).map((item) => [fmtDate(item.timestamp), item.key, item.text]), '') : '',
  ].join('')))
  sections.push(section('Acessos ao portal', table(['Data e hora', 'Resultado', 'IP', 'Navegador', 'Aparelho'], list(data.loginLogs)
    .slice().sort((a, b) => (toTime(b.timestamp) || 0) - (toTime(a.timestamp) || 0))
    .map((item) => [fmtDateTime(item.timestamp), item.status === 'success' ? 'Entrou' : (item.reason || item.status), item.ip, item.browser, item.device || item.os]), 'Nenhum acesso registrado.'),
  `${list(data.moduleAccess).length} acesso(s) a materiais registrados.`))
  sections.push(section('Monitoramento das provas', [
    table(['Data e hora', 'Prova', 'Evento'], list(proctoring.focusEvents).map((item) => [fmtDateTime(item.timestamp), item.examKey, item.type || item.event]), 'Nenhuma saída da tela da prova registrada.'),
    table(['Prova', 'Teclas registradas', 'Atalhos suspeitos', 'Último registro'], keystrokeSummary(list(proctoring.keystrokes)), 'Nenhuma tecla registrada.'),
  ].join(''), 'O detalhe de cada tecla registrada está no arquivo JSON.'))
  const examRecords = list(data.examRecords)
  if (examRecords.length) {
    sections.push(section('Registros das provas', table(['Prova', 'Registro do teclado', 'Versão', 'Tempo extra', 'Contestações'], examRecords.map((item) => [
      item.examKey, item.keystrokeModeLabel, item.assignedVersion, item.adjustment && item.adjustment.extraMinutes ? `${item.adjustment.extraMinutes} min` : '—', list(item.questionReports).length,
    ]), '')))
  }
  if (list(data.examMessages).length) {
    sections.push(section('Mensagens recebidas durante a prova', table(['Data e hora', 'Prova', 'Mensagem'], list(data.examMessages).map((item) => [fmtDateTime(item.timestamp || item.createdAt), item.examKey, item.messageText]), '')))
  }
  sections.push(section('Alterações do cadastro', table(['Data e hora', 'Campo', 'Antes', 'Depois'], list(data.profileHistory).map((item) => [fmtDateTime(item.timestamp), item.field, item.oldValue, item.newValue]), 'Nenhuma alteração registrada.')))
  if (admin) {
    sections.push(section('Auditoria', table(['Data e hora', 'Ação', 'Quem', 'Campo'], list(data.audit).slice().reverse().map((item) => [fmtDateTime(item.timestamp), item.label || item.action, item.actor, item.field]), 'Nenhuma entrada.')))
  }

  const subtitle = [institution.name, `Gerado em ${fmtDateTime(data.generatedAt)}`, admin && data.generatedBy ? `por ${data.generatedBy}` : ''].filter(Boolean).join(' · ')
  const dpo = institution.dpo ? `Encarregado de dados: ${[institution.dpo.name, institution.dpo.email, institution.dpo.phone].filter(Boolean).join(' · ')}` : ''
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#171a21;margin:0;background:#fff}
    .wrap{padding:28px 34px;max-width:960px;margin:0 auto}
    header{border-bottom:2px solid #182033;padding-bottom:12px;margin-bottom:14px}
    header h1{font-size:21px;margin:0 0 4px} header p{margin:2px 0;color:#596273;font-size:12px}
    .notice{border:1px solid #d7dbe3;border-radius:8px;padding:10px 12px;font-size:12px;color:#384152;background:#f6f7fa}
    section{margin-top:18px;break-inside:auto}
    h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#182033;margin:0 0 6px}
    table{border-collapse:collapse;width:100%;font-size:12px;margin-bottom:6px}
    th,td{border:1px solid #d7dbe3;padding:5px 8px;text-align:left;vertical-align:top;word-break:break-word}
    thead th{background:#182033;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
    table.pairs th{width:32%;background:#eef1f6;color:#182033;font-weight:600}
    tr{break-inside:avoid}
    .empty{color:#8790a0;font-size:12px;margin:2px 0 6px}
    .note{color:#596273;font-size:11px;margin:2px 0 6px}
    footer{margin-top:24px;display:flex;justify-content:space-between;gap:12px;color:#8790a0;font-size:11px}
    @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.wrap{padding:0}}
  </style></head><body><div class="wrap">
    <header>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(subtitle)}</p>
      ${dpo ? `<p>${escapeHtml(dpo)}</p>` : ''}
    </header>
    <p class="notice">${escapeHtml(data.notice || '')}</p>
    ${sections.join('')}
    <footer><span>${escapeHtml(institution.name || 'IClass')}</span><span>Gerado pelo IClass</span></footer>
  </div></body></html>`
}

// Abre a janela de impressão já no clique (antes de esperar o servidor): janela aberta
// depois de um await perde o gesto do usuário e o navegador costuma bloquear. Retorna
// null se o navegador bloqueou.
export function openPrintWindow() {
  const win = window.open('', '_blank')
  if (!win) return null
  try {
    win.document.write('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Preparando…</title></head><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;color:#333">Preparando a cópia dos dados…</body></html>')
    win.document.close()
  } catch { /* janela já fechada: printDataExport cuida */ }
  return win
}

// Escreve a cópia na janela (a aberta por openPrintWindow ou uma nova) e chama a
// impressão. Retorna false se o navegador bloqueou a janela ou ela foi fechada.
export function printDataExport(data, targetWindow) {
  const win = targetWindow && !targetWindow.closed ? targetWindow : (targetWindow ? null : window.open('', '_blank'))
  if (!win) return false
  win.document.open()
  win.document.write(dataExportHtml(data))
  win.document.close()
  win.focus()
  setTimeout(() => win.print(), 300)
  return true
}

// Nome do arquivo baixado: o mesmo do servidor (meus-dados-AAAA-MM-DD.json).
export function dataExportFileName(data, fallback = 'meus-dados.json') {
  const day = String((data && data.generatedAt) || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fallback
  if (data.audience !== 'admin') return `meus-dados-${day}.json`
  const email = String((data.profile && data.profile.email) || 'aluno').toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 80)
  return `dados-${email}-${day}.json`
}

// Salva a cópia já recebida como arquivo JSON (sem pedir de novo ao servidor).
export function downloadDataExport(data, fileName = dataExportFileName(data)) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return fileName
}
