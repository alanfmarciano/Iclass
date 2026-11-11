// Cartão "Retenção de dados" da tela Sistema (H8b: SEG-13; decisão 4 do Alan). Só os
// registros técnicos têm prazo, e só quando o administrador liga: teclas e saídas de tela
// da prova, registros de acesso e lixeira. Mostra o que nunca é apagado, a prévia do que
// a próxima limpeza apaga com os prazos da tela, a última limpeza e o aviso enquanto os
// prazos não foram revisados. "Limpar agora" só liga depois da primeira revisão, pede
// APAGAR e o servidor recusa sem revisão (not_reviewed) e com prova em andamento (GET/POST /api/admin/lgpd/retention, /preview e /run). O professor vê o
// cartão desligado.
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Eraser, Save, ShieldCheck, Sparkles } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../../components/ui/Card'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import { TypedConfirm, typedConfirmMatches } from '../../../components/ui/TypedConfirm'
import { useApi } from '../../../hooks/useApi'
import { api } from '../../../lib/api'
import { useToast } from '../../../context/ToastProvider'

export const RETENTION_NEVER_DELETED = 'Nunca são apagados por prazo: cadastro dos alunos, notas, entregas de prova, frequência, observações, mensagens e a auditoria. As 14 cópias de segurança automáticas (uma por dia) guardam os dados como estavam no dia de cada cópia e são trocadas sozinhas: um registro apagado aqui ainda fica nelas por até 14 dias.'
export const RETENTION_NOT_REVIEWED = 'Prazos de retenção ainda não definidos'
export const RETENTION_ADMIN_ONLY = 'Só o administrador altera os prazos de retenção'

export const RETENTION_FIELDS = [
  { key: 'proctoringDays', label: 'Monitoramento da prova', hint: 'Teclas e saídas da tela. Conta do encerramento da prova; prova aberta nunca perde nada. 0 = não apagar; mínimo de 30 dias.' },
  { key: 'loginLogsDays', label: 'Registros de acesso', hint: 'Entradas no sistema (login). 0 = não apagar; mínimo de 180 dias (Marco Civil da Internet).' },
  { key: 'trashDays', label: 'Lixeira', hint: 'Itens excluídos ficam na lixeira por este prazo. 0 = manter para sempre.' },
]

const integer = (n) => (Math.round(Number(n) || 0)).toLocaleString('pt-BR')

// Aviso enquanto os prazos não foram revisados. A lixeira já tinha prazo antes desta
// versão (padrão de 30 dias) e continua sendo esvaziada a cada 6 h por ele; o resto
// (teclas, saídas de tela e registros de acesso) não é apagado sozinho.
export function notReviewedText(trashDays) {
  const days = Math.round(Number(trashDays) || 0)
  if (days <= 0) return 'Enquanto isso, nada é apagado sozinho.'
  return `Enquanto isso, teclas, saídas de tela e registros de acesso não são apagados; só a lixeira continua sendo esvaziada sozinha, com o prazo de ${integer(days)} ${days === 1 ? 'dia' : 'dias'} que já valia.`
}

// "Com estes prazos, a próxima limpeza apaga X teclas, Y saídas de tela, Z registros de
// acesso e W itens da lixeira."
export function retentionPreviewText(counts) {
  const c = counts || {}
  const plural = (n, one, many) => `${integer(n)} ${Number(n) === 1 ? one : many}`
  return `Com estes prazos, a próxima limpeza apaga ${plural(c.keystrokes, 'tecla', 'teclas')}, ${plural(c.proctoringLogs, 'saída de tela', 'saídas de tela')}, ${plural(c.loginLogs, 'registro de acesso', 'registros de acesso')} e ${plural(c.trash, 'item da lixeira', 'itens da lixeira')}.`
}

function formatWhen(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value || '')
  if (!Number.isFinite(ms) || ms <= 0) return ''
  try { return new Date(ms).toLocaleString('pt-BR') } catch { return '' }
}

export function lastRunText(lastRun) {
  if (!lastRun || !lastRun.at) return 'Nenhuma limpeza feita ainda.'
  const c = lastRun.counts || {}
  const who = lastRun.trigger === 'manual' ? `pedida por ${lastRun.by || 'administrador'}` : 'automática'
  const removed = `${integer(c.keystrokes)} teclas, ${integer(c.proctoringLogs)} saídas de tela, ${integer(c.loginLogs)} registros de acesso` + (lastRun.trigger === 'manual' ? ` e ${integer(c.trash)} itens da lixeira` : '')
  const left = lastRun.remaining && Object.values(lastRun.remaining).some((n) => Number(n) > 0) ? ' Ficou sobra para a próxima hora.' : ''
  return `Última limpeza: ${formatWhen(lastRun.at)} (${who}), apagou ${removed}.${left}`
}

function toForm(settings) {
  const out = {}
  RETENTION_FIELDS.forEach((field) => { out[field.key] = String(settings?.[field.key] ?? 0) })
  return out
}

function Days({ id, label, hint, value, onChange, disabled }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">{label}</label>
      <span className="flex items-center gap-2">
        <input id={id} type="number" min={0} max={3650} step={1} inputMode="numeric" value={value} disabled={disabled} aria-describedby={`${id}-dica`} onChange={(e) => onChange(e.target.value)} className="h-[38px] w-28 px-3 rounded-md bg-surface border border-border text-text text-sm disabled:opacity-60" />
        <span className="text-sm text-muted">dias</span>
      </span>
      <span id={`${id}-dica`} className="text-xs text-subtle">{hint}</span>
    </div>
  )
}

// Professor: o cartão aparece desligado, com os prazos em vigor (GET /api/admin/settings).
function RetencaoReadOnly() {
  const { data } = useApi('/api/admin/settings')
  const values = {
    proctoringDays: data?.retention?.proctoringDays ?? 0,
    loginLogsDays: data?.retention?.loginLogsDays ?? 0,
    trashDays: data?.trash?.retentionDays ?? 0,
  }
  return (
    <Card aria-disabled="true">
      <CardHeader title={<span className="inline-flex items-center gap-2"><ShieldCheck size={16} /> Retenção de dados</span>} subtitle="Por quanto tempo o IClass guarda os registros técnicos" />
      <CardBody className="space-y-4">
        <p className="text-sm text-warning" role="note">{RETENTION_ADMIN_ONLY}.</p>
        <p className="text-xs text-muted">{RETENTION_NEVER_DELETED}</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 opacity-70">
          {RETENTION_FIELDS.map((field) => <Days key={field.key} id={`retention-ro-${field.key}`} label={field.label} hint={field.hint} value={String(values[field.key])} onChange={() => {}} disabled />)}
        </div>
      </CardBody>
    </Card>
  )
}

export function RetencaoCard({ isAdmin = false }) {
  if (!isAdmin) return <RetencaoReadOnly />
  return <RetencaoAdmin />
}

function RetencaoAdmin() {
  const { data, error, refetch } = useApi('/api/admin/lgpd/retention')
  const toast = useToast()
  const [form, setForm] = useState(null)
  const [preview, setPreview] = useState(null)
  const [previewError, setPreviewError] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  useEffect(() => { if (data?.settings) setForm(toForm(data.settings)) }, [data])

  const saved = useMemo(() => toForm(data?.settings), [data])
  const changed = !!form && RETENTION_FIELDS.some((field) => String(form[field.key]).trim() !== saved[field.key])
  const query = form ? RETENTION_FIELDS.map((field) => `${field.key}=${encodeURIComponent(String(form[field.key]).trim())}`).join('&') : ''

  // Prévia dos prazos da tela (os gravados vêm junto do GET; os editados, da prévia).
  useEffect(() => {
    if (!form || !changed) { setPreview(null); setPreviewError(''); return undefined }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const r = await api.get(`/api/admin/lgpd/retention/preview?${query}`, { background: true })
        if (!cancelled) { setPreview(r); setPreviewError('') }
      } catch (e) {
        if (!cancelled) { setPreview(null); setPreviewError(e.message) }
      }
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, changed]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-2"><ShieldCheck size={16} /> Retenção de dados</span>} />
        <CardBody><p className="text-sm text-danger">Não foi possível carregar a retenção: {error.message}</p></CardBody>
      </Card>
    )
  }
  if (!data || !form) return null

  const counts = changed ? preview?.counts : data.preview?.counts
  const active = Number(data.activeApplications) || 0
  const anyDeadline = RETENTION_FIELDS.some((field) => Number(data.settings?.[field.key]) > 0)

  async function save() {
    setBusy(true)
    try {
      const body = {}
      RETENTION_FIELDS.forEach((field) => { body[field.key] = String(form[field.key]).trim() === '' ? '' : Number(form[field.key]) })
      const r = await api.post('/api/admin/lgpd/retention', body)
      ;(r.adjusted || []).forEach((item) => toast.info(item.message))
      toast.success('Prazos de retenção salvos.')
      setForm(toForm(r.settings))
      refetch(true)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function runNow() {
    if (!typedConfirmMatches(confirmText, 'APAGAR')) return
    setBusy(true)
    try {
      const r = await api.post('/api/admin/lgpd/retention/run', { confirm: 'APAGAR' }, { timeoutMs: 0 })
      toast.success(lastRunText(r.lastRun))
      setOpen(false)
      setConfirmText('')
      refetch(true)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  function close() {
    if (busy) return
    setOpen(false)
    setConfirmText('')
  }

  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><ShieldCheck size={16} /> Retenção de dados</span>} subtitle="Por quanto tempo o IClass guarda os registros técnicos" />
      <CardBody className="space-y-4">
        {!data.reviewed && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-text" role="status">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
            <span><strong className="font-semibold">{RETENTION_NOT_REVIEWED}.</strong> {notReviewedText(data.settings?.trashDays)} Revise e salve os prazos (os recomendados servem para a maioria das escolas).</span>
          </div>
        )}
        <p className="text-xs text-muted">{RETENTION_NEVER_DELETED}</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {RETENTION_FIELDS.map((field) => (
            <Days key={field.key} id={`retention-${field.key}`} label={field.label} hint={field.hint} value={form[field.key]} disabled={busy}
              onChange={(value) => setForm((current) => ({ ...current, [field.key]: value }))} />
          ))}
        </div>
        <p className="text-sm text-text" data-testid="retention-preview" aria-live="polite">
          {previewError ? <span className="text-danger">{previewError}</span> : counts ? retentionPreviewText(counts) : 'Calculando a prévia…'}
        </p>
        <p className="text-xs text-subtle" data-testid="retention-last-run">{lastRunText(data.lastRun)} A limpeza automática roda uma vez por dia, só sem prova em andamento.</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" icon={Sparkles} disabled={busy}
            onClick={() => setForm(toForm(data.recommended))}>Usar prazos recomendados</Button>
          <Button variant="secondary" icon={Eraser} disabled={busy || changed || !data.reviewed || !anyDeadline || active > 0}
            title={changed || !data.reviewed ? 'Salve os prazos antes de limpar' : undefined} onClick={() => setOpen(true)}>Limpar agora</Button>
          <Button icon={Save} loading={busy} disabled={!changed && !!data.reviewed} onClick={save}>Salvar prazos</Button>
        </div>
        {active > 0 && <p className="text-xs text-muted">Há prova em andamento; a limpeza roda quando ela terminar.</p>}
        <Modal
          open={open}
          onClose={close}
          title="Limpar os registros antigos agora"
          description="Apaga de vez o que passou do prazo. Não dá para desfazer (só as cópias de segurança dos últimos dias ainda têm esses registros)."
          footer={<>
            <Button variant="ghost" onClick={close} disabled={busy}>Cancelar</Button>
            <Button variant="destructive" icon={Eraser} loading={busy} disabled={!typedConfirmMatches(confirmText, 'APAGAR')} onClick={runNow}>Apagar</Button>
          </>}
        >
          <div className="space-y-3">
            {data.preview?.counts && <p className="text-sm text-text">{retentionPreviewText(data.preview.counts).replace('Com estes prazos, a próxima limpeza apaga', 'Esta limpeza apaga')}</p>}
            <TypedConfirm id="retention-confirm" word="APAGAR" value={confirmText} onChange={setConfirmText} disabled={busy} onConfirm={runNow} autoFocus />
          </div>
        </Modal>
      </CardBody>
    </Card>
  )
}

export default RetencaoCard
