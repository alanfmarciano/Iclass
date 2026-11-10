import { useMemo } from 'react'
import { AlertTriangle, ClipboardCheck, Download, Minus, Plus } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { SectionLabel } from '../../components/ui/SectionLabel'
import { Skeleton } from '../../components/ui/Skeleton'
import { useApi } from '../../hooks/useApi'
import { usePreferences } from '../../context/PreferencesProvider'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'
import { NowBand } from './dashboard/NowBand'
import { ActionQueue } from './dashboard/ActionQueue'
import { PulseGrid } from './dashboard/PulseGrid'
import { RiskList } from './dashboard/RiskList'
import { DisciplineFrequency } from './dashboard/DisciplineFrequency'
import { WeekAgenda } from './dashboard/WeekAgenda'
import { DataQualityNote } from './dashboard/DataQualityNote'
import { csvCell } from '../../lib/csv'

// Dashboard v3 — "fila de trabalho do dia", não relatório em miniatura.
// São 4 endpoints com volatilidades diferentes; cada seção carrega, falha e
// se recupera sozinha (skeleton + retry por seção) — /trends cair não pode
// derrubar a fila. Ver docs/PLANO_DASHBOARD_V3.md.

function SectionState({ query, height = 120, children }) {
  if (query.loading) return <div style={{ height }}><Skeleton className="h-full rounded-2xl" /></div>
  if (query.error) {
    return (
      <div className="premium-card flex items-center gap-3 rounded-2xl px-5 py-4">
        <AlertTriangle size={16} className="flex-none text-warning" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-sm text-muted">Não foi possível carregar esta seção.</p>
        <button onClick={() => query.refetch()} className="flex-none text-sm font-medium text-primary hover:text-primary-hover">Tentar de novo</button>
      </div>
    )
  }
  return children
}

function Stepper({ value, onChange, min = 1, max = 50 }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border">
      <button aria-label="Mostrar menos alunos" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} className="p-1 text-muted hover:text-text disabled:opacity-40"><Minus size={13} /></button>
      <span className="min-w-[20px] text-center text-xs text-text tabular-nums">{value}</span>
      <button aria-label="Mostrar mais alunos" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} className="p-1 text-muted hover:text-text disabled:opacity-40"><Plus size={13} /></button>
    </span>
  )
}

const ymd = (d) => d.toISOString().slice(0, 10)

export default function DashboardPage() {
  const { courseId, courseName, className, period } = useAdminWorkspace()
  const location = useLocation()
  const nav = useNavigate()
  const { pref, setPref } = usePreferences()
  const riskCount = pref('dashboard.riskCount', 5)

  const ctx = new URLSearchParams({ courseId, studentClass: className }).toString()
  // students-overview já vem escopado do servidor — sem refiltro no cliente.
  const overview = useApi(`/api/admin/dashboard/students-overview?${ctx}`)
  const now = useApi(`/api/admin/dashboard/now?${ctx}`, [], { pollMs: 30000 })
  const queue = useApi(`/api/admin/dashboard/queue?${ctx}`)
  const trends = useApi(`/api/admin/dashboard/trends?${ctx}`)
  const calendar = useApi(`/api/admin/announcements/calendar?${ctx}`)

  const hoje = new Date()
  const contexto = [
    `${className}${period ? ` — ${period}` : ''}`,
    courseName || courseId,
    overview.data ? `${overview.data.length} alunos` : null,
    hoje.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }),
  ].filter(Boolean).join(' · ')

  // Fila: adiar por 24h persiste em preferences (servidor filtra na próxima carga;
  // aqui remove otimisticamente para a linha sumir na hora).
  const snooze = (item) => {
    const cur = pref('dashboard.snoozed', {})
    setPref('dashboard.snoozed', { ...cur, [item.id]: Date.now() })
    queue.setData((queue.data || []).filter((i) => i.id !== item.id))
  }

  // Alunos em risco: lista única com motivos; sem chamada = "sem dado", nunca 0%.
  const freqOrd = (o) => (o.frequencia == null ? Infinity : o.frequencia)
  const emRisco = useMemo(() => [...(overview.data || [])]
    .filter((o) => o.riscoLevel !== 'baixo')
    .sort((a, b) => (a.riscoLevel === 'alto' ? -1 : 1) - (b.riscoLevel === 'alto' ? -1 : 1) || freqOrd(a) - freqOrd(b))
    .slice(0, riskCount), [overview.data, riskCount])
  const semDado = useMemo(() => (overview.data || []).filter((o) => !(Number(o.totalAulas) > 0)).length, [overview.data])

  // Agenda: eventos do calendário nos próximos 7 dias + próxima aplicação de prova.
  const agenda = useMemo(() => {
    const fim = ymd(new Date(Date.now() + 7 * 86400000))
    const inicio = ymd(new Date())
    const eventos = (calendar.data || [])
      .filter((ev) => ev.eventDate >= inicio && ev.eventDate <= fim)
      .map((ev) => ({ ...ev, subtitle: ev.message ? ev.message.slice(0, 80) : '' }))
    const prox = now.data?.proximaAplicacao
    if (prox && !now.data?.aplicacao) {
      const data = ymd(new Date(prox.startsAt))
      if (data <= fim && !eventos.some((ev) => ev.eventType === 'prova' && ev.eventDate === data)) {
        eventos.push({ id: `app_${prox.id}`, eventDate: data, eventType: 'prova', title: prox.titulo, subtitle: 'aplicação agendada', startTime: '' })
      }
    }
    return eventos.sort((a, b) => a.eventDate.localeCompare(b.eventDate) || String(a.startTime).localeCompare(String(b.startTime))).slice(0, 6)
  }, [calendar.data, now.data])

  // Qualidade dos dados — junto do conteúdo, não no porão da tela.
  const dataQuality = useMemo(() => {
    const notes = []
    if (semDado > 0) notes.push({
      text: `${semDado} ${semDado === 1 ? 'aluno sem nenhuma chamada registrada — fica' : 'alunos sem nenhuma chamada registrada — ficam'} fora de todos os números acima`,
      action: { label: 'Lançar chamada', onClick: () => nav('/chamada') },
    })
    const cob = trends.data?.disciplinas?.cobertura
    if (cob && cob.total > 0 && cob.comDisciplina < cob.total) {
      notes.push({ text: `${cob.total - cob.comDisciplina} de ${cob.total} registros de presença sem disciplina — a frequência por matéria cobre só ${cob.comDisciplina}` })
    }
    return notes
  }, [semDado, trends.data, nav])

  // Exportar ≠ imprimir: gera CSV do overview (imprimir continua no navegador).
  const exportCsv = () => {
    const rows = overview.data || []
    const esc = csvCell
    const linhas = [
      ['Aluno', 'E-mail', 'Turma', 'Frequência (%)', 'Presenças', 'Aulas', 'Faltas', 'Média', 'Risco'].map(esc).join(';'),
      ...rows.map((o) => [o.name, o.email, o.className, o.frequencia ?? 'sem dado', o.presentes, o.totalAulas, o.faltas, o.media ?? 'sem prova', o.riscoLevel].map(esc).join(';')),
    ]
    const blob = new Blob(['﻿' + linhas.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `dashboard-${className || 'turma'}-${ymd(new Date())}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const disc = trends.data?.disciplinas
  const openStudent = (email) => nav('/alunos/' + encodeURIComponent(email))

  return (
    <div className="mx-auto max-w-[1320px] space-y-6">
      {/* O Dashboard é o destino de acesso negado do app inteiro — este alerta não pode sumir. */}
      {location.state?.accessDenied && (
        <div role="alert" className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-text">Sua conta não possui permissão para abrir essa tela.</div>
      )}

      <PageHeader title="Dashboard" subtitle={contexto}>
        <Button variant="secondary" icon={Download} onClick={exportCsv}>Exportar</Button>
        <Button icon={ClipboardCheck} onClick={() => nav('/chamada')}>Lançar chamada</Button>
      </PageHeader>

      {/* AGORA — some numa linha fora de horário, devolvendo o espaço à fila. */}
      <section aria-label="Agora">
        <SectionState query={now} height={96}>
          <NowBand now={now.data} onChamada={() => nav('/chamada')} onProva={() => nav('/monitor')} />
        </SectionState>
      </section>

      {/* FILA + AGENDA — no mobile a fila vem antes de tudo: o professor no
          celular quer a pendência, não a tendência. */}
      <section aria-label="Precisa de você" className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.35fr_1fr]">
        <div>
          <SectionLabel>Precisa de você</SectionLabel>
          <SectionState query={queue} height={180}>
            <ActionQueue items={queue.data || []} onOpen={(item) => nav(item.href)} onSnooze={snooze} />
          </SectionState>
        </div>
        <div>
          <SectionLabel action={<button onClick={() => nav('/calendario')} className="text-xs font-medium text-primary hover:text-primary-hover">Calendário</button>}>
            Próximos 7 dias
          </SectionLabel>
          <SectionState query={calendar} height={180}>
            <WeekAgenda events={agenda} onOpen={() => nav('/calendario')} />
          </SectionState>
        </div>
      </section>

      {/* PULSO — 3 números com tendência, não 8 soltos. */}
      <section aria-label="Pulso da turma">
        <SectionLabel action={<button onClick={() => nav('/resultados')} className="text-xs font-medium text-primary hover:text-primary-hover">Ver resultados</button>}>
          Pulso da turma
        </SectionLabel>
        <SectionState query={trends} height={170}>
          <PulseGrid trends={trends.data} />
        </SectionState>
      </section>

      {/* ALUNOS + DISCIPLINAS */}
      <section aria-label="Alunos que precisam de atenção" className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.35fr_1fr]">
        <div>
          <SectionLabel action={<Stepper value={riskCount} onChange={(v) => setPref('dashboard.riskCount', v)} />}>
            Alunos que precisam de atenção
          </SectionLabel>
          <SectionState query={overview} height={200}>
            <RiskList students={emRisco} semDado={semDado} limiar={disc?.limiar ?? 75} onOpen={openStudent} />
          </SectionState>
        </div>
        {/* D5: o recorte por disciplina só aparece com cobertura ≥ 50% dos registros. */}
        {disc?.exibir && disc.itens.length > 0 && (
          <div>
            <SectionLabel action={<button onClick={() => nav('/chamada')} className="text-xs font-medium text-primary hover:text-primary-hover">Chamada</button>}>
              Frequência por disciplina
            </SectionLabel>
            <DisciplineFrequency disciplinas={disc.itens} limiar={disc.limiar} semDisciplina={disc.cobertura.total - disc.cobertura.comDisciplina} />
          </div>
        )}
      </section>

      <DataQualityNote notes={dataQuality} />
    </div>
  )
}
