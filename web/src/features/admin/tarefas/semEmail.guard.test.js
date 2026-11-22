import { describe, expect, it } from 'vitest'

// Aluno sem e-mail nas telas de tarefa do painel (fase 3, pendência da J1 passada ao C7):
// GET /api/admin/assignments/:id (roster) e o detalhe da entrega mandam studentEmail com o
// endereço interno 'aluno-<id>@sem-email.invalid', que é a chave do cadastro nas rotas e
// nunca aparece na tela. Este teste lê o código das telas de tarefa (a lista, o formulário
// e as que vierem: detalhe, correção, prévia) e falha quando uma delas usa studentEmail
// sem passar por studentLabel (tarefas/assignmentText.js) ou displayEmail
// (lib/studentProfile.js), ou quando põe studentEmail direto no texto do JSX.
const SOURCES = {
  ...import.meta.glob('../Tarefa*.jsx', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('./**/*.{js,jsx}', { query: '?raw', import: 'default', eager: true }),
}

const HELPER_IMPORT = /import\s*\{[^}]*\b(studentLabel|displayEmail)\b[^}]*\}\s*from\s*'[^']*(assignmentText|studentProfile)'/
// {row.studentEmail}, {sub.studentEmail}, {studentEmail} como texto de um elemento ou num
// template de texto visível (`... ${row.studentEmail} ...`).
const RAW_IN_JSX = />\s*\{\s*[\w.?]*studentEmail\s*\}/
const RAW_IN_TEMPLATE = /`[^`]*\$\{\s*[\w.?]*studentEmail\s*\}[^`]*`/

function screens() {
  return Object.entries(SOURCES)
    .map(([file, source]) => [file.replace(/^\.\.\//, 'features/admin/').replace(/^\.\//, 'features/admin/tarefas/'), source])
    .filter(([file]) => !/\.test\.[jt]sx?$/.test(file))
    // assignmentText.js é onde ficam os ajudantes.
    .filter(([file]) => !file.endsWith('/assignmentText.js'))
}

describe('aluno sem e-mail nas telas de tarefa', () => {
  it('as telas de tarefa existem e entram na conferência', () => {
    const files = screens().map(([file]) => file)
    expect(files).toContain('features/admin/TarefasPage.jsx')
    expect(files).toContain('features/admin/tarefas/TarefaForm.jsx')
  })

  it('studentEmail só aparece por studentLabel ou displayEmail, nunca direto no texto', () => {
    const problems = []
    for (const [file, source] of screens()) {
      if (!/studentEmail/.test(source)) continue
      if (!HELPER_IMPORT.test(source)) problems.push(`${file}: usa studentEmail sem importar studentLabel ou displayEmail`)
      source.split('\n').forEach((line, index) => {
        if (RAW_IN_JSX.test(line) || RAW_IN_TEMPLATE.test(line)) problems.push(`${file}:${index + 1}: ${line.trim()}`)
      })
    }
    expect(problems, 'Mostre o aluno por studentLabel(row) (o endereço interno do aluno sem e-mail vira "sem e-mail")').toEqual([])
  })

  it('a própria conferência pega o uso direto (o teste não passa à toa)', () => {
    expect(RAW_IN_JSX.test('<td>{row.studentEmail}</td>')).toBe(true)
    expect(RAW_IN_JSX.test('<td>{studentLabel(row).email}</td>')).toBe(false)
    expect(RAW_IN_TEMPLATE.test('toast.success(`Nota salva para ${row.studentEmail}`)')).toBe(true)
    expect(RAW_IN_TEMPLATE.test('api.post(`${base}/grade`, { studentEmail: row.studentEmail })')).toBe(false)
    expect(HELPER_IMPORT.test("import { countsLine, studentLabel } from './tarefas/assignmentText'")).toBe(true)
  })
})
