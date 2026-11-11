import { describe, expect, it } from 'vitest'
import alunosSource from '../features/admin/AlunosPage.jsx?raw'
import { OBSERVATION_TEXT_MAX_CHARS, SHORT_TEXT_COUNTER_FROM, clampText, formatCount, tooLongMessage } from './textLimits'

// Fase 2, H9b (ENG-03): a observação pedagógica tem o mesmo teto do servidor (5.000
// caracteres em observations/create e update). Antes o campo da tela não tinha limite e o
// professor só descobria pelo erro ao registrar.
describe('[UC-ERRO-003] Observação pedagógica: teto da tela igual ao do servidor', () => {
  it('o Textarea "Observação" de Alunos usa maxLength 5.000 e a contagem a partir de 4.500', () => {
    expect(OBSERVATION_TEXT_MAX_CHARS).toBe(5000)
    expect(SHORT_TEXT_COUNTER_FROM).toBe(4500)
    const field = alunosSource.split('\n').find(line => line.includes('<Textarea label="Observação"'))
    expect(field).toBeTruthy()
    expect(field).toContain('maxLength={OBSERVATION_TEXT_MAX_CHARS}')
    expect(field).toContain('counterFrom={SHORT_TEXT_COUNTER_FROM}')
  })
})

describe('[UC-ERRO-003] textLimits: corte e mensagem dos caminhos sem maxLength', () => {
  it('clampText corta no teto e diz se cortou; tooLongMessage usa o milhar em pt-BR', () => {
    expect(clampText('abc', 5)).toEqual({ text: 'abc', cut: false })
    expect(clampText('abcdef', 5)).toEqual({ text: 'abcde', cut: true })
    expect(clampText(null, 5)).toEqual({ text: '', cut: false })
    expect(tooLongMessage(5001, 5000)).toBe('O texto aceita no máximo 5.000 caracteres (este tem 5.001).')
    expect(formatCount(1000000)).toBe('1.000.000')
  })
})
