import { useState, useEffect, useMemo } from 'react'
import { RefreshCw, Trash2, Wifi, AlertTriangle, Save, Settings2, RotateCcw, FolderOpen, FileText, Database, Download, Upload } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Modal } from '../../components/ui/Modal'
import { PageHeader } from '../../components/ui/PageHeader'
import { Badge } from '../../components/ui/Badge'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { useAuth } from '../../context/AuthProvider'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'
import { ADMIN_PERMISSIONS, canAccessAdminPermission } from '../../lib/adminPermissions'

const TIMEZONES = ['America/Sao_Paulo', 'America/Manaus', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Bahia', 'America/Cuiaba', 'America/Campo_Grande', 'America/Rio_Branco', 'America/Noronha', 'UTC']
const UPLOAD_TYPES = [['pdf', 'PDF'], ['image', 'Imagem'], ['video', 'Vídeo'], ['doc', 'Documento'], ['sheet', 'Planilha'], ['zip', 'Compactado'], ['other', 'Outros']]

function Field({ label, children, hint }) {
  return <label className="flex flex-col gap-1.5"><span className="text-sm font-medium text-text">{label}</span>{children}{hint && <span className="text-xs text-subtle">{hint}</span>}</label>
}
function Num({ value, onChange, min, max, suffix }) {
  return <div className="flex items-center gap-2"><input type="number" min={min} max={max} value={value} onChange={(e) => onChange(e.target.value)} className="h-[38px] w-28 px-3 rounded-md bg-surface border border-border text-text text-sm" />{suffix && <span className="text-sm text-muted">{suffix}</span>}</div>
}

function SettingsCard() {
  const { data, refetch } = useApi('/api/admin/settings')
  const [cfg, setCfg] = useState(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  useEffect(() => { if (data) setCfg(JSON.parse(JSON.stringify(data))) }, [data])
  if (!cfg) return null

  const set = (path, val) => setCfg((c) => { const n = JSON.parse(JSON.stringify(c)); let o = n; for (let i = 0; i < path.length - 1; i++) o = o[path[i]]; o[path[path.length - 1]] = val; return n })
  const toggleType = (t) => set(['upload', 'allowedTypes'], cfg.upload.allowedTypes.includes(t) ? cfg.upload.allowedTypes.filter((x) => x !== t) : [...cfg.upload.allowedTypes, t])

  async function save() {
    setBusy(true)
    try { const r = await api.post('/api/admin/settings', cfg); setCfg(r.settings); toast.success('Configurações salvas'); refetch() }
    catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Settings2 size={16} /> Configurações</span>} subtitle="Regionais, sessão, upload, presença, lixeira e manutenção" />
      <CardBody className="space-y-6">
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-subtle">Regionais</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Fuso horário" hint="Usado no cálculo da presença/datas.">
              <Select value={cfg.timezone} onChange={(e) => set(['timezone'], e.target.value)}>{TIMEZONES.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
            </Field>
            <Field label="Idioma e formato"><div className="h-[38px] px-3 rounded-md bg-surface-2 border border-border text-text text-sm flex items-center">Português (Brasil) · dd/MM/aaaa</div></Field>
          </div>
        </section>

        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-subtle">Sessão</p>
          <div className="flex flex-wrap gap-6">
            <Field label="Inatividade" hint="Desloga após ficar parado."><Num value={cfg.session.idleMinutes} onChange={(v) => set(['session', 'idleMinutes'], v)} min={5} max={720} suffix="min" /></Field>
            <Field label="Sessão máxima" hint="Prazo absoluto desde o login."><Num value={cfg.session.absoluteHours} onChange={(v) => set(['session', 'absoluteHours'], v)} min={1} max={24} suffix="h" /></Field>
          </div>
        </section>

        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-subtle">Upload de arquivos</p>
          <div className="flex flex-wrap items-end gap-6">
            <Field label="Tamanho máximo"><Num value={cfg.upload.maxSizeMb} onChange={(v) => set(['upload', 'maxSizeMb'], v)} min={1} max={1024} suffix="MB" /></Field>
            <Field label="Tipos permitidos">
              <div className="flex flex-wrap gap-2">
                {UPLOAD_TYPES.map(([t, lbl]) => (
                  <button key={t} type="button" onClick={() => toggleType(t)} className={`px-2.5 py-1.5 rounded-md border text-xs font-medium ${cfg.upload.allowedTypes.includes(t) ? 'bg-primary-soft text-primary border-primary/40' : 'border-border text-muted'}`}>{lbl}</button>
                ))}
              </div>
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-subtle">Presença automática</p>
          <label className="flex items-center gap-2 text-sm text-text"><input type="checkbox" checked={cfg.attendance.autoOnLogin} onChange={(e) => set(['attendance', 'autoOnLogin'], e.target.checked)} /> Marcar presença quando o aluno acessa o sistema</label>
          <p className="text-xs text-subtle">Só vale durante as aulas do dia da turma (do início da primeira aula, menos a tolerância, até o fim da última). Acesso fora desse horário não marca presença nem falta. Na Chamada o registro aparece como “Automática”, com a hora e o IP do acesso, para você conferir.</p>
          <div className="flex flex-wrap gap-6">
            <Field label="Janela — início" hint="Opcional: limita ainda mais o horário. Vazio = só a grade da turma."><input type="time" value={cfg.attendance.windowStart} onChange={(e) => set(['attendance', 'windowStart'], e.target.value)} className="h-[38px] px-3 rounded-md bg-surface border border-border text-text text-sm" /></Field>
            <Field label="Janela — fim"><input type="time" value={cfg.attendance.windowEnd} onChange={(e) => set(['attendance', 'windowEnd'], e.target.value)} className="h-[38px] px-3 rounded-md bg-surface border border-border text-text text-sm" /></Field>
          </div>
        </section>

        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-subtle">Lixeira</p>
          <Field label="Reter itens excluídos por" hint="0 = manter para sempre."><Num value={cfg.trash.retentionDays} onChange={(v) => set(['trash', 'retentionDays'], v)} min={0} max={3650} suffix="dias" /></Field>
        </section>

        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-subtle">Modo manutenção</p>
          <label className="flex items-center gap-2 text-sm text-text"><input type="checkbox" checked={cfg.maintenance.enabled} onChange={(e) => set(['maintenance', 'enabled'], e.target.checked)} /> Bloquear o acesso dos alunos (o painel do instrutor continua funcionando)</label>
          <Input id="mnt-msg" label="Mensagem exibida ao aluno" value={cfg.maintenance.message} onChange={(e) => set(['maintenance', 'message'], e.target.value)} />
        </section>

        <div className="flex justify-end"><Button icon={Save} loading={busy} onClick={save}>Salvar configurações</Button></div>
      </CardBody>
    </Card>
  )
}

function _human(b) { if (!b) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = b; while (n >= 1024 && i < 3) { n /= 1024; i++ } return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i] }
function _when(ts) { try { return new Date(ts).toLocaleString('pt-BR') } catch { return '' } }

function TrashCard() {
  const { data: items, loading, refetch } = useApi('/api/admin/trash')
  const toast = useToast()
  const list = items || []
  async function restore(id) { try { await api.post('/api/admin/trash/restore', { id }); toast.success('Item restaurado'); refetch() } catch (e) { toast.error(e.message) } }
  async function del(id) { if (!confirm('Excluir definitivamente? Não dá para recuperar depois.')) return; try { await api.post('/api/admin/trash/delete', { id }); toast.success('Excluído definitivamente'); refetch() } catch (e) { toast.error(e.message) } }
  async function empty() { if (!confirm('Esvaziar a lixeira? Todos os itens serão apagados definitivamente.')) return; try { const r = await api.post('/api/admin/trash/empty', {}); toast.success((r.removed || 0) + ' item(ns) apagados'); refetch() } catch (e) { toast.error(e.message) } }
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Trash2 size={16} /> Lixeira</span>} subtitle="Itens excluídos — restaure ou apague de vez"
        action={list.length > 0 ? <Button size="sm" variant="secondary" icon={Trash2} onClick={empty}>Esvaziar</Button> : null} />
      <CardBody className="space-y-2">
        {loading ? <p className="text-sm text-muted">Carregando…</p> : list.length === 0 ? (
          <p className="text-sm text-muted">A lixeira está vazia.</p>
        ) : list.map((e) => (
          <div key={e.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
            <span className="w-8 h-8 rounded-md bg-surface-2 text-muted grid place-items-center shrink-0">{e.isDir ? <FolderOpen size={15} /> : <FileText size={15} />}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text truncate">{e.name}{e.isDir ? ' (pasta)' : ''}</p>
              <p className="text-xs text-subtle truncate">de {e.originalRel} · excluído {_when(e.deletedAt)}{e.size ? ' · ' + _human(e.size) : ''}</p>
            </div>
            <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => restore(e.id)}>Restaurar</Button>
            <Button size="sm" variant="ghost" icon={Trash2} className="text-danger" onClick={() => del(e.id)}>Excluir</Button>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}

function _bkAuth() { try { const a = JSON.parse(localStorage.getItem('iclass-v3-auth')) || {}; const h = {}; if (a.adminSession) h['x-admin-session'] = a.adminSession; else if (a.adminAuth) h['Authorization'] = a.adminAuth; return h } catch { return {} } }

const BACKUP_ACTION_LABEL = {
  backup_restored: 'Restauração concluída',
  backup_restore_failed: 'Restauração com falha',
  backup_server_created: 'Cópia gerada no servidor',
  backup_downloaded: 'Backup baixado',
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
                <p className="font-medium text-text">
                  {BACKUP_ACTION_LABEL[entry.action] || 'Backup'}
                  {entry.action === 'backup_downloaded' && entry.format ? ` (${entry.format.toUpperCase()})` : ''}
                  {entry.file ? <span className="font-normal text-muted"> · {entry.file}</span> : null}
                </p>
                {entry.error && <p className="text-danger">{entry.error}</p>}
                <p className="text-subtle">{entry.timestamp ? new Date(entry.timestamp).toLocaleString('pt-BR') : 'Data não registrada'} · {entry.actor || '—'}{entry.ip ? ` · IP ${entry.ip}` : ''}</p>
              </div>
              {entry.action === 'backup_restore_failed' ? <Badge tone="danger">Falhou</Badge> : entry.action === 'backup_restored' ? <Badge tone="success">Restaurado</Badge> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Baixar e restaurar backup é só do administrador: o arquivo leva todos os alunos e
// os hashes de senha das contas (SEG-X1). Professor com "Executar manutenção" só gera
// a cópia de segurança, que fica guardada no servidor.
function BackupCard({ isAdmin }) {
  const toast = useToast()
  const history = useApi(isAdmin ? '/api/admin/backup/history' : null, [isAdmin])
  const [file, setFile] = useState(null)
  const [confirmTxt, setConfirmTxt] = useState('')
  const [replaceAccounts, setReplaceAccounts] = useState(false)
  const [busy, setBusy] = useState(false)
  const [serverBusy, setServerBusy] = useState(false)
  async function serverBackup() {
    setServerBusy(true)
    try {
      const r = await api.post('/api/admin/backup/server', {})
      toast.success(`Cópia de segurança gerada no servidor (${r.fileName}). Ficam as ${r.kept || 20} cópias manuais mais recentes.`)
      if (isAdmin) history.refetch(true)
    } catch (e) { toast.error(e.message) } finally { setServerBusy(false) }
  }
  async function download(kind) {
    try {
      const res = await fetch('/api/admin/backup/' + kind, { headers: _bkAuth() })
      if (!res.ok) { const d = await res.json().catch(() => null); throw new Error((d && d.error) || 'Falha ao gerar backup') }
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') || ''
      const m = cd.match(/filename="([^"]+)"/)
      const name = m ? m[1] : (kind === 'full' ? 'iclass-backup.zip' : 'iclass-backup.json')
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url)
      history.refetch(true)
    } catch (e) { toast.error(e.message) }
  }
  async function restore() {
    if (!file) return toast.error('Escolha o arquivo de backup')
    if (confirmTxt.trim().toUpperCase() !== 'RESTAURAR') return toast.error('Digite RESTAURAR para confirmar')
    if (!window.confirm(replaceAccounts
      ? 'Isto substitui TODOS os dados atuais, inclusive as contas de acesso. Um backup de segurança será criado antes. Continuar?'
      : 'Isto substitui TODOS os dados atuais (as contas de acesso continuam as de hoje). Um backup de segurança será criado antes. Continuar?')) return
    const fd = new FormData(); fd.append('file', file); fd.append('confirm', confirmTxt); fd.append('replaceAccounts', replaceAccounts ? '1' : '0')
    setBusy(true)
    try {
      const res = await fetch('/api/admin/backup/restore', { method: 'POST', headers: _bkAuth(), body: fd })
      const d = await res.json().catch(() => null)
      if (!res.ok) throw new Error((d && d.error) || 'Falha ao restaurar')
      const skipped = Number(d && d.accountsNotRestored) || 0
      toast.success(skipped > 0
        ? `Backup restaurado. ${skipped === 1 ? 'Uma conta de acesso do backup não existe aqui e não foi restaurada' : `${skipped} contas de acesso do backup não existem aqui e não foram restauradas`}; para trazê-las, restaure de novo marcando "Substituir também as contas de acesso".`
        : 'Backup restaurado. Recarregue a página para ver os dados.')
      setFile(null); setConfirmTxt(''); setReplaceAccounts(false)
    } catch (e) {
      toast.error(e.message)
      // A falha fica no histórico (a restauração bem-sucedida encerra as sessões).
      history.refetch(true)
    } finally { setBusy(false) }
  }
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Database size={16} /> Backup geral</span>} subtitle={isAdmin ? 'Gere, baixe ou restaure o sistema a partir de um arquivo' : 'Gere uma cópia de segurança guardada no servidor'} />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" icon={Save} loading={serverBusy} onClick={serverBackup}>Gerar cópia no servidor</Button>
          {isAdmin && <Button variant="secondary" icon={Download} onClick={() => download('data')}>Baixar dados (JSON)</Button>}
          {isAdmin && <Button variant="secondary" icon={Download} onClick={() => download('full')}>Baixar completo (ZIP)</Button>}
        </div>
        {!isAdmin && <p className="text-xs text-muted">Baixar e restaurar backup é exclusivo do administrador, porque o arquivo traz os dados de todos os alunos e as senhas protegidas das contas.</p>}
        {isAdmin && <div className="p-4 rounded-lg border border-danger/40 bg-danger-soft space-y-3">
          <p className="text-sm font-semibold text-text">Restaurar de um arquivo</p>
          <p className="text-xs text-muted">Substitui TODOS os dados atuais. Um backup de segurança é criado automaticamente antes. As contas de acesso (administradores e professores) continuam as de hoje, a menos que você marque a opção abaixo. Numa instalação nova (troca de computador), marque a opção para trazer os professores do backup.</p>
          <input type="file" accept=".json,.zip" onChange={(e) => setFile(e.target.files?.[0] || null)} className="text-sm text-muted file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-surface-2 file:text-text file:font-medium" />
          <label className="flex items-center gap-2 text-sm text-text"><input type="checkbox" checked={replaceAccounts} onChange={(e) => setReplaceAccounts(e.target.checked)} /> Substituir também as contas de acesso pelas do backup</label>
          <div className="flex flex-wrap items-center gap-3">
            <Input id="bk-confirm" value={confirmTxt} onChange={(e) => setConfirmTxt(e.target.value)} placeholder="Digite RESTAURAR" />
            <Button variant="destructive" icon={Upload} loading={busy} onClick={restore}>Restaurar</Button>
          </div>
        </div>}
        {isAdmin && <BackupHistory entries={history.data?.entries} />}
      </CardBody>
    </Card>
  )
}

const APPLICATION_STATUS = { prepared: 'Preparada', waiting: 'Sala de espera', running: 'Em andamento', paused: 'Pausada', finished: 'Finalizada', cancelled: 'Cancelada' }
function _plural(n, one, many) { return `${n} ${n === 1 ? one : many}` }
function _appLabel(a) { return `${a.examTitle || a.examKey} · ${APPLICATION_STATUS[a.status] || a.status}${a.createdAt ? ' · ' + _when(a.createdAt) : ''}` }

function _classKey(courseId, name) { return `${courseId || ''}::${name || ''}` }

// Turmas que a conta pode manter, com o nome do curso, para o seletor da Manutenção.
// A tela Sistema fica no Ambiente da instituição (sem turma ativa): a turma das ações
// por turma é escolhida aqui, e a turma ativa (quando houver) já vem escolhida.
export function maintenanceClassOptions(classes, courses, current) {
  const courseNames = new Map((Array.isArray(courses) ? courses : []).map((course) => [String(course.id), course.name || course.id]))
  const options = (Array.isArray(classes) ? classes : [])
    .filter((cls) => cls && cls.name && !cls.deletedAt && cls.status !== 'deleted')
    .map((cls) => ({ key: _classKey(cls.courseId, cls.name), className: cls.name, courseId: cls.courseId || '', courseName: courseNames.get(String(cls.courseId)) || cls.courseId || '' }))
    .sort((a, b) => a.courseName.localeCompare(b.courseName, 'pt-BR') || a.className.localeCompare(b.className, 'pt-BR'))
  if (current?.className && !options.some((option) => option.key === _classKey(current.courseId, current.className))) {
    options.unshift({ key: _classKey(current.courseId, current.className), className: current.className, courseId: current.courseId || '', courseName: current.courseName || current.courseId || '' })
  }
  return options
}

// Confirmação digitada no padrão do app (RESETAR, RESTAURAR...): o botão só funciona
// com a palavra certa, e o servidor confere de novo.
function TypedConfirm({ id, word, value, onChange }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">Digite <b className="text-text font-mono">{word}</b> para confirmar.</p>
      <Input id={id} aria-label={`Digite ${word} para confirmar`} value={value} onChange={(e) => onChange(e.target.value)} placeholder={word} autoComplete="off" />
    </div>
  )
}

export default function SistemaPage() {
  const { auth } = useAuth()
  const workspace = useAdminWorkspace()
  const { data: net } = useApi('/api/admin/network-info')
  const canManage = canAccessAdminPermission(auth, ADMIN_PERMISSIONS.SYSTEM_MANAGE)
  const { data: classList } = useApi(canManage ? '/api/admin/classes' : null)
  const { data: courseList } = useApi(canManage ? '/api/courses' : null)
  // Turma das ações de manutenção (limpar estado de prova e resetar sala).
  const [target, setTarget] = useState(() => workspace.className ? { courseId: workspace.courseId, className: workspace.className, courseName: workspace.courseName } : null)
  useEffect(() => {
    if (workspace.className) setTarget({ courseId: workspace.courseId, className: workspace.className, courseName: workspace.courseName })
  }, [workspace.courseId, workspace.className, workspace.courseName])
  const classOptions = useMemo(() => maintenanceClassOptions(classList, courseList, target), [classList, courseList, target])
  const targetOption = target ? classOptions.find((option) => option.key === _classKey(target.courseId, target.className)) : null
  const courseId = target?.courseId || ''
  const className = target?.className || ''
  const classLabel = targetOption ? `${targetOption.className}${targetOption.courseName ? ` · ${targetOption.courseName}` : ''}` : className
  const [preview, setPreview] = useState(null)
  const [previewError, setPreviewError] = useState(null)
  const [dialog, setDialog] = useState(null) // 'restart' | 'flush' | 'reset'
  const [confirmText, setConfirmText] = useState('')
  const [flushApplication, setFlushApplication] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const ips = (net && (net.addresses || net.ips || net)) || []
  const list = Array.isArray(ips) ? ips : []

  async function loadPreview(applicationId = '') {
    setPreviewError(null)
    try {
      const params = new URLSearchParams()
      if (className) params.set('studentClass', className)
      if (courseId) params.set('courseId', courseId)
      if (applicationId) params.set('applicationId', applicationId)
      setPreview(await api.get(`/api/admin/maintenance/preview?${params.toString()}`))
    } catch (e) { setPreview(null); setPreviewError(e.message) }
  }
  function openDialog(kind) {
    setConfirmText(''); setFlushApplication(''); setPreview(null); setDialog(kind)
    loadPreview('')
  }
  function closeDialog() { if (!busy) { setDialog(null); setConfirmText('') } }

  async function restart() {
    setBusy(true)
    try { await api.post('/api/admin/server/restart', { confirm: 'REINICIAR' }); toast.info('Servidor reiniciando…'); setDialog(null) }
    catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }
  async function flush() {
    if (confirmText.trim().toUpperCase() !== 'LIMPAR') return toast.error('Digite LIMPAR para confirmar')
    setBusy(true)
    try {
      const r = await api.post('/api/admin/flush-exam-state', { studentClass: className, courseId, applicationId: flushApplication || undefined, confirm: confirmText.trim().toUpperCase() })
      toast.success(r?.message || 'Estado de prova limpo'); setDialog(null); setConfirmText('')
    } catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }
  async function reset() {
    if (confirmText.trim().toUpperCase() !== 'RESETAR') return toast.error('Digite RESETAR para confirmar')
    setBusy(true)
    try {
      const r = await api.post('/api/admin/reset', { studentClass: className, courseId, confirm: confirmText.trim().toUpperCase() })
      toast.success(r?.message || 'Sala resetada'); setDialog(null); setConfirmText('')
    } catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }

  const flushPlan = preview?.flush
  const flushBlocked = !!flushPlan?.blockedBy?.length
  const flushEmpty = !!flushPlan && !flushBlocked && (flushPlan.counts.examStates + flushPlan.counts.messages) === 0
  const resetPlan = preview?.reset
  const restartActive = preview?.restart?.activeApplications || []
  const noClass = !className

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader title="Sistema" subtitle="Rede, configurações e manutenção." />

      <Card>
        <CardHeader title="Rede local" subtitle="Endereços para os alunos acessarem" />
        <CardBody className="space-y-2">
          {list.length === 0 && <p className="text-sm text-muted flex items-center gap-2"><Wifi size={16} /> Endereços aparecem quando o servidor estiver rodando.</p>}
          {list.map((ip, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <Wifi size={15} className="text-info" />
              <code className="font-mono text-text">{ip.address || ip}</code>
              {ip.name && <Badge tone="neutral">{ip.name}</Badge>}
            </div>
          ))}
        </CardBody>
      </Card>

      {canManage && <SettingsCard />}

      {canManage && <TrashCard />}

      {canManage && <BackupCard isAdmin={auth?.accountRole !== 'professor'} />}

      {canManage && <Card>
        <CardHeader title="Manutenção" subtitle="Limpar o estado de prova e resetar a sala valem só para a turma escolhida aqui." />
        <CardBody className="space-y-4">
          <div className="max-w-md">
            <Select id="maintenance-class" label="Turma" value={target ? _classKey(target.courseId, target.className) : ''}
              onChange={(e) => { const option = classOptions.find((item) => item.key === e.target.value); setTarget(option ? { courseId: option.courseId, className: option.className, courseName: option.courseName } : null) }}>
              <option value="">Escolha a turma…</option>
              {classOptions.map((option) => <option key={option.key} value={option.key}>{option.className}{option.courseName ? ` · ${option.courseName}` : ''}</option>)}
            </Select>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" icon={RefreshCw} onClick={() => openDialog('restart')}>Reiniciar servidor</Button>
            <Button variant="secondary" icon={Trash2} disabled={noClass} title={noClass ? 'Escolha a turma acima' : undefined} onClick={() => openDialog('flush')}>Limpar estado de prova</Button>
          </div>
          {noClass && <p className="text-xs text-subtle">Escolha a turma acima para limpar o estado de prova ou resetar a sala. Reiniciar o servidor vale para todas as turmas.</p>}
        </CardBody>
      </Card>}

      {canManage && <Card>
        <CardHeader title="Zona de risco" />
        <CardBody>
          <div className="flex flex-wrap items-center gap-3 p-4 rounded-lg border border-danger/40 bg-danger-soft">
            <AlertTriangle className="text-danger" size={22} />
            <div className="flex-1 min-w-[220px]"><p className="font-semibold text-text">Resetar sala</p><p className="text-sm text-muted">{noClass ? 'Escolha a turma em Manutenção, acima.' : `Só na turma ${classLabel}: encerra as provas em andamento salvando as respostas, desconecta os alunos dela e limpa as mensagens de prova. Não afeta conteúdos liberados, notas nem logs.`}</p></div>
            <Button variant="destructive" disabled={noClass} onClick={() => openDialog('reset')}>Resetar sala</Button>
          </div>
        </CardBody>
      </Card>}

      {!canManage && <Badge tone="neutral">Ações de manutenção não liberadas para esta conta.</Badge>}

      <Modal open={dialog === 'restart'} onClose={closeDialog} title="Reiniciar servidor" description="Todos os alunos e professores conectados perdem a conexão por alguns segundos."
        footer={<><Button variant="ghost" onClick={closeDialog}>Cancelar</Button><Button variant="destructive" loading={busy} onClick={restart}>Reiniciar agora</Button></>}>
        {previewError && <p className="text-sm text-danger">{previewError}</p>}
        {restartActive.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-warning">{_plural(restartActive.length, 'prova em andamento', 'provas em andamento')}:</p>
            <ul className="text-sm text-text list-disc pl-5 space-y-1">
              {restartActive.map((a) => <li key={a.id}>{a.studentClass} · {_appLabel(a)}</li>)}
            </ul>
            <p className="text-xs text-muted">As respostas já salvas ficam guardadas, mas os alunos precisam entrar de novo depois do reinício.</p>
          </div>
        ) : <p className="text-sm text-muted">{preview ? 'Nenhuma prova em andamento agora.' : 'Conferindo as provas em andamento…'}</p>}
      </Modal>

      <Modal open={dialog === 'flush'} onClose={closeDialog} title={`Limpar estado de prova · turma ${classLabel}`} description="Apaga só o estado de tentativas e as mensagens de prova da turma escolhida."
        footer={<><Button variant="ghost" onClick={closeDialog}>Cancelar</Button><Button variant="destructive" loading={busy} disabled={!flushPlan || flushBlocked || flushEmpty || confirmText.trim().toUpperCase() !== 'LIMPAR'} onClick={flush}>Limpar estado</Button></>}>
        <div className="space-y-4">
          <Select label="Aplicação" value={flushApplication} onChange={(e) => { setFlushApplication(e.target.value); loadPreview(e.target.value) }}>
            <option value="">Todas as provas desta turma</option>
            {(preview?.applications || []).map((a) => <option key={a.id} value={a.id}>{_appLabel(a)}</option>)}
          </Select>
          {previewError && <p className="text-sm text-danger">{previewError}</p>}
          {!flushPlan && !previewError && <p className="text-sm text-muted">Calculando o que será apagado…</p>}
          {flushBlocked && (
            <p className="text-sm text-warning" role="alert">Há aplicação em andamento ({flushPlan.blockedBy.map((a) => a.examTitle).join(', ')}). Encerre-a pelo Monitor, salvando ou desconsiderando as respostas, antes de limpar.</p>
          )}
          {flushPlan && !flushBlocked && (
            <div className="text-sm space-y-1">
              {flushEmpty ? <p className="text-muted">Nada para limpar nesta seleção.</p> : <>
                <p className="text-text"><b>Será apagado:</b> {_plural(flushPlan.counts.examStates, 'estado de tentativa sem entrega', 'estados de tentativa sem entrega')}{flushPlan.counts.pendingAnswers ? ` (${flushPlan.counts.pendingAnswers} com respostas não entregues)` : ''} e {_plural(flushPlan.counts.messages, 'mensagem de prova', 'mensagens de prova')}.</p>
                <p className="text-muted"><b className="text-text">Fica preservado:</b> {_plural(flushPlan.preserved.proctoringLogs, 'registro de monitoramento', 'registros de monitoramento')}, {_plural(flushPlan.preserved.keystrokes, 'registro de digitação', 'registros de digitação')}, todas as entregas e notas.</p>
                <p className="text-xs text-subtle">Um backup dos dados é salvo antes da limpeza.</p>
              </>}
            </div>
          )}
          {flushPlan && !flushBlocked && !flushEmpty && <TypedConfirm id="flush-confirm" word="LIMPAR" value={confirmText} onChange={setConfirmText} />}
        </div>
      </Modal>

      <Modal open={dialog === 'reset'} onClose={closeDialog} title={`Resetar sala · turma ${classLabel}`} description="Um backup dos dados (com as aplicações de prova) é salvo antes do reset."
        footer={<><Button variant="ghost" onClick={closeDialog}>Cancelar</Button><Button variant="destructive" loading={busy} disabled={!resetPlan || confirmText.trim().toUpperCase() !== 'RESETAR'} onClick={reset}>Confirmar reset</Button></>}>
        <div className="space-y-4">
          {previewError && <p className="text-sm text-danger">{previewError}</p>}
          {!resetPlan && !previewError && <p className="text-sm text-muted">Conferindo a turma…</p>}
          {resetPlan && (
            <div className="text-sm space-y-2">
              {resetPlan.activeApplications.length > 0 ? (
                <div>
                  <p className="text-text font-semibold">Provas encerradas com as respostas salvas (viram entrega):</p>
                  <ul className="list-disc pl-5 space-y-1 text-text">
                    {resetPlan.activeApplications.map((a) => <li key={a.id}>{_appLabel(a)}: {_plural(a.inProgressAttempts, 'tentativa em andamento', 'tentativas em andamento')}{a.waitingToStart ? `, ${a.waitingToStart} ainda nas instruções` : ''}</li>)}
                  </ul>
                </div>
              ) : <p className="text-muted">Nenhuma prova em andamento nesta turma.</p>}
              <p className="text-text">{_plural(resetPlan.counts.sessions, 'aluno desconectado', 'alunos desconectados')} · {_plural(resetPlan.counts.examStates, 'estado de prova limpo', 'estados de prova limpos')} · {_plural(resetPlan.counts.messages, 'mensagem limpa', 'mensagens limpas')}.</p>
              {resetPlan.counts.keptInOtherExam > 0 && <p className="text-muted">{_plural(resetPlan.counts.keptInOtherExam, 'aluno continua conectado', 'alunos continuam conectados')} por estar fazendo prova em outra turma.</p>}
              <p className="text-muted">Outras turmas, conteúdos liberados, notas e logs de monitoramento não são afetados.</p>
              <p className="text-xs text-warning">Desfazer exige restaurar esse backup, e a restauração volta todas as turmas ao momento do reset: entregas, notas e mudanças feitas depois, em qualquer turma, se perdem.</p>
            </div>
          )}
          {resetPlan && <TypedConfirm id="reset-confirm" word="RESETAR" value={confirmText} onChange={setConfirmText} />}
        </div>
      </Modal>
    </div>
  )
}
