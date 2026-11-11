import { describe, expect, it } from 'vitest'
import { acceptanceText, ageOn, birthDateText, guardianComplete, isMinorBirthDate } from './legalAcceptance'

// Fase 2, H8a-2 (SEG-08, SEG-09): idade, responsável do menor e o texto de um aceite
// gravado, como o professor lê na ficha do aluno.
describe('[UC-LGPD-007] data de nascimento e texto do aceite', () => {
  it('idade em anos completos e menor de 18', () => {
    expect(ageOn('2008-11-12', '2026-11-11')).toBe(17)
    expect(ageOn('2008-11-11', '2026-11-11')).toBe(18)
    expect(isMinorBirthDate('2008-11-12', '2026-11-11')).toBe(true)
    expect(isMinorBirthDate('2008-11-11', '2026-11-11')).toBe(false)
    expect(isMinorBirthDate('', '2026-11-11')).toBe(false)
    expect(ageOn('2009-02-30', '2026-11-11')).toBe(null)
  })

  it('data como o professor lê', () => {
    expect(birthDateText('2009-05-06', '2026-11-11')).toBe('06/05/2009 (17 anos, menor de idade)')
    expect(birthDateText('2000-01-01', '2026-11-11')).toBe('01/01/2000 (26 anos)')
    expect(birthDateText('', '2026-11-11')).toBe('')
  })

  it('responsável completo: nome e um telefone ou e-mail', () => {
    expect(guardianComplete({ name: 'Maria', phone: '(11) 98888-7777' })).toBe(true)
    expect(guardianComplete({ name: 'Maria', email: 'maria@exemplo.com' })).toBe(true)
    expect(guardianComplete({ name: 'Maria' })).toBe(false)
    expect(guardianComplete({ name: 'Ma', phone: '11988887777' })).toBe(false)
    expect(guardianComplete({ name: 'Maria', phone: '123' })).toBe(false)
  })

  it('texto do aceite: versão publicada, modelo, aceite antigo 1.0 e nenhum', () => {
    const at = '2026-11-10T12:00:00.000Z'
    expect(acceptanceText({ documentId: 'termos_v2', version: 2, at })).toBe('Versão 2 · 10/11/2026')
    expect(acceptanceText({ documentId: 'modelo-2026.1:termos', version: null, at })).toBe('Modelo padrão do IClass · 10/11/2026')
    expect(acceptanceText({ version: '1.0', at })).toBe('v1.0, aceite antigo sem documento · 10/11/2026')
    expect(acceptanceText(null)).toBe('Nenhum aceite registrado')
  })
})
