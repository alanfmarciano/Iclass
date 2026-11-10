import { useMemo, useState } from 'react'
import { Archive, RotateCcw, ShieldOff, Trash2 } from 'lucide-react'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageState } from '../../components/ui/PageState'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Textarea } from '../../components/ui/Textarea'
import { Modal } from '../../components/ui/Modal'
import { EmptyState } from '../../components/ui/EmptyState'
import { TypedConfirm, typedConfirmMatches } from '../../components/ui/TypedConfirm'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import {
  ANONYMIZED_STATUS, CLOSE_STATUS_OPTIONS, LIFECYCLE_REASON_MIN, STATUS_REASON_MAX,
  STUDENT_ANONYMIZE_KEEPS, STUDENT_ANONYMIZE_REMOVES, STUDENT_DELETE_KEEPS, STUDENT_DELETE_REMOVES, backupReminder,
} from './studentDeletion'

// Cadastros encerrados (H7c; FUN-03, decisão 4 do Alan), só do administrador. Lista quem
// foi desligado (Inativo, Transferido, Evadido, Concluído) e os anonimizados, do mais
// antigo para o mais novo, e é aqui que se decide caso a caso: Reativar, Anonimizar
// (guarda notas, presença e certificados sem os dados pessoais) ou Apagar de vez. Nada
// disso acontece sozinho depois de um prazo. Os filtros (situação e "encerrados há mais
// de N anos") rodam no navegador; cadastro desligado antes da atualização sem data na
// auditoria aparece como "data não registrada".
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000
const STATUS_TONE = { Inativo: 'neutral', 'Concluído': 'success', Transferido: 'warning', Evadido: 'warning', [ANONYMIZED_STATUS]: 'neutral' }
const ACTIONS = {
  reactivate: { title: 'Reativar', confirm: 'Reativar', word: null, reasonRequired: false },
  anonymize: { title: 'Anonimizar', confirm: 'Anonimizar', word: 'ANONIMIZAR', reasonRequired: true },
  purge: { title: 'Apagar de vez', confirm: 'Apagar de vez', word: 'APAGAR', reasonRequired: true },
}

function fmtDate(ms) {
  if (!ms) return ''
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR')
}

function yearsSince(ms, now) {
  if (!ms) return null
  return Math.max(0, (now - ms) / YEAR_MS)
}

function ageText(years) {
  if (years === null) return ''
  if (years < 1 / 12) return 'há menos de um mês'
  if (years < 1) { const months = Math.floor(years * 12); return `há ${months} ${months === 1 ? 'mês' : 'meses'}` }
  const whole = Math.floor(years)
  return `há ${whole} ${whole === 1 ? 'ano' : 'anos'}`
}

function plural(count, one, many) { return `${count} ${count === 1 ? one : many}` }

export default function CadastrosEncerradosPage() {
  const toast = useToast()
  const closed = useApi('/api/admin/students/closed')
  const [status, setStatus] = useState('')
  const [minYears, setMinYears] = useState('')
  const [query, setQuery] = useState('')
  const [action, setAction] = useState(null) // { mode, row }
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const now = Date.now()

  const items = useMemo(() => (Array.isArray(closed.data?.items) ? closed.data.items : []), [closed.data])
  const years = minYears === '' ? null : Math.max(0, Number(minYears) || 0)
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return items.filter((row) => {
      if (status && row.status !== status) return false
      if (years !== null) {
        const age = yearsSince(row.since, now)
        if (age === null || age < years) return false
      }
      if (term && ![row.name, row.nomeSocial, row.email, row.matricula].some((value) => String(value || '').toLowerCase().includes(term))) return false
      return true
    })
  }, [items, status, years, query, now])
  const undatedOut = years !== null ? items.filter((row) => !row.since && (!status || row.status === status)).length : 0

  function open(mode, row) {
    setAction({ mode, row })
    setReason('')
    setTyped('')
  }
  function close() { if (!busy) setAction(null) }

  const spec = action ? ACTIONS[action.mode] : null
  const trimmed = reason.trim()
  const reasonOk = !spec || ((!spec.reasonRequired || trimmed.length >= LIFECYCLE_REASON_MIN) && trimmed.length <= STATUS_REASON_MAX)
  const wordOk = !spec || !spec.word || typedConfirmMatches(typed, spec.word)
  const canConfirm = !!spec && reasonOk && wordOk && !busy

  async function confirm() {
    if (!canConfirm) return
    const { mode, row } = action
    setBusy(true)
    try {
      if (mode === 'reactivate') {
        const res = await api.post('/api/admin/student/bulk-status', { emails: [row.email], status: 'Ativo', reason: trimmed })
        const skipped = Array.isArray(res?.skipped) ? res.skipped[0] : null
        if (res && res.updated === 0 && skipped) throw new Error(skipped.reason || 'Nada mudou.')
        toast.success(`${row.name} voltou a Ativo.`)
      } else if (mode === 'anonymize') {
        const res = await api.post('/api/admin/students/anonymize', { email: row.email, confirm: typed, reason: trimmed })
        toast.success(`Cadastro anonimizado: agora é ${res?.name || 'um código'}.`)
      } else {
        await api.post('/api/admin/students/purge', { email: row.email, confirm: typed, reason: trimmed })
        toast.success('Cadastro apagado de vez.')
      }
      setAction(null)
      closed.refetch()
    } catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Cadastros encerrados" subtitle="Alunos desligados e anonimizados. Decida caso a caso: reativar, anonimizar (notas, presença e certificados ficam sem os dados pessoais) ou apagar de vez. Nada acontece sozinho depois de um prazo." />

      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Select label="Situação" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Todas</option>
            {[...CLOSE_STATUS_OPTIONS, ANONYMIZED_STATUS].map((option) => <option key={option} value={option}>{option}</option>)}
          </Select>
          <Input label="Encerrados há mais de (anos)" type="number" min="0" step="1" inputMode="numeric" value={minYears} onChange={(event) => setMinYears(event.target.value)} placeholder="Qualquer data" />
          <Input label="Buscar" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome, e-mail ou matrícula" />
        </div>
        {undatedOut > 0 && <p className="mt-3 text-xs text-muted">{plural(undatedOut, 'cadastro sem data registrada ficou', 'cadastros sem data registrada ficaram')} de fora do filtro de anos.</p>}
      </Card>

      <PageState loading={closed.loading && !closed.data} error={closed.error} onRetry={closed.refetch}>
        {filtered.length === 0 ? (
          <Card><EmptyState icon={Archive} title={items.length ? 'Nenhum cadastro com estes filtros' : 'Nenhum cadastro encerrado'} description={items.length ? 'Mude a situação ou o prazo.' : 'Quem for desligado em Alunos aparece aqui.'} /></Card>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted">{plural(filtered.length, 'cadastro', 'cadastros')}, do mais antigo para o mais novo.</p>
            {filtered.map((row) => {
              const age = yearsSince(row.since, now)
              const counts = row.counts || {}
              return (
                <Card key={row.email} className="p-4 space-y-3" data-testid="cadastro-encerrado">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-text break-words">{row.nomeSocial || row.name}</p>
                      <p className="text-sm text-muted break-all">{row.email}{row.matricula ? ` · matrícula ${row.matricula}` : ''}</p>
                    </div>
                    <Badge tone={STATUS_TONE[row.status] || 'neutral'}>{row.status}</Badge>
                  </div>
                  <div className="text-sm text-text space-y-1">
                    <p>{row.since ? `Encerrado em ${fmtDate(row.since)} (${ageText(age)})` : 'Encerrado em data não registrada'}{row.by ? ` por ${row.by}` : ''}.</p>
                    {row.anonymized && row.anonymizedAt && <p>Anonimizado em {fmtDate(row.anonymizedAt)}.</p>}
                    {row.reason && <p className="text-muted break-words">Motivo: {row.reason}</p>}
                    {Array.isArray(row.classes) && row.classes.length > 0 && <p className="text-muted break-words">Turmas: {row.classes.map((entry) => entry.name).join(', ')}</p>}
                    <p className="text-muted">Guardados: {plural(counts.submissions || 0, 'nota', 'notas')}, {plural(counts.attendance || 0, 'presença', 'presenças')}, {plural(counts.certificates || 0, 'certificado', 'certificados')}.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!row.anonymized && <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => open('reactivate', row)}>Reativar</Button>}
                    {!row.anonymized && <Button size="sm" variant="secondary" icon={ShieldOff} onClick={() => open('anonymize', row)}>Anonimizar</Button>}
                    <Button size="sm" variant="destructive" icon={Trash2} onClick={() => open('purge', row)}>Apagar de vez</Button>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </PageState>

      <Modal open={!!action} onClose={close} title={spec ? `${spec.title}: ${action.row.nomeSocial || action.row.name}?` : ''} description={action?.row.email}
        footer={<>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancelar</Button>
          <Button variant={action?.mode === 'reactivate' ? 'primary' : 'destructive'} onClick={confirm} loading={busy} disabled={!canConfirm}>{spec?.confirm}</Button>
        </>}>
        {spec && (
          <div className="space-y-3">
            {action.mode === 'reactivate' && <p className="text-sm text-text">O aluno volta a Ativo e consegue entrar de novo, com as notas e a presença de antes.</p>}
            {action.mode === 'anonymize' && <><p className="text-sm text-text">{STUDENT_ANONYMIZE_KEEPS}</p><p className="text-sm text-text">{STUDENT_ANONYMIZE_REMOVES}</p></>}
            {action.mode === 'purge' && <><p className="text-sm text-text">{STUDENT_DELETE_REMOVES}</p><p className="text-sm text-text">{STUDENT_DELETE_KEEPS}</p></>}
            {action.mode !== 'reactivate' && <p className="text-sm text-muted">{backupReminder(closed.data?.lastBackupAt)}</p>}
            <Textarea label={spec.reasonRequired ? 'Motivo' : 'Motivo (opcional)'} value={reason} onChange={(event) => setReason(event.target.value)} className="min-h-[72px]"
              error={trimmed.length > STATUS_REASON_MAX ? `No máximo ${STATUS_REASON_MAX} caracteres.` : undefined}
              placeholder={action.mode === 'reactivate' ? 'Ex.: voltou a estudar' : 'Ex.: pedido do responsável'} />
            {spec.word && <TypedConfirm word={spec.word} value={typed} onChange={setTyped} onConfirm={confirm} disabled={busy} />}
          </div>
        )}
      </Modal>
    </div>
  )
}
