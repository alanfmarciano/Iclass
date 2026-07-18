import { cn } from '../../../lib/cn'

// Frequência por disciplina com o traço do limiar da turma. Renderização é
// condicionada pelo chamador (D5): só aparece quando a cobertura de
// `disciplinaId` nos registros é suficiente para o recorte ser honesto.
export function DisciplineFrequency({ disciplinas = [], limiar = 75, semDisciplina = 0 }) {
  if (!disciplinas.length) return null
  return (
    <div className="premium-card rounded-2xl p-0">
      <div className="flex flex-col gap-4 px-5 py-4">
        {disciplinas.map((d) => (
          <div key={d.disciplinaId}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="text-[13px] text-text">{d.nome}</span>
              <span className={cn('text-[13px] font-semibold tabular-nums', d.emRisco ? 'text-danger' : 'text-text')}>
                {d.frequencia == null ? '—' : `${d.frequencia}%`}
                <span className="ml-1.5 text-[11.5px] font-normal text-subtle">{d.presentes}/{d.total} aulas</span>
              </span>
            </div>
            <div className="relative h-[3px] rounded-full bg-border">
              {d.frequencia != null && (
                <div className={cn('absolute -top-[1px] left-0 h-[5px] rounded-full', d.emRisco ? 'bg-danger' : 'bg-success')} style={{ width: `${d.frequencia}%` }} />
              )}
              <div className="absolute -top-[4px] h-[11px] w-px bg-subtle opacity-60" style={{ left: `${limiar}%` }} title={`Limiar de risco da turma: ${limiar}%`} />
            </div>
          </div>
        ))}
      </div>
      {semDisciplina > 0 && (
        <p className="border-t border-border px-5 py-3 text-[12.5px] text-subtle">
          {semDisciplina} {semDisciplina === 1 ? 'registro antigo sem disciplina não entra' : 'registros antigos sem disciplina não entram'} neste recorte
        </p>
      )}
    </div>
  )
}
