import { Sparkline } from '../../../components/ui/Sparkline'
import { TrendPill } from '../../../components/ui/TrendPill'

function MetricCard({ label, value, unit, delta, deltaUnit, invert, base, serie, tone, serieUnit }) {
  return (
    <div className="premium-card rounded-2xl p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[.1em] text-subtle">{label}</p>
      <div className="mt-2.5 flex items-end gap-2.5">
        <p className="text-[34px] font-semibold leading-none tracking-[-0.04em] text-text tabular-nums">
          {value == null ? <span className="text-lg font-medium text-subtle">sem dado</span> : <>{value}{unit && <span className="ml-0.5 text-base font-medium text-muted">{unit}</span>}</>}
        </p>
        <TrendPill delta={delta} unit={deltaUnit} invert={invert} className="mb-0.5" />
      </div>
      {base && <p className="mt-2 text-[11.5px] leading-relaxed text-subtle">{base}</p>}
      {serie && serie.length > 0 && <Sparkline points={serie} tone={tone} unit={serieUnit} className="mt-3.5" />}
    </div>
  )
}

// Pulso da turma: 3 números com tendência — um número solto não diz se a turma
// está melhorando ou piorando, que é a única pergunta que importa numa visão geral.
export function PulseGrid({ trends }) {
  if (!trends) return null
  const { frequencia, media, engajamento } = trends
  const fmt1 = (v) => v == null ? null : String(v).replace('.', ',')
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <MetricCard
        label="Frequência" value={frequencia.atual} unit="%"
        delta={frequencia.deltaPP} deltaUnit=" p.p."
        base={`${frequencia.base.comChamada} de ${frequencia.base.total} alunos com chamada lançada · vs. 30 dias anteriores`}
        serie={frequencia.serie} tone="success" serieUnit="%"
      />
      <MetricCard
        label="Média das provas" value={fmt1(media.atual)}
        delta={media.delta}
        base={`${media.base.provas} ${media.base.provas === 1 ? 'prova' : 'provas'} de ${media.base.alunos} ${media.base.alunos === 1 ? 'aluno avaliado' : 'alunos avaliados'} · janela de 30 dias`}
        serie={media.serie} tone="info"
      />
      <MetricCard
        label="Engajamento" value={engajamento.atual} unit={`/${engajamento.total}`}
        delta={engajamento.anterior != null ? engajamento.atual - engajamento.anterior : null}
        base={`acessaram o material nos últimos 7 dias · ${engajamento.semAcessoMais14d} sem acesso há +14 dias`}
        serie={engajamento.serie} tone="primary"
      />
    </div>
  )
}
