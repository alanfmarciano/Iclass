// Atividades (tarefas com envio) no portal do aluno (fase 3, C9 / P1-g; FUN-01, D8, D9,
// D12 do P1). Funções puras, sem React: a lista (AtividadesPage), o detalhe com o envio
// (AtividadeDetalhePage), o cartão da Início e o comprovante impresso usam as mesmas
// frases e regras.
//
// - A situação ('A fazer', 'Enviada', 'Refazer até ...') e o prazo efetivo (com a
//   prorrogação do aluno) vêm prontos do servidor (GET /api/student/assignments, contrato
//   C4 do P1): a tela só agrupa e escreve.
// - Horários sempre no relógio da escola: o servidor manda o fuso (timezone) e a hora dele
//   (serverNow) junto; "faltam 2 dias" conta pelo relógio do servidor, nunca pelo do
//   celular (que pode estar errado, D8).
// - Antes de mandar, a tela confere tipo, tamanho e quantidade com as mesmas frases do
//   servidor (backend/routes/studentAssignments.js e utils/assignmentFiles.js), para o
//   aluno não esperar o upload inteiro e ouvir "não". O servidor confere de novo (ele é
//   quem manda).
import { relativeDeadlineText } from '../../admin/tarefas/assignmentText'
import { formatBytes, lateAmountText, safeExternalLink } from '../../admin/tarefas/correction'
import { fmtGrade } from '../../../lib/grades'
import { displayEmail } from '../../../lib/studentProfile'
import { MB, emptySubmissionText, fileProblem, linkProblem, mbText, selectionProblem } from './atividadeRules'

export { MB, emptySubmissionText, fileProblem, formatBytes, lateAmountText, linkProblem, relativeDeadlineText, safeExternalLink, selectionProblem }


// ------------------------------------------------------------ situação
// Cor do selo de cada situação (o texto do selo sempre diz a situação: a cor só reforça).
const SITUATION_TONES = Object.freeze({
  a_fazer: 'info',
  atrasada: 'danger',
  refazer: 'warning',
  nao_aberta: 'neutral',
  enviada: 'success',
  entregue_em_maos: 'success',
  devolvida: 'info',
  encerrada_sem_envio: 'neutral',
})

export function situationTone(row) {
  if (row && row.situacaoTexto === 'Turma encerrada') return 'neutral'
  return SITUATION_TONES[row?.situacao] || 'neutral'
}

const WAITING_CODES = new Set(['a_fazer', 'atrasada', 'refazer', 'nao_aberta'])

// Esperando o envio do aluno (entra em "A fazer" e na Início).
export function isToDo(row) {
  return !!row && WAITING_CODES.has(row.situacao) && row.aceitaEnvio === true
}

// Seções da lista, na ordem da tela. Cada tarefa cai numa só; o servidor já manda por
// prazo, e a ordem dentro da seção é a dele.
export const SECTIONS = Object.freeze([
  { id: 'a-fazer', title: 'A fazer', empty: 'Nenhuma atividade esperando o seu envio.' },
  { id: 'enviadas', title: 'Enviadas', empty: 'Nada enviado ainda.' },
  { id: 'devolvidas', title: 'Devolvidas', empty: 'Nenhuma atividade devolvida ainda.' },
  { id: 'encerradas', title: 'Encerradas sem envio', empty: '' },
])

export function sectionOf(row) {
  if (isToDo(row)) return 'a-fazer'
  if (row?.situacao === 'devolvida') return 'devolvidas'
  if (row?.situacao === 'enviada' || row?.situacao === 'entregue_em_maos') return 'enviadas'
  return 'encerradas'
}

export function groupAssignments(rows) {
  const groups = Object.fromEntries(SECTIONS.map((section) => [section.id, []]))
  ;(Array.isArray(rows) ? rows : []).forEach((row) => { groups[sectionOf(row)].push(row) })
  return groups
}

// ------------------------------------------------------------ datas no relógio da escola
const WEEKDAYS = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.']

function zoneParts(ms, timezone) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  let format
  try {
    format = new Intl.DateTimeFormat('en-CA', timezone ? { ...options, timeZone: timezone } : options)
  } catch {
    format = new Intl.DateTimeFormat('en-CA', options)
  }
  const out = {}
  format.formatToParts(new Date(ms)).forEach((part) => { out[part.type] = part.value })
  const hour = out.hour === '24' ? '00' : out.hour
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(out.year), Number(out.month) - 1, Number(out.day))).getUTCDay()]
  return { year: out.year, month: out.month, day: out.day, time: `${hour}:${out.minute}`, weekday }
}

// 'sex., 22/11 às 23:00' no fuso da escola; com o ano quando não é o ano de agora
// ('sex., 08/01/2027 às 23:00'). '' sem instante.
export function dateTimeText(ms, timezone, now = null) {
  const p = zoneParts(ms, timezone)
  if (!p) return ''
  const current = typeof now === 'number' ? zoneParts(now, timezone) : null
  const year = current && current.year === p.year ? '' : `/${p.year}`
  return `${p.weekday}, ${p.day}/${p.month}${year} às ${p.time}`
}

// '14:32' no fuso da escola ('' sem instante).
export function timeText(ms, timezone) {
  const p = zoneParts(ms, timezone)
  return p ? p.time : ''
}

// '20/11' no fuso da escola ('' sem instante).
export function dayMonthText(ms, timezone) {
  const p = zoneParts(ms, timezone)
  return p ? `${p.day}/${p.month}` : ''
}

// '20/11/2026 às 14:32' no fuso da escola ('' sem instante).
export function fullDateTimeText(ms, timezone) {
  const p = zoneParts(ms, timezone)
  return p ? `${p.day}/${p.month}/${p.year} às ${p.time}` : ''
}

// Linha do prazo: 'Prazo: sex., 22/11 às 23:00 (faltam 2 dias)'. O "faltam" só aparece
// enquanto a atividade espera o envio (na enviada ou devolvida ele só atrapalha).
export function deadlineLine(row, now, timezone) {
  if (!row || typeof row.dueAt !== 'number') return 'Sem prazo definido'
  const absolute = dateTimeText(row.dueAt, timezone, now)
  const relative = isToDo(row) && row.situacao !== 'refazer' ? relativeDeadlineText(row.dueAt, now) : ''
  return `Prazo: ${absolute}${relative ? ` (${relative})` : ''}`
}

// 'Envios encerram sáb., 23/11 às 08:00' ('' sem encerramento).
export function closeLine(closeAt, timezone, now = null) {
  if (typeof closeAt !== 'number') return ''
  return `Envios encerram ${dateTimeText(closeAt, timezone, now)}`
}

// ------------------------------------------------------------ nota devolvida
// Nota da devolução (0 a 100 no servidor, 0 a 10 com vírgula na tela).
export function returnSummary(devolucao) {
  if (!devolucao) return null
  const desconto = Number(devolucao.desconto) || 0
  return {
    nota: fmtGrade(devolucao.nota),
    notaFinal: fmtGrade(devolucao.notaFinal),
    desconto,
    descontoTexto: desconto > 0 ? `Desconto por atraso: -${desconto}%` : '',
  }
}

// ------------------------------------------------------------ comprovante
// 'Recebido às 14:32 de 20/11 — versão 2 — 3 arquivos (5,2 MB) — código A1B2C3D4'. A
// hora é a da chegada do pedido ao servidor (requestAt), a que vale para o prazo.
export function receiptLine(version, timezone) {
  if (!version) return ''
  const files = Array.isArray(version.files) ? version.files : []
  const parts = [`Recebido às ${timeText(version.requestAt, timezone)} de ${dayMonthText(version.requestAt, timezone)}`, `versão ${version.n}`]
  if (files.length) parts.push(`${files.length} ${files.length === 1 ? 'arquivo' : 'arquivos'} (${formatBytes(version.bytes)})`)
  if (version.text) parts.push('resposta em texto')
  if (version.link) parts.push('link')
  if (version.comprovante) parts.push(`código ${version.comprovante}`)
  return parts.join(' — ')
}

// 'No prazo' ou 'Com atraso de 2 dias'.
export function versionTimingText(version) {
  if (!version || !version.late) return 'No prazo'
  const amount = lateAmountText(version.lateMs)
  return amount ? `Com atraso de ${amount}` : 'Com atraso'
}

// Comprovante para imprimir ou salvar em PDF (web/src/lib/printDocument.js: cabeçalho da
// escola e "Gerado por" no rodapé). student: { name, email, studentClass, courseName }.
export function receiptDocument({ assignment, version, student = {}, escola, displayName, timezone, geradoEm }) {
  const files = Array.isArray(version?.files) ? version.files : []
  const pares = [
    ['Aluno', student.name || '—'],
    ['E-mail', displayEmail(student.email || '') || '—'],
    ['Turma', [student.courseName, student.studentClass].filter(Boolean).join(' · ') || '—'],
    ['Atividade', assignment?.title || '—'],
    ['Prazo', typeof assignment?.dueAt === 'number' ? fullDateTimeText(assignment.dueAt, timezone) : 'Sem prazo definido'],
    ['Versão', String(version?.n ?? '—')],
    ['Recebido em', fullDateTimeText(version?.requestAt, timezone) || '—'],
    ['Situação do envio', versionTimingText(version)],
    ['Código do comprovante', version?.comprovante || '—'],
  ]
  const secoes = [
    { titulo: 'Entrega', pares },
    {
      titulo: 'Arquivos recebidos',
      tabela: {
        colunas: ['Arquivo', 'Tamanho', 'Código'],
        linhas: files.map((file) => [file.name, formatBytes(file.size), file.comprovante || '—']),
        vazio: 'Nenhum arquivo nesta versão.',
        alinhar: ['', 'direita', 'centro'],
      },
    },
  ]
  if (version?.text) secoes.push({ titulo: 'Resposta em texto', texto: version.text })
  if (version?.link) secoes.push({ titulo: 'Link enviado', texto: version.link })
  secoes.push({
    observacao: 'A hora de recebimento é a da chegada do envio ao computador do professor, a que vale para o prazo. O código do comprovante muda se qualquer parte do que foi recebido mudar; o professor confere o mesmo código na tela dele.',
  })
  return {
    titulo: 'Comprovante de entrega',
    subtitulo: assignment?.title || '',
    escola,
    displayName,
    fuso: timezone || undefined,
    geradoEm,
    secoes,
  }
}

// ------------------------------------------------------------ arquivos escolhidos
function extensionOf(name) {
  const match = /\.[^./\\]+$/.exec(String(name || ''))
  return match ? match[0].toLowerCase() : ''
}

const EXTENSION_BY_TYPE = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
})

// Arquivo sem extensão no nome (galeria de alguns Android: 'IMG_2031'): ganha a do tipo
// que o aparelho informou ('IMG_2031.jpg'). O servidor recusa nome sem extensão.
export function withExtension(file) {
  if (!file || extensionOf(file.name)) return file
  const ext = EXTENSION_BY_TYPE[String(file.type || '').toLowerCase()]
  if (!ext || typeof File !== 'function') return file
  return new File([file], `${String(file.name || 'arquivo').trim() || 'arquivo'}${ext}`, { type: file.type, lastModified: file.lastModified })
}

// "O que enviar", por extenso: 'Até 5 arquivos de até 10 MB cada (até 50 MB por envio).'
export function limitsText(aceita) {
  if (!aceita?.resposta?.files) return ''
  const maxFiles = Number(aceita.maxFiles) || 1
  const files = maxFiles === 1 ? '1 arquivo' : `${maxFiles} arquivos`
  const each = maxFiles === 1 ? '' : ' cada'
  const total = aceita.maxTotalMb && maxFiles > 1 ? ` (até ${aceita.maxTotalMb} MB por envio)` : ''
  return `Até ${files} de até ${mbText(aceita.maxSizeMb)} MB${each}${total}.`
}

// Como responder: 'arquivo, texto ou link'.
export function responseKindsText(resposta) {
  const kinds = [resposta?.files && 'arquivo', resposta?.text && 'texto', resposta?.link && 'link'].filter(Boolean)
  if (kinds.length <= 1) return kinds[0] || ''
  return `${kinds.slice(0, -1).join(', ')} ou ${kinds[kinds.length - 1]}`
}

// Corpo do envio (o mesmo que o servidor lê: campo 'files' para cada arquivo, 'text' e
// 'link' só quando a tarefa recebe e há algo escrito).
export function buildSubmissionForm({ files = [], text = '', link = '', resposta = {} }) {
  const form = new FormData()
  if (resposta.files) files.forEach((file) => form.append('files', file, file.name))
  if (resposta.text && String(text).trim()) form.append('text', text)
  if (resposta.link && String(link).trim()) form.append('link', String(link).trim())
  return form
}
