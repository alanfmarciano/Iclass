import { useId, useLayoutEffect, useRef } from 'react'
import QuestionMarkdown from '../../exam/QuestionMarkdown'
import { formatCharCount } from '../../../components/ui/Textarea'

// Campo de resposta de uma questão da prova, por tipo (fase 3, P3-S2: AVA-06, UXA-12;
// D5 e contrato C11 do desenho P3). A resposta que sai daqui é a que vai ao servidor:
// - uma correta: o identificador da alternativa (botões, como sempre);
// - verdadeiro ou falso: o identificador de "Verdadeiro" ou "Falso" (dois botões grandes,
//   rádio nativo);
// - várias corretas: a lista de identificadores marcados (caixas nativas, na ordem das
//   alternativas);
// - numérica: { numero } (campo de texto com teclado numérico do celular, aceita vírgula);
// - resposta curta: { texto } (uma linha);
// - dissertativa: { texto } (área de texto que cresce, com contador "1.230 de 10.000").
// onChange(undefined) apaga a resposta (lista vazia ou campo vazio): a questão volta a
// contar como em branco. O texto só com espaços fica na tela, mas conta como em branco.
// O aluno vê a letra da posição (A, B, C...) e nunca a letra original (AVA-05).

const fieldClass = 'h-11 min-w-0 w-full rounded-lg border border-border bg-surface-2 px-3.5 text-sm text-text placeholder:text-subtle focus:bg-surface disabled:cursor-not-allowed disabled:opacity-60'

function textOf(value, field) {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value[field] === 'string' ? value[field] : ''
}

function ChoiceButtons({ question, value, onChange, disabled }) {
  return question.alternatives.map((alt) => {
    const sel = value === alt.id
    return (
      <button
        key={alt.id}
        type="button"
        aria-pressed={sel}
        disabled={disabled}
        onClick={() => onChange(alt.id)}
        className={`w-full min-w-0 text-left flex items-center gap-3 p-3 max-[359px]:gap-2 max-[359px]:p-2 rounded-lg border transition disabled:cursor-not-allowed disabled:opacity-60 ${sel ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-2'}`}
      >
        <span className={`w-6 h-6 shrink-0 grid place-items-center rounded-full text-xs font-bold ${sel ? 'bg-primary text-primary-fg' : 'bg-surface-2 text-muted'}`}>{alt.label}</span>
        <QuestionMarkdown text={alt.text} links={false} zoom={false} className="min-w-0 flex-1 text-sm text-text" />
      </button>
    )
  })
}

function TrueFalse({ question, value, onChange, disabled, describedBy }) {
  return (
    <fieldset aria-describedby={describedBy}>
      <legend className="sr-only">Verdadeiro ou falso</legend>
      <div className="grid grid-cols-2 gap-2 max-[319px]:grid-cols-1">
        {question.alternatives.map((alt) => {
          const sel = value === alt.id
          return (
            <label
              key={alt.id}
              className={`flex min-h-[56px] min-w-0 cursor-pointer items-center justify-center gap-2 rounded-lg border p-3 text-base font-semibold transition ${sel ? 'border-primary bg-primary-soft text-text' : 'border-border text-text hover:bg-surface-2'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <input
                type="radio"
                name={`questao-${question.number}`}
                value={alt.id}
                checked={sel}
                disabled={disabled}
                onChange={() => onChange(alt.id)}
                className="h-5 w-5 shrink-0 accent-[var(--primary)]"
              />
              <span className="min-w-0 break-words">{String(alt.text || '')}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

function MultipleAnswer({ question, value, onChange, disabled, describedBy }) {
  const hintId = useId()
  const selected = Array.isArray(value) ? value : []
  const toggle = (id) => {
    const set = new Set(selected)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    const next = question.alternatives.map((alt) => alt.id).filter((altId) => set.has(altId))
    onChange(next.length ? next : undefined)
  }
  return (
    <fieldset aria-describedby={[hintId, describedBy].filter(Boolean).join(' ')}>
      <legend id={hintId} className="mb-2 text-xs font-medium text-muted">Marque todas as corretas.</legend>
      <div className="space-y-2">
        {question.alternatives.map((alt) => {
          const checked = selected.includes(alt.id)
          return (
            <label
              key={alt.id}
              className={`flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3 transition max-[359px]:gap-2 max-[359px]:p-2 ${checked ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-2'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => toggle(alt.id)}
                className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--primary)]"
              />
              <span className={`w-6 h-6 shrink-0 grid place-items-center rounded-full text-xs font-bold ${checked ? 'bg-primary text-primary-fg' : 'bg-surface-2 text-muted'}`} aria-hidden="true">{alt.label}</span>
              <span className="sr-only">{alt.label})</span>
              <QuestionMarkdown text={alt.text} links={false} zoom={false} className="min-w-0 flex-1 text-sm text-text" />
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

function NumericAnswer({ question, value, onChange, disabled, describedBy }) {
  const id = useId()
  const hintId = useId()
  const text = textOf(value, 'numero')
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted">Sua resposta (número)</label>
      <div className="flex min-w-0 items-center gap-2">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={question.maxLength || undefined}
          value={text}
          disabled={disabled}
          aria-describedby={[hintId, describedBy].filter(Boolean).join(' ')}
          onChange={(event) => onChange(event.target.value === '' ? undefined : { numero: event.target.value })}
          className={`${fieldClass} max-w-[14rem] font-mono tabular-nums`}
        />
        {question.unit && <span className="shrink-0 text-sm text-text">{question.unit}</span>}
      </div>
      <p id={hintId} className="text-xs text-subtle">Use vírgula ou ponto para as casas decimais.</p>
    </div>
  )
}

function ShortAnswer({ question, value, onChange, disabled, describedBy }) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted">Sua resposta</label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={question.maxLength || undefined}
        value={textOf(value, 'texto')}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value === '' ? undefined : { texto: event.target.value })}
        className={fieldClass}
      />
    </div>
  )
}

function EssayAnswer({ question, value, onChange, disabled, describedBy }) {
  const id = useId()
  const counterId = useId()
  const ref = useRef(null)
  const text = textOf(value, 'texto')
  const max = question.maxLength || 10000
  // A área começa com 6 linhas e cresce com o texto (até 70% da tela; daí em diante rola).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    if (el.scrollHeight > el.clientHeight) el.style.height = `${el.scrollHeight + 2}px`
  }, [text])
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted">Sua resposta</label>
      <textarea
        id={id}
        ref={ref}
        rows={6}
        maxLength={max}
        value={text}
        disabled={disabled}
        aria-describedby={[counterId, describedBy].filter(Boolean).join(' ')}
        onChange={(event) => onChange(event.target.value === '' ? undefined : { texto: event.target.value })}
        className="block w-full min-w-0 max-h-[70vh] resize-y overflow-y-auto rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm leading-relaxed text-text focus:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
      />
      <p id={counterId} className={`text-right text-xs ${text.length >= max ? 'text-warning' : 'text-subtle'}`}>
        {formatCharCount(text.length)} de {formatCharCount(max)}
      </p>
    </div>
  )
}

export default function QuestionAnswer({ question, value, onChange, disabled = false, describedBy }) {
  const props = { question, value, onChange, disabled, describedBy }
  if (question.type === 'true_false') return <TrueFalse {...props} />
  if (question.type === 'multiple_answer') return <MultipleAnswer {...props} />
  if (question.type === 'numeric') return <NumericAnswer {...props} />
  if (question.type === 'short_answer') return <ShortAnswer {...props} />
  if (question.type === 'essay') return <EssayAnswer {...props} />
  return <ChoiceButtons {...props} />
}
