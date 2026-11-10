// Cartão "Armazenamento" da tela Sistema (H1-c: CONF-06, DES-11, CONF-05). Antes não
// havia onde ver o tamanho do banco, quanto dele é espaço vazio depois de apagar dados,
// quanto tempo leva gravar, a última falha de gravação nem se a pasta de dados está
// dentro do OneDrive. O botão Compactar (VACUUM) é só do administrador, pede COMPACTAR e
// o servidor recusa com prova em andamento (GET /api/admin/storage, POST
// /api/admin/storage/compact).
import { useState } from 'react'
import { AlertTriangle, HardDrive, Minimize2 } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../../components/ui/Card'
import { Badge } from '../../../components/ui/Badge'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import { TypedConfirm, typedConfirmMatches } from '../../../components/ui/TypedConfirm'
import { useApi } from '../../../hooks/useApi'
import { api } from '../../../lib/api'
import { useToast } from '../../../context/ToastProvider'

export const ONEDRIVE_WARNING = 'A pasta de dados está dentro do OneDrive. Mova a pasta do IClass para fora dela (ex.: C:\\IClass) para evitar travas e cópias inconsistentes do banco.'

// Nome de cada coleção do banco como o professor reconhece.
const COLLECTION_LABELS = {
  students: 'Alunos', classes: 'Turmas', courses: 'Cursos', submissions: 'Entregas de prova', notes: 'Caderno dos alunos',
  annotations: 'Anotações nas apostilas', forum: 'Fórum', evaluations: 'Avaliações', progress: 'Progresso nas apostilas',
  uploads: 'Envios de arquivo', admins: 'Contas de acesso', proctoringLogs: 'Registros do Monitor', studentExamState: 'Provas em andamento',
  broadcastMessages: 'Mensagens de prova', questionBank: 'Banco de questões', auditLogs: 'Auditoria', loginLogs: 'Registros de login',
  pedagogicalObservations: 'Observações pedagógicas', attendance: 'Presenças', certificates: 'Certificados', moduleAccess: 'Acessos às apostilas',
  schools: 'Escolas', announcements: 'Avisos', library: 'Biblioteca', examApplications: 'Aplicações de prova', authSessions: 'Sessões abertas',
}

const integer = (n) => (Math.round(Number(n) || 0)).toLocaleString('pt-BR')

// 0 KB, 640 KB, 12,4 MB, 1,2 GB. Passa para a unidade de cima a partir de 1.000 da de
// baixo (1.014 KB vira "1 MB"), para nunca mostrar quatro dígitos com ponto.
const KB = 1024
const MB = 1024 * KB
const GB = 1024 * MB
export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  const decimal = (n) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
  if (Math.round(value / KB) < 1000) return `${Math.round(value / KB).toLocaleString('pt-BR')} KB`
  if (Math.round((value / MB) * 10) / 10 < 1000) return `${decimal(value / MB)} MB`
  return `${decimal(value / GB)} GB`
}

function formatWhen(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value || '')
  if (!Number.isFinite(ms) || ms <= 0) return ''
  try { return new Date(ms).toLocaleString('pt-BR') } catch { return '' }
}

function formatMs(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return ''
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`
}

// As 5 coleções com mais linhas: [{ name, label, rows }].
export function topCollections(rows, limit = 5) {
  return Object.entries(rows || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, label: COLLECTION_LABELS[name] || name, rows: Number(count) }))
}

// "3,2 MB (40% do arquivo)" ou "ainda não medido". A proporção usa allocatedBytes, o mesmo
// tamanho que o servidor usa para sugerir compactar (o maior entre o arquivo e as páginas
// do SQLite); databaseBytes sozinho, em WAL antes do checkpoint, pode ser só 4 KB.
export function freeSpaceText(storage) {
  if (!storage || storage.freeBytes === null || storage.freeBytes === undefined) return 'ainda não medido'
  const total = Number(storage.allocatedBytes) || Number(storage.databaseBytes) || 0
  const percent = total > 0 ? Math.round((Number(storage.freeBytes) / total) * 100) : 0
  return `${formatBytes(storage.freeBytes)}${total > 0 ? ` (${Math.min(100, percent)}% do arquivo)` : ''}`
}

// "120 MB" ou, com o -wal ainda cheio, "122 MB no total: 120 MB no arquivo principal e
// 2 MB de gravações recentes (-wal)". O total vem primeiro: logo depois de ligar, em WAL, o
// arquivo principal pode ter só 4 KB e quase tudo estar no -wal.
export function databaseSizeText(storage) {
  if (!storage) return ''
  const main = Number(storage.databaseBytes) || 0
  const wal = Number(storage.walBytes) || 0
  if (wal <= 0) return formatBytes(main)
  return `${formatBytes(main + wal)} no total: ${formatBytes(main)} no arquivo principal e ${formatBytes(wal)} de gravações recentes (-wal)`
}

export function lastFullSaveText(storage) {
  if (!storage || !storage.lastFullSaveAt) return 'Ainda não houve gravação completa desde que o servidor ligou.'
  const took = formatMs(storage.lastFullSaveMs)
  return `${formatWhen(storage.lastFullSaveAt)}${took ? `, levou ${took}` : ''}`
}

export function compactResultText(result) {
  if (!result) return ''
  return `Banco compactado: de ${formatBytes(result.antes)} para ${formatBytes(result.depois)}${formatMs(result.ms) ? ` em ${formatMs(result.ms)}` : ''}.`
}

function Row({ label, children }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-3 py-1.5 border-b border-border last:border-b-0">
      <dt className="text-sm text-muted sm:w-48 shrink-0">{label}</dt>
      <dd className="text-sm text-text break-words min-w-0">{children}</dd>
    </div>
  )
}

export function ArmazenamentoCard() {
  const toast = useToast()
  const { data, error, refetch } = useApi('/api/admin/storage')
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const storage = data?.storage
  const active = Number(data?.activeApplications) || 0
  const top = topCollections(storage?.rows)

  function close() {
    if (busy) return
    setOpen(false)
    setConfirmText('')
  }

  async function compact() {
    if (busy || !typedConfirmMatches(confirmText, 'COMPACTAR')) return
    setBusy(true)
    try {
      // Sem prazo no navegador: o VACUUM de um banco grande pode levar alguns minutos, e
      // o servidor termina de qualquer jeito.
      const r = await api.post('/api/admin/storage/compact', { confirm: 'COMPACTAR' }, { timeoutMs: 0 })
      setResult(r)
      toast.success(compactResultText(r))
      setOpen(false)
      setConfirmText('')
      refetch(true)
    } catch (e) {
      toast.error(e.message)
      refetch(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><HardDrive size={16} /> Armazenamento</span>}
        subtitle="Tamanho do banco de dados, espaço recuperável e gravação."
        action={storage?.compactSuggested ? <Badge tone="info" dot>Vale compactar</Badge> : null}
      />
      <CardBody className="space-y-3">
        {!data && !error && <p className="text-sm text-muted">Carregando…</p>}
        {!data && error && <p className="text-sm text-danger">Não foi possível consultar o armazenamento agora. {error.message}</p>}
        {storage?.inSyncedFolder && (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-warning/40 bg-warning-soft text-sm text-text" role="alert">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <p>{ONEDRIVE_WARNING}</p>
          </div>
        )}
        {storage?.lastWriteError && (
          <p className="text-sm text-danger" role="alert">
            Última falha ao gravar: {formatWhen(storage.lastWriteError.at)} · {storage.lastWriteError.code}
            {storage.pendingRetry ? ' · o IClass está tentando gravar de novo sozinho.' : ''}
          </p>
        )}
        {storage && (
          <dl>
            <Row label="Banco de dados">{databaseSizeText(storage)}</Row>
            <Row label="Espaço recuperável">{freeSpaceText(storage)}</Row>
            <Row label="Maiores coleções">
              {top.length ? top.map((item) => `${item.label}: ${integer(item.rows)}`).join(' · ') : 'Nenhum dado ainda.'}
            </Row>
            <Row label="Teclas da prova gravadas">{integer(storage.keystrokes)}</Row>
            <Row label="Última gravação completa">{lastFullSaveText(storage)}</Row>
            <Row label="Tempo de gravação (p95)">{formatMs(storage.commitP95Ms) || 'ainda sem medida'}</Row>
            {data.diskFreeBytes !== null && data.diskFreeBytes !== undefined && <Row label="Livre no disco">{formatBytes(data.diskFreeBytes)}</Row>}
          </dl>
        )}
        {result && <p className="text-sm text-success" role="status">{compactResultText(result)}</p>}
        {data?.canCompact && (
          <div className="space-y-2 pt-1">
            <p className="text-xs text-muted">Compactar devolve ao disco o espaço que sobrou no arquivo depois de apagar dados. As gravações ficam paradas por alguns segundos; faça fora do horário de prova.</p>
            <Button variant="secondary" icon={Minimize2} disabled={busy || active > 0} onClick={() => setOpen(true)}>Compactar banco</Button>
            {active > 0 && <p className="text-xs text-muted">Há prova em andamento. Compacte o banco depois que as provas terminarem.</p>}
          </div>
        )}
        <Modal
          open={open}
          onClose={close}
          title="Compactar o banco"
          description="O IClass reescreve o arquivo do banco sem o espaço vazio. Nenhum dado é apagado."
          footer={<>
            <Button variant="ghost" onClick={close} disabled={busy}>Cancelar</Button>
            <Button variant="primary" icon={Minimize2} loading={busy} disabled={!typedConfirmMatches(confirmText, 'COMPACTAR')} onClick={compact}>Compactar</Button>
          </>}
        >
          <div className="space-y-3">
            {storage && <p className="text-sm text-text">Espaço recuperável agora: {freeSpaceText(storage)}.</p>}
            <TypedConfirm id="compact-confirm" word="COMPACTAR" value={confirmText} onChange={setConfirmText} disabled={busy} onConfirm={compact} autoFocus />
          </div>
        </Modal>
      </CardBody>
    </Card>
  )
}

export default ArmazenamentoCard
