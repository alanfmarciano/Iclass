import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, CalendarClock, ExternalLink, Hand, RotateCcw, Save, Send } from 'lucide-react'
import { Modal } from '../../../components/ui/Modal'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import { Badge } from '../../../components/ui/Badge'
import { Button } from '../../../components/ui/Button'
import { Input } from '../../../components/ui/Input'
import { Select } from '../../../components/ui/Select'
import { Textarea } from '../../../components/ui/Textarea'
import { GradeReasonDialog, isReasonRequiredError } from '../GradeReasonDialog'
import { useToast } from '../../../context/ToastProvider'
import { api } from '../../../lib/api'
import { fmtGrade } from '../../../lib/grades'
import { hidePlaceholderEmails, studentKey, studentLabel } from './assignmentText'
import {
  CORRECTION_LIMITS, extensionBody, finalScorePreview, gradeBody, gradeInputText, lateText, localPartsInZone,
  manualEntryBody, penaltyLine, queuePosition, readGradeText, redoBody, rowDisplay, rowStatusInfo, safeExternalLink, schoolDateTime,
} from './correction'
import { FilePreview } from './FilePreview'
import { TOUCH } from './touch'

// Painel de correção de uma entrega (fase 3, C8 / P1-f; FUN-01, D7, D9 e D10 do P1).
// Gaveta à direita no computador e tela cheia no celular (Modal drawer), com os botões
// principais fixos embaixo.
//
// - Versões: "Versão 2 de 3", com a hora de chegada no relógio da escola, o atraso e o
//   código do comprovante; arquivos com prévia (FilePreview), texto do aluno como texto
//   puro e link só como texto, com "Abrir" em outra aba (noopener noreferrer).
// - Nota de 0 a 10 com vírgula, desconto de atraso da versão escolhida ("Atraso de 2 dias:
//   -20%, nota final 6,4", prévia pela conta do servidor) e "Dispensar desconto";
//   comentário até 5.000 caracteres.
// - Salvar (o aluno ainda não vê), Devolver ao aluno, Pedir para refazer (comentário e prazo
//   novo), Prorrogar prazo (motivo), Entrega em mãos (observação e nota opcional) e
//   Próximo aluno (a ordem da lista filtrada quando o painel abriu). Nota já devolvida:
//   mudar pede o motivo (GradeReasonDialog), que vai para a auditoria.
// - Aluno sem entrega: só a nota zero explícita ou a entrega em mãos (ninguém ganha zero
//   sozinho, D10); o servidor confere tudo de novo e a recusa aparece no campo dele.
// - Conta só de consulta, tarefa arquivada e rascunho: o painel mostra a entrega sem os
//   botões de mudar.
// - Correção digitada e não salva: fechar ou ir para o próximo pergunta antes.

const DAY_MS = 24 * 60 * 60 * 1000
const FIELD_OF = Object.freeze({ grade: 'grade', comment: 'comment' })

function emptyForm(grade) {
  return { gradeText: gradeInputText(grade), comment: grade?.comment || '', waive: !!grade?.penaltyWaived }
}

function sameForm(a, b) {
  return a.gradeText.trim() === b.gradeText.trim() && a.comment === b.comment && a.waive === b.waive
}

// Prazo sugerido nos diálogos de prazo: o prazo de agora do aluno, se ainda não passou;
// senão, daqui a 7 dias às 23:59 (o professor muda).
function suggestedDeadline(deadlineWindow, assignment, serverNow, timezone) {
  const current = deadlineWindow?.dueAt ?? assignment?.dueAt ?? null
  if (typeof current === 'number' && current > serverNow) return localPartsInZone(current, timezone) || { date: '', time: '23:59' }
  const later = localPartsInZone(serverNow + 7 * DAY_MS, timezone)
  return { date: later ? later.date : '', time: '23:59' }
}

export function CorrecaoPanel({ open, onClose, assignment, row, queue, onNavigate, onChanged, readOnly = false, timezone = '', serverNow = Date.now() }) {
  const toast = useToast()
  const base = `/api/admin/assignments/${encodeURIComponent(assignment?.id || '')}`
  const [detail, setDetail] = useState({ status: 'idle', submission: null, error: '' })
  const [versionN, setVersionN] = useState(null)
  const [form, setForm] = useState(() => emptyForm(row?.grade))
  const [initial, setInitial] = useState(() => emptyForm(row?.grade))
  const [errors, setErrors] = useState({})
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState(null)
  const [pendingLeave, setPendingLeave] = useState(null)
  const [reasonAction, setReasonAction] = useState(null)
  const [deadline, setDeadline] = useState({ date: '', time: '', closeDate: '', closeTime: '' })
  const [manual, setManual] = useState({ note: '', gradeText: '', returnNow: false })
  const loadToken = useRef(0)

  const key = studentKey(row)
  const submissionId = row?.submissionId || null
  const who = rowDisplay(row)
  const status = rowStatusInfo(row)
  const position = queuePosition(queue, key)
  const gradable = !readOnly && assignment?.status === 'publicada'
  const submission = detail.submission
  const versions = useMemo(() => (Array.isArray(submission?.versions) ? submission.versions : []), [submission])
  const version = versions.find((item) => item.n === versionN) || versions[versions.length - 1] || null
  const returned = (submission?.status || row?.status) === 'devolvida' && !!(submission?.returnedAt ?? row?.returnedAt)
  const delivered = (versions.length > 0) || !!(submission?.manualEntry || row?.manualEntry)
  const savedGrade = submission?.grade || row?.grade || null
  const deadlineWindow = submission?.window || { dueAt: row?.extension?.dueAt ?? assignment?.dueAt ?? null, closeAt: row?.extension?.closeAt ?? assignment?.closeAt ?? null, individual: !!row?.extension }
  const dirty = !sameForm(form, initial)
  const read = readGradeText(form.gradeText)

  function resetFrom(grade) {
    const next = emptyForm(grade)
    setForm(next)
    setInitial(next)
    setErrors({})
    setSummary('')
  }

  // Abriu ou trocou de aluno: a correção da lista na hora e a entrega completa do servidor.
  useEffect(() => {
    if (!open) return
    resetFrom(row?.grade)
    setVersionN(null)
    if (!submissionId) {
      setDetail({ status: 'ready', submission: null, error: '' })
      return
    }
    const token = ++loadToken.current
    setDetail({ status: 'loading', submission: null, error: '' })
    api.get(`${base}/submissions/${encodeURIComponent(submissionId)}`)
      .then((data) => {
        if (token !== loadToken.current) return
        setDetail({ status: 'ready', submission: data?.submission || null, error: '' })
        resetFrom(data?.submission?.grade || null)
      })
      .catch((error) => {
        if (token !== loadToken.current) return
        setDetail({ status: 'error', submission: null, error: hidePlaceholderEmails(error?.message) || 'Não foi possível abrir a entrega.' })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key, submissionId, base])

  function retry() {
    const token = ++loadToken.current
    setDetail({ status: 'loading', submission: null, error: '' })
    api.get(`${base}/submissions/${encodeURIComponent(submissionId)}`)
      .then((data) => { if (token === loadToken.current) { setDetail({ status: 'ready', submission: data?.submission || null, error: '' }); resetFrom(data?.submission?.grade || null) } })
      .catch((error) => { if (token === loadToken.current) setDetail({ status: 'error', submission: null, error: hidePlaceholderEmails(error?.message) || 'Não foi possível abrir a entrega.' }) })
  }

  function change(patch) {
    setForm((current) => ({ ...current, ...patch }))
    setErrors((current) => {
      const next = { ...current }
      if ('gradeText' in patch) delete next.grade
      if ('comment' in patch) delete next.comment
      return next
    })
    setSummary('')
  }

  // Sair (fechar ou outro aluno) com a correção digitada e não salva: pergunta antes.
  function leave(action) {
    if (dirty && gradable) setPendingLeave({ action })
    else action()
  }

  function applyResponse(result, message) {
    if (result?.submission) {
      setDetail({ status: 'ready', submission: result.submission, error: '' })
      resetFrom(result.submission.grade || null)
    }
    if (result?.row) onChanged?.(result.row)
    if (result?.changed === false) toast.info('Nada mudou: a correção já estava assim.')
    else if (message) toast.success(message)
  }

  // Recusa do servidor: no campo que ele indicou (nota, comentário) ou, sem campo, no aviso
  // do painel (uma vez só: o campo já tem role=alert).
  function showRefusal(error) {
    const message = hidePlaceholderEmails(error?.message) || 'Não foi possível salvar. Tente de novo.'
    const field = FIELD_OF[error?.data?.field]
    if (field) setErrors({ [field]: message })
    else setSummary(message)
  }

  function versionArg() {
    return version ? version.n : null
  }

  // A nota digitada vale? Mostra o erro no campo e devolve false.
  function gradeProblem() {
    const message = read.error || (read.empty && !savedGrade ? 'Informe a nota (de 0 a 10).' : '')
    if (message) setErrors({ grade: message })
    return !!message
  }

  async function sendGrade(action, reason = '') {
    if (gradeProblem()) return
    setBusy(true)
    setSummary('')
    try {
      const result = await api.post(`${base}/grade`, gradeBody({ studentEmail: row.studentEmail, action, gradeText: form.gradeText, comment: form.comment, version: versionArg(), waivePenalty: form.waive, reason }))
      setReasonAction(null)
      applyResponse(result, returned ? 'Correção alterada' : (action === 'devolver' ? 'Devolvida ao aluno' : 'Correção salva'))
    } catch (error) {
      if (isReasonRequiredError(error) && !reason) { setReasonAction(action); return }
      if (reason) throw error
      showRefusal(error)
    } finally {
      setBusy(false)
    }
  }

  // Salvar e Devolver: com a nota já devolvida e algo mudado, o motivo vem antes.
  function submit(action) {
    if (gradeProblem()) return
    if (returned && dirty) { setReasonAction(action); return }
    sendGrade(action)
  }

  function openDeadlineDialog(kind) {
    const suggested = suggestedDeadline(deadlineWindow, assignment, serverNow, timezone)
    setDeadline({ date: suggested.date, time: suggested.time, closeDate: '', closeTime: '' })
    setDialog(kind)
  }

  function openManualDialog() {
    setManual({ note: submission?.manualEntry?.note || row?.manualEntry?.note || '', gradeText: form.gradeText, returnNow: false })
    setDialog('manual')
  }

  async function confirmRedo(reason) {
    const result = await api.post(`${base}/grade`, redoBody({ studentEmail: row.studentEmail, gradeText: form.gradeText, comment: form.comment, version: versionArg(), waivePenalty: form.waive, dueDate: deadline.date, dueTime: deadline.time, closeDate: deadline.closeDate, closeTime: deadline.closeTime, reason: reason || '' }))
    applyResponse(result, 'Pedido para refazer enviado ao aluno')
    setDialog(null)
  }

  async function confirmExtension(reason) {
    const result = await api.post(`${base}/extension`, extensionBody({ studentEmail: row.studentEmail, dueDate: deadline.date, dueTime: deadline.time, closeDate: deadline.closeDate, closeTime: deadline.closeTime, reason }))
    applyResponse(result, 'Prazo do aluno prorrogado')
    setDialog(null)
  }

  async function confirmManual() {
    const result = await api.post(`${base}/manual-entry`, manualEntryBody({ studentEmail: row.studentEmail, note: manual.note, gradeText: manual.gradeText, comment: form.comment !== initial.comment ? form.comment : '', returnNow: manual.returnNow }))
    applyResponse(result, manual.returnNow ? 'Entrega em mãos registrada e devolvida' : 'Entrega em mãos registrada')
    setDialog(null)
  }

  const scorePreview = read.error || read.empty ? (savedGrade?.score ?? null) : read.score
  const lateInfo = penaltyLine({ version, latePolicy: assignment?.latePolicy, waived: form.waive, score: scorePreview })
  const canWaive = !!version && Number(version.penaltyPct) > 0 && assignment?.latePolicy?.mode === 'desconto'
  const link = version ? safeExternalLink(version.link) : ''
  const hasClose = assignment?.closeAt !== null && assignment?.closeAt !== undefined

  const footer = (
    <>
      {position.next && (
        <Button variant="ghost" icon={ArrowRight} className={TOUCH} disabled={busy} onClick={() => leave(() => onNavigate?.(position.next))}>Próximo aluno</Button>
      )}
      {gradable && (
        <>
          <Button variant="secondary" icon={Save} className={TOUCH} loading={busy && reasonAction === null} disabled={busy} onClick={() => submit('salvar')}>{returned ? 'Salvar alteração' : 'Salvar'}</Button>
          {!returned && <Button icon={Send} className={TOUCH} disabled={busy} onClick={() => submit('devolver')}>Devolver ao aluno</Button>}
        </>
      )}
      {!gradable && !position.next && <Button variant="secondary" className={TOUCH} onClick={onClose}>Fechar</Button>}
    </>
  )

  return (
    <>
      <Modal open={open} drawer size="lg" onClose={() => leave(onClose)} title={who.name}
        description={[who.detail, position.index >= 0 ? `Aluno ${position.index + 1} de ${position.total}` : ''].filter(Boolean).join(' · ')}
        footer={footer}>
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            {row?.newVersionAfterGrade && <Badge tone="warning">Nova versão depois da correção</Badge>}
            {row?.enrolled === false && <Badge tone="neutral">Fora da turma</Badge>}
            {deadlineWindow?.individual && <Badge tone="info">Prazo próprio</Badge>}
          </div>

          {!gradable && (
            <p className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-muted">
              {readOnly ? 'Sua conta é só de consulta: você vê a entrega, mas não corrige.'
                : assignment?.status === 'arquivada' ? 'Esta tarefa está arquivada. Reative a tarefa em Tarefas > Arquivadas para corrigir.'
                  : 'Esta tarefa ainda é um rascunho: publique para os alunos enviarem.'}
            </p>
          )}

          <section aria-label="Prazo do aluno" className="space-y-1 text-sm">
            <p className="text-text">Prazo: {schoolDateTime(deadlineWindow?.dueAt, timezone) || 'sem prazo'}{deadlineWindow?.individual ? ' (prazo próprio deste aluno)' : ''}</p>
            {deadlineWindow?.closeAt !== null && deadlineWindow?.closeAt !== undefined && <p className="text-muted">Envios encerram {schoolDateTime(deadlineWindow.closeAt, timezone)}</p>}
            {(submission?.extension || row?.extension)?.reason && <p className="text-muted">Motivo do prazo próprio: {(submission?.extension || row?.extension).reason}</p>}
          </section>

          {detail.status === 'loading' && <p className="text-sm text-muted" aria-live="polite">Carregando a entrega...</p>}
          {detail.status === 'error' && (
            <div role="alert" className="space-y-2 rounded-lg border border-danger p-3 text-sm text-danger">
              <p>{detail.error}</p>
              <Button size="sm" variant="secondary" className={TOUCH} onClick={retry}>Tentar de novo</Button>
            </div>
          )}

          {detail.status === 'ready' && (
            <section aria-label="Entrega" className="space-y-3">
              {(submission?.manualEntry || row?.manualEntry) && (
                <p className="rounded-lg border border-border p-3 text-sm text-text">
                  Entregue em mãos em {schoolDateTime((submission?.manualEntry || row?.manualEntry).at, timezone)}
                  {(submission?.manualEntry || row?.manualEntry).note ? `: ${(submission?.manualEntry || row?.manualEntry).note}` : ''}
                </p>
              )}
              {!versions.length && !(submission?.manualEntry || row?.manualEntry) && (
                <p className="text-sm text-muted">Nenhuma versão enviada pelo sistema. Sem entrega, só a nota zero ou a entrega em mãos.</p>
              )}
              {versions.length > 0 && version && (
                <>
                  {versions.length > 1 ? (
                    <div className="sm:max-w-sm">
                      <Select label="Versão" className={TOUCH} value={String(version.n)} onChange={(event) => setVersionN(Number(event.target.value))}>
                        {versions.map((item, index) => (
                          <option key={item.n} value={item.n}>{`Versão ${index + 1} de ${versions.length}${index === versions.length - 1 ? ' (a mais nova)' : ''}${savedGrade && savedGrade.versionGraded === item.n ? ' · corrigida' : ''}`}</option>
                        ))}
                      </Select>
                    </div>
                  ) : (
                    <p className="text-sm font-medium text-text">Versão 1 de 1</p>
                  )}
                  <p className="text-sm text-muted">
                    Recebida em {schoolDateTime(version.requestAt, timezone)}
                    {version.late ? ` · ${lateText(version.lateMs)}` : ' · no prazo'}
                    {version.comprovante ? ` · comprovante ${version.comprovante}` : ''}
                  </p>
                  {version.files.length > 0 && (
                    <ul className="space-y-2" aria-label="Arquivos da versão">
                      {version.files.map((file) => <li key={file.id}><FilePreview base={base} file={file} /></li>)}
                    </ul>
                  )}
                  {version.text && (
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-text">Texto do aluno</p>
                      <div className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2 p-3 text-sm text-text">{version.text}</div>
                    </div>
                  )}
                  {version.link && (
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-text">Link do aluno</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 break-all rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-text">{version.link}</span>
                        {link && (
                          <a href={link} target="_blank" rel="noopener noreferrer" className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-semibold text-text hover:bg-surface-2 ${TOUCH}`}>
                            <ExternalLink aria-hidden="true" size={16} />Abrir
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          <section aria-label="Correção" className="space-y-3 border-t border-border pt-4">
            {savedGrade && savedGrade.finalScore !== null && savedGrade.finalScore !== undefined && (
              <p className="text-sm text-text">
                {returned ? 'Devolvida' : 'Correção salva'}: nota final {fmtGrade(savedGrade.finalScore)}
                {savedGrade.penaltyPct ? ` (nota ${fmtGrade(savedGrade.score)}, desconto de ${savedGrade.penaltyPct}%)` : ''}
                {savedGrade.versionGraded ? ` · versão ${versions.findIndex((item) => item.n === savedGrade.versionGraded) + 1 || savedGrade.versionGraded}` : ''}
                {returned ? ` · em ${schoolDateTime(submission?.returnedAt ?? row?.returnedAt, timezone)}` : ' · o aluno ainda não vê'}
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr] sm:items-start">
              <Input label="Nota (0 a 10)" inputMode="decimal" autoComplete="off" value={form.gradeText} maxLength={5}
                disabled={!gradable || busy} error={errors.grade}
                helper={!delivered && gradable ? 'Sem entrega: só a nota zero. Para outra nota, registre a entrega em mãos.' : undefined}
                onChange={(event) => change({ gradeText: event.target.value })} />
              <div className="space-y-2 pt-0 text-sm sm:pt-7">
                {lateInfo && <p className={form.waive ? 'text-muted' : 'text-warning'} aria-live="polite">{lateInfo}</p>}
                {!lateInfo && read.score !== null && !read.error && <p className="text-muted" aria-live="polite">Nota final {fmtGrade(finalScorePreview(read.score, 0))}.</p>}
                {canWaive && (
                  <label className="inline-flex min-h-[44px] items-center gap-2 text-text sm:min-h-0">
                    <input type="checkbox" checked={form.waive} disabled={!gradable || busy} onChange={(event) => change({ waive: event.target.checked })} />
                    Dispensar desconto
                  </label>
                )}
              </div>
            </div>
            <Textarea label="Comentário para o aluno" value={form.comment} maxLength={CORRECTION_LIMITS.commentMax} counterFrom={Math.floor(CORRECTION_LIMITS.commentMax * 0.9)}
              disabled={!gradable || busy} error={errors.comment} onChange={(event) => change({ comment: event.target.value })} />
            <p className="text-xs text-muted">{returned ? 'O aluno já vê esta nota: mudar pede o motivo, que fica na Auditoria.' : '"Salvar" guarda sem o aluno ver; "Devolver ao aluno" mostra a nota e o comentário para ele.'}</p>
            {summary && <p role="alert" className="text-sm text-danger">{summary}</p>}
          </section>

          {gradable && (
            <section aria-label="Outras ações" className="flex flex-wrap gap-2 border-t border-border pt-4">
              {delivered && <Button size="sm" variant="secondary" icon={RotateCcw} className={TOUCH} disabled={busy} onClick={() => openDeadlineDialog('redo')}>Pedir para refazer</Button>}
              {!returned && <Button size="sm" variant="secondary" icon={CalendarClock} className={TOUCH} disabled={busy} onClick={() => openDeadlineDialog('extension')}>Prorrogar prazo</Button>}
              {!returned && <Button size="sm" variant="secondary" icon={Hand} className={TOUCH} disabled={busy} onClick={openManualDialog}>Entrega em mãos</Button>}
            </section>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={dialog === 'redo'}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => { try { await confirmRedo(reason) } catch (error) { throw new Error(hidePlaceholderEmails(error?.message) || 'Não foi possível pedir para refazer.') } }}
        title="Pedir para refazer?"
        message={`${who.name} recebe o comentário e pode mandar uma versão nova até o prazo abaixo. ${returned ? 'A nota devolvida fica escondida até a nova correção.' : 'A nota não aparece para o aluno.'}`}
        confirmLabel="Pedir para refazer"
        requireReason={returned}
        reasonLabel="Motivo (a nota já foi devolvida)"
        confirmDisabled={!form.comment.trim() || !deadline.date}
      >
        <Textarea label="O que o aluno precisa refazer (comentário)" value={form.comment} maxLength={CORRECTION_LIMITS.commentMax} onChange={(event) => change({ comment: event.target.value })} autoFocus={!returned} />
        <DeadlineFields value={deadline} onChange={setDeadline} hasClose={hasClose} prefix="Novo prazo" />
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'extension'}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => { try { await confirmExtension(reason) } catch (error) { throw new Error(hidePlaceholderEmails(error?.message) || 'Não foi possível prorrogar.') } }}
        title="Prorrogar o prazo do aluno?"
        message={`Só ${who.name} ganha este prazo; o da turma não muda.`}
        confirmLabel="Prorrogar"
        requireReason
        reasonLabel="Motivo da prorrogação"
        confirmDisabled={!deadline.date}
      >
        <DeadlineFields value={deadline} onChange={setDeadline} hasClose={hasClose} prefix="Novo prazo" autoFocus />
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'manual'}
        onClose={() => setDialog(null)}
        onConfirm={async () => { try { await confirmManual() } catch (error) { throw new Error(hidePlaceholderEmails(error?.message) || 'Não foi possível registrar a entrega em mãos.') } }}
        title="Registrar entrega em mãos?"
        message="Para o trabalho entregue fora do IClass (papel, pendrive, apresentação). Fica registrado quem lançou e quando."
        confirmLabel="Registrar"
        confirmDisabled={!!readGradeText(manual.gradeText).error}
      >
        <Textarea label="Observação (opcional)" value={manual.note} maxLength={CORRECTION_LIMITS.manualNoteMax} onChange={(event) => setManual((current) => ({ ...current, note: event.target.value }))} autoFocus className="min-h-[80px]" />
        <Input label="Nota (0 a 10, opcional)" inputMode="decimal" autoComplete="off" maxLength={5} value={manual.gradeText} error={readGradeText(manual.gradeText).error || undefined}
          onChange={(event) => setManual((current) => ({ ...current, gradeText: event.target.value }))} />
        <label className="inline-flex min-h-[44px] items-center gap-2 text-sm text-text sm:min-h-0">
          <input type="checkbox" checked={manual.returnNow} disabled={!manual.gradeText.trim() && !savedGrade} onChange={(event) => setManual((current) => ({ ...current, returnNow: event.target.checked }))} />
          Devolver ao aluno agora
        </label>
      </ConfirmDialog>

      <GradeReasonDialog
        open={reasonAction !== null}
        onClose={() => setReasonAction(null)}
        onConfirm={(reason) => sendGrade(reasonAction, reason)}
        title="Alterar a nota já devolvida?"
        note={`${studentLabel(row).title} já vê esta correção. A mudança aparece para o aluno e o motivo fica na Auditoria.`}
        confirmLabel="Salvar alteração"
        reason="required"
      />

      <ConfirmDialog
        open={!!pendingLeave}
        onClose={() => setPendingLeave(null)}
        onConfirm={() => { const action = pendingLeave?.action; setPendingLeave(null); resetFrom(savedGrade); action?.() }}
        title="Descartar a correção não salva?"
        message="A nota ou o comentário que você digitou ainda não foram salvos."
        confirmLabel="Descartar"
        tone="danger"
      />
    </>
  )
}

function DeadlineFields({ value, onChange, hasClose, prefix, autoFocus = false }) {
  const set = (patch) => onChange((current) => ({ ...current, ...patch }))
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Input type="date" label={`${prefix}: data`} value={value.date} onChange={(event) => set({ date: event.target.value })} autoFocus={autoFocus} />
        <Input type="time" label={`${prefix}: hora`} value={value.time} onChange={(event) => set({ time: event.target.value })} />
      </div>
      {hasClose && (
        <div className="grid grid-cols-2 gap-3">
          <Input type="date" label="Encerramento do aluno: data (opcional)" value={value.closeDate} onChange={(event) => set({ closeDate: event.target.value })} />
          <Input type="time" label="Encerramento: hora" value={value.closeTime} onChange={(event) => set({ closeTime: event.target.value })} />
        </div>
      )}
      <p className="text-xs text-muted">No relógio da escola. O prazo do aluno não pode ser antes do prazo da turma.</p>
    </div>
  )
}
