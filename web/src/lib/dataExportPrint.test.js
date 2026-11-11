import { afterEach, describe, expect, it, vi } from 'vitest'
import { dataExportFileName, dataExportHtml, openPrintWindow, printDataExport, PRINT_ROW_LIMIT } from './dataExportPrint'

// H8c reduzido (SEG-14): a versão para imprimir de "Meus dados" e da exportação do
// administrador. O servidor decide o que entra; aqui a tela só mostra, sem <script> na
// janela (CSP do H5d) e com o texto escapado.
function sample(overrides = {}) {
  return {
    type: 'iclass-dados-pessoais',
    formatVersion: 1,
    audience: 'aluno',
    generatedAt: '2026-11-10T13:00:00.000Z',
    notice: 'Cópia dos seus dados pessoais.',
    institution: { id: 'esc', name: 'Escola Técnica', dpo: { name: 'Dra. Encarregada', email: 'dpo@escola.local' } },
    profile: { name: 'Ana <b>Souza</b>', email: 'ana@escola.local', matricula: '2026-07', accessibilityNoteRestricted: true },
    enrollments: { classes: [{ className: '1DES', courseId: 'DES', courseName: 'Desenvolvimento' }], requests: [] },
    acceptances: { terms: null, privacy: null, previous: [] },
    submissions: [
      { examKey: 'mod1_prova', timestamp: '2026-10-01T12:00:00Z', score: 85, gradePublished: true },
      { examKey: 'mod2_prova', timestamp: '2026-10-02T12:00:00Z', score: 30, gradePublished: false, resultStatus: 'em_revisao' },
    ],
    attendance: [],
    certificates: [],
    observations: [{ timestamp: '2026-10-03T12:00:00Z', category: 'Elogio', text: 'Muito bem', visibility: 'Compartilhada', author: 'Prof. X' }],
    forum: { questions: [{ timestamp: '2026-10-04T12:00:00Z', key: 'mod1', text: '<script>alert(1)</script>', replies: [{ from: 'Equipe', text: 'ok' }] }], replies: [] },
    moduleAccess: [],
    loginLogs: [{ timestamp: '2026-10-05T12:00:00Z', status: 'success', ip: '10.0.0.5', browser: 'Chrome' }],
    proctoring: { focusEvents: [], keystrokes: [{ examKey: 'mod1_prova', serverTs: 1760000000000, suspicious: true }, { examKey: 'mod1_prova', serverTs: 1760000001000 }] },
    examRecords: [],
    examMessages: [],
    profileHistory: [],
    audit: [{ timestamp: '2026-10-06T12:00:00Z', action: 'student_updated', label: 'Cadastro alterado', actor: 'admin@escola.local' }],
    counts: {},
    ...overrides,
  }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('[UC-LGPD-010] Meus dados · versão para imprimir', () => {
  it('escapa o texto, não põe <script> na janela e mostra as seções do aluno', () => {
    const html = dataExportHtml(sample())
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('Ana &lt;b&gt;Souza&lt;/b&gt;')
    for (const title of ['Identificação', 'Matrículas', 'Notas e entregas', 'Frequência', 'Certificados', 'Observações compartilhadas com você', 'Fórum de dúvidas', 'Acessos ao portal', 'Monitoramento das provas', 'Alterações do cadastro']) {
      expect(html).toContain(title)
    }
    expect(html).toContain('Encarregado de dados: Dra. Encarregada · dpo@escola.local')
    expect(html).toContain('Existe uma observação restrita à coordenação')
    // O aluno não vê a auditoria nem quem escreveu a observação.
    expect(html).not.toContain('Auditoria')
    expect(html).not.toContain('Prof. X')
  })

  it('nota (guardada de 0 a 100) sai na escala 0 a 10; não publicada aparece como "Em revisão", sem o número', () => {
    const html = dataExportHtml(sample())
    expect(html).toContain('8,5')
    expect(html).toContain('Em revisão')
    expect(html).not.toMatch(/>3,0</)
  })

  it('resume as teclas por prova (o detalhe fica no arquivo)', () => {
    const html = dataExportHtml(sample())
    expect(html).toMatch(/<td>mod1_prova<\/td><td>2<\/td><td>1<\/td>/)
  })

  it(`lista longa mostra ${PRINT_ROW_LIMIT} linhas e diz quantas ficaram só no arquivo`, () => {
    const loginLogs = Array.from({ length: PRINT_ROW_LIMIT + 7 }, (_, i) => ({ timestamp: 1760000000000 + i * 1000, status: 'success', ip: `10.0.0.${i % 250}` }))
    const html = dataExportHtml(sample({ loginLogs }))
    expect(html).toContain('E mais 7 registros, só no arquivo JSON.')
  })

  it('nome do arquivo igual ao do servidor', () => {
    expect(dataExportFileName(sample())).toBe('meus-dados-2026-11-10.json')
    expect(dataExportFileName(sample({ audience: 'admin' }))).toBe('dados-ana_escola.local-2026-11-10.json')
    expect(dataExportFileName({}, 'x.json')).toBe('x.json')
  })
})

describe('[UC-LGPD-011] Exportação do administrador · versão para imprimir', () => {
  it('mostra a auditoria, a autoria das observações e quem gerou', () => {
    const html = dataExportHtml(sample({ audience: 'admin', generatedBy: 'admin@escola.local' }))
    expect(html).toContain('Dados pessoais — Ana')
    expect(html).toContain('Auditoria')
    expect(html).toContain('Cadastro alterado')
    expect(html).toContain('Prof. X')
    expect(html).toContain('por admin@escola.local')
    expect(html).not.toMatch(/<script/i)
  })
})

describe('Janela de impressão', () => {
  function fakeWindow() {
    return { closed: false, document: { open: vi.fn(), write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn() }
  }

  it('openPrintWindow devolve null quando o navegador bloqueia', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openPrintWindow()).toBeNull()
  })

  it('escreve a cópia na janela aberta no clique e chama a impressão daqui', () => {
    vi.useFakeTimers()
    const win = fakeWindow()
    const open = vi.spyOn(window, 'open')
    expect(printDataExport(sample(), win)).toBe(true)
    expect(open).not.toHaveBeenCalled()
    expect(win.document.write.mock.calls[0][0]).toContain('Meus dados — Ana')
    vi.advanceTimersByTime(400)
    expect(win.print).toHaveBeenCalled()
  })

  it('janela fechada antes de a cópia chegar: devolve false, sem abrir outra', () => {
    const win = { ...fakeWindow(), closed: true }
    const open = vi.spyOn(window, 'open')
    expect(printDataExport(sample(), win)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
