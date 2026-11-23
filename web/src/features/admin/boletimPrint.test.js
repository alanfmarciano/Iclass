import { describe, expect, it } from 'vitest'
import { boletimDocument, boletimHtml } from './boletimPrint'

function report(grades, criterio, extra = {}) {
  return {
    student: { name: 'Ana', email: 'ana@x.local' },
    course: { name: 'Desenvolvimento' },
    institution: 'Escola Modelo',
    attendance: {},
    criterio,
    modules: [{ name: 'Módulo 1', average: 6, exams: grades.map((grade, index) => ({ examKey: `P${index}`, title: `Prova ${index + 1}`, attempts: 1, grade })) }],
    ...extra,
  }
}

const notasEmVermelho = (html) => [...html.matchAll(/<b class="nota-baixa">([^<]*)<\/b>/g)].map((m) => m[1])

describe('boletim impresso', () => {
  it('[UC-TENTATIVA-003] nota abaixo da média mínima em vermelho pela regra única (padrão 6,0)', () => {
    expect(notasEmVermelho(boletimHtml(report([5.9, 6, 9.5, null])))).toEqual(['5,9'])
  })

  it('[UC-TENTATIVA-003] usa o critério que vem com o boletim', () => {
    expect(notasEmVermelho(boletimHtml(report([5.9, 4.9, 7], { mediaMinima: 5 })))).toEqual(['4,9'])
    expect(notasEmVermelho(boletimHtml(report([6.5, 7], { mediaMinima: 7 })))).toEqual(['6,5'])
  })

  it('[UC-NOTAS-008] sai pelo documento impresso da escola: rodapé com o nome da instituição, sem "Gerado pelo IClass"', () => {
    const html = boletimHtml(report([8]), { escola: { nome: 'Colégio Aurora', razaoSocial: 'Aurora Ensino Ltda' }, displayName: 'Aurora' })
    expect(html).not.toContain('Gerado pelo IClass')
    expect(html).toMatch(/Gerado por Aurora em \d{2}\/\d{2}\/\d{4}/)
    expect(html).toContain('Colégio Aurora')
    expect(html).toContain('Aurora Ensino Ltda')
    // Sem a identidade visual, o nome da instituição que vem com o boletim.
    expect(boletimHtml(report([8]))).toMatch(/Gerado por Escola Modelo em/)
  })

  it('[UC-NOTAS-008] com critérios: etapas, média final, situação e menção do servidor, sem recalcular', () => {
    const rep = report([8.5], { mediaMinima: 6, mencoes: [{ sigla: 'B', nome: 'Bom', min: 7 }] }, {
      etapas: [
        { ordem: 1, nome: '1º bimestre', peso: 1, media: 5, recuperacao: 7, final: 7, semNota: false },
        { ordem: 2, nome: '2º bimestre', peso: 2, media: null, recuperacao: null, final: null, semNota: true },
      ],
      // O servidor manda 7,2: o boletim mostra 7,2 mesmo que as etapas dessem outra conta.
      mediaFinal: 7.2,
      situacao: 'cursando',
      situacaoRotulo: 'Cursando',
      mencao: { sigla: 'B', nome: 'Bom' },
      situacaoPorDisciplina: [{ id: 'd1', nome: 'Lógica', mediaFinal: 5.5, situacaoRotulo: 'Em recuperação', mencao: null }],
      avisosNotas: ['Seminário sem etapa: não entra na média.'],
      periodoLetivo: { id: 'per_1', nome: '2026', inicio: '2026-02-02', fim: '2026-12-15' },
      attendance: { frequency: 90, faltas: 2, aulasPrevistas: 80, frequenciaMinima: 75, faltasPermitidasRestantes: 18, disciplines: [{ id: 'd1', name: 'Lógica', presentes: 18, faltas: 2, frequencia: 90, cargaHoraria: 60, aulasPrevistas: 40, faltasPermitidasRestantes: 8 }] },
    })
    rep.modules[0].exams[0] = { ...rep.modules[0].exams[0], etapa: 2, peso: 1 }
    rep.modules[0].exams.push({ examKey: 'Q', title: 'Quiz', attempts: 1, grade: 9, etapa: null })
    const doc = boletimDocument(rep)
    const titulos = doc.secoes.map((secao) => secao.titulo).filter(Boolean)
    expect(titulos).toEqual(['Aluno', 'Resultado', 'Notas por etapa', 'Situação por disciplina', 'Avaliações', 'Frequência', 'Frequência por disciplina'])
    const resultado = Object.fromEntries(doc.secoes.find((s) => s.titulo === 'Resultado').pares)
    expect(resultado).toMatchObject({ 'Média final': '7,2', Situação: 'Cursando', Menção: 'B (Bom)', 'Média mínima para aprovação': '6,0' })
    const html = boletimHtml(rep)
    expect(html).toContain('1º bimestre')
    expect(html).toContain('sem nota')
    expect(html).toContain('2º bimestre · peso 1')
    expect(html).toContain('sem etapa, fora da média')
    expect(html).toContain('Seminário sem etapa: não entra na média.')
    expect(html).toContain('2026 (02/02/2026 a 15/12/2026)')
    expect(html).toContain('60 h')
    expect(html).toContain('Faltas que ainda pode ter')
    expect(notasEmVermelho(html)).toEqual(['5,5'])
  })

  it('[UC-NOTAS-008] nome de aluno e título de prova com HTML aparecem como texto', () => {
    const rep = report([7])
    rep.student.name = '<img src=x onerror=alert(1)>'
    rep.modules[0].exams[0].title = '<script>x</script>'
    const html = boletimHtml(rep)
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>x')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
  })
})
