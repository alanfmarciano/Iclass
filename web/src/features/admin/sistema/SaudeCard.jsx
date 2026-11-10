// Cartão "Saúde do servidor" da tela Sistema (H3c, CONF-12, OPS-06): o que o
// GET /api/admin/system/health devolve, atualizado a cada 15 s. Antes não havia como o
// professor saber se o servidor estava funcionando, há quanto tempo, se o reinício
// automático estava ligado nem quando foi a última falha.
import { Activity } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../../components/ui/Card'
import { Badge } from '../../../components/ui/Badge'
import { useApi } from '../../../hooks/useApi'

export const HEALTH_POLL_MS = 15000

const STATUS = {
  ok: { label: 'Funcionando', tone: 'success' },
  starting: { label: 'Iniciando', tone: 'info' },
  degraded: { label: 'Com problemas', tone: 'danger' },
}

// 45 s, 12 min, 3 h 05 min, 2 dias e 4 h.
export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? 'dia' : 'dias'} e ${hours % 24} h`
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return null
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

function formatWhen(value) {
  const ms = toMs(value)
  if (!ms) return ''
  try { return new Date(ms).toLocaleString('pt-BR') } catch { return '' }
}

const decimal = (n) => (Number(n) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })

export function lastSaveText(save, now = Date.now()) {
  const at = toMs(save && save.lastOkAt)
  if (!at) return 'Ainda não houve salvamento desde que o servidor ligou.'
  const ago = formatDuration((now - at) / 1000)
  const took = Number(save.lastDurationMs)
  const tookText = !Number.isFinite(took) || took < 0 ? '' : (took < 1000 ? `, levou ${Math.round(took)} ms` : `, levou ${decimal(took / 1000)} s`)
  const failures = Number(save.consecutiveFailures) || 0
  const failText = failures > 0 ? ` · ${failures} ${failures === 1 ? 'falha seguida' : 'falhas seguidas'} depois dele` : ''
  return `há ${ago}${tookText}${failText}`
}

export function supervisorText(health) {
  if (!health || !health.supervised) return 'Reinício automático: desligado nesta forma de abrir o IClass'
  const restarts = Number(health.restarts) || 0
  return `Reinício automático: ligado (${restarts} ${restarts === 1 ? 'reinício' : 'reinícios'})`
}

const OUTAGE_REASONS = { crash: 'queda do servidor', restart: 'reinício', suspended: 'computador suspenso ou travado' }

export function outageText(outage) {
  if (!outage) return 'Nenhuma queda durante prova.'
  const parts = [formatWhen(outage.to)]
  parts.push(`fora do ar por ${formatDuration((Number(outage.durationMs) || 0) / 1000)}`)
  if (outage.reason && OUTAGE_REASONS[outage.reason]) parts.push(OUTAGE_REASONS[outage.reason])
  const where = [outage.examKey, outage.studentClass && `turma ${outage.studentClass}`].filter(Boolean).join(' · ')
  if (where) parts.push(where)
  parts.push(outage.compensated ? 'tempo devolvido aos alunos' : 'tempo não devolvido')
  return parts.filter(Boolean).join(' · ')
}

export function crashText(crash) {
  if (!crash) return 'Nenhuma falha registrada.'
  return [formatWhen(crash.at), crash.kind, crash.summary].filter(Boolean).join(' · ')
}

function Row({ label, children }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-3 py-1.5 border-b border-border last:border-b-0">
      <dt className="text-sm text-muted sm:w-48 shrink-0">{label}</dt>
      <dd className="text-sm text-text break-words min-w-0">{children}</dd>
    </div>
  )
}

export function SaudeCard({ refreshKey = 0 }) {
  const { data, error } = useApi('/api/admin/system/health', [refreshKey], { pollMs: HEALTH_POLL_MS })
  const status = STATUS[data?.status] || (error ? STATUS.degraded : null)
  const now = Date.now()
  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><Activity size={16} /> Saúde do servidor</span>}
        subtitle="Atualizado a cada 15 segundos."
        action={status && <Badge tone={status.tone} dot>{status.label}</Badge>}
      />
      <CardBody>
        {!data && !error && <p className="text-sm text-muted">Conferindo o servidor…</p>}
        {!data && error && <p className="text-sm text-danger">Não foi possível consultar o servidor agora. {error.message}</p>}
        {data && (
          <dl>
            {data.degraded && <Row label="Problema">Erro inesperado {formatWhen(data.degraded.at) ? `em ${formatWhen(data.degraded.at)}` : 'no servidor'} (veja Última falha). Reinicie o IClass assim que possível.</Row>}
            <Row label="Ligado há">{formatDuration(data.uptimeSeconds)}{data.startedAt ? ` (desde ${formatWhen(data.startedAt)})` : ''}</Row>
            <Row label="Memória">{decimal(data.rssMb)} MB</Row>
            <Row label="Banco de dados">{decimal(data.dbFileMb)} MB{data.database === 'error' ? ' · sem responder' : ''}</Row>
            <Row label="Último salvamento">{lastSaveText(data.save, now)}</Row>
            <Row label="Última falha">{crashText(data.lastCrash)}</Row>
            <Row label="Última queda durante prova">{outageText(data.lastOutage)}</Row>
            {data.version && <Row label="Versão">{data.version}</Row>}
          </dl>
        )}
        {data && <p className="text-sm text-text pt-3">{supervisorText(data)}</p>}
      </CardBody>
    </Card>
  )
}

export default SaudeCard
