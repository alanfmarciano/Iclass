import { useId, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Bold, Code2, Copy, Eye, ImagePlus, Library, Pencil, Plus, Table2, Trash2 } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Switch } from '../../components/ui/Switch'
import { useToast } from '../../context/ToastProvider'
import { api } from '../../lib/api'
import QuestionMarkdown from '../exam/QuestionMarkdown'
import QuestionAnswer from '../student/exam/QuestionAnswer'
import {
  DIFFICULTY_OPTIONS,
  EDITOR_LIMITS,
  QUESTION_TYPE_OPTIONS,
  answerSummary,
  duplicateEditorQuestion,
  editorPointsValue,
  editorQuestion,
  formatDecimal,
  formatPointsLabel,
  isChoiceType,
  linkedBankKey,
  questionProblems,
  questionTypeLabel,
  rubricTotal,
  totalPoints,
} from './questionEditorModel'

// Editor das questões da prova (fase 3, P3-S3: AVA-06, FUN-10, UXA-12; desenho P3,
// telas.professor "editor da avaliação"). Extraído da tela Provas (ProvasPage.jsx), que
// guarda o título, o tema e as instruções; aqui ficam as questões:
// - seletor de tipo com uma frase de exemplo (Uma correta, Várias corretas, Verdadeiro ou
//   falso, Numérica, Resposta curta e Dissertativa) e os pontos (aceita vírgula);
// - enunciado em Markdown com barra simples (negrito, código, tabela e imagem enviada pelo
//   /api/admin/upload-image) e prévia como o aluno vê (QuestionMarkdown e o mesmo campo
//   de resposta da prova); no celular, abas Editar e Prévia;
// - alternativas com a marca de correta (rádio em Uma correta, caixa em Várias corretas,
//   com pontuação parcial ou tudo ou nada); Verdadeiro ou falso com as duas respostas;
//   numérica com valor, tolerância e unidade; resposta curta com as respostas aceitas;
//   nas duas, "mandar para mim quando não bater"; dissertativa com resposta esperada e
//   rubrica (critérios e pontos, com a soma conferida);
// - explicação (o aluno vê com o gabarito liberado) e, em "Mais detalhes", dificuldade,
//   habilidades e etiquetas;
// - total de pontos da prova no topo; excluir uma questão preenchida pede confirmação
//   (ConfirmDialog, contrato C12 do P3).
// Trocar o tipo não apaga o que já foi escrito (questionEditorModel.js).
// "Salvar no banco" vale para os seis tipos desde o banco no modelo único (P3-S9a); a
// questão que já está no banco (bankKey) mostra "Do banco" e não é salva de novo; mudar o
// enunciado ou o gabarito dela no editor a desliga do banco (linkedBankKey). O cartão
// (QuestionCard) também é o editor de um item do banco (QuestionBankPanel.jsx): sem
// onMove, onDuplicate, onRemove e onSaveToBank, os botões deles não aparecem.

const fieldClass = 'w-full min-w-0 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text'
const IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp'
// Botão de ícone de uma linha (excluir alternativa, resposta aceita ou critério): 44 px no
// toque, como pede o desenho para a tela a 375 px.
const ROW_ICON_BUTTON = '!h-11 !w-11 shrink-0 !px-0'

function selectionOf(element, value) {
  const start = Number.isInteger(element?.selectionStart) ? element.selectionStart : value.length
  const end = Number.isInteger(element?.selectionEnd) ? element.selectionEnd : start
  return { start, end, selected: value.slice(start, end) }
}

// Texto alternativo da imagem a partir do nome do arquivo (sem extensão nem colchetes).
function altFromFileName(name) {
  return String(name || 'imagem').replace(/\.[a-z0-9]+$/i, '').replace(/[[\]()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'imagem'
}

// Campo de Markdown com a barra simples. onChange recebe o texto inteiro.
export function MarkdownField({ label, value, onChange, rows = 4, maxLength, placeholder, allowImage = true, hint }) {
  const toast = useToast()
  const id = useId()
  const hintId = useId()
  const ref = useRef(null)
  const fileRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const text = String(value ?? '')

  function replaceSelection(build) {
    const element = ref.current
    const { start, end, selected } = selectionOf(element, text)
    const { insert, cursorStart, cursorEnd } = build(selected)
    const next = `${text.slice(0, start)}${insert}${text.slice(end)}`
    onChange(next)
    const restore = () => {
      if (!element) return
      element.focus()
      try { element.setSelectionRange(start + cursorStart, start + cursorEnd) } catch {}
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore)
    else setTimeout(restore, 0)
  }

  function bold() {
    replaceSelection((selected) => {
      const inner = selected || 'texto'
      return { insert: `**${inner}**`, cursorStart: 2, cursorEnd: 2 + inner.length }
    })
  }

  function code() {
    replaceSelection((selected) => {
      if (selected && !selected.includes('\n')) return { insert: `\`${selected}\``, cursorStart: 1, cursorEnd: 1 + selected.length }
      const inner = selected || 'código'
      const before = text && !text.endsWith('\n') && ref.current?.selectionStart > 0 ? '\n' : ''
      return { insert: `${before}\`\`\`\n${inner}\n\`\`\`\n`, cursorStart: before.length + 4, cursorEnd: before.length + 4 + inner.length }
    })
  }

  function table() {
    replaceSelection(() => {
      const template = '\n| Coluna 1 | Coluna 2 |\n| --- | --- |\n| valor | valor |\n'
      return { insert: template, cursorStart: 3, cursorEnd: 11 }
    })
  }

  async function uploadImage(file) {
    if (!file) return
    const form = new FormData()
    form.append('image', file)
    setUploading(true)
    try {
      const data = await api.post('/api/admin/upload-image', form)
      // No Markdown vai o endereço limpo (/uploads/<nome>): a sessão só entra na imagem
      // exibida (QuestionMarkdown), nunca no texto salvo.
      const markdown = `![${altFromFileName(file.name)}](${data.url})`
      replaceSelection(() => ({ insert: `\n${markdown}\n`, cursorStart: 1, cursorEnd: 1 + markdown.length }))
      toast.success('Imagem inserida')
    } catch (error) {
      toast.error(error.message)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-text">{label}</label>
        <div className="flex flex-wrap gap-1" role="toolbar" aria-label={`Formatação: ${label}`}>
          <Button type="button" size="sm" variant="ghost" icon={Bold} onClick={bold} aria-label={`Negrito em ${label}`} title="Negrito">
            <span className="hidden sm:inline">Negrito</span>
          </Button>
          <Button type="button" size="sm" variant="ghost" icon={Code2} onClick={code} aria-label={`Código em ${label}`} title="Código">
            <span className="hidden sm:inline">Código</span>
          </Button>
          <Button type="button" size="sm" variant="ghost" icon={Table2} onClick={table} aria-label={`Tabela em ${label}`} title="Tabela">
            <span className="hidden sm:inline">Tabela</span>
          </Button>
          {allowImage && (
            <>
              <Button type="button" size="sm" variant="ghost" icon={ImagePlus} loading={uploading} onClick={() => fileRef.current?.click()} aria-label={`Imagem em ${label}`} title="Imagem (JPG, PNG, GIF ou WebP)">
                <span className="hidden sm:inline">Imagem</span>
              </Button>
              <input ref={fileRef} type="file" accept={IMAGE_TYPES} className="hidden" aria-label={`Enviar imagem para ${label}`} data-testid="question-image-input" onChange={(event) => uploadImage(event.target.files?.[0])} />
            </>
          )}
        </div>
      </div>
      <textarea
        id={id}
        ref={ref}
        value={text}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`${fieldClass} font-mono leading-relaxed`}
      />
      {hint && <p id={hintId} className="text-xs text-subtle">{hint}</p>}
    </div>
  )
}

// Questão como o aluno vê na prova: enunciado, campo de resposta (pode testar; nada é
// enviado) e, abaixo, o gabarito e a explicação.
export function QuestionPreview({ question, number }) {
  const [answer, setAnswer] = useState(undefined)
  const type = question.type
  const alternatives = type === 'true_false'
    ? [{ id: 'A', label: 'A', text: 'Verdadeiro' }, { id: 'B', label: 'B', text: 'Falso' }]
    : (isChoiceType(type) ? question.alternatives.map((alternative) => ({ id: alternative.letter, label: alternative.letter, text: alternative.text || `Alternativa ${alternative.letter}` })) : [])
  const points = editorPointsValue(question)
  const previewQuestion = {
    number,
    type,
    alternatives,
    unit: type === 'numeric' ? String(question.numeric?.unit || '').trim() : '',
    maxLength: type === 'numeric' ? 32 : type === 'short_answer' ? 300 : type === 'essay' ? 10000 : null,
  }
  const summary = answerSummary(question)
  return (
    <div className="min-w-0 space-y-3 rounded-lg border border-border bg-surface-2/40 p-3" aria-label={`Prévia da questão ${number}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="font-semibold text-text">Questão {number}</span>
        <span>{Number.isFinite(points) ? formatPointsLabel(points) : 'pontos inválidos'}</span>
      </div>
      {String(question.text || '').trim()
        ? <QuestionMarkdown text={question.text} links={false} className="text-sm font-medium text-text" />
        : <p className="text-sm italic text-subtle">O enunciado aparece aqui.</p>}
      <QuestionAnswer question={previewQuestion} value={answer} onChange={setAnswer} />
      <div className="space-y-1 border-t border-border pt-2 text-xs text-muted">
        <p><b className="text-text">Resposta certa:</b> {summary || '—'}</p>
        {type === 'essay' && String(question.expectedAnswer || '').trim() && (
          <p className="whitespace-pre-wrap"><b className="text-text">Resposta esperada (só você vê):</b> {question.expectedAnswer}</p>
        )}
        {String(question.explanation || '').trim() && (
          <div>
            <b className="text-text">Explicação (o aluno vê com o gabarito liberado):</b>
            <QuestionMarkdown text={question.explanation} links={false} className="mt-1 text-xs text-text" />
          </div>
        )}
      </div>
    </div>
  )
}

function ChoiceAlternatives({ question, index, update }) {
  const multiple = question.type === 'multiple_answer'
  const alternatives = question.alternatives
  function setAlternatives(next) {
    update({ alternatives: next.map((alternative, position) => ({ ...alternative, letter: String.fromCharCode(65 + position) })) })
  }
  function mark(position, checked) {
    setAlternatives(alternatives.map((alternative, altIndex) => {
      if (multiple) return altIndex === position ? { ...alternative, isCorrect: checked } : alternative
      return { ...alternative, isCorrect: altIndex === position }
    }))
  }
  function remove(position) {
    if (alternatives.length <= EDITOR_LIMITS.minAlternatives) return
    const removedWasCorrect = alternatives[position]?.isCorrect
    const next = alternatives.filter((_, altIndex) => altIndex !== position)
    if (!multiple && removedWasCorrect && next.length) next[0] = { ...next[0], isCorrect: true }
    setAlternatives(next)
  }
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="mb-1 text-sm font-medium text-text">
        Alternativas <span className="text-xs font-normal text-muted">({multiple ? 'marque todas as corretas' : 'marque a correta'})</span>
      </legend>
      {alternatives.map((alternative, position) => (
        <div key={position} className={`flex min-w-0 items-start gap-2 rounded-lg border p-2 ${alternative.isCorrect ? 'border-success/60 bg-success-soft/30' : 'border-border'}`}>
          {/* Alvo de 44 px (desenho P3, celular_375): o rótulo inteiro, com a letra, marca a correta. */}
          <label className="flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 hover:bg-surface-2" data-testid="alternative-mark">
            <input
              type={multiple ? 'checkbox' : 'radio'}
              name={`correta-${question.uid}`}
              checked={alternative.isCorrect}
              onChange={(event) => mark(position, multiple ? event.target.checked : true)}
              aria-label={`Marcar alternativa ${alternative.letter} como correta`}
              className="h-5 w-5 shrink-0 cursor-pointer accent-[var(--success)]"
            />
            <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-bold text-muted">{alternative.letter}</span>
          </label>
          <textarea
            value={alternative.text}
            rows={1}
            maxLength={EDITOR_LIMITS.alternative}
            onChange={(event) => setAlternatives(alternatives.map((item, altIndex) => (altIndex === position ? { ...item, text: event.target.value } : item)))}
            className={`${fieldClass} min-h-[44px] resize-y`}
            placeholder={`Alternativa ${alternative.letter}`}
            aria-label={`Texto da alternativa ${alternative.letter} da questão ${index + 1}`}
          />
          <Button type="button" size="sm" variant="ghost" icon={Trash2} className={ROW_ICON_BUTTON} aria-label={`Excluir alternativa ${alternative.letter}`} disabled={alternatives.length <= EDITOR_LIMITS.minAlternatives} onClick={() => remove(position)} />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" variant="secondary" icon={Plus} disabled={alternatives.length >= EDITOR_LIMITS.maxAlternatives} onClick={() => setAlternatives([...alternatives, { letter: '', text: '', isCorrect: false }])}>
          Adicionar alternativa
        </Button>
        <span className="text-xs text-subtle">De 2 a 8 alternativas.</span>
      </div>
      {multiple && (
        <div className="space-y-1 rounded-md bg-surface-2/50 p-2">
          <Switch label="Pontuação parcial" checked={question.partialCredit !== false} onChange={(value) => update({ partialCredit: value })} />
          <p className="text-xs text-muted">
            {question.partialCredit !== false
              ? 'Cada correta marcada vale uma parte dos pontos e cada errada marcada desconta uma parte; a questão nunca fica negativa.'
              : 'Tudo ou nada: o aluno só ganha os pontos se marcar exatamente as corretas.'}
          </p>
        </div>
      )}
    </fieldset>
  )
}

function ReviewSwitch({ question, update }) {
  return (
    <div className="space-y-1">
      <Switch label="Mandar para mim quando a resposta não bater" checked={question.review === 'professor'} onChange={(value) => update({ review: value ? 'professor' : 'auto' })} />
      <p className="text-xs text-muted">
        {question.review === 'professor'
          ? 'A resposta que não bater fica para você corrigir, e a nota sai depois da sua correção.'
          : 'A resposta que não bater vale zero na hora.'}
      </p>
    </div>
  )
}

function TypeFields({ question, index, update }) {
  if (question.type === 'multiple_choice' || question.type === 'multiple_answer') {
    return <ChoiceAlternatives question={question} index={index} update={update} />
  }
  if (question.type === 'true_false') {
    return (
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-text">A afirmação é</legend>
        <div className="grid grid-cols-2 gap-2">
          {[['A', 'Verdadeiro'], ['B', 'Falso']].map(([letter, label]) => (
            <label key={letter} className={`flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-lg border p-2 text-sm font-semibold ${question.trueFalse === letter ? 'border-success/60 bg-success-soft/30 text-text' : 'border-border text-text'}`}>
              <input type="radio" name={`vf-${question.uid}`} checked={question.trueFalse === letter} onChange={() => update({ trueFalse: letter })} aria-label={`Resposta certa: ${label}`} className="h-5 w-5 accent-[var(--success)]" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
    )
  }
  if (question.type === 'numeric') {
    const numeric = question.numeric
    const set = (patch) => update({ numeric: { ...numeric, ...patch } })
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input label="Resposta certa" inputMode="decimal" value={numeric.value} onChange={(event) => set({ value: event.target.value })} placeholder="Ex.: 3,5" helper="Aceita vírgula." />
          <Input label="Tolerância (±)" inputMode="decimal" value={numeric.tolerance} onChange={(event) => set({ tolerance: event.target.value })} placeholder="0" helper="Vazio = só o valor exato." />
          <Input label="Unidade (opcional)" value={numeric.unit} maxLength={EDITOR_LIMITS.unit} onChange={(event) => set({ unit: event.target.value })} placeholder="Ex.: ms" helper="Aparece ao lado do campo do aluno." />
        </div>
        <ReviewSwitch question={question} update={update} />
      </div>
    )
  }
  if (question.type === 'short_answer') {
    const accepted = question.acceptedAnswers
    const setAccepted = (next) => update({ acceptedAnswers: next.length ? next : [''] })
    return (
      <div className="space-y-3">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-text">Respostas aceitas <span className="text-xs font-normal text-muted">(sem diferença de maiúsculas, acentos e espaços a mais)</span></legend>
          {accepted.map((item, position) => (
            <div key={position} className="flex min-w-0 items-center gap-2">
              <input
                value={item}
                maxLength={EDITOR_LIMITS.acceptedAnswer}
                onChange={(event) => setAccepted(accepted.map((value, itemIndex) => (itemIndex === position ? event.target.value : value)))}
                className={`${fieldClass} h-11`}
                placeholder={position === 0 ? 'Ex.: ls' : 'Outra forma aceita'}
                aria-label={`Resposta aceita ${position + 1} da questão ${index + 1}`}
              />
              <Button type="button" size="sm" variant="ghost" icon={Trash2} className={ROW_ICON_BUTTON} aria-label={`Excluir resposta aceita ${position + 1}`} disabled={accepted.length <= 1} onClick={() => setAccepted(accepted.filter((_, itemIndex) => itemIndex !== position))} />
            </div>
          ))}
          <Button type="button" size="sm" variant="secondary" icon={Plus} disabled={accepted.length >= EDITOR_LIMITS.acceptedAnswers} onClick={() => setAccepted([...accepted, ''])}>Adicionar resposta aceita</Button>
        </fieldset>
        <ReviewSwitch question={question} update={update} />
      </div>
    )
  }
  // Dissertativa.
  const rubric = question.rubric
  const setRubric = (next) => update({ rubric: next })
  const points = editorPointsValue(question)
  const sum = rubricTotal(question)
  const filled = rubric.some((criterion) => String(criterion.nome || '').trim() || String(criterion.pontos || '').trim())
  const matches = Number.isFinite(points) && Math.abs(sum - points) <= 0.005
  return (
    <div className="space-y-3">
      <label className="block text-sm text-text">
        <span className="mb-1 block font-medium">Resposta esperada <span className="text-xs font-normal text-muted">(só você vê, na correção)</span></span>
        <textarea value={question.expectedAnswer} rows={3} maxLength={EDITOR_LIMITS.expectedAnswer} onChange={(event) => update({ expectedAnswer: event.target.value })} className={fieldClass} placeholder="O que uma boa resposta deve trazer." />
      </label>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-text">Rubrica <span className="text-xs font-normal text-muted">(opcional; a soma dos critérios é a pontuação da questão)</span></legend>
        {rubric.map((criterion, position) => (
          <div key={criterion.id || `novo-${position}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_6rem_auto] items-center gap-2">
            <input
              value={criterion.nome}
              maxLength={EDITOR_LIMITS.rubricName}
              onChange={(event) => setRubric(rubric.map((item, itemIndex) => (itemIndex === position ? { ...item, nome: event.target.value } : item)))}
              className={`${fieldClass} h-11`}
              placeholder="Ex.: Explica o conceito"
              aria-label={`Critério ${position + 1} da rubrica da questão ${index + 1}`}
            />
            <input
              value={criterion.pontos}
              inputMode="decimal"
              onChange={(event) => setRubric(rubric.map((item, itemIndex) => (itemIndex === position ? { ...item, pontos: event.target.value } : item)))}
              className={`${fieldClass} h-11`}
              placeholder="Pontos"
              aria-label={`Pontos do critério ${position + 1} da questão ${index + 1}`}
            />
            <Button type="button" size="sm" variant="ghost" icon={Trash2} className={ROW_ICON_BUTTON} aria-label={`Excluir critério ${position + 1}`} onClick={() => setRubric(rubric.filter((_, itemIndex) => itemIndex !== position))} />
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="secondary" icon={Plus} disabled={rubric.length >= EDITOR_LIMITS.rubricCriteria} onClick={() => setRubric([...rubric, { id: '', nome: '', pontos: '' }])}>Adicionar critério</Button>
          {filled && (
            <span role="status" className={`text-xs ${matches ? 'text-success' : 'text-warning'}`}>
              Soma dos critérios: {formatDecimal(sum)} de {Number.isFinite(points) ? formatDecimal(points) : '—'} {matches ? '(confere)' : '(precisa ser igual aos pontos)'}
            </span>
          )}
          {filled && !matches && sum > 0 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => update({ points: formatDecimal(sum) })}>Usar {formatDecimal(sum)} como pontos</Button>
          )}
        </div>
      </fieldset>
    </div>
  )
}

export function QuestionCard({ question, index, count = 1, onChange, onMove, onDuplicate, onRemove, onSaveToBank, showProblems, label }) {
  const [tab, setTab] = useState('editar')
  const [details, setDetails] = useState(() => !!(question.difficulty || question.skills || question.tags))
  const typeSelectId = useId()
  const typeHintId = useId()
  const update = (patch) => onChange({ ...question, ...patch })
  // Várias corretas -> Uma correta: fica marcada só a primeira (as outras alternativas e
  // os textos continuam). O resto da troca de tipo não mexe em nada.
  const changeType = (type) => {
    if (type === 'multiple_choice' && question.alternatives.filter((alternative) => alternative.isCorrect).length > 1) {
      const first = question.alternatives.findIndex((alternative) => alternative.isCorrect)
      update({ type, alternatives: question.alternatives.map((alternative, position) => ({ ...alternative, isCorrect: position === first })) })
      return
    }
    update({ type })
  }
  const problems = showProblems ? questionProblems(question) : []
  const typeOption = QUESTION_TYPE_OPTIONS.find((option) => option.value === question.type) || QUESTION_TYPE_OPTIONS[0]
  const points = editorPointsValue(question)
  const inBank = !!linkedBankKey(question)
  const cardLabel = label || `Questão ${index + 1}`
  return (
    <Card id={`questao-editor-${index + 1}`} className={`min-w-0 space-y-3 p-3 sm:p-4 ${problems.length ? 'border-warning/60' : ''}`} aria-label={cardLabel} role="group">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">{cardLabel}</Badge>
        <Badge tone="neutral">{questionTypeLabel(question.type)}</Badge>
        {inBank && onSaveToBank && <Badge tone="neutral">Do banco</Badge>}
        <span className="text-xs text-muted">{Number.isFinite(points) ? formatPointsLabel(points) : 'pontos inválidos'}</span>
        <div className="flex-1" />
        <div className="flex flex-wrap gap-1">
          {onMove && <Button type="button" size="sm" variant="ghost" icon={ArrowUp} onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Subir (questão ${index + 1})`}><span className="hidden md:inline">Subir</span></Button>}
          {onMove && <Button type="button" size="sm" variant="ghost" icon={ArrowDown} onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Descer (questão ${index + 1})`}><span className="hidden md:inline">Descer</span></Button>}
          {onDuplicate && <Button type="button" size="sm" variant="ghost" icon={Copy} onClick={onDuplicate} aria-label={`Duplicar (questão ${index + 1})`}><span className="hidden md:inline">Duplicar</span></Button>}
          {onSaveToBank && (
            <Button
              type="button" size="sm" variant="ghost" icon={Library} onClick={() => onSaveToBank(question)} disabled={inBank}
              aria-label={`Salvar no banco (questão ${index + 1})`}
              title={inBank ? 'Esta questão já está no banco de questões.' : 'Salvar no banco de questões'}
            ><span className="hidden md:inline">Salvar no banco</span></Button>
          )}
          {onRemove && <Button type="button" size="sm" variant="ghost" icon={Trash2} onClick={onRemove} disabled={count <= 1} aria-label={`Excluir (questão ${index + 1})`}><span className="hidden md:inline">Excluir</span></Button>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
        <div className="min-w-0 flex flex-col gap-1.5">
          <label htmlFor={typeSelectId} className="text-sm font-medium text-text">Tipo da questão</label>
          <select id={typeSelectId} value={question.type} aria-describedby={typeHintId} onChange={(event) => changeType(event.target.value)} className="h-[38px] min-w-0 w-full rounded-md border border-border bg-surface px-3 text-sm text-text">
            {QUESTION_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <span id={typeHintId} className="text-xs text-subtle">{typeOption.example}</span>
        </div>
        <Input label="Pontos" inputMode="decimal" value={question.points} onChange={(event) => update({ points: event.target.value })} helper="De 0,1 a 100." />
      </div>

      <div className="flex gap-1 lg:hidden" role="tablist" aria-label={`Editar ou ver a prévia da questão ${index + 1}`}>
        <Button type="button" size="sm" role="tab" aria-selected={tab === 'editar'} variant={tab === 'editar' ? 'secondary' : 'ghost'} icon={Pencil} onClick={() => setTab('editar')}>Editar</Button>
        <Button type="button" size="sm" role="tab" aria-selected={tab === 'previa'} variant={tab === 'previa' ? 'secondary' : 'ghost'} icon={Eye} onClick={() => setTab('previa')}>Prévia</Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className={`min-w-0 space-y-4 ${tab === 'previa' ? 'hidden lg:block' : ''}`}>
          <MarkdownField
            label="Enunciado"
            value={question.text}
            onChange={(text) => update({ text })}
            rows={4}
            maxLength={EDITOR_LIMITS.text}
            placeholder="Texto da questão"
            hint="Markdown: **negrito**, `código`, bloco com ```, tabela e imagem. A quebra de linha fica como você escreveu."
          />
          <TypeFields question={question} index={index} update={update} />
          <MarkdownField
            label="Explicação (opcional)"
            value={question.explanation}
            onChange={(explanation) => update({ explanation })}
            rows={2}
            maxLength={EDITOR_LIMITS.explanation}
            placeholder="Por que esta é a resposta certa."
            hint="O aluno vê a explicação só quando o gabarito for liberado."
          />
          <div className="rounded-lg border border-border">
            <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-text" aria-expanded={details} onClick={() => setDetails((value) => !value)}>
              Mais detalhes <span className="text-xs text-muted">{details ? 'Esconder' : 'Dificuldade, habilidades e etiquetas'}</span>
            </button>
            {details && (
              <div className="grid grid-cols-1 gap-3 border-t border-border p-3 sm:grid-cols-3">
                <Select label="Dificuldade" value={question.difficulty} onChange={(event) => update({ difficulty: event.target.value })}>
                  {DIFFICULTY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select>
                <Input label="Habilidades" value={question.skills} onChange={(event) => update({ skills: event.target.value })} placeholder="Ex.: BNCC EM13MAT101" helper="Separe por vírgula (até 10, com até 80 letras cada)." />
                <Input label="Etiquetas" value={question.tags} onChange={(event) => update({ tags: event.target.value })} placeholder="Ex.: redes, IPv4" helper="Separe por vírgula (até 10, com até 40 letras cada)." />
              </div>
            )}
          </div>
        </div>
        <div className={`min-w-0 ${tab === 'editar' ? 'hidden lg:block' : ''}`}>
          <p className="mb-2 hidden text-xs font-semibold uppercase text-subtle lg:block">Prévia (como o aluno vê)</p>
          <QuestionPreview question={question} number={index + 1} />
        </div>
      </div>

      {problems.length > 0 && (
        <ul className="list-disc space-y-0.5 rounded-md border border-warning/50 bg-warning/10 py-2 pl-7 pr-3 text-xs text-text" aria-label={`O que falta na questão ${index + 1}`}>
          {problems.map((problem) => <li key={problem}>{problem.charAt(0).toUpperCase() + problem.slice(1)}</li>)}
        </ul>
      )}
    </Card>
  )
}

// Tem algo escrito (para perguntar antes de excluir).
function hasContent(question) {
  if (String(question.text || '').trim() || String(question.explanation || '').trim() || String(question.expectedAnswer || '').trim()) return true
  if (question.alternatives.some((alternative) => String(alternative.text || '').trim())) return true
  if (question.acceptedAnswers.some((item) => String(item || '').trim())) return true
  if (String(question.numeric?.value || '').trim()) return true
  return question.rubric.some((criterion) => String(criterion.nome || '').trim())
}

function excerpt(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean
}

// "Total da prova: 12,5 pontos em 6 questões".
export function PointsTotal({ questions, className = '' }) {
  const { total, invalid } = totalPoints(questions)
  const count = Array.isArray(questions) ? questions.length : 0
  return (
    <p className={`text-sm text-text ${className}`.trim()} role="status">
      <b>Total da prova: {formatPointsLabel(total)}</b> em {count} {count === 1 ? 'questão' : 'questões'}
      {invalid > 0 && <span className="text-warning"> ({invalid} com pontos inválidos fora da soma)</span>}
      <span className="block text-xs text-muted">A nota é a proporção dos pontos que o aluno fez.</span>
    </p>
  )
}

export default function QuestionEditor({ questions, onChange, onOpenBank, onSaveToBank, showProblems = false }) {
  const [removing, setRemoving] = useState(null)
  const list = Array.isArray(questions) ? questions : []

  function replace(index, next) {
    onChange(list.map((question, position) => (position === index ? next : question)))
  }
  function move(index, direction) {
    const target = index + direction
    if (target < 0 || target >= list.length) return
    const next = [...list]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }
  function duplicate(index) {
    const next = [...list]
    next.splice(index + 1, 0, duplicateEditorQuestion(list[index]))
    onChange(next)
  }
  function askRemove(index) {
    if (list.length <= 1) return
    if (!hasContent(list[index])) {
      onChange(list.filter((_, position) => position !== index))
      return
    }
    setRemoving({ uid: list[index].uid, number: index + 1, text: list[index].text })
  }
  function confirmRemove() {
    if (!removing) return
    onChange(list.filter((question) => question.uid !== removing.uid))
    setRemoving(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2 border-t border-border pt-4">
        <div>
          <h3 className="font-semibold text-text">Questões</h3>
          <PointsTotal questions={list} />
        </div>
        <div className="flex flex-wrap gap-2">
          {onOpenBank && <Button type="button" size="sm" variant="secondary" icon={Library} onClick={onOpenBank}>Banco de questões</Button>}
          <Button type="button" size="sm" icon={Plus} onClick={() => onChange([...list, editorQuestion()])}>Adicionar questão</Button>
        </div>
      </div>
      <div className="space-y-4">
        {list.map((question, index) => (
          <QuestionCard
            key={question.uid}
            question={question}
            index={index}
            count={list.length}
            showProblems={showProblems}
            onChange={(next) => replace(index, next)}
            onMove={(direction) => move(index, direction)}
            onDuplicate={() => duplicate(index)}
            onRemove={() => askRemove(index)}
            onSaveToBank={onSaveToBank}
          />
        ))}
      </div>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={confirmRemove}
        tone="danger"
        title={`Excluir a questão ${removing?.number || ''}?`}
        message={removing ? `${excerpt(removing.text) ? `"${excerpt(removing.text)}" ` : ''}sai da prova quando você salvar. Para desistir, feche o editor sem salvar.` : ''}
        confirmLabel="Excluir"
      />
    </div>
  )
}
