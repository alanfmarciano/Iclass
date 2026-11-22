import { describe, expect, it } from 'vitest'

// Aluno sem e-mail nas telas de tarefa do painel (fase 3, pendência da J1 passada ao C7):
// GET /api/admin/assignments/:id (roster) e o detalhe da entrega mandam studentEmail com o
// endereço interno 'aluno-<id>@sem-email.invalid', que é a chave do cadastro nas rotas e
// nunca aparece na tela. Este teste lê o código das telas de tarefa (a lista, o formulário
// e as que vierem: detalhe, correção, prévia) e falha quando uma delas usa studentEmail
// fora dos usos de chave listados em USOS_DE_CHAVE: corpo e endereço da rota, key do React,
// comparação e Map/Set, ou dentro de studentLabel/displayEmail/hidePlaceholderEmails. Todo o
// resto (texto do JSX, title=, aria-label=, template, '{row.name || row.studentEmail}',
// 'const email = row.studentEmail' para mostrar depois) reprova: mostre o aluno por
// studentLabel(row) (tarefas/assignmentText.js) e os avisos por hidePlaceholderEmails.
// A conferência é por lista de usos permitidos (o que ela não conhece reprova); um uso de
// chave novo e legítimo entra em USOS_DE_CHAVE com o motivo.
const SOURCES = {
  ...import.meta.glob('../Tarefa*.jsx', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('./**/*.{js,jsx}', { query: '?raw', import: 'default', eager: true }),
}

const HELPER_IMPORT = /import\s*\{[^}]*\b(studentLabel|displayEmail)\b[^}]*\}\s*from\s*'[^']*(assignmentText|studentProfile)'/
const TOKEN = /(?:[\w$]+\??\.)*studentEmail\b/g

// Começo de objeto ('({', ', {', '= {', 'return {', ': {', '[{') ou item depois de vírgula
// dentro dele; '>{' e '={' (texto e atributo do JSX) não são objeto.
const OBJECT_KEY_BEFORE = /(?:(?:\(|,|\[|=\s|\breturn|:)\s*\{\s*|,\s*)$/
const DESTRUCTURING = /\b(?:const|let|var)\s*\{[^}]*$/
// Cada uso permitido olha o que vem antes (na mesma linha) e o que vem depois do nome.
const USOS_DE_CHAVE = [
  // Chave do corpo da rota: { studentEmail: row.studentEmail } ou { studentEmail }.
  // (desestruturar com outro nome, 'const { studentEmail: email } = row', não é chave).
  { motivo: 'nome do campo no corpo da rota', test: (token, before, after) => token === 'studentEmail' && /^\s*:/.test(after) && OBJECT_KEY_BEFORE.test(before) && !DESTRUCTURING.test(before) },
  { motivo: 'valor do campo studentEmail no corpo da rota', test: (token, before) => /\bstudentEmail\s*:\s*$/.test(before) && !DESTRUCTURING.test(before) },
  // Atalho num objeto: '({ studentEmail })', 'body = { studentEmail, score }'. '{studentEmail}'
  // no JSX (texto ou atributo) e 'const { studentEmail } = row' não entram.
  { motivo: 'atalho { studentEmail } no corpo da rota', test: (token, before, after) => token === 'studentEmail' && OBJECT_KEY_BEFORE.test(before) && /^\s*[,}]/.test(after) && !DESTRUCTURING.test(before) },
  { motivo: 'endereço da rota', test: (token, before) => /encodeURIComponent\(\s*$/.test(before) },
  { motivo: 'key do React', test: (token, before) => /\bkey=\{[^}]*$/.test(before) },
  { motivo: 'comparação', test: (token, before, after) => /[!=]==?\s*$/.test(before) || /^\s*[!=]==?/.test(after) },
  { motivo: 'Map/Set pela chave', test: (token, before) => /\.(has|get|set|add|delete)\(\s*$/.test(before) },
  { motivo: 'passa pelo ajudante', test: (token, before) => /\b(studentLabel|displayEmail|hidePlaceholderEmails|isPlaceholderEmail)\(\s*$/.test(before) },
]

// Linha de comentário não conta.
function isComment(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('{/*')
}

function rawUses(source) {
  const problems = []
  source.split('\n').forEach((line, index) => {
    if (isComment(line)) return
    for (const match of line.matchAll(TOKEN)) {
      const before = line.slice(0, match.index)
      const after = line.slice(match.index + match[0].length)
      if (!USOS_DE_CHAVE.some((uso) => uso.test(match[0], before, after))) problems.push({ line: index + 1, text: line.trim() })
    }
  })
  return problems
}

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

  it('studentEmail só aparece como chave (rota, key, comparação) ou dentro de studentLabel/displayEmail', () => {
    const problems = []
    for (const [file, source] of screens()) {
      if (!/studentEmail/.test(source)) continue
      rawUses(source).forEach((use) => problems.push(`${file}:${use.line}: ${use.text}`))
      // Tela que lida com studentEmail (fora de comentário) também mostra o aluno: o ajudante
      // precisa estar importado.
      const inCode = source.split('\n').some((line) => !isComment(line) && /studentEmail/.test(line))
      if (inCode && !HELPER_IMPORT.test(source)) problems.push(`${file}: usa studentEmail sem importar studentLabel ou displayEmail`)
    }
    expect(problems, 'Mostre o aluno por studentLabel(row) (o endereço interno do aluno sem e-mail vira "sem e-mail")').toEqual([])
  })

  it('a própria conferência pega o uso direto e o indireto (o teste não passa à toa)', () => {
    const flagged = (code) => rawUses(code).length > 0
    // Reprovam: texto, atributos, alternativa, alias e template.
    expect(flagged('<td>{row.studentEmail}</td>')).toBe(true)
    expect(flagged('<td>{row.name || row.studentEmail}</td>')).toBe(true)
    expect(flagged('<span title={row.studentEmail}>{studentLabel(row).name}</span>')).toBe(true)
    expect(flagged('<button aria-label={`Corrigir ${row.studentEmail}`}>')).toBe(true)
    expect(flagged('const email = row.studentEmail')).toBe(true)
    expect(flagged('const { studentEmail: email } = row')).toBe(true)
    expect(flagged('toast.success(`Nota salva para ${row.studentEmail}`)')).toBe(true)
    expect(flagged('<p>{sub?.studentEmail}</p>')).toBe(true)
    expect(flagged('{row.semEmail ? "sem e-mail" : row.studentEmail}')).toBe(true)
    expect(flagged('const { studentEmail } = row')).toBe(true)
    expect(flagged('<td>{studentEmail}</td>')).toBe(true)
    expect(flagged('<td>{ studentEmail }</td>')).toBe(true)
    expect(flagged('<Avatar title={studentEmail} />')).toBe(true)
    // Passam: chave da rota, key, comparação, Map/Set e os ajudantes.
    expect(flagged('api.post(`${base}/grade`, { studentEmail: row.studentEmail, score })')).toBe(false)
    expect(flagged('api.post(`${base}/grade`, { studentEmail, score })')).toBe(false)
    expect(flagged('const body = { score, studentEmail }')).toBe(false)
    expect(flagged('function gradeBody({ studentEmail, score }) {')).toBe(false)
    expect(flagged('const url = `${base}/submissions/${encodeURIComponent(row.studentEmail)}`')).toBe(false)
    expect(flagged('<li key={row.studentEmail}>')).toBe(false)
    expect(flagged('rows.find((item) => item.studentEmail === selected)')).toBe(false)
    expect(flagged('selectedSet.has(row.studentEmail)')).toBe(false)
    expect(flagged('<td>{studentLabel(row).email}</td>')).toBe(false)
    expect(flagged('<td>{displayEmail(row.studentEmail)}</td>')).toBe(false)
    expect(flagged('// studentEmail é a chave')).toBe(false)
    expect(HELPER_IMPORT.test("import { countsLine, studentLabel } from './tarefas/assignmentText'")).toBe(true)
  })
})
