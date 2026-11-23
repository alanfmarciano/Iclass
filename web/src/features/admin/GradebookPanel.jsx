import { useState } from 'react'
import { AlertTriangle, ChevronDown, Download } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { PageState } from '../../components/ui/PageState'
import { useApi } from '../../hooks/useApi'
import { criterioOf, fmtGrade, fmtGradeValue, fmtMencao, fmtMinimumGrade, gradeTone, situacaoTone } from '../../lib/grades'
import { displayEmail } from '../../lib/studentProfile'

// Quadro de notas da turma (FUN-06): uma linha por aluno, uma coluna por prova
// (ou por aplicação, quando a mesma prova foi aplicada mais de uma vez) e a média.
// Vem do mesmo cálculo do servidor usado no boletim e na planilha exportada.
//
// Com os critérios do curso ligados (B9 / P2-S4, FUN-02): as colunas se agrupam por
// etapa ("Etapa 1 · peso 2"), cada etapa ganha a coluna da média dela (já com a
// recuperação), e vêm a média final, a frequência, a situação e a menção, tudo pronto do
// servidor (gradebook.js + gradingRules.js; o navegador não refaz conta, D3 do P2). As
// cores seguem a média mínima do curso (criterio). No celular (abaixo de 768 px) a tabela
// larga vira uma lista de alunos; tocar no aluno abre as notas por etapa. Sem critérios,
// o quadro de sempre.
//
// gradebook (opcional): o resultado de useApi do quadro, quando a tela já o carrega
// (Resultados); sem ele, o painel busca sozinho.

const TONE_TEXT = { success: 'text-success', warning: 'text-warning', danger: 'text-danger', neutral: 'text-text', info: 'text-info' }

// Grupo da coluna no quadro com critérios: 'etapa:N', 'final' (recuperação final),
// 'sem_etapa' ou 'fora' (não conta na média).
export function columnGroupOf(column) {
  if (column.fora) return 'fora'
  const rec = /^etapa:(\d+)$/.exec(String(column.recuperacaoDe || ''))
  if (rec) return `etapa:${rec[1]}`
  if (column.recuperacaoDe === 'final') return 'final'
  if (column.etapa) return `etapa:${column.etapa}`
  return 'sem_etapa'
}

// Colunas na ordem do quadro com critérios: etapa a etapa (cada uma com a média dela no
// fim), a recuperação final, as sem etapa e as que não contam. Devolve
// [{ key, titulo, colunas, etapa? }].
export function gradebookGroups(gradebook) {
  const etapas = Array.isArray(gradebook?.etapas) ? gradebook.etapas : []
  const columns = Array.isArray(gradebook?.columns) ? gradebook.columns : []
  const byGroup = new Map()
  columns.forEach((column) => {
    const key = columnGroupOf(column)
    if (!byGroup.has(key)) byGroup.set(key, [])
    byGroup.get(key).push(column)
  })
  const groups = etapas.map((etapa) => ({
    key: `etapa:${etapa.ordem}`,
    titulo: etapas.length > 1 || Number(etapa.peso) !== 1 ? `${etapa.nome} · peso ${fmtWeight(etapa.peso)}` : etapa.nome,
    colunas: byGroup.get(`etapa:${etapa.ordem}`) || [],
    etapa,
  }))
  const extra = [
    { key: 'final', titulo: 'Recuperação final' },
    { key: 'sem_etapa', titulo: 'Sem etapa (fora da média)' },
    { key: 'fora', titulo: 'Não contam na média' },
  ]
  extra.forEach((group) => { if (byGroup.has(group.key)) groups.push({ ...group, colunas: byGroup.get(group.key) }) })
  return groups
}

export function fmtWeight(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '1'
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',')
}

function fmtPct(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${Math.round(Number(value))}%`
}

function columnTitle(column) {
  const parts = [column.moduleName]
  if (column.tipo) parts.push(column.tipo)
  if (column.recuperacaoDe) parts.push('recuperação')
  if (column.peso !== undefined && Number(column.peso) !== 1) parts.push(`peso ${fmtWeight(column.peso)}`)
  if (column.arquivado) parts.push('arquivada, fora da média')
  return parts.filter(Boolean).join(' · ')
}

// Nota de uma prova no quadro, com a cor da faixa pela média mínima do curso
// (gradeTone/gradeBand, a mesma regra do servidor). Coluna fora da média (sem etapa, "Não
// conta" ou arquivada) fica sem cor.
// Prova que espera a correção do professor (aguardandoCorrecao, sem nota): "aguardando
// correção" no lugar do traço (A18). Antes a célula ficava com o traço, como se o aluno
// não tivesse feito a prova.
function Cell({ cell, criterio, muted = false }) {
  const tone = cell && !muted ? gradeTone(cell.score == null ? null : cell.score / 10, criterio) : null
  if (cell?.aguardandoCorrecao && cell.score == null) {
    return <span className="whitespace-nowrap text-xs font-medium text-warning" title="A nota sai quando o professor concluir a correção">aguardando correção</span>
  }
  return (
    <>
      {cell ? <span className={tone ? TONE_TEXT[tone] : undefined}>{fmtGrade(cell.score)}</span> : <span className="text-subtle">—</span>}
      {cell?.pending > 0 && <span className="ml-1 text-[10px] text-warning" title="Há tentativa ainda não publicada para o aluno">•</span>}
    </>
  )
}

function etapaOf(row, ordem) {
  return (row.etapas || []).find((etapa) => etapa.ordem === ordem) || null
}

function EtapaValue({ value, criterio }) {
  if (!value || value.final === null || value.final === undefined) return <span className="text-subtle">—</span>
  const tone = gradeTone(value.final, criterio)
  const detail = [
    value.media !== null && value.media !== undefined ? `média ${fmtGradeValue(value.media)}` : 'sem nota',
    value.recuperacao !== null && value.recuperacao !== undefined ? `recuperação ${fmtGradeValue(value.recuperacao)}` : '',
    value.contouComoZero ? 'contou como 0' : '',
  ].filter(Boolean).join(' · ')
  return (
    <span className={`font-semibold ${TONE_TEXT[tone]}`} title={detail}>
      {fmtGradeValue(value.final)}
      {value.recuperacaoAplicada && <span className="ml-1 text-[10px] font-normal text-muted">(rec.)</span>}
    </span>
  )
}

function SituacaoBadge({ row }) {
  if (!row.situacao) return <span className="text-subtle">—</span>
  return <Badge tone={situacaoTone(row.situacao)} className="whitespace-nowrap">{row.situacaoRotulo || row.situacao}</Badge>
}

// Lista do celular: um cartão por aluno; tocar abre as notas (por etapa com critérios).
function PhoneList({ gradebook, criterio, withCriteria, groups, onOpenStudent }) {
  const [open, setOpen] = useState(() => new Set())
  const toggle = (email) => setOpen((current) => {
    const next = new Set(current)
    if (next.has(email)) next.delete(email)
    else next.add(email)
    return next
  })
  const columns = gradebook.columns || []
  const comMencao = Array.isArray(gradebook.mencoes) && gradebook.mencoes.length > 0
  return (
    <ul className="space-y-2 md:hidden" aria-label="Alunos e notas">
      {gradebook.rows.map((row) => {
        const isOpen = open.has(row.email)
        const media = row.averageScore == null ? null : row.averageScore
        const tone = gradeTone(media == null ? null : media / 10, criterio)
        return (
          <li key={row.email} className="rounded-xl border border-border bg-surface">
            <button type="button" className="flex w-full items-center gap-3 px-3 py-3 text-left" aria-expanded={isOpen} onClick={() => toggle(row.email)}>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-semibold text-text">{row.name}</span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  {withCriteria && <SituacaoBadge row={row} />}
                  {withCriteria && comMencao && row.mencao && <Badge tone="neutral">{fmtMencao(row.mencao)}</Badge>}
                  {row.pendingCount > 0 && <span className="text-xs text-warning">{row.pendingCount} a publicar</span>}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className={`block text-lg font-semibold tabular-nums ${TONE_TEXT[tone]}`}>{media == null ? '—' : fmtGrade(media)}</span>
                <span className="block text-[11px] text-subtle">{withCriteria ? 'média final' : 'média'}</span>
              </span>
              <ChevronDown size={16} className="shrink-0 text-muted transition-transform" style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} aria-hidden />
            </button>
            {isOpen && (
              <div className="space-y-3 border-t border-border px-3 py-3 text-sm">
                {withCriteria ? groups.map((group) => {
                  const value = group.etapa ? etapaOf(row, group.etapa.ordem) : null
                  return (
                    <div key={group.key}>
                      <div className="flex items-center justify-between gap-2 text-xs font-semibold text-muted">
                        <span className="min-w-0 break-words">{group.titulo}</span>
                        {group.etapa && <EtapaValue value={value} criterio={criterio} />}
                      </div>
                      <ul className="mt-1 space-y-1">
                        {group.colunas.map((column) => (
                          <li key={column.id} className="flex items-start justify-between gap-2">
                            <span className="min-w-0 break-words text-text">{column.label}</span>
                            <span className="shrink-0 tabular-nums"><Cell cell={row.cells?.[column.id]} criterio={criterio} muted={group.key === 'fora' || group.key === 'sem_etapa' || !!column.arquivado} /></span>
                          </li>
                        ))}
                        {group.colunas.length === 0 && <li className="text-xs text-subtle">Nenhuma avaliação nesta etapa.</li>}
                      </ul>
                    </div>
                  )
                }) : (
                  <ul className="space-y-1">
                    {columns.map((column) => (
                      <li key={column.id} className="flex items-start justify-between gap-2">
                        <span className="min-w-0 break-words text-text">{column.label}</span>
                        <span className="shrink-0 tabular-nums"><Cell cell={row.cells?.[column.id]} criterio={criterio} muted={!!column.arquivado} /></span>
                      </li>
                    ))}
                  </ul>
                )}
                {withCriteria && <p className="text-xs text-muted">Frequência {fmtPct(row.frequencia)}</p>}
                {withCriteria && (row.avisos || []).map((aviso) => <p key={aviso.codigo || aviso.texto} className="text-xs text-warning">{aviso.texto}</p>)}
                {onOpenStudent && (row.gradedCount > 0 || row.pendingCount > 0) && (
                  <Button size="sm" variant="secondary" className="w-full" onClick={() => onOpenStudent(row.email)}>Ver as provas do aluno</Button>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function GradebookPanel({ courseId, studentClass, refreshKey, onExport, onOpenStudent, gradebook }) {
  const query = new URLSearchParams({ courseId: courseId || '', studentClass: studentClass || '' }).toString()
  const own = useApi(!gradebook && courseId && studentClass ? `/api/admin/gradebook?${query}` : null, [refreshKey])
  const { data, loading, error, refetch } = gradebook || own
  const columns = data?.columns || []
  const rows = data?.rows || []
  const criterio = criterioOf(data)
  const withCriteria = Array.isArray(data?.etapas) && data.etapas.length > 0
  const groups = withCriteria ? gradebookGroups(data) : []
  const comMencao = withCriteria && Array.isArray(data?.mencoes) && data.mencoes.length > 0
  const avisos = Array.isArray(data?.avisos) ? data.avisos : []

  return (
    <section className="space-y-3" aria-label="Quadro de notas da turma">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-subtle">
          {withCriteria
            ? `Notas de 0 a 10 com a regra de cada prova. A média de cada etapa e a média final seguem os critérios do curso (média mínima ${fmtMinimumGrade(criterio)}).`
            : 'Notas de 0 a 10 com a regra de cada prova (todas as tentativas lançadas, publicadas ou não). A média é a mesma da lista de alunos.'}
        </p>
        {onExport && <Button size="sm" variant="secondary" icon={Download} onClick={onExport}>Exportar planilha (CSV)</Button>}
      </div>
      {avisos.map((aviso) => (
        <p key={aviso.codigo || aviso.texto} className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning" role="status">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> <span>{aviso.texto} Ajuste no Plano de avaliação.</span>
        </p>
      ))}
      <PageState loading={loading} error={error} onRetry={refetch}>
        {rows.length === 0 ? (
          <p className="rounded-xl border border-border bg-surface px-4 py-8 text-center text-sm text-muted">Nenhum aluno nesta turma.</p>
        ) : (
          <>
            <PhoneList gradebook={data} criterio={criterio} withCriteria={withCriteria} groups={groups} onOpenStudent={onOpenStudent} />
            <div className="hidden overflow-x-auto rounded-xl border border-border bg-surface md:block">
              <table className="w-full min-w-max text-sm">
                <caption className="sr-only">Quadro de notas da turma {studentClass}</caption>
                <thead>
                  {withCriteria && (
                    <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-subtle">
                      <th scope="col" className="sticky left-0 z-10 bg-surface-2 px-3 pt-2" />
                      {groups.map((group) => (
                        <th key={group.key} scope="colgroup" colSpan={group.colunas.length + (group.etapa ? 1 : 0)} className="border-l border-border px-3 pt-2 text-center font-semibold">
                          {group.titulo}
                        </th>
                      ))}
                      <th scope="colgroup" colSpan={comMencao ? 5 : 4} className="border-l border-border px-3 pt-2 text-center font-semibold">Resultado</th>
                    </tr>
                  )}
                  <tr className="bg-surface-2 text-left text-xs text-muted">
                    <th scope="col" className="sticky left-0 z-10 bg-surface-2 px-3 py-2 font-semibold">Aluno</th>
                    {withCriteria ? groups.flatMap((group) => [
                      ...group.colunas.map((column, index) => (
                        <th key={column.id} scope="col" className={`max-w-[12rem] px-3 py-2 text-right font-semibold ${index === 0 ? 'border-l border-border' : ''}`} title={columnTitle(column)}>
                          {column.label}{column.recuperacaoDe ? <span className="block text-[10px] font-normal text-subtle">recuperação</span> : null}
                        </th>
                      )),
                      ...(group.etapa ? [<th key={`${group.key}-media`} scope="col" className={`px-3 py-2 text-right font-semibold text-text ${group.colunas.length === 0 ? 'border-l border-border' : ''}`}>Média da etapa</th>] : []),
                    ]) : columns.map((column) => (
                      <th key={column.id} scope="col" className="max-w-[12rem] px-3 py-2 text-right font-semibold" title={columnTitle(column)}>{column.label}</th>
                    ))}
                    {withCriteria ? (
                      <>
                        <th scope="col" className="border-l border-border px-3 py-2 text-right font-semibold">Média final</th>
                        <th scope="col" className="px-3 py-2 text-right font-semibold">Frequência</th>
                        <th scope="col" className="px-3 py-2 text-left font-semibold">Situação</th>
                        {comMencao && <th scope="col" className="px-3 py-2 text-left font-semibold">Menção</th>}
                      </>
                    ) : <th scope="col" className="px-3 py-2 text-right font-semibold">Média</th>}
                    <th scope="col" className="px-3 py-2 text-right font-semibold">A publicar</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const mediaTone = gradeTone(row.averageScore == null ? null : row.averageScore / 10, criterio)
                    return (
                      <tr key={row.email} className="border-t border-border">
                        <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-medium">
                          {onOpenStudent && (row.gradedCount > 0 || row.pendingCount > 0)
                            ? <button type="button" className="text-left text-text hover:text-primary" onClick={() => onOpenStudent(row.email)}>{row.name}</button>
                            : <span className="text-text">{row.name}</span>}
                          <span className="block text-xs font-normal text-subtle">{displayEmail(row.email)}</span>
                        </th>
                        {withCriteria ? groups.flatMap((group) => [
                          ...group.colunas.map((column, index) => (
                            <td key={column.id} className={`px-3 py-2 text-right tabular-nums text-text ${index === 0 ? 'border-l border-border' : ''} ${group.key === 'fora' || group.key === 'sem_etapa' || column.arquivado ? 'text-muted' : ''}`}>
                              <Cell cell={row.cells?.[column.id]} criterio={criterio} muted={group.key === 'fora' || group.key === 'sem_etapa' || !!column.arquivado} />
                            </td>
                          )),
                          ...(group.etapa ? [
                            <td key={`${group.key}-media`} className={`bg-surface-2/60 px-3 py-2 text-right tabular-nums ${group.colunas.length === 0 ? 'border-l border-border' : ''}`}>
                              <EtapaValue value={etapaOf(row, group.etapa.ordem)} criterio={criterio} />
                            </td>,
                          ] : []),
                        ]) : columns.map((column) => (
                          <td key={column.id} className="px-3 py-2 text-right tabular-nums text-text"><Cell cell={row.cells?.[column.id]} criterio={criterio} muted={!!column.arquivado} /></td>
                        ))}
                        {withCriteria ? (
                          <>
                            <td className={`border-l border-border px-3 py-2 text-right font-semibold tabular-nums ${TONE_TEXT[mediaTone]}`} title={(row.avisos || []).map((aviso) => aviso.texto).join(' ') || undefined}>
                              {row.averageScore == null ? '—' : fmtGrade(row.averageScore)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted">{fmtPct(row.frequencia)}</td>
                            <td className="px-3 py-2"><SituacaoBadge row={row} /></td>
                            {comMencao && <td className="px-3 py-2 font-semibold text-text" title={row.mencao?.nome || undefined}>{fmtMencao(row.mencao, '—')}</td>}
                          </>
                        ) : (
                          <td className="px-3 py-2 text-right font-semibold tabular-nums text-text">{row.averageScore == null ? '—' : fmtGrade(row.averageScore)}</td>
                        )}
                        <td className="px-3 py-2 text-right tabular-nums text-muted">{row.pendingCount || 0}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </PageState>
    </section>
  )
}
