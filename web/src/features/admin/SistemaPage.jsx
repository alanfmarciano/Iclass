import { useState, useEffect } from 'react'
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
          <div className="flex flex-wrap gap-6">
            <Field label="Janela — início" hint="Vazio = qualquer horário."><input type="time" value={cfg.attendance.windowStart} onChange={(e) => set(['attendance', 'windowStart'], e.target.value)} className="h-[38px] px-3 rounded-md bg-surface border border-border text-text text-sm" /></Field>
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

function BackupCard() {
  const toast = useToast()
  const [file, setFile] = useState(null)
  const [confirmTxt, setConfirmTxt] = useState('')
  const [busy, setBusy] = useState(false)
  async function download(kind) {
    try {
      const res = await fetch('/api/admin/backup/' + kind, { headers: _bkAuth() })
      if (!res.ok) { const d = await res.json().catch(() => null); throw new Error((d && d.error) || 'Falha ao gerar backup') }
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') || ''
      const m = cd.match(/filename="([^"]+)"/)
      const name = m ? m[1] : (kind === 'full' ? 'iclass-backup.zip' : 'iclass-backup.json')
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url)
    } catch (e) { toast.error(e.message) }
  }
  async function restore() {
    if (!file) return toast.error('Escolha o arquivo de backup')
    if (confirmTxt.trim().toUpperCase() !== 'RESTAURAR') return toast.error('Digite RESTAURAR para confirmar')
    if (!window.confirm('Isto substitui TODOS os dados atuais. Um backup de segurança será criado antes. Continuar?')) return
    const fd = new FormData(); fd.append('file', file); fd.append('confirm', confirmTxt)
    setBusy(true)
    try {
      const res = await fetch('/api/admin/backup/restore', { method: 'POST', headers: _bkAuth(), body: fd })
      const d = await res.json().catch(() => null)
      if (!res.ok) throw new Error((d && d.error) || 'Falha ao restaurar')
      toast.success('Backup restaurado. Recarregue a página para ver os dados.')
      setFile(null); setConfirmTxt('')
    } catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Database size={16} /> Backup geral</span>} subtitle="Baixe uma cópia ou restaure o sistema a partir de um arquivo" />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" icon={Download} onClick={() => download('data')}>Baixar dados (JSON)</Button>
          <Button variant="secondary" icon={Download} onClick={() => download('full')}>Baixar completo (ZIP)</Button>
        </div>
        <div className="p-4 rounded-lg border border-danger/40 bg-danger-soft space-y-3">
          <p className="text-sm font-semibold text-text">Restaurar de um arquivo</p>
          <p className="text-xs text-muted">Substitui TODOS os dados atuais. Um backup de segurança é criado automaticamente antes.</p>
          <input type="file" accept=".json,.zip" onChange={(e) => setFile(e.target.files?.[0] || null)} className="text-sm text-muted file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-surface-2 file:text-text file:font-medium" />
          <div className="flex flex-wrap items-center gap-3">
            <Input id="bk-confirm" value={confirmTxt} onChange={(e) => setConfirmTxt(e.target.value)} placeholder="Digite RESTAURAR" />
            <Button variant="destructive" icon={Upload} loading={busy} onClick={restore}>Restaurar</Button>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

export default function SistemaPage() {
  const { auth } = useAuth()
  const { data: net } = useApi('/api/admin/network-info')
  const [confirm, setConfirm] = useState('')
  const [resetOpen, setResetOpen] = useState(false)
  const toast = useToast()
  const canManage = canAccessAdminPermission(auth, ADMIN_PERMISSIONS.SYSTEM_MANAGE)
  const ips = (net && (net.addresses || net.ips || net)) || []
  const list = Array.isArray(ips) ? ips : []

  async function restart() { try { await api.post('/api/admin/server/restart', {}); toast.info('Servidor reiniciando…') } catch (e) { toast.error(e.message) } }
  async function flush() { try { const r = await api.post('/api/admin/flush-exam-state', {}); toast.success(r?.message || 'Estado de prova limpo') } catch (e) { toast.error(e.message) } }
  async function reset() {
    if (confirm !== 'RESETAR') return toast.error('Digite RESETAR para confirmar')
    try { await api.post('/api/admin/reset', {}); toast.success('Sala resetada'); setResetOpen(false); setConfirm('') } catch (e) { toast.error(e.message) }
  }
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

      {canManage && <BackupCard />}

      {canManage && <Card>
        <CardHeader title="Manutenção" />
        <CardBody className="flex flex-wrap gap-3">
          <Button variant="secondary" icon={RefreshCw} onClick={restart}>Reiniciar servidor</Button>
          <Button variant="secondary" icon={Trash2} onClick={flush}>Limpar estado de prova</Button>
        </CardBody>
      </Card>}

      {canManage && <Card>
        <CardHeader title="Zona de risco" />
        <CardBody>
          <div className="flex items-center gap-3 p-4 rounded-lg border border-danger/40 bg-danger-soft">
            <AlertTriangle className="text-danger" size={22} />
            <div className="flex-1"><p className="font-semibold text-text">Resetar sala</p><p className="text-sm text-muted">Apaga o estado da prova ativa. Não afeta conteúdos liberados.</p></div>
            <Button variant="destructive" onClick={() => setResetOpen(true)}>Resetar sala</Button>
          </div>
        </CardBody>
      </Card>}

      {!canManage && <Badge tone="neutral">Ações de manutenção não liberadas para esta conta.</Badge>}

      <Modal open={resetOpen} onClose={() => { setResetOpen(false); setConfirm('') }} title="Resetar sala" description="Ação irreversível."
        footer={<><Button variant="ghost" onClick={() => { setResetOpen(false); setConfirm('') }}>Cancelar</Button><Button variant="destructive" onClick={reset}>Confirmar reset</Button></>}>
        <p className="text-sm text-muted mb-3">Digite <b className="text-text font-mono">RESETAR</b> para confirmar.</p>
        <Input id="rc" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="RESETAR" />
      </Modal>
    </div>
  )
}
