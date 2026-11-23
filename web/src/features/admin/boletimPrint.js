// Boletim do aluno para impressão (o usuário salva como PDF pela caixa de impressão).
// Passa pelo documento impresso único (web/src/lib/printDocument.js, C5 do P4): cabeçalho
// com os dados da escola e rodapé "Gerado por <nome da instituição> em <data>", sem o
// rodapé fixo com o nome do IClass de antes.
//
// Nota, média, situação e menção vêm prontas do servidor (GET /api/admin/student/report,
// contrato C1 do P2): o boletim só formata. A nota abaixo da média mínima fica em vermelho
// pelo critério que vem com o boletim (report.criterio; sem critérios, o padrão 6,0).
import { fmtGradeValue, fmtMencao, isPassingGrade } from '../../lib/grades'
import { html, printDocument, printDocumentHtml, schoolFromBranding, trustedHtml } from '../../lib/printDocument'

const grade = (value) => fmtGradeValue(value, '—')
const pct = (value) => (value === null || value === undefined ? '—' : `${value}%`)
const date = (value) => {
  if (!value) return '—'
  // Data do período letivo (AAAA-MM-DD): sem fuso, para não voltar um dia.
  const ymd = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  return ymd ? value.split('-').reverse().join('/') : new Date(value).toLocaleDateString('pt-BR')
}
const weight = (value) => (value === null || value === undefined ? '—' : String(value).replace('.', ','))

// Nota em vermelho quando abaixo da média mínima do critério do boletim.
function gradeCell(value, criterio) {
  if (value === null || value === undefined) return '—'
  return isPassingGrade(value, criterio) === false ? html`<b class="nota-baixa">${grade(value)}</b>` : html`<b>${grade(value)}</b>`
}

// "Recuperação de" do plano, como o servidor manda (normalizeRecoveryTarget em
// gradingRules.js): 'final' ou 'etapa:N', com N a ordem da etapa.
export function recoveryLabel(target, etapaNome = new Map()) {
  if (target === 'final') return 'recuperação final'
  const match = /^etapa:(\d+)$/.exec(String(target || ''))
  if (!match) return 'recuperação'
  const ordem = Number(match[1])
  return `recuperação: ${etapaNome.get(ordem) || `Etapa ${ordem}`}`
}

function examExtra(exam, etapaNome) {
  const parts = []
  if (exam.fora) parts.push('não conta na média')
  else if (exam.recuperacaoDe) parts.push(recoveryLabel(exam.recuperacaoDe, etapaNome))
  else if (exam.etapa) parts.push(`${etapaNome.get(exam.etapa) || `Etapa ${exam.etapa}`}${exam.peso !== undefined && exam.peso !== null ? ` · peso ${weight(exam.peso)}` : ''}`)
  // Com mais de uma etapa, a avaliação sem etapa fica fora da média (o aviso vem embaixo).
  else if (etapaNome.size > 1 && exam.grade !== null && exam.grade !== undefined) parts.push('sem etapa, fora da média')
  if (exam.arquivada) parts.push('arquivada, fora da média')
  return parts.join(' · ')
}

// Opções do documento (printDocument) do boletim. A escola do cabeçalho, o nome do rodapé
// e o fuso da data vêm com o boletim (report.identidade e report.fuso: a escola do curso
// DESTE boletim, que na ficha pode ser outro curso que o aberto no painel). identity
// ({ escola, displayName, fuso }, da identidade do painel) só vale para boletim de versão
// anterior, sem esses campos; sem nada, o nome da instituição que vem com o boletim.
export function boletimDocument(report, identity = {}) {
  const student = report.student || {}
  const name = (student.nomeSocial && student.nomeSocial.trim()) || student.name || student.email || 'Aluno'
  const attendance = report.attendance || {}
  const criterio = report.criterio
  const etapas = Array.isArray(report.etapas) ? report.etapas : []
  const withCriteria = etapas.length > 0
  const etapaNome = new Map(etapas.map((etapa) => [etapa.ordem, etapa.nome]))
  const institution = report.institution || ''
  const ownIdentity = report.identidade && typeof report.identidade === 'object' ? report.identidade : null
  const escola = { nome: institution, ...((ownIdentity ? schoolFromBranding(ownIdentity) : identity.escola) || {}) }
  if (!escola.nome) escola.nome = institution
  const displayName = (ownIdentity && ownIdentity.displayName) || identity.displayName || institution
  const fuso = report.fuso || identity.fuso

  const subtitle = [
    report.course?.name || '',
    report.className ? `Turma ${report.className}` : '',
    report.periodoLetivo?.nome || report.period || '',
  ].filter(Boolean).join(' · ')

  const secoes = []
  secoes.push({
    titulo: 'Aluno',
    pares: [
      ['Nome', name],
      ...(student.matricula ? [['Matrícula', student.matricula]] : []),
      ['E-mail', student.email || '—'],
      ...(report.periodoLetivo ? [['Período letivo', `${report.periodoLetivo.nome} (${date(report.periodoLetivo.inicio)} a ${date(report.periodoLetivo.fim)})`]] : []),
      ['Emitido em', date(report.generatedAt)],
    ],
  })

  if (report.gradesHidden) {
    secoes.push({ titulo: 'Notas', texto: 'As notas não aparecem para esta conta.' })
  } else {
    // Resultado: média final, situação e menção do servidor.
    const resultado = [
      [withCriteria ? 'Média final' : 'Média geral', grade(report.mediaFinal ?? report.overallAverage)],
    ]
    if (report.recuperacaoFinal !== null && report.recuperacaoFinal !== undefined) resultado.push(['Recuperação final', grade(report.recuperacaoFinal)])
    if (report.situacaoRotulo) resultado.push(['Situação', report.situacaoRotulo])
    if (fmtMencao(report.mencao)) resultado.push(['Menção', `${fmtMencao(report.mencao)}${report.mencao.nome ? ` (${report.mencao.nome})` : ''}`])
    if (criterio && criterio.mediaMinima !== undefined && criterio.mediaMinima !== null) resultado.push(['Média mínima para aprovação', grade(criterio.mediaMinima)])
    secoes.push({ titulo: 'Resultado', pares: resultado })

    if (withCriteria) {
      secoes.push({
        titulo: 'Notas por etapa',
        tabela: {
          colunas: ['Etapa', 'Peso', 'Média', 'Recuperação', 'Nota da etapa'],
          alinhar: ['', 'direita', 'direita', 'direita', 'direita'],
          linhas: etapas.map((etapa) => [
            etapa.nome,
            weight(etapa.peso),
            etapa.semNota ? 'sem nota' : grade(etapa.media),
            grade(etapa.recuperacao),
            etapa.semNota ? '—' : gradeCell(etapa.final, criterio),
          ]),
        },
      })
    }

    const porDisciplina = Array.isArray(report.situacaoPorDisciplina) ? report.situacaoPorDisciplina : []
    if (porDisciplina.length > 0) {
      secoes.push({
        titulo: 'Situação por disciplina',
        tabela: {
          colunas: ['Disciplina', 'Média final', 'Situação', ...(porDisciplina.some((item) => fmtMencao(item.mencao)) ? ['Menção'] : [])],
          alinhar: ['', 'direita', ''],
          linhas: porDisciplina.map((item) => [
            item.nome,
            gradeCell(item.mediaFinal, criterio),
            item.situacaoRotulo || '—',
            ...(porDisciplina.some((entry) => fmtMencao(entry.mencao)) ? [fmtMencao(item.mencao, '—')] : []),
          ]),
        },
      })
    }

    // Avaliações por módulo (provas, avaliações da turma e tarefas com nota publicada).
    const linhas = []
    ;(report.modules || []).forEach((module) => {
      linhas.push([html`<b>${module.name}</b>`, '', '', '', html`<b>Média ${grade(module.average)}</b>`])
      if (!(module.exams || []).length) linhas.push(['Nenhuma avaliação neste módulo.', '', '', '', ''])
      ;(module.exams || []).forEach((exam) => {
        linhas.push([
          exam.title || exam.examKey,
          examExtra(exam, etapaNome) || '—',
          `${exam.attempts || 0}${exam.pendingAttempts ? ` (+${exam.pendingAttempts} a publicar)` : ''}`,
          date(exam.lastAt),
          gradeCell(exam.grade, criterio),
        ])
      })
    })
    secoes.push({
      titulo: 'Avaliações',
      tabela: {
        colunas: ['Avaliação', withCriteria ? 'Etapa e peso' : 'Observação', 'Tentativas', 'Última', 'Nota'],
        alinhar: ['', '', 'direita', 'direita', 'direita'],
        linhas,
        vazio: 'Curso sem avaliações.',
      },
    })
  }

  const disciplines = Array.isArray(attendance.disciplines) ? attendance.disciplines : []
  const withPlanned = disciplines.some((d) => d.aulasPrevistas !== null && d.aulasPrevistas !== undefined)
  const withHours = disciplines.some((d) => d.cargaHoraria !== null && d.cargaHoraria !== undefined)
  const withRemaining = disciplines.some((d) => d.faltasPermitidasRestantes !== null && d.faltasPermitidasRestantes !== undefined)
  secoes.push({
    titulo: 'Frequência',
    pares: [
      ['Frequência geral', pct(attendance.frequency)],
      ['Faltas (aulas)', String(attendance.faltas ?? 0)],
      ...(attendance.aulasPrevistas !== null && attendance.aulasPrevistas !== undefined ? [['Aulas previstas no período', String(attendance.aulasPrevistas)]] : []),
      ...(attendance.frequenciaMinima !== null && attendance.frequenciaMinima !== undefined ? [['Frequência mínima', `${attendance.frequenciaMinima}%`]] : []),
      ...(attendance.faltasPermitidasRestantes !== null && attendance.faltasPermitidasRestantes !== undefined ? [['Faltas que ainda pode ter', String(attendance.faltasPermitidasRestantes)]] : []),
      ['Tópicos concluídos', `${report.progress?.completedUnits ?? 0}/${report.progress?.totalUnits ?? 0}`],
    ],
  })
  secoes.push({
    titulo: 'Frequência por disciplina',
    tabela: {
      colunas: ['Disciplina', ...(withHours ? ['Carga horária'] : []), ...(withPlanned ? ['Aulas previstas'] : []), 'Presenças', 'Faltas', 'Frequência', ...(withRemaining ? ['Faltas que ainda pode ter'] : [])],
      alinhar: ['', ...(withHours ? ['direita'] : []), ...(withPlanned ? ['direita'] : []), 'direita', 'direita', 'direita', 'direita'],
      linhas: disciplines.map((d) => [
        d.name,
        ...(withHours ? [d.cargaHoraria === null || d.cargaHoraria === undefined ? '—' : `${d.cargaHoraria} h`] : []),
        ...(withPlanned ? [d.aulasPrevistas === null || d.aulasPrevistas === undefined ? '—' : String(d.aulasPrevistas)] : []),
        String(d.presentes ?? 0),
        String(d.faltas ?? 0),
        pct(d.frequencia),
        ...(withRemaining ? [d.faltasPermitidasRestantes === null || d.faltasPermitidasRestantes === undefined ? '—' : String(d.faltasPermitidasRestantes)] : []),
      ]),
      vazio: 'Nenhuma aula lançada.',
    },
  })

  const examKeys = (report.modules || []).flatMap((module) => (module.exams || []).filter((exam) => exam.grade !== null && exam.grade !== undefined).map((exam) => exam.examKey))
  const hasRepeatedExam = new Set(examKeys).size < examKeys.length
  const notes = [
    'Só notas publicadas entram na média.',
    hasRepeatedExam ? 'Prova aplicada mais de uma vez aparece em uma linha por aplicação, e cada aplicação entra na média.' : '',
    'Faltas abonadas não contam.',
    attendance.days ? `${attendance.days} dia(s) com registro de presença.` : '',
  ].filter(Boolean).join(' ')
  const avisos = Array.isArray(report.avisosNotas) ? report.avisosNotas.filter(Boolean) : []
  secoes.push({
    paragrafos: avisos,
    observacao: notes,
    assinaturas: [report.issuedBy || 'Instrutor', 'Responsável pelo aluno'],
  })

  return {
    titulo: `Boletim — ${name}`,
    subtitulo: subtitle,
    escola,
    displayName,
    fuso,
    rodapeEsquerda: [escola.nome, report.course?.name].filter(Boolean).join(' · '),
    estilo: trustedHtml('.nota-baixa{color:#cf3943}'),
    secoes,
  }
}

// HTML do boletim (o que vai para a janela de impressão; os testes conferem por aqui).
export function boletimHtml(report, identity) {
  return printDocumentHtml(boletimDocument(report, identity))
}

// Abre a caixa de impressão com o boletim, na janela aberta no clique (openPrintWindow)
// ou numa nova. Retorna false se o pop-up foi bloqueado.
export function printBoletim(report, identity, targetWindow) {
  return printDocument(boletimDocument(report, identity), targetWindow)
}
