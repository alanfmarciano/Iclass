import { describe, expect, it } from 'vitest'

// Fase 2, H2-C (DES-09): toda consulta periódica ao servidor passa pelo usePolling (uma
// por vez, pausa com a aba oculta, recuo na falha, prazo de 10 s). Este teste lê o código
// das telas e falha se aparecer um setInterval novo que não seja um relógio da tela.
// Exceções conhecidas:
// - ExamRunner: a sincronização da prova (4 s) e o envio da digitação (2 s) não pausam
//   com a aba oculta e têm a própria guarda de uma por vez (testes em ExamRunner.test.jsx);
// - MonitorPage: as duas consultas do Monitor (3 s e 2 s) ficam com o H2-D (trilha A),
//   que reescreve o Monitor; até lá, pendência conhecida, e a lista falha quando elas
//   saírem, para não guardar exceção vencida;
// - lazyPage: a conferência do servidor enquanto a tela espera o arquivo é uma espera
//   curta e com fim (até 3 minutos), encadeada por setTimeout e com prazo em cada
//   conferência; não é consulta periódica e não entra aqui.
const SOURCES = import.meta.glob('../**/*.{js,jsx}', { query: '?raw', import: 'default', eager: true })

const CLOCK = /setInterval\(\s*\(\)\s*=>\s*set[A-Z]\w*\(/
const GUARDED = {
  'features/student/exam/ExamRunner.jsx': [/setInterval\(\(\) => sync\(\{ fromTimer: true \}\), SYNC_MS\)/, /setInterval\(\(\) => flushKeystrokes\(\), KEYSTROKE_FLUSH_MS\)/],
}
const PENDING_UNTIL_H2D = {
  'features/admin/MonitorPage.jsx': [/setInterval\(poll, 3000\)/, /setInterval\(\(\) => fetchKeystrokes\(/],
}

function productionSources() {
  return Object.entries(SOURCES)
    // As chaves vêm relativas a esta pasta: '../features/...' e './useApi.js'.
    .map(([file, source]) => [file.startsWith('./') ? `hooks/${file.slice(2)}` : file.replace(/^\.\.\//, ''), source])
    .filter(([file]) => !/\.test\.[jt]sx?$/.test(file) && !file.startsWith('test/'))
}

describe('[UC-DESEMPENHO-002] consultas periódicas só pelo usePolling', () => {
  it('nenhum setInterval de consulta ao servidor fora das exceções conhecidas', () => {
    const unexpected = []
    const pendingSeen = new Set()
    for (const [file, source] of productionSources()) {
      source.split('\n').forEach((line, index) => {
        if (!line.includes('setInterval(')) return
        if (CLOCK.test(line)) return
        if ((GUARDED[file] || []).some((pattern) => pattern.test(line))) return
        const pending = (PENDING_UNTIL_H2D[file] || []).find((pattern) => pattern.test(line))
        if (pending) { pendingSeen.add(`${file} ${pending}`); return }
        unexpected.push(`${file}:${index + 1}: ${line.trim()}`)
      })
    }
    expect(unexpected, 'Use o usePolling (hooks/usePolling.js) para consultar o servidor de tempos em tempos').toEqual([])
    const allPending = Object.entries(PENDING_UNTIL_H2D).flatMap(([file, patterns]) => patterns.map((pattern) => `${file} ${pattern}`))
    expect(allPending.filter((entry) => !pendingSeen.has(entry)), 'Consulta do Monitor já saiu do setInterval: tire da lista PENDING_UNTIL_H2D').toEqual([])
  })

  it('as telas que consultam de tempos em tempos usam o usePolling', () => {
    const files = [
      'hooks/useApi.js',
      'components/ui/NotificationBell.jsx',
      'context/AuthProvider.jsx',
      'features/admin/ForumPage.jsx',
      'features/admin/StudentAnswersModal.jsx',
      'features/student/DuvidasPage.jsx',
      'features/student/ProvasPage.jsx',
      'features/student/StudentCourseGate.jsx',
      'features/student/useStudentHeartbeat.js',
    ]
    const sources = Object.fromEntries(productionSources())
    for (const file of files) {
      expect(sources[file], file).toBeTruthy()
      expect(sources[file], file).toMatch(/usePolling\(/)
      expect(sources[file], file).not.toMatch(/setInterval\(/)
    }
  })
})
