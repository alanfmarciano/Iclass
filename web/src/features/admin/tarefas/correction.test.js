import { describe, expect, it } from 'vitest'
import {
  extensionBody, filterCounts, finalScorePreview, formatBytes, gradeBody, gradeInputText, isReturnableRow, lateAmountText, lateDaysStarted,
  lateText, localPartsInZone, manualEntryBody, penaltyLine, queuePosition, readGradeText, redoBody, rowDisplay, rowMatches, rowStatusInfo,
  safeExternalLink, schoolDateTime,
} from './correction'

// Regras das telas de entrega e correção (fase 3, C8 / P1-f; FUN-01). A conta da nota
// final e dos dias de atraso é comparada com a do servidor em
// test/backend/assignments-correction-screen.test.js.
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

const rows = [
  { studentEmail: 'a@x.com', status: 'para_corrigir', versions: 1, lastVersion: { n: 1, late: false } },
  { studentEmail: 'b@x.com', status: 'para_corrigir', versions: 1, lastVersion: { n: 1, late: true, lateMs: DAY } },
  { studentEmail: 'c@x.com', status: 'corrigida', versions: 1, lastVersion: { n: 1, late: false }, grade: { finalScore: 70 } },
  { studentEmail: 'd@x.com', status: 'nao_entregue', versions: 0, lastVersion: null },
  { studentEmail: 'e@x.com', status: 'devolvida', versions: 2, lastVersion: { n: 2, late: true, lateMs: HOUR } },
  { studentEmail: 'f@x.com', status: 'para_corrigir', versions: 0, lastVersion: null, manualEntry: { note: '', at: 1 } },
  { studentEmail: 'g@x.com', status: 'nao_entregue', versions: 0, lastVersion: null, grade: { finalScore: 0 } },
]

describe('filtros e situação da lista da turma', () => {
  it('as contagens seguem as regras do servidor (atrasada é a última versão; em mãos não é "sem envio")', () => {
    expect(filterCounts(rows)).toEqual({ todos: 7, 'para-corrigir': 3, corrigidas: 1, atrasadas: 2, 'sem-envio': 2, devolvidas: 1 })
    expect(rows.filter((row) => rowMatches(row, 'sem-envio')).map((row) => row.studentEmail)).toEqual(['d@x.com', 'g@x.com'])
  })

  it('rótulos da situação e "Entregue em mãos, sem nota"', () => {
    expect(rowStatusInfo(rows[0]).label).toBe('Para corrigir')
    expect(rowStatusInfo(rows[2])).toEqual({ label: 'Corrigida, sem devolver', tone: 'info' })
    expect(rowStatusInfo(rows[5]).label).toBe('Entregue em mãos, sem nota')
    expect(rowStatusInfo({}).label).toBe('Sem envio')
  })

  it('"Devolver todas" só conta correção salva com nota', () => {
    expect(rows.filter(isReturnableRow).map((row) => row.studentEmail)).toEqual(['c@x.com'])
    expect(isReturnableRow({ status: 'corrigida', grade: { finalScore: null } })).toBe(false)
  })

  it('aluno sem e-mail aparece como "sem e-mail", nunca com o endereço interno', () => {
    const shown = rowDisplay({ studentEmail: 'aluno-alu_0123456789abcdef@sem-email.invalid', semEmail: true, name: 'Bia Reis', matricula: '2026-7' })
    expect(shown).toEqual({ title: 'Bia Reis (sem e-mail)', name: 'Bia Reis', detail: 'matrícula 2026-7 · sem e-mail' })
    expect(JSON.stringify(shown)).not.toContain('sem-email.invalid')
  })

  it('a fila do "Próximo aluno" é a lista de quando o painel abriu', () => {
    expect(queuePosition(['a', 'b', 'c'], 'b')).toEqual({ index: 1, total: 3, previous: 'a', next: 'c' })
    expect(queuePosition(['a', 'b', 'c'], 'c').next).toBe(null)
    expect(queuePosition(['a'], 'z')).toEqual({ index: -1, total: 1, previous: null, next: null })
  })
})

describe('horários no relógio da escola', () => {
  // 2026-11-20 17:32 UTC = 14:32 em São Paulo (UTC-3) = 02:32 de 21/11 em Tóquio.
  const at = Date.UTC(2026, 10, 20, 17, 32)
  it('usa o fuso que o servidor mandou, não o do navegador', () => {
    expect(schoolDateTime(at, 'America/Sao_Paulo')).toBe('20/11/2026 às 14:32')
    expect(schoolDateTime(at, 'Asia/Tokyo')).toBe('21/11/2026 às 02:32')
    expect(localPartsInZone(at, 'America/Sao_Paulo')).toEqual({ date: '2026-11-20', time: '14:32' })
    expect(schoolDateTime(null, 'America/Sao_Paulo')).toBe('')
  })

  it('atraso por extenso conta o dia iniciado, como o desconto', () => {
    expect(lateText(0)).toBe('')
    expect(lateText(30 * 1000)).toBe('Atrasada 1 minuto')
    expect(lateText(5 * 60 * 1000)).toBe('Atrasada 5 minutos')
    expect(lateText(3 * HOUR)).toBe('Atrasada 3 horas')
    expect(lateText(DAY)).toBe('Atrasada 1 dia')
    expect(lateText(DAY + 1)).toBe('Atrasada 2 dias')
    expect(lateAmountText(2.5 * DAY)).toBe('3 dias')
    expect(lateDaysStarted(1)).toBe(1)
    expect(lateDaysStarted(-5)).toBe(0)
  })
})

describe('nota, desconto e corpos das rotas', () => {
  it('nota digitada com vírgula; texto inválido avisa', () => {
    expect(readGradeText('8,5')).toEqual({ score: 85, empty: false, error: '' })
    expect(readGradeText(' ')).toEqual({ score: null, empty: true, error: '' })
    expect(readGradeText('11').error).toMatch(/de 0 a 10/)
    expect(gradeInputText({ score: 73 })).toBe('7,3')
    expect(gradeInputText(null)).toBe('')
  })

  it('linha do desconto: "Atraso de 2 dias: -20%, nota final 6,4"', () => {
    const version = { late: true, lateMs: 1.5 * DAY, penaltyPct: 20 }
    expect(penaltyLine({ version, latePolicy: { mode: 'desconto' }, score: 80 })).toBe('Atraso de 2 dias: -20%, nota final 6,4.')
    expect(penaltyLine({ version, latePolicy: { mode: 'desconto' }, score: 80, waived: true })).toBe('Atraso de 2 dias: desconto de 20% dispensado.')
    expect(penaltyLine({ version: { ...version, penaltyPct: 0 }, latePolicy: { mode: 'aceitar' }, score: 80 })).toMatch(/não desconta/)
    expect(penaltyLine({ version: { late: false }, latePolicy: { mode: 'desconto' }, score: 80 })).toBe('')
    expect(finalScorePreview(85, 15)).toBe(72)
    expect(finalScorePreview(null, 10)).toBe(null)
  })

  it('corpos de salvar, devolver, refazer, prorrogar e entrega em mãos', () => {
    expect(gradeBody({ studentEmail: 'a@x.com', action: 'devolver', gradeText: ' 8,5 ', comment: 'Bom', version: 2, waivePenalty: true }))
      .toEqual({ studentEmail: 'a@x.com', action: 'devolver', grade: '8,5', comment: 'Bom', version: 2, waivePenalty: true })
    // Sem versão (zero sem entrega ou entrega em mãos), o servidor escolhe; motivo só quando há.
    expect(gradeBody({ studentEmail: 'a@x.com', action: 'salvar', gradeText: '0', comment: '', version: null, reason: 'Corrigi' }))
      .toEqual({ studentEmail: 'a@x.com', action: 'salvar', grade: '0', comment: '', waivePenalty: false, reason: 'Corrigi' })
    expect(redoBody({ studentEmail: 'a@x.com', gradeText: '', comment: 'Refaça', version: 1, dueDate: '2026-12-01', dueTime: '18:00' }))
      .toEqual({ studentEmail: 'a@x.com', action: 'refazer', grade: '', comment: 'Refaça', version: 1, waivePenalty: false, redoDueDate: '2026-12-01', redoDueTime: '18:00' })
    expect(redoBody({ studentEmail: 'a@x.com', comment: 'R', dueDate: '2026-12-01', dueTime: '18:00', closeDate: '2026-12-03', closeTime: '' }))
      .toMatchObject({ redoCloseDate: '2026-12-03', redoCloseTime: '23:59' })
    expect(extensionBody({ studentEmail: 'a@x.com', dueDate: '2026-12-01', dueTime: '08:00', reason: '  Atestado ' }))
      .toEqual({ studentEmail: 'a@x.com', dueDate: '2026-12-01', dueTime: '08:00', reason: 'Atestado' })
    expect(manualEntryBody({ studentEmail: 'a@x.com', note: ' pendrive ', gradeText: '7', returnNow: true }))
      .toEqual({ studentEmail: 'a@x.com', note: 'pendrive', returnNow: true, grade: '7' })
    expect(manualEntryBody({ studentEmail: 'a@x.com', note: '' })).toEqual({ studentEmail: 'a@x.com', note: '', returnNow: false })
  })
})

describe('arquivos e links', () => {
  it('tamanho em pt-BR', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1,5 KB')
    expect(formatBytes(5.2 * 1024 * 1024)).toBe('5,2 MB')
  })

  it('só http(s) vira link "Abrir"', () => {
    expect(safeExternalLink('https://example.com/a b')).toBe('https://example.com/a%20b')
    expect(safeExternalLink('javascript:alert(1)')).toBe('')
    expect(safeExternalLink('  HTTP://x.y ')).toBe('http://x.y/')
    expect(safeExternalLink('data:text/html,oi')).toBe('')
  })
})
