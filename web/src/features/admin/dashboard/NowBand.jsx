import { CircleOff, MonitorPlay, Timer } from 'lucide-react'
import { cn } from '../../../lib/cn'

function fmtHora(ts) {
  if (!ts) return null
  const diff = Date.now() - ts
  if (diff < 60000) return 'agora mesmo'
  if (diff < 3600000) return `há ${Math.round(diff / 60000)} min`
  if (diff < 86400000) return `há ${Math.round(diff / 3600000)} h`
  return `há ${Math.round(diff / 86400000)} dias`
}
const fmtData = (ymd) => {
  const d = new Date(`${ymd}T12:00:00`)
  return d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
}

function Cell({ children, onClick, className }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag onClick={onClick} className={cn('flex flex-col gap-1 bg-surface p-5 text-left transition-colors', onClick && 'cursor-pointer hover:bg-surface-2', className)}>
      {children}
    </Tag>
  )
}
const K = ({ children }) => <p className="text-[11px] font-semibold uppercase tracking-[.1em] text-subtle">{children}</p>

// Faixa "Agora": aula corrente + chamada, aplicação de prova, presença online.
// Fora de horário (`aula` e `aplicacao` nulos) colapsa numa linha única e
// devolve o espaço à fila — às 22h de sábado a tela não abre com caixas vazias.
export function NowBand({ now, onChamada, onProva }) {
  if (!now) return null
  const { aula, proximaAula, aplicacao, proximaAplicacao, online } = now

  const foraDeHorario = !aula && !aplicacao
  if (foraDeHorario) {
    return (
      <div className="premium-card flex flex-wrap items-center gap-x-6 gap-y-1 rounded-2xl px-5 py-3.5 text-sm">
        <span className="inline-flex items-center gap-2 text-muted">
          <Timer size={15} className="text-subtle" aria-hidden="true" />
          {proximaAula
            ? <>Próxima aula: <strong className="font-medium text-text">{fmtData(proximaAula.data)}{proximaAula.inicio ? `, ${proximaAula.inicio}` : ''} · {proximaAula.nome}</strong></>
            : 'Nenhuma aula na grade dos próximos 7 dias'}
        </span>
        {proximaAplicacao && (
          <span className="text-muted">Próxima prova: <strong className="font-medium text-text">{proximaAplicacao.titulo}</strong> · {new Date(proximaAplicacao.startsAt).toLocaleDateString('pt-BR')}</span>
        )}
        <span className="ml-auto inline-flex items-center gap-2 text-muted tabular-nums">
          <span className={cn('inline-block h-[7px] w-[7px] rounded-full', online.count ? 'bg-success' : 'bg-subtle')} aria-hidden="true" />
          {online.count} online
          {online.ultimoAcessoAt && !online.count && <span className="text-subtle">· último acesso {fmtHora(online.ultimoAcessoAt)}</span>}
        </span>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border lg:grid-cols-[1.5fr_1.2fr_1fr]">
      <Cell onClick={aula ? onChamada : undefined}>
        <K>Aula em andamento</K>
        {aula ? (
          <>
            <p className="mt-1 text-[17px] font-semibold tracking-[-0.02em] text-text">{aula.ordem}ª aula · {aula.nome}</p>
            <p className="text-[12.5px] text-muted">{aula.inicio} – {aula.fim} · tolerância de {aula.toleranciaMin} min</p>
            <p className="mt-2 text-[12.5px] font-semibold text-primary">
              {aula.chamadaStatus === 'concluida' ? 'Chamada lançada ✓' : aula.chamadaStatus === 'rascunho' ? 'Chamada em rascunho →' : 'Chamada ainda não lançada →'}
            </p>
          </>
        ) : (
          <p className="mt-1 text-sm text-muted">
            {proximaAula ? <>Sem aula agora · próxima: {fmtData(proximaAula.data)}{proximaAula.inicio ? `, ${proximaAula.inicio}` : ''}</> : 'Sem aula agora'}
          </p>
        )}
      </Cell>

      <Cell onClick={aplicacao ? onProva : undefined}>
        <K>Aplicação de prova</K>
        {aplicacao ? (
          <>
            <span className="mt-1 inline-flex items-center gap-1.5 self-start rounded-full bg-danger-soft px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[.09em] text-danger">
              <span className="inline-block h-[7px] w-[7px] animate-pulse rounded-full bg-danger" aria-hidden="true" />
              {aplicacao.status === 'waiting' ? 'sala de espera' : aplicacao.status === 'paused' ? 'pausada' : 'em andamento'}
            </span>
            <p className="mt-1 text-[15px] font-semibold text-text">{aplicacao.titulo}</p>
            <p className="text-[12.5px] text-muted tabular-nums">{aplicacao.entregues} de {aplicacao.total} entregas</p>
          </>
        ) : (
          <div className="mt-2 flex items-center gap-3">
            <div className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] border border-border bg-surface-2 text-subtle"><CircleOff size={15} /></div>
            <div>
              <p className="text-sm font-medium text-text">Nenhuma prova em andamento</p>
              <p className="text-[12.5px] text-subtle">
                {proximaAplicacao ? `A próxima está agendada para ${new Date(proximaAplicacao.startsAt).toLocaleDateString('pt-BR')}` : 'Nenhuma agendada'}
              </p>
            </div>
          </div>
        )}
      </Cell>

      <Cell>
        <K>Alunos conectados</K>
        <p className="mt-1 inline-flex items-center gap-2 text-[17px] font-semibold text-text tabular-nums">
          <span className={cn('inline-block h-[7px] w-[7px] rounded-full', online.count ? 'animate-pulse bg-success' : 'bg-subtle')} aria-hidden="true" />
          {online.count}
        </p>
        <p className="text-[12.5px] text-muted">nos últimos {online.janelaMin} minutos</p>
        {online.ultimoAcessoAt != null && (
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-[12.5px] text-subtle"><MonitorPlay size={13} aria-hidden="true" />Último acesso {fmtHora(online.ultimoAcessoAt)}</p>
        )}
      </Cell>
    </div>
  )
}
