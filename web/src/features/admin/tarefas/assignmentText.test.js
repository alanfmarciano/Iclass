import { describe, expect, it } from 'vitest'
import { countsLine, deadlineLine, latePolicyText, localDateTimeText, relativeDeadlineText, studentLabel } from './assignmentText'

describe('textos das telas de tarefa', () => {
  it('prazo no relógio da escola (os campos local do servidor) e quanto falta pelo relógio do servidor', () => {
    expect(localDateTimeText('2026-12-04', '23:00')).toBe('sex., 04/12/2026 às 23:00')
    const dueAt = Date.UTC(2026, 11, 5, 2, 0) // 04/12 23:00 em São Paulo
    const assignment = { status: 'publicada', dueAt, local: { dueDate: '2026-12-04', dueTime: '23:00' } }
    expect(deadlineLine(assignment, dueAt - 2 * 24 * 3600 * 1000 - 60000)).toBe('Prazo: sex., 04/12/2026 às 23:00 (faltam 2 dias)')
    expect(deadlineLine(assignment, dueAt + 3 * 3600 * 1000)).toBe('Prazo: sex., 04/12/2026 às 23:00 (terminou há 3 horas)')
    expect(deadlineLine({ ...assignment, status: 'rascunho' }, dueAt - 1000)).toBe('Prazo: sex., 04/12/2026 às 23:00')
    expect(deadlineLine({ status: 'rascunho', dueAt: null, local: {} }, 0)).toBe('Sem prazo definido')
    expect(relativeDeadlineText(1000 + 60000, 1000)).toBe('falta 1 minuto')
    expect(relativeDeadlineText(24 * 3600 * 1000 + 5, 0)).toBe('falta 1 dia')
  })

  it('contadores e regra de atraso por extenso', () => {
    expect(countsLine({ paraCorrigir: 3, atrasadas: 1, naoEntregues: 12 })).toBe('Para corrigir 3 · Atrasadas 1 · Sem envio 12')
    expect(countsLine(undefined)).toBe('Para corrigir 0 · Atrasadas 0 · Sem envio 0')
    expect(latePolicyText({ mode: 'desconto', penaltyPerDayPct: 10, penaltyMaxPct: 50 })).toBe('Depois do prazo, a entrega é aceita com desconto de 10% por dia, até 50%.')
    expect(latePolicyText({ mode: 'bloquear' })).toBe('Depois do prazo, a entrega não é aceita.')
    expect(latePolicyText({ mode: 'aceitar' })).toBe('Depois do prazo, a entrega é aceita e marcada como atrasada.')
  })

  it('aluno sem e-mail aparece como "sem e-mail", nunca com o endereço interno (pendência da J1)', () => {
    const internal = 'aluno-alu_00000000000000a1@sem-email.invalid'
    const fromRoster = studentLabel({ studentEmail: internal, semEmail: true, name: 'Bia Reis', matricula: '2026-002' })
    expect(fromRoster).toEqual({ name: 'Bia Reis', email: 'sem e-mail', matricula: '2026-002', semEmail: true, title: 'Bia Reis (sem e-mail)' })
    // Sem a marca semEmail (resposta antiga) o endereço interno também é reconhecido.
    expect(studentLabel({ studentEmail: internal, name: '' })).toMatchObject({ name: 'sem e-mail', email: 'sem e-mail', title: 'sem e-mail' })
    expect(JSON.stringify(studentLabel({ studentEmail: internal }))).not.toMatch(/sem-email\.invalid/)
    expect(studentLabel({ studentEmail: 'ana@x.com', name: 'Ana' }).title).toBe('Ana (ana@x.com)')
  })
})
