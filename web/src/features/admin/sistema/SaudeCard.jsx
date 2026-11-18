// Cartão "Saúde do servidor" da tela Sistema (H3c, CONF-12, OPS-06): o que o
// GET /api/admin/system/health devolve, atualizado a cada 15 s. Antes não havia como o
// professor saber se o servidor estava funcionando, há quanto tempo, se o reinício
// automático estava ligado nem quando foi a última falha.
import { useEffect, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../../components/ui/Card'
import { Badge } from '../../../components/ui/Badge'
import { useApi } from '../../../hooks/useApi'

export const HEALTH_POLL_MS = 15000
// Sem resposta nova por mais que isto (duas consultas perdidas), o cartão deixa de
// mostrar o selo da última leitura: um pedido preso (servidor travado, computador
// suspenso) não dá erro nenhum e o selo ficava "Funcionando" com números parados.
export const HEALTH_STALE_MS = 2 * HEALTH_POLL_MS
// Relógio da tela (só redesenha; não consulta o servidor).
const CLOCK_MS = 5000

const STATUS = {
  ok: { label: 'Funcionando', tone: 'success' },
  starting: { label: 'Iniciando', tone: 'info' },
  degraded: { label: 'Com problemas', tone: 'danger' },
  // Sem resposta: mesmo selo de "com problemas" (os três estados do desenho); o aviso
  // acima dos números diz que o servidor não respondeu.
  unreachable: { label: 'Com problemas', tone: 'danger' },
}

// O servidor está subindo: o handler de boot responde 503 {starting:true} no /api (e
// {status:'starting'} no /api/health).
function isStartingError(error) {
  const body = error && error.data
  return !!(error && error.status === 503 && body && (body.starting === true || body.status === 'starting'))
}

// Estado do cartão a partir da última leitura e do último problema.
// - problem (o erro da consulta mais recente que falhou, guardado até chegar uma leitura
//   nova): 503 starting → 'starting'; qualquer outro → 'unreachable';
// - leitura mais velha que HEALTH_STALE_MS → 'unreachable' (sem resposta);
// - senão, o status que o servidor mandou.
// O useApi guarda a leitura antiga junto com o erro (e limpa o erro no começo de cada
// consulta), então o selo não pode vir só de data.status.
export function healthState({ data, problem, receivedAt, now = Date.now() }) {
  if (problem) return isStartingError(problem) ? 'starting' : 'unreachable'
  if (!data) return null
  if (receivedAt && now - receivedAt > HEALTH_STALE_MS) return 'unreachable'
  return STATUS[data.status] ? data.status : 'ok'
}

function clockTime(ms) {
  try { return new Date(ms).toLocaleTimeString('pt-BR') } catch { return '' }
}

// Linha de aviso quando a leitura na tela não é de agora.
export function staleNotice(state, receivedAt) {
  const since = receivedAt ? ` Os números abaixo são da última resposta, às ${clockTime(receivedAt)}.` : ''
  if (state === 'starting') return `O servidor está iniciando; o cartão atualiza sozinho quando ele terminar.${since}`
  if (state === 'unreachable') return `O servidor não está respondendo.${since} Se continuar assim, veja a janela do IClass.`
  return ''
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
  const [receivedAt, setReceivedAt] = useState(null)
  const [problem, setProblem] = useState(null)
  // Só redesenha de tempos em tempos (para a leitura velha virar "Com problemas" mesmo
  // com o pedido preso); a hora usada é a do desenho.
  const [, setTick] = useState(0)
  const lastDataRef = useRef(null)
  // Leitura nova: guarda a hora e esquece o problema anterior.
  useEffect(() => {
    if (!data || data === lastDataRef.current) return
    lastDataRef.current = data
    setReceivedAt(Date.now())
    setProblem(null)
  }, [data])
  // Consulta que falhou: o problema vale até a próxima leitura (o useApi limpa o erro no
  // começo de cada consulta nova, e o selo piscaria "Funcionando" enquanto ela espera).
  useEffect(() => { if (error) setProblem(error) }, [error])
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), CLOCK_MS)
    return () => clearInterval(id)
  }, [])
  const now = Date.now()
  const state = healthState({ data, problem, receivedAt, now })
  const status = state ? STATUS[state] : null
  const fresh = state === 'ok' || state === 'degraded'
  const notice = data && !fresh ? staleNotice(state, receivedAt) : ''
  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><Activity size={16} /> Saúde do servidor</span>}
        subtitle="Atualizado a cada 15 segundos."
        action={status && <Badge tone={status.tone} dot>{status.label}</Badge>}
      />
      <CardBody>
        {!data && !problem && <p className="text-sm text-muted">Conferindo o servidor…</p>}
        {!data && problem && state === 'starting' && <p className="text-sm text-muted">O servidor está iniciando; o cartão atualiza sozinho quando ele terminar.</p>}
        {!data && problem && state !== 'starting' && <p className="text-sm text-danger">Não foi possível consultar o servidor agora. {problem.message}</p>}
        {notice && <p className={`text-sm pb-2 ${state === 'starting' ? 'text-muted' : 'text-danger'}`} role="status">{notice}</p>}
        {data && (
          <dl className={fresh ? undefined : 'opacity-60'}>
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
