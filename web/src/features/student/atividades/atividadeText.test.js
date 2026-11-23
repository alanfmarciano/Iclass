import { describe, expect, it } from 'vitest'
import { printDocumentHtml } from '../../../lib/printDocument'
import {
  MB, buildSubmissionForm, closeLine, dateTimeText, deadlineLine, emptySubmissionText, fileProblem, groupAssignments,
  isToDo, limitsText, linkProblem, newEnvioId, receiptDocument, receiptLine, responseKindsText, returnSummary, sectionOf, situationText, versionWithEnvioId,
  selectionProblem, situationTone, studentRelativeDeadlineText, versionTimingText, withExtension,
} from './atividadeText'

// Fase 3, C9 (P1-g; FUN-01): textos e regras das telas de atividade do aluno. Antes do C9
// o portal do aluno não tinha onde ver nem enviar uma tarefa (estes módulos não existiam).

const TZ = 'America/Sao_Paulo'
// 22/11/2026 (domingo) 12:00 em São Paulo = 15:00 UTC.
const NOW = Date.UTC(2026, 10, 22, 15, 0)
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const ACEITA = { resposta: { files: true, text: true, link: true }, extensoes: ['.pdf', '.jpg', '.jpeg', '.png'], maxFiles: 2, maxSizeMb: 1, maxTotalMb: 2 }

describe('atividades do aluno: situação e seções', () => {
  const rows = [
    { id: 'a', situacao: 'a_fazer', aceitaEnvio: true },
    { id: 'b', situacao: 'atrasada', aceitaEnvio: true },
    { id: 'c', situacao: 'refazer', aceitaEnvio: true },
    { id: 'd', situacao: 'enviada', aceitaEnvio: true },
    { id: 'e', situacao: 'entregue_em_maos', aceitaEnvio: true },
    { id: 'f', situacao: 'devolvida', aceitaEnvio: false },
    { id: 'g', situacao: 'encerrada_sem_envio', aceitaEnvio: false },
    // Turma encerrada: o servidor manda aceitaEnvio false e o selo "Turma encerrada".
    { id: 'h', situacao: 'a_fazer', aceitaEnvio: false, situacaoTexto: 'Turma encerrada' },
  ]

  it('separa em A fazer, Enviadas, Devolvidas e Encerradas, mantendo a ordem do servidor', () => {
    const groups = groupAssignments(rows)
    expect(groups['a-fazer'].map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(groups.enviadas.map((row) => row.id)).toEqual(['d', 'e'])
    expect(groups.devolvidas.map((row) => row.id)).toEqual(['f'])
    expect(groups.encerradas.map((row) => row.id)).toEqual(['g', 'h'])
    expect(isToDo(rows[7])).toBe(false)
    expect(sectionOf({})).toBe('encerradas')
  })

  it('a cor do selo acompanha a situação; turma encerrada fica neutra', () => {
    expect(situationTone(rows[0])).toBe('info')
    expect(situationTone(rows[1])).toBe('danger')
    expect(situationTone(rows[2])).toBe('warning')
    expect(situationTone(rows[3])).toBe('success')
    expect(situationTone(rows[7])).toBe('neutral')
    expect(situationTone(null)).toBe('neutral')
  })

  it('C9 ajuste 1: refazer com o prazo vencido (sem aceitar envio) fica em Enviadas, com o selo "Prazo para refazer encerrado"', () => {
    const expired = { id: 'r', situacao: 'refazer', aceitaEnvio: false, situacaoTexto: 'Refazer até 21/11 às 23:00', versoes: 1 }
    expect(sectionOf(expired)).toBe('enviadas')
    expect(situationText(expired)).toBe('Prazo para refazer encerrado')
    expect(situationTone(expired)).toBe('neutral')
    // Refazer na turma encerrada: também tem versões; o selo continua "Turma encerrada".
    const closedClass = { situacao: 'refazer', aceitaEnvio: false, situacaoTexto: 'Turma encerrada', versoes: 2 }
    expect(sectionOf(closedClass)).toBe('enviadas')
    expect(situationText(closedClass)).toBe('Turma encerrada')
    // Qualquer tarefa com versão enviada nunca cai em "Encerradas sem envio".
    expect(sectionOf({ situacao: 'a_fazer', aceitaEnvio: false, situacaoTexto: 'Turma encerrada', versoes: 1 })).toBe('enviadas')
    // Refazer aberto continua em A fazer, com o texto do servidor.
    expect(situationText({ situacao: 'refazer', aceitaEnvio: true, situacaoTexto: 'Refazer até 25/11 às 18:00' })).toBe('Refazer até 25/11 às 18:00')
  })

  it('C9 ajuste 1: identificador do envio com 24 caracteres seguros e diferente a cada envio; acha a versão dele', () => {
    const a = newEnvioId()
    const b = newEnvioId()
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(a).not.toBe(b)
    expect(versionWithEnvioId([{ n: 1, envioId: '' }, { n: 2, envioId: a }], a)).toEqual({ n: 2, envioId: a })
    expect(versionWithEnvioId([{ n: 1, envioId: '' }], a)).toBeNull()
    expect(versionWithEnvioId([{ n: 1, envioId: '' }], '')).toBeNull()
    expect(versionWithEnvioId(null, a)).toBeNull()
  })
})

describe('atividades do aluno: prazo no relógio da escola', () => {
  it('escreve o prazo no fuso da escola e o "faltam" pelo relógio do servidor', () => {
    const dueAt = Date.UTC(2026, 10, 25, 2, 0) // 24/11 23:00 em São Paulo
    expect(dateTimeText(dueAt, TZ, NOW)).toBe('ter., 24/11 às 23:00')
    expect(deadlineLine({ situacao: 'a_fazer', aceitaEnvio: true, dueAt }, NOW, TZ)).toBe('Prazo: ter., 24/11 às 23:00 (faltam 2 dias e 11 horas)')
    // Enviada ou devolvida: sem o "faltam".
    expect(deadlineLine({ situacao: 'enviada', aceitaEnvio: true, dueAt }, NOW, TZ)).toBe('Prazo: ter., 24/11 às 23:00')
    expect(deadlineLine({ situacao: 'atrasada', aceitaEnvio: true, dueAt: NOW - 3 * DAY }, NOW, TZ)).toMatch(/\(terminou há 3 dias\)$/)
    expect(deadlineLine({ situacao: 'a_fazer', dueAt: null }, NOW, TZ)).toBe('Sem prazo definido')
  })

  it('C9 ajuste 2: nos três últimos dias o "faltam" do aluno mostra também as horas (1 dia e 23 h não é "falta 1 dia")', () => {
    const HOUR = 60 * 60 * 1000
    expect(studentRelativeDeadlineText(NOW + DAY + 23 * HOUR + 59 * 60000, NOW)).toBe('falta 1 dia e 23 horas')
    expect(studentRelativeDeadlineText(NOW + DAY + HOUR, NOW)).toBe('falta 1 dia e 1 hora')
    expect(studentRelativeDeadlineText(NOW + DAY + 20 * 60000, NOW)).toBe('falta 1 dia')
    expect(studentRelativeDeadlineText(NOW + 2 * DAY + 5 * HOUR, NOW)).toBe('faltam 2 dias e 5 horas')
    // Menos de um dia e três dias ou mais: como no painel do professor.
    expect(studentRelativeDeadlineText(NOW + 5 * HOUR, NOW)).toBe('faltam 5 horas')
    expect(studentRelativeDeadlineText(NOW + 3 * DAY + 20 * HOUR, NOW)).toBe('faltam 3 dias')
    expect(studentRelativeDeadlineText(NOW - DAY - 5 * HOUR, NOW)).toBe('terminou há 1 dia')
    expect(studentRelativeDeadlineText(null, NOW)).toBe('')
  })

  it('mostra o ano quando o prazo é de outro ano e não depende do fuso do aparelho', () => {
    const nextYear = Date.UTC(2027, 0, 8, 2, 0) // 07/01/2027 23:00 em São Paulo
    expect(dateTimeText(nextYear, TZ, NOW)).toBe('qui., 07/01/2027 às 23:00')
    expect(dateTimeText(nextYear, 'Asia/Tokyo', NOW)).toBe('sex., 08/01/2027 às 11:00')
    expect(closeLine(nextYear, TZ, NOW)).toBe('Envios encerram qui., 07/01/2027 às 23:00')
    expect(closeLine(null, TZ, NOW)).toBe('')
  })
})

describe('atividades do aluno: o que enviar e as conferências antes de mandar', () => {
  it('descreve os limites e as formas de responder por extenso', () => {
    expect(limitsText(ACEITA)).toBe('Até 2 arquivos de até 1 MB cada (até 2 MB por envio).')
    expect(limitsText({ ...ACEITA, maxFiles: 1, maxSizeMb: 2.5 })).toBe('Até 1 arquivo de até 2,5 MB.')
    expect(limitsText({ resposta: { files: false } })).toBe('')
    expect(responseKindsText({ files: true, text: true, link: true })).toBe('arquivo, texto ou link')
    expect(responseKindsText({ files: true })).toBe('arquivo')
    expect(emptySubmissionText({ files: true, link: true })).toBe('O envio está vazio. Envie um arquivo ou o link.')
  })

  it('recusa com as frases do servidor: executável, tipo fora da tarefa, sem extensão, grande, vazio', () => {
    expect(fileProblem({ name: 'relatorio.pdf', size: 1000 }, ACEITA)).toBe('')
    expect(fileProblem({ name: 'virus.exe', size: 10 }, ACEITA)).toBe('O arquivo "virus.exe" não pode ser enviado: arquivos executáveis (.exe) são sempre recusados.')
    expect(fileProblem({ name: 'planilha.xlsx', size: 10 }, ACEITA)).toBe('O arquivo "planilha.xlsx" (.xlsx) não é aceito nesta tarefa. Formatos aceitos: .pdf, .jpg, .jpeg, .png.')
    expect(fileProblem({ name: 'IMG_2031', size: 10 }, ACEITA)).toBe('O arquivo "IMG_2031" não tem extensão (como .pdf ou .jpg). Renomeie e envie de novo.')
    expect(fileProblem({ name: 'foto.JPG', size: MB + 1 }, ACEITA)).toBe('O arquivo "foto.JPG" passa do limite de 1 MB por arquivo desta tarefa.')
    expect(fileProblem({ name: 'vazio.pdf', size: 0 }, ACEITA)).toBe('O arquivo "vazio.pdf" está vazio.')
  })

  it('confere a quantidade, o total do envio e o link', () => {
    const one = { size: MB }
    expect(selectionProblem([one, one], ACEITA)).toBe('')
    expect(selectionProblem([one, one, one], ACEITA)).toBe('Envie no máximo 2 arquivo(s) por vez nesta tarefa.')
    expect(selectionProblem([one, { size: MB + 1 }], ACEITA)).toBe('O envio passa do limite de 2 MB por envio. Envie menos arquivos ou arquivos menores.')
    expect(linkProblem('')).toBe('')
    expect(linkProblem('https://github.com/ana/projeto')).toBe('')
    expect(linkProblem('github.com/ana')).toBe('Informe um link que comece com http:// ou https://.')
    expect(linkProblem('javascript:alert(1)')).toBe('Informe um link que comece com http:// ou https://.')
  })

  it('arquivo da galeria sem extensão ganha a do tipo informado pelo aparelho', () => {
    const fixed = withExtension(new File(['x'], 'IMG_2031', { type: 'image/jpeg' }))
    expect(fixed.name).toBe('IMG_2031.jpg')
    expect(fixed.type).toBe('image/jpeg')
    const same = new File(['x'], 'relatorio.pdf', { type: 'application/pdf' })
    expect(withExtension(same)).toBe(same)
    const unknown = new File(['x'], 'arquivo', { type: 'application/x-desconhecido' })
    expect(withExtension(unknown)).toBe(unknown)
  })

  it('o corpo do envio leva "files" para cada arquivo e o texto e o link só quando a tarefa recebe', () => {
    const files = [new File(['a'], 'a.pdf'), new File(['b'], 'b.jpg')]
    const form = buildSubmissionForm({ files, text: 'Minha resposta', link: ' https://x.org ', resposta: { files: true, text: true, link: true } })
    expect(form.getAll('files').map((file) => file.name)).toEqual(['a.pdf', 'b.jpg'])
    expect(form.get('text')).toBe('Minha resposta')
    expect(form.get('link')).toBe('https://x.org')
    const onlyFiles = buildSubmissionForm({ files, text: 'ignorado', link: 'https://x.org', resposta: { files: true } })
    expect(onlyFiles.get('text')).toBeNull()
    expect(onlyFiles.get('link')).toBeNull()
    expect(buildSubmissionForm({ files: [], text: '   ', resposta: { text: true } }).get('text')).toBeNull()
  })
})

describe('[UC-IMPRESSAO-001] atividades do aluno: comprovante e devolução', () => {
  const version = {
    n: 2,
    requestAt: Date.UTC(2026, 10, 20, 17, 32), // 20/11 14:32 em São Paulo
    late: false,
    lateMs: 0,
    files: [{ id: 'f_1', name: 'Relatório <final>.pdf', size: 3 * MB, comprovante: '0A1B2C3D' }, { id: 'f_2', name: 'foto.jpg', size: 2.2 * MB, comprovante: 'FFEE0011' }],
    bytes: 5.2 * MB,
    text: '',
    link: '',
    comprovante: 'A1B2C3D4',
  }

  it('linha do comprovante com a hora da chegada, a versão, os arquivos e o código', () => {
    expect(receiptLine(version, TZ)).toBe('Recebido às 14:32 de 20/11 — versão 2 — 2 arquivos (5,2 MB) — código A1B2C3D4')
    expect(receiptLine({ ...version, files: [], bytes: 0, text: 'Resposta', link: 'https://x.org' }, TZ)).toBe('Recebido às 14:32 de 20/11 — versão 2 — resposta em texto — link — código A1B2C3D4')
    expect(versionTimingText(version)).toBe('No prazo')
    expect(versionTimingText({ late: true, lateMs: 2 * DAY })).toBe('Com atraso de 2 dias')
  })

  it('o comprovante impresso sai pelo printDocument: escola, "Gerado por", código, arquivos e texto escapado', () => {
    const doc = receiptDocument({
      assignment: { title: 'Relatório da prática', dueAt: Date.UTC(2026, 10, 21, 2, 59) },
      version,
      student: { name: 'Ana <b>Lima</b>', email: 'aluno-x@sem-email.invalid', studentClass: '1DES', courseName: 'Desenvolvimento' },
      escola: { nome: 'Escola Técnica Modelo' },
      displayName: 'Escola Técnica Modelo',
      timezone: TZ,
      geradoEm: version.requestAt,
    })
    const markup = printDocumentHtml(doc)
    const parsed = new DOMParser().parseFromString(markup, 'text/html')
    expect(parsed.title).toBe('Comprovante de entrega')
    expect(markup).toContain('Escola Técnica Modelo')
    expect(markup).toContain('Gerado por Escola Técnica Modelo em 20/11/2026 às 14:32')
    expect(markup).not.toContain('Gerado pelo IClass')
    expect(markup).toContain('A1B2C3D4')
    expect(markup).toContain('0A1B2C3D')
    expect(markup).toContain('20/11/2026 às 14:32')
    expect(markup).toContain('Desenvolvimento · 1DES')
    // Aluno sem e-mail: nunca o endereço interno.
    expect(markup).not.toContain('sem-email.invalid')
    expect(markup).toContain('sem e-mail')
    // Nome com HTML não vira HTML.
    expect(parsed.querySelector('b')).toBeNull()
    expect(markup).toContain('Relatório &lt;final&gt;.pdf')
  })

  it('devolução: nota final com vírgula e o desconto só quando houve', () => {
    expect(returnSummary({ nota: 85, desconto: 20, notaFinal: 68 })).toEqual({ nota: '8,5', notaFinal: '6,8', desconto: 20, descontoTexto: 'Desconto por atraso: -20%' })
    expect(returnSummary({ nota: 90, desconto: 0, notaFinal: 90 }).descontoTexto).toBe('')
    expect(returnSummary(null)).toBeNull()
  })
})
