import { describe, expect, it } from 'vitest'
import { csvCell } from './csv'

describe('csvCell', () => {
  it('neutraliza fórmula no começo da célula', () => {
    expect(csvCell('=HYPERLINK("http://x";"Clique")')).toBe('"\'=HYPERLINK(""http://x"";""Clique"")"')
    expect(csvCell('+1+1')).toBe('"\'+1+1"')
    expect(csvCell('-2+3')).toBe('"\'-2+3"')
    expect(csvCell('@SUM(1)')).toBe('"\'@SUM(1)"')
    expect(csvCell('\t=1')).toBe('"\'\t=1"')
  })

  it('mantém texto comum e números entre aspas', () => {
    expect(csvCell('Ana Souza')).toBe('"Ana Souza"')
    expect(csvCell('a;b')).toBe('"a;b"')
    expect(csvCell(87)).toBe('"87"')
    expect(csvCell(null)).toBe('""')
    expect(csvCell(undefined)).toBe('""')
  })
})
