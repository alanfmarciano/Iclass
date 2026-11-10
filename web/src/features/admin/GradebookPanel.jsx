import { Download } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { PageState } from '../../components/ui/PageState'
import { useApi } from '../../hooks/useApi'
import { fmtGrade } from '../../lib/grades'

// Quadro de notas da turma (FUN-06): uma linha por aluno, uma coluna por prova
// (ou por aplicação, quando a mesma prova foi aplicada mais de uma vez) e a média.
// Vem do mesmo cálculo do servidor usado no boletim e na planilha exportada.
export function GradebookPanel({ courseId, studentClass, refreshKey, onExport, onOpenStudent }) {
  const query = new URLSearchParams({ courseId: courseId || '', studentClass: studentClass || '' }).toString()
  const { data, loading, error, refetch } = useApi(courseId && studentClass ? `/api/admin/gradebook?${query}` : null, [refreshKey])
  const columns = data?.columns || []
  const rows = data?.rows || []

  return (
    <section className="space-y-3" aria-label="Quadro de notas da turma">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-subtle">
          Notas de 0 a 10 com a regra de cada prova (todas as tentativas lançadas, publicadas ou não). A média é a mesma da lista de alunos.
        </p>
        {onExport && <Button size="sm" variant="secondary" icon={Download} onClick={onExport}>Exportar planilha (CSV)</Button>}
      </div>
      <PageState loading={loading} error={error} onRetry={refetch}>
        {rows.length === 0 ? (
          <p className="rounded-xl border border-border bg-surface px-4 py-8 text-center text-sm text-muted">Nenhum aluno nesta turma.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="w-full min-w-max text-sm">
              <caption className="sr-only">Quadro de notas da turma {studentClass}</caption>
              <thead>
                <tr className="bg-surface-2 text-left text-xs text-muted">
                  <th scope="col" className="sticky left-0 z-10 bg-surface-2 px-3 py-2 font-semibold">Aluno</th>
                  {columns.map((column) => (
                    <th key={column.id} scope="col" className="max-w-[12rem] px-3 py-2 text-right font-semibold" title={column.moduleName}>{column.label}</th>
                  ))}
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Média</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">A publicar</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.email} className="border-t border-border">
                    <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-medium">
                      {onOpenStudent && (row.gradedCount > 0 || row.pendingCount > 0)
                        ? <button type="button" className="text-left text-text hover:text-primary" onClick={() => onOpenStudent(row.email)}>{row.name}</button>
                        : <span className="text-text">{row.name}</span>}
                      <span className="block text-xs font-normal text-subtle">{row.email}</span>
                    </th>
                    {columns.map((column) => {
                      const cell = row.cells?.[column.id]
                      return (
                        <td key={column.id} className="px-3 py-2 text-right tabular-nums text-text">
                          {cell ? fmtGrade(cell.score) : <span className="text-subtle">—</span>}
                          {cell?.pending > 0 && <span className="ml-1 text-[10px] text-warning" title="Há tentativa ainda não publicada para o aluno">•</span>}
                        </td>
                      )
                    })}
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-text">{row.averageScore == null ? '—' : fmtGrade(row.averageScore)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{row.pendingCount || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageState>
    </section>
  )
}
