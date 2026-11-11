// Cartão "Backup" da tela Sistema (H4b: OPS-03, CONF-11, decisões §3 SEG-15). Mostra a
// situação (último backup neste computador e no destino externo, falha, atraso, adiamento
// por prova), "Fazer backup agora", o destino externo (pendrive, HD externo ou pasta de
// rede), os backups guardados com Baixar e Restaurar, a restauração de um arquivo e o
// histórico. Baixar um backup pede a senha do administrador de novo; restaurar passa pela
// prévia (RestorePreview). O professor com "Executar manutenção" vê a situação e faz o
// backup no servidor; baixar, restaurar e o destino são do administrador (SEG-X1).
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock3, Database, Download, HardDriveUpload, RotateCcw, Save, Upload, Usb } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../../components/ui/Card'
import { Badge } from '../../../components/ui/Badge'
import { Button } from '../../../components/ui/Button'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import { useApi } from '../../../hooks/useApi'
import { api, downloadFile } from '../../../lib/api'
import { useToast } from '../../../context/ToastProvider'
import { RestorePreview } from './RestorePreview'

export const BACKUP_ACTION_LABEL = {
  backup_restored: 'Restauração concluída',
  backup_restore_failed: 'Restauração com falha',
  backup_server_created: 'Cópia gerada no servidor',
  backup_downloaded: 'Backup baixado',
  backup_auto_created: 'Backup automático feito',
  backup_auto_failed: 'Backup automático falhou',
  backup_config_changed: 'Destino do backup alterado',
}

// Por que a senha é pedida de novo, em uma linha (decisões §3, SEG-15).
export const DOWNLOAD_PASSWORD_REASON = 'O backup traz os dados pessoais de todos os alunos; por isso o IClass pede a senha do administrador de novo para baixar.'
export const DESTINATION_DATA_WARNING = 'O backup traz dados pessoais de alunos e senhas protegidas; guarde o pendrive ou a pasta em local seguro.'

// Restaurar não muda quem abre o painel em outros aparelhos (settings.network fica o de
// hoje; decisões do coordenador §7, J2): a tela diz isso em uma linha, antes e depois.
export const NETWORK_KEPT_NOTE = 'A configuração de rede (quem abre o painel em outros aparelhos) continua a de hoje.'

// Restauração de backup de versão anterior (sem as aplicações de prova): o que
// aconteceu com as aplicações, no histórico e no aviso de sucesso.
export function legacyRestoreNote({ applicationsDiscarded = 0, applicationsRebuilt = 0 } = {}) {
  const discarded = Number(applicationsDiscarded) || 0
  const rebuilt = Number(applicationsRebuilt) || 0
  return `Backup de versão anterior: as aplicações de prova foram refeitas a partir das turmas do backup (${discarded === 1 ? '1 aplicação atual descartada' : `${discarded} aplicações atuais descartadas`}, ${rebuilt === 1 ? '1 refeita' : `${rebuilt} refeitas`}).`
}

const KB = 1024
const MB = 1024 * KB
const GB = 1024 * MB
export function formatBackupBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  const decimal = (n) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
  if (value < MB) return `${Math.max(1, Math.round(value / KB)).toLocaleString('pt-BR')} KB`
  if (value < GB) return `${decimal(value / MB)} MB`
  return `${decimal(value / GB)} GB`
}

function when(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value || '')
  if (!Number.isFinite(ms) || ms <= 0) return ''
  try { return new Date(ms).toLocaleString('pt-BR') } catch { return '' }
}

const HOUR = 3600000
function daysAgo(value, now = Date.now()) {
  const ms = Date.parse(value || '')
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor((now - ms) / (24 * HOUR)))
}

function agoText(value, now = Date.now()) {
  const ms = Date.parse(value || '')
  if (!Number.isFinite(ms)) return ''
  const hours = Math.floor((now - ms) / HOUR)
  if (hours < 1) return 'há menos de 1 hora'
  if (hours < 48) return hours === 1 ? 'há 1 hora' : `há ${hours} horas`
  const days = daysAgo(value, now)
  return `há ${days} dias`
}

// A faixa do alto do cartão: vermelha (falhou ou atrasado), amarela (só neste computador,
// cópia externa atrasada ou destino desconectado) ou verde. Devolve { tone, title, text }.
export function backupBand(status, { isAdmin = true, now = Date.now() } = {}) {
  if (!status) return null
  const failure = status.ultimaFalha
  if (failure) {
    const target = failure.alvo === 'externo' ? 'A cópia no destino externo falhou' : 'O backup falhou'
    return { tone: 'danger', title: `${target}${when(failure.em) ? ` em ${when(failure.em)}` : ''}`, text: failure.mensagem || 'Veja o histórico de backup.' }
  }
  const lastLocal = Date.parse(status.local?.ultimoSucesso || '')
  const localLate = !Number.isFinite(lastLocal) || now - lastLocal > 26 * HOUR
  if (localLate && !status.adiadoPorProva) {
    return {
      tone: 'danger',
      title: Number.isFinite(lastLocal) ? `Último backup ${agoText(status.local.ultimoSucesso, now)}` : 'Nenhum backup feito ainda',
      text: 'Use "Fazer backup agora". O automático roda quando o servidor liga e de hora em hora, se o último tiver 20 horas ou mais.',
    }
  }
  if (status.configurado && status.externo && !status.externo.acessivel) {
    return { tone: 'warning', title: 'Destino externo desconectado', text: 'Conecte o pendrive ou o HD externo (ou confira a pasta de rede); a próxima cópia vai para lá.' }
  }
  if (status.configurado && status.externo) {
    const lastExternal = Date.parse(status.externo.ultimoSucesso || status.externo.configuradoEm || '')
    if (Number.isFinite(lastExternal) && now - lastExternal > 26 * HOUR) {
      return { tone: 'warning', title: 'Cópia externa atrasada', text: `Última cópia no destino externo ${status.externo.ultimoSucesso ? agoText(status.externo.ultimoSucesso, now) : 'ainda não feita'}.` }
    }
  }
  if (!status.configurado) {
    return {
      tone: 'warning',
      title: 'Backup só neste computador',
      text: isAdmin ? 'Escolha abaixo um pendrive, HD externo ou pasta de rede para guardar uma cópia fora daqui.' : 'Peça ao administrador para escolher um destino externo (pendrive, HD externo ou pasta de rede).',
    }
  }
  return { tone: 'success', title: 'Backup em dia', text: 'Cópia neste computador e no destino externo.' }
}

const BAND_STYLE = {
  danger: 'border-danger/40 bg-danger-soft',
  warning: 'border-warning/40 bg-warning-soft',
  success: 'border-success/40 bg-success-soft',
}
const BAND_ICON = { danger: AlertTriangle, warning: AlertTriangle, success: CheckCircle2 }
const BAND_ICON_COLOR = { danger: 'text-danger', warning: 'text-warning', success: 'text-success' }

function StatusBand({ band }) {
  if (!band) return null
  const Icon = BAND_ICON[band.tone] || AlertTriangle
  return (
    <div className={`flex items-start gap-2 rounded-lg border p-3 ${BAND_STYLE[band.tone] || ''}`} role={band.tone === 'danger' ? 'alert' : 'status'} aria-label="Situação do backup">
      <Icon size={16} className={`mt-0.5 shrink-0 ${BAND_ICON_COLOR[band.tone] || ''}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text">{band.title}</p>
        <p className="text-xs text-muted break-words">{band.text}</p>
      </div>
    </div>
  )
}

function StatusLines({ status }) {
  if (!status) return null
  const local = status.local || {}
  const externo = status.externo
  return (
    <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
      <div className="min-w-0 rounded-lg border border-border p-3">
        <dt className="text-subtle">Neste computador</dt>
        <dd className="mt-0.5 text-text break-words">{local.ultimoSucesso ? `${when(local.ultimoSucesso)}${local.bytes ? ` · ${formatBackupBytes(local.bytes)}` : ''}` : 'Nenhum backup ainda'}</dd>
      </div>
      <div className="min-w-0 rounded-lg border border-border p-3">
        <dt className="text-subtle">No destino externo</dt>
        <dd className="mt-0.5 text-text break-words">{!status.configurado ? 'Não configurado' : externo?.ultimoSucesso ? `${when(externo.ultimoSucesso)}${externo.bytes ? ` · ${formatBackupBytes(externo.bytes)}` : ''}` : 'Nenhuma cópia ainda'}</dd>
      </div>
      {status.adiadoPorProva && (
        <p className="sm:col-span-2 flex items-start gap-1.5 text-muted"><Clock3 size={13} className="mt-0.5 shrink-0" aria-hidden="true" />Backup automático adiado: há prova em andamento. Ele roda quando a prova acabar (ou, se o último passar de 48 horas, mesmo com a prova).</p>
      )}
      {status.proximoAutomatico && !status.adiadoPorProva && (
        <p className="sm:col-span-2 text-subtle">Próximo backup automático a partir de {when(status.proximoAutomatico)} (com o servidor ligado).</p>
      )}
    </dl>
  )
}

// Destino externo (só administrador): caminho absoluto da pasta, testado na hora de salvar.
function DestinationForm({ onSaved }) {
  const toast = useToast()
  const config = useApi('/api/admin/backup/config')
  const [destino, setDestino] = useState('')
  const [keep, setKeep] = useState('14')
  const [error, setError] = useState({})
  const [busy, setBusy] = useState(false)
  const [checked, setChecked] = useState(null)
  useEffect(() => {
    if (!config.data) return
    setDestino(config.data.destino || '')
    setKeep(String(config.data.guardarExterno || 14))
  }, [config.data])
  const limits = config.data?.limites?.guardarExterno || { min: 1, max: 90 }
  async function save(nextDestino = destino) {
    setBusy(true)
    setError({})
    try {
      const r = await api.post('/api/admin/backup/config', { destino: nextDestino, guardarExterno: Number(keep) }, { timeoutMs: 0 })
      setDestino(r.destino || '')
      setChecked(r.destino ? r : null)
      toast.success(r.destino ? `Destino salvo e testado: ${r.pasta}` : 'Cópia externa desligada.')
      config.refetch(true)
      onSaved?.()
    } catch (e) {
      const field = e?.data?.field === 'guardarExterno' ? 'guardarExterno' : 'destino'
      setError({ [field]: e.message })
    } finally { setBusy(false) }
  }
  const suggestion = config.data?.sugestao
  return (
    <section className="space-y-3 rounded-lg border border-border p-4" aria-label="Destino externo">
      <p className="flex items-center gap-2 text-sm font-semibold text-text"><Usb size={15} aria-hidden="true" /> Destino externo</p>
      <p className="text-xs text-muted">Pasta de um pendrive, HD externo ou pasta de rede, fora da pasta do IClass. Todo dia vai para lá o backup completo (com a biblioteca), numa pasta com o nome deste computador.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
        <Input id="backup-destino" label="Pasta do destino" placeholder="Ex.: E:\Backups ou \\servidor\pasta" value={destino} onChange={(e) => setDestino(e.target.value)} error={error.destino} autoComplete="off" spellCheck={false} />
        <Input id="backup-guardar" label="Guardar no destino" type="number" inputMode="numeric" min={limits.min} max={limits.max} value={keep} onChange={(e) => setKeep(e.target.value)} error={error.guardarExterno} helper={`backups (${limits.min} a ${limits.max})`} className="sm:w-28" />
      </div>
      {suggestion && !destino && (
        <button type="button" className="text-left text-xs text-primary underline underline-offset-2 break-all" onClick={() => setDestino(suggestion)}>Usar a pasta do launcher: {suggestion}</button>
      )}
      <p className="flex items-start gap-1.5 text-xs text-warning"><AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />{DESTINATION_DATA_WARNING}</p>
      {checked && (
        <p className="text-xs text-muted break-words" role="status">
          Gravação testada em {checked.pasta}.{checked.livreBytes !== null && checked.livreBytes !== undefined ? ` ${formatBackupBytes(checked.livreBytes)} livres.` : ''}
          {checked.mesmoDisco ? ' Atenção: essa pasta fica no mesmo disco do IClass; se o disco falhar, perde-se o backup também.' : ''}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={HardDriveUpload} loading={busy} onClick={() => save()} disabled={!destino.trim() && !config.data?.destino}>Testar e salvar</Button>
        {config.data?.destino && <Button variant="ghost" onClick={() => save('')} disabled={busy}>Desligar cópia externa</Button>}
      </div>
    </section>
  )
}

// Senha do administrador de novo para baixar (bilhete de uso único do servidor).
function PasswordPrompt({ target, onCancel, onDone }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setPassword(''); setError(''); setBusy(false) }, [target])
  async function confirm(event) {
    event?.preventDefault()
    if (!password) return setError('Informe a senha do administrador.')
    setBusy(true)
    setError('')
    try {
      const r = await api.post('/api/admin/backup/download-ticket', { ...target.ticket, password }, { timeoutMs: 0 })
      setPassword('')
      await onDone(r.ticket)
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }
  return (
    <Modal open={!!target} onClose={() => !busy && onCancel()} title="Confirme a senha para baixar" description={DOWNLOAD_PASSWORD_REASON}
      footer={<>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancelar</Button>
        <Button icon={Download} loading={busy} onClick={confirm}>Baixar</Button>
      </>}>
      {target && (
        <form onSubmit={confirm} className="space-y-3">
          <p className="text-sm text-text break-words">{target.label}</p>
          <Input id="backup-download-password" label="Senha do administrador" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={error} autoFocus />
        </form>
      )}
    </Modal>
  )
}

const ORIGIN_LABEL = {
  automatico: 'Automático', manual: 'Manual', 'seguranca-restauracao': 'Segurança (antes de restaurar)', 'seguranca-completa': 'Segurança',
  'antes-limpeza-prova': 'Antes de limpar o estado de prova', 'antes-resetar-sala': 'Antes de resetar a sala',
}

function StoredBackups({ list, onDownload, onRestore, checking }) {
  const items = list?.itens || []
  return (
    <section className="space-y-2" aria-label="Backups guardados">
      <p className="text-sm font-semibold text-text">Backups guardados</p>
      {list?.destino && !list.externoAcessivel && <p className="text-xs text-warning">O destino externo não está acessível agora; a lista mostra só os deste computador.</p>}
      {items.length === 0 ? <p className="text-xs text-muted">Nenhum backup guardado ainda.</p> : (
        <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Lista de backups">
          {items.slice(0, 30).map((item) => (
            <li key={`${item.local}:${item.nome}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-sm text-text">{when(item.criadoEm) || item.nome} <span className="text-xs text-muted">· {ORIGIN_LABEL[item.origem] || item.origem}{item.variante === 'completo' ? ' · completo' : item.variante === 'dados' ? ' · só os dados' : ''}</span></p>
                <p className="text-xs text-subtle break-all">{item.nome} · {formatBackupBytes(item.bytes)}</p>
              </div>
              <Badge tone={item.local === 'externo' ? 'info' : 'neutral'}>{item.local === 'externo' ? 'Destino externo' : 'Neste computador'}</Badge>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" icon={Download} onClick={() => onDownload(item)} aria-label={`Baixar ${item.nome}`}>Baixar</Button>
                <Button size="sm" variant="ghost" icon={RotateCcw} disabled={checking} onClick={() => onRestore(item)} aria-label={`Restaurar ${item.nome}`}>Restaurar</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// Histórico de backup (só o administrador vê): restaurações, falhas, cópias e downloads.
export function BackupHistory({ entries }) {
  if (!entries) return null
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-text">Histórico de backup</p>
      {entries.length === 0 ? <p className="text-xs text-muted">Nenhum registro ainda.</p> : (
        <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Histórico de backup">
          {entries.slice(0, 10).map((entry) => (
            <li key={entry.id || `${entry.action}-${entry.timestamp}`} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-xs">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-text break-words">
                  {BACKUP_ACTION_LABEL[entry.action] || 'Backup'}
                  {entry.action === 'backup_downloaded' && entry.format ? ` (${entry.format.toUpperCase()})` : ''}
                  {entry.file ? <span className="font-normal text-muted break-all"> · {entry.file}</span> : null}
                </p>
                {entry.externo && <p className="text-muted break-all">Cópia externa: {entry.externo}</p>}
                {entry.action === 'backup_config_changed' && <p className="text-muted break-all">{entry.destino ? `Destino: ${entry.destino}` : 'Cópia externa desligada'}</p>}
                {entry.externoErro && <p className="text-danger">Cópia externa: {entry.externoErro}</p>}
                {entry.error && <p className="text-danger">{entry.error}</p>}
                {entry.legacyApplications && <p className="text-muted">{legacyRestoreNote(entry)}</p>}
                <p className="text-subtle">{entry.timestamp ? new Date(entry.timestamp).toLocaleString('pt-BR') : 'Data não registrada'} · {entry.actor === 'sistema' ? 'automático' : (entry.actor || '—')}{entry.ip ? ` · IP ${entry.ip}` : ''}</p>
              </div>
              {['backup_restore_failed', 'backup_auto_failed'].includes(entry.action) ? <Badge tone="danger">Falhou</Badge> : entry.action === 'backup_restored' ? <Badge tone="success">Restaurado</Badge> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const DOWNLOADS = {
  completo: { path: '/api/admin/backup/full?variante=completo', fallback: 'iclass-backup-completo.zip', label: 'Backup completo (ZIP, com a biblioteca)' },
  dados: { path: '/api/admin/backup/full?variante=dados', fallback: 'iclass-backup-dados.zip', label: 'Só os dados (ZIP)' },
}

export function BackupCard({ isAdmin }) {
  const toast = useToast()
  const status = useApi('/api/admin/backup/status')
  const list = useApi(isAdmin ? '/api/admin/backup/list' : null, [isAdmin])
  const history = useApi(isAdmin ? '/api/admin/backup/history' : null, [isAdmin])
  const [file, setFile] = useState(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [serverBusy, setServerBusy] = useState(false)
  const [download, setDownload] = useState(null)
  // Prévia da restauração (H4a): o servidor confere o arquivo (enviado ou da lista) sem
  // mudar nada e devolve o token de uso único com o que o backup traz ao lado de hoje.
  const [preview, setPreview] = useState(null)
  const fileInputRef = useRef(null)
  const refreshAll = () => {
    status.refetch(true)
    if (isAdmin) { list.refetch(true); history.refetch(true) }
  }
  async function serverBackup() {
    setServerBusy(true)
    try {
      const r = await api.post('/api/admin/backup/server', {}, { timeoutMs: 0 })
      if (r.externoErro) toast.warning(`Backup feito neste computador (${r.fileName}), mas a cópia externa falhou: ${r.externoErro}`)
      else toast.success(r.externo ? `Backup feito neste computador e no destino externo (${r.externo.fileName}).` : `Backup feito neste computador (${r.fileName}). Ficam os ${r.kept || 20} backups manuais mais recentes.`)
    } catch (e) { toast.error(e.message) } finally { setServerBusy(false); refreshAll() }
  }
  function askDownload(kind) {
    const item = DOWNLOADS[kind]
    setDownload({ ticket: { tipo: kind }, label: item.label, path: item.path, fallback: item.fallback })
  }
  function askStoredDownload(item) {
    setDownload({
      ticket: { tipo: 'arquivo', local: item.local, nome: item.nome },
      label: `${item.nome} (${item.local === 'externo' ? 'destino externo' : 'neste computador'})`,
      path: `/api/admin/backup/file?local=${encodeURIComponent(item.local)}&nome=${encodeURIComponent(item.nome)}`,
      fallback: item.nome,
    })
  }
  // Download pelo cliente da API (lib/api.js): sem rede, a mensagem em português.
  async function runDownload(ticket) {
    const target = download
    setDownload(null)
    try {
      await downloadFile(`${target.path}${target.path.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`, target.fallback)
    } catch (e) { toast.error(e.message) } finally { history.refetch(true) }
  }
  async function check() {
    if (!file) return toast.error('Escolha o arquivo de backup')
    const fd = new FormData(); fd.append('file', file)
    setChecking(true)
    try {
      setPreview(await api.post('/api/admin/backup/restore/preview', fd, { timeoutMs: 0 }))
    } catch (e) {
      toast.error(e.message)
      history.refetch(true)
    } finally { setChecking(false) }
  }
  async function checkStored(item) {
    setChecking(true)
    try {
      setPreview(await api.post('/api/admin/backup/restore/preview', { local: item.local, nome: item.nome }, { timeoutMs: 0 }))
    } catch (e) {
      toast.error(e.message)
      history.refetch(true)
    } finally { setChecking(false) }
  }
  function clearFile() {
    setFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }
  async function restore({ replaceAccounts }) {
    if (!preview?.token) return
    setBusy(true)
    try {
      const d = await api.post('/api/admin/backup/restore', { token: preview.token, confirm: 'RESTAURAR', replaceAccounts }, { timeoutMs: 0 })
      const skipped = Number(d && d.accountsNotRestored) || 0
      const legacy = d?.legacyApplications ? ` ${legacyRestoreNote(d)}` : ''
      const network = d?.networkKept ? ` ${NETWORK_KEPT_NOTE}` : ''
      toast.success(skipped > 0
        ? `Backup restaurado. ${skipped === 1 ? 'Uma conta de acesso do backup não existe aqui e não foi restaurada' : `${skipped} contas de acesso do backup não existem aqui e não foram restauradas`}; para trazê-las, restaure de novo marcando "Substituir também as contas de acesso".${legacy}${network}`
        : `Backup restaurado. Recarregue a página para ver os dados.${legacy}${network}`)
      setPreview(null)
      clearFile()
    } catch (e) {
      toast.error(e.message)
      // Prévia vencida ou já usada: envie o arquivo de novo.
      if (e.status === 400 || e.status === 403) setPreview(null)
      // A falha fica no histórico (a restauração bem-sucedida encerra as sessões).
      history.refetch(true)
    } finally { setBusy(false) }
  }
  const band = backupBand(status.data, { isAdmin })
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Database size={16} /> Backup</span>} subtitle={isAdmin ? 'Situação, destino externo, backups guardados e restauração' : 'Situação do backup e cópia de segurança no servidor'} />
      <CardBody className="space-y-4 min-w-0">
        <StatusBand band={band} />
        <StatusLines status={status.data} />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={Save} loading={serverBusy} onClick={serverBackup}>Fazer backup agora</Button>
          {isAdmin && <Button variant="secondary" icon={Download} onClick={() => askDownload('completo')}>Baixar completo (ZIP)</Button>}
          {isAdmin && <Button variant="secondary" icon={Download} onClick={() => askDownload('dados')}>Baixar só os dados (ZIP)</Button>}
        </div>
        {isAdmin && <p className="text-xs text-muted">{DOWNLOAD_PASSWORD_REASON}</p>}
        {!isAdmin && <p className="text-xs text-muted">Baixar, restaurar e escolher o destino externo é exclusivo do administrador, porque o backup traz os dados de todos os alunos e as senhas protegidas das contas.</p>}
        {isAdmin && <DestinationForm onSaved={refreshAll} />}
        {isAdmin && <StoredBackups list={list.data} checking={checking} onDownload={askStoredDownload} onRestore={checkStored} />}
        {isAdmin && <div className="p-4 rounded-lg border border-danger/40 bg-danger-soft space-y-3">
          <p className="text-sm font-semibold text-text">Restaurar de um arquivo</p>
          <p className="text-xs text-muted">Substitui TODOS os dados atuais. Antes de mudar qualquer coisa, o IClass confere o arquivo e mostra o que ele traz ao lado do que há hoje. Um backup de segurança é criado automaticamente antes. As contas de acesso (administradores e professores) continuam as de hoje, a menos que você marque a opção na conferência. Numa instalação nova (troca de computador), marque a opção para trazer os professores do backup.</p>
          <p className="text-xs text-muted">{NETWORK_KEPT_NOTE}</p>
          <input ref={fileInputRef} type="file" accept=".json,.zip" aria-label="Arquivo de backup" onChange={(e) => setFile(e.target.files?.[0] || null)} className="max-w-full text-sm text-muted file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-surface-2 file:text-text file:font-medium" />
          <Button variant="destructive" icon={Upload} loading={checking} disabled={!file} onClick={check}>Conferir backup</Button>
        </div>}
        {isAdmin && <BackupHistory entries={history.data?.entries} />}
        <PasswordPrompt target={download} onCancel={() => setDownload(null)} onDone={runDownload} />
        <RestorePreview preview={preview} busy={busy} networkNote={NETWORK_KEPT_NOTE} onCancel={() => setPreview(null)} onConfirm={restore} />
      </CardBody>
    </Card>
  )
}
