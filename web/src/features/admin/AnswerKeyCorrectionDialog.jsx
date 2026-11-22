import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Eye } from 'lucide-react'
import { Modal } from '../../components/ui/Modal'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { Input } from '../../components/ui/Input'
import { Textarea } from '../../components/ui/Textarea'
import { api } from '../../lib/api'
import { fmtGrade } from '../../lib/grades'

// Corrigir o gabarito depois da prova (fase 3, P3-S6: AVA-X2; D14 do desenho P3). O
// professor escolhe a questão, a resposta certa nova e o motivo; "Ver impacto" pede a
// prévia ao servidor ("Muda a nota de 7 alunos (3 já publicadas: eles serão avisados)") e
// só depois dela o botão "Corrigir gabarito" grava. Mudar qualquer campo pede a prévia de
// novo. Só o gabarito muda: o texto e a ordem da prova ficam como os alunos viram. A
// letra é a ORIGINAL da questão (a da avaliação), não a da versão embaralhada.

export const MOTIVO_MIN = 5
export const MOTIVO_MAX = 500

const TYPE_LABELS = {
  multiple_choice: 'Uma correta',
  multiple_answer: 'Várias corretas',
  true_false: 'Verdadeiro ou falso',
  numeric: 'Numérica',
  short_answer: 'Resposta curta',
  essay: 'Dissertativa',
}
const KNOWN_TYPES = Object.keys(TYPE_LABELS)
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function questionTypeOf(question) {
  const type = typeof question?.type === 'string' ? question.type.trim() : ''
  return KNOWN_TYPES.includes(type) ? type : 'multiple_choice'
}

function questionNumberOf(question, index) {
  return Number(question?.originalNumber || question?.number || index + 1)
}

function originalLetter(alternative, index) {
  return String(alternative?.letter || LETTERS[index] || '').trim().toUpperCase()
}

function shortText(text, max = 70) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function numberText(value) {
  return Number.isFinite(Number(value)) && value !== '' && value !== null ? String(Number(value)).replace('.', ',') : ''
}

// Questões da aplicação que o professor pode corrigir: as da primeira versão, pela ordem
// da prova original, com as alternativas pela letra original. A dissertativa e a questão
// trocada no Monitor ficam de fora.
export function correctableQuestions(application) {
  const snapshots = Array.isArray(application?.versionSnapshots) ? application.versionSnapshots : []
  const questions = Array.isArray(snapshots[0]?.questions) ? snapshots[0].questions : []
  const replaced = new Set(snapshots.flatMap((snapshot) => (snapshot?.questions || [])
    .filter((question) => question?.isAdditional && Number(question.replacedQuestionNumber) > 0)
    .map((question) => Number(question.replacedQuestionNumber))))
  const annulled = new Map((application?.annulledQuestions || []).map((entry) => [Number(entry.questionNumber), entry]))
  return questions
    .map((question, index) => {
      const number = questionNumberOf(question, index)
      const alternatives = (Array.isArray(question?.alternatives) ? question.alternatives : [])
        .map((alternative, position) => ({ letter: originalLetter(alternative, position), text: String(alternative?.text || ''), isCorrect: alternative?.isCorrect === true }))
        .sort((a, b) => a.letter.localeCompare(b.letter, 'pt-BR'))
      return { number, type: questionTypeOf(question), text: String(question?.text || question?.questionText || ''), alternatives, question, annulment: annulled.get(number) || null }
    })
    .filter((item) => item.type !== 'essay' && !replaced.has(item.number))
    .sort((a, b) => a.number - b.number)
}

// Gabarito atual da questão, no formato dos campos do diálogo.
export function currentKeyDraft(item) {
  const question = item?.question || {}
  const marked = (item?.alternatives || []).filter((alternative) => alternative.isCorrect).map((alternative) => alternative.letter)
  if (item?.type === 'multiple_answer') {
    const fromList = Array.isArray(question.correctAnswers) ? question.correctAnswers.map((letter) => String(letter).toUpperCase()) : []
    return { letters: marked.length ? marked : fromList }
  }
  if (item?.type === 'numeric') return { value: numberText(question.numeric?.value), tolerance: numberText(question.numeric?.tolerance ?? 0) }
  if (item?.type === 'short_answer') return { accepted: (question.acceptedAnswers || []).join('\n') }
  const letter = String(question.correctAnswer || marked[0] || '').toUpperCase()
  return { letter }
}

// Corpo do pedido com o gabarito do tipo da questão.
export function answerKeyPayload(item, draft) {
  if (item.type === 'multiple_answer') return { correctAnswers: [...(draft.letters || [])].sort() }
  if (item.type === 'numeric') return { numeric: { value: String(draft.value || '').trim(), tolerance: String(draft.tolerance || '').trim() || '0' } }
  if (item.type === 'short_answer') return { acceptedAnswers: String(draft.accepted || '').split('\n').map((line) => line.trim()).filter(Boolean) }
  return { correctAnswer: draft.letter || '' }
}

// "Muda a nota de 7 alunos (3 já publicadas: eles serão avisados)."
export function impactSummary(preview) {
  if (!preview) return ''
  if (preview.unchanged) return preview.message || 'O gabarito já é este: nenhuma nota muda.'
  const changed = Number(preview.changed) || 0
  const published = Number(preview.published) || 0
  if (changed === 0) return 'Nenhuma nota muda com o gabarito novo.'
  const who = changed === 1 ? 'Muda a nota de 1 aluno' : `Muda a nota de ${changed} alunos`
  if (published === 0) return `${who} (nenhuma publicada ainda).`
  if (published === 1) return `${who} (1 já publicada: o aluno será avisado).`
  return `${who} (${published} já publicadas: eles serão avisados).`
}

export function AnswerKeyCorrectionDialog({ open, application, onClose, onCorrected }) {
  const questions = useMemo(() => correctableQuestions(application), [application])
  const [number, setNumber] = useState('')
  const [draft, setDraft] = useState({})
  const [motivo, setMotivo] = useState('')
  const [removeAnnulment, setRemoveAnnulment] = useState(false)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const item = questions.find((entry) => String(entry.number) === String(number)) || null

  useEffect(() => {
    if (!open) return
    const first = questions[0] || null
    setNumber(first ? String(first.number) : '')
    setDraft(first ? currentKeyDraft(first) : {})
    setMotivo('')
    setRemoveAnnulment(false)
    setPreview(null)
    setError('')
    setBusy('')
  }, [open, application?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function changed(next) {
    setPreview(null)
    setError('')
    next()
  }

  function chooseQuestion(value) {
    changed(() => {
      setNumber(value)
      const next = questions.find((entry) => String(entry.number) === String(value))
      setDraft(next ? currentKeyDraft(next) : {})
      setRemoveAnnulment(false)
    })
  }

  const trimmedMotivo = motivo.trim()
  const missing = !item
    ? 'Escolha a questão.'
    : (item.annulment && !removeAnnulment)
      ? 'Esta questão está anulada: marque "Tirar a anulação" para corrigir pelo gabarito.'
      : trimmedMotivo.length < MOTIVO_MIN
        ? `Escreva o motivo (pelo menos ${MOTIVO_MIN} caracteres).`
        : ''

  function payload(dryRun) {
    return {
      questionNumber: item.number,
      ...answerKeyPayload(item, draft),
      motivo: trimmedMotivo,
      ...(item.annulment ? { tirarAnulacao: removeAnnulment } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    }
  }

  async function send(dryRun) {
    if (!item || missing || busy) return
    setBusy(dryRun ? 'preview' : 'save')
    setError('')
    try {
      const response = await api.post(`/api/admin/exam-applications/${encodeURIComponent(application.id)}/answer-key-correction`, payload(dryRun))
      if (dryRun) setPreview(response)
      else onCorrected?.(response)
    } catch (err) {
      setError(err?.message || 'Não foi possível corrigir o gabarito. Tente de novo.')
    } finally {
      setBusy('')
    }
  }

  const close = () => { if (!busy) onClose?.() }
  const canSave = !!preview && !preview.unchanged && !missing
  const toggleLetter = (letter) => changed(() => setDraft((current) => {
    const letters = new Set(current.letters || [])
    if (letters.has(letter)) letters.delete(letter)
    else letters.add(letter)
    return { ...current, letters: [...letters].sort() }
  }))

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title="Corrigir gabarito"
      description="Muda só a resposta certa desta aplicação: o texto e a ordem da prova ficam como os alunos viram, e as notas são recalculadas."
      footer={<>
        <Button variant="ghost" onClick={close} disabled={!!busy}>Cancelar</Button>
        <Button variant="secondary" icon={Eye} onClick={() => send(true)} loading={busy === 'preview'} disabled={!!missing || (!!busy && busy !== 'preview')}>Ver impacto</Button>
        <Button icon={CheckCircle2} onClick={() => send(false)} loading={busy === 'save'} disabled={!canSave || (!!busy && busy !== 'save')}>Corrigir gabarito</Button>
      </>}
    >
      {questions.length === 0 ? (
        <p className="text-sm text-muted">Esta aplicação não tem questão com resposta certa automática para corrigir (a dissertativa é corrigida pelo professor).</p>
      ) : (
        <div className="space-y-4">
          <Select label="Questão" value={number} onChange={(event) => chooseQuestion(event.target.value)} disabled={!!busy}>
            {questions.map((entry) => (
              <option key={entry.number} value={entry.number}>
                {`Questão ${entry.number} · ${TYPE_LABELS[entry.type]}${entry.annulment ? ' · anulada' : ''} · ${shortText(entry.text, 60)}`}
              </option>
            ))}
          </Select>

          {item && (
            <div className="rounded-lg border border-border bg-surface-2 p-3 space-y-3">
              <p className="text-sm text-text whitespace-pre-line break-words">{shortText(item.text, 400)}</p>
              {(item.type === 'multiple_choice' || item.type === 'true_false') && (
                <fieldset className="space-y-2">
                  <legend className="text-[13px] font-medium text-muted mb-1">Resposta certa</legend>
                  {item.alternatives.map((alternative) => (
                    <label key={alternative.letter} className="flex min-h-[44px] items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm cursor-pointer">
                      <input type="radio" name="answer-key-letter" className="h-5 w-5 shrink-0" checked={draft.letter === alternative.letter} disabled={!!busy}
                        onChange={() => changed(() => setDraft({ letter: alternative.letter }))} />
                      <span className="font-bold text-text shrink-0">{item.type === 'true_false' ? '' : `${alternative.letter})`}</span>
                      <span className="min-w-0 break-words text-text">{alternative.text}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              {item.type === 'multiple_answer' && (
                <fieldset className="space-y-2">
                  <legend className="text-[13px] font-medium text-muted mb-1">Respostas certas (marque todas)</legend>
                  {item.alternatives.map((alternative) => (
                    <label key={alternative.letter} className="flex min-h-[44px] items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm cursor-pointer">
                      <input type="checkbox" className="h-5 w-5 shrink-0" checked={(draft.letters || []).includes(alternative.letter)} disabled={!!busy}
                        onChange={() => toggleLetter(alternative.letter)} />
                      <span className="font-bold text-text shrink-0">{alternative.letter})</span>
                      <span className="min-w-0 break-words text-text">{alternative.text}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              {item.type === 'numeric' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input label={`Resposta certa${item.question?.numeric?.unit ? ` (${item.question.numeric.unit})` : ''}`} inputMode="decimal" value={draft.value || ''} disabled={!!busy}
                    onChange={(event) => { const value = event.target.value; changed(() => setDraft((current) => ({ ...current, value }))) }} />
                  <Input label="Tolerância" inputMode="decimal" value={draft.tolerance || ''} disabled={!!busy}
                    onChange={(event) => { const tolerance = event.target.value; changed(() => setDraft((current) => ({ ...current, tolerance }))) }} />
                </div>
              )}
              {item.type === 'short_answer' && (
                <Textarea label="Respostas aceitas (uma por linha)" value={draft.accepted || ''} disabled={!!busy} className="min-h-[96px]"
                  onChange={(event) => { const accepted = event.target.value; changed(() => setDraft({ accepted })) }} />
              )}
              {item.annulment && (
                <label className="flex min-h-[44px] items-start gap-3 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-sm cursor-pointer">
                  <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={removeAnnulment} disabled={!!busy}
                    onChange={(event) => { const checked = event.target.checked; changed(() => setRemoveAnnulment(checked)) }} />
                  <span className="text-text">
                    Tirar a anulação desta questão ({item.annulment.mode === 'ponto_para_todos' ? 'ponto para todos' : 'removida do total'}) e corrigir pelo gabarito novo.
                  </span>
                </label>
              )}
            </div>
          )}

          <Textarea label="Motivo (fica no histórico da nota e na Auditoria)" value={motivo} maxLength={MOTIVO_MAX} counterFrom={Math.floor(MOTIVO_MAX * 0.9)}
            placeholder="Ex.: a máscara /24 é 255.255.255.0; o gabarito estava com a letra C." disabled={!!busy} className="min-h-[80px]"
            onChange={(event) => { const value = event.target.value; changed(() => setMotivo(value)) }} />

          <p className="text-xs text-muted">A avaliação no editor não muda: corrija lá também para as próximas aplicações.</p>

          {preview && (
            <div role="status" className={`rounded-lg border p-3 text-sm ${preview.unchanged || !preview.changed ? 'border-border bg-surface-2' : 'border-warning bg-warning-soft'}`}>
              <p className="font-semibold text-text flex items-start gap-2">
                {!preview.unchanged && preview.changed ? <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" /> : null}
                <span>{impactSummary(preview)}</span>
              </p>
              {!preview.unchanged && preview.question && (
                <p className="mt-1 text-muted break-words">Resposta certa: {preview.question.antes || '—'} → {preview.question.depois || '—'}</p>
              )}
              {(preview.students || []).length > 0 && (
                <ul className="mt-2 max-h-48 overflow-y-auto divide-y divide-border">
                  {preview.students.map((student) => (
                    <li key={student.submissionId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <span className="min-w-0 break-words text-text">{student.name}</span>
                      <span className="font-mono text-text">
                        {fmtGrade(student.from)} → {fmtGrade(student.to)}
                        {student.published && <span className="ml-2 font-sans text-xs text-muted">publicada</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          {!error && item && missing && <p className="text-xs text-muted">{missing}</p>}
        </div>
      )}
    </Modal>
  )
}

export default AnswerKeyCorrectionDialog
