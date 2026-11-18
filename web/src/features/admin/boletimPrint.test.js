import { describe, expect, it } from 'vitest'
import { boletimHtml } from './boletimPrint'

function report(grades, criterio) {
  return {
    student: { name: 'Ana', email: 'ana@x.local' },
    course: { name: 'Desenvolvimento' },
    attendance: {},
    criterio,
    modules: [{ name: 'Módulo 1', average: 6, exams: grades.map((grade, index) => ({ examKey: `P${index}`, title: `Prova ${index + 1}`, attempts: 1, grade })) }],
  }
}

const notasEmVermelho = (html) => [...html.matchAll(/<td class="num grade( low)?">([^<]*)<\/td>/g)].filter((m) => m[1]).map((m) => m[2])

describe('boletim impresso', () => {
  it('[UC-TENTATIVA-003] nota abaixo da média mínima em vermelho pela regra única (padrão 6,0)', () => {
    expect(notasEmVermelho(boletimHtml(report([5.9, 6, 9.5, null])))).toEqual(['5,9'])
  })

  it('[UC-TENTATIVA-003] usa o critério que vem com o boletim', () => {
    expect(notasEmVermelho(boletimHtml(report([5.9, 4.9, 7], { mediaMinima: 5 })))).toEqual(['4,9'])
    expect(notasEmVermelho(boletimHtml(report([6.5, 7], { mediaMinima: 7 })))).toEqual(['6,5'])
  })
})
