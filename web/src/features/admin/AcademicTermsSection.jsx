import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarRange, Lock, LockOpen, Pencil, Plus, Trash2, Wand2 } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card, CardBody } from '../../components/ui/Card'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { EmptyState } from '../../components/ui/EmptyState'
import { Input } from '../../components/ui/Input'
import { Modal } from '../../components/ui/Modal'
import { PageState } from '../../components/ui/PageState'
import { Select } from '../../components/ui/Select'
import { Skeleton } from '../../components/ui/Skeleton'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'

// Períodos letivos na tela Turmas (fase 3, B8 / P2-S8, FUN-05). As regras são do servidor
// (GET/POST /api/admin/academic/terms, B5): datas reais, etapas dentro do período, em
// sequência e sem se cruzar, período encerrado sem turma nova e sem mudar de data, reabrir
// com motivo. A tela só monta o pedido, sugere as datas das etapas e mostra a recusa no
// campo que o servidor apontou (field). Encerrar o período não encerra turma nem muda
// nota: depois de encerrar, o assistente (ClassClosureDialog, B10) oferece encerrar as
// turmas ligadas que a conta vê, com o resumo de situações de cada uma, e lembra da
// matrícula em lote na turma nova (tela Alunos).

export const MAX_TERM_STAGES = 6

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function ymdToUtc(date) {
  const match = YMD_RE.exec(String(date || ''))
  if (!match) return null
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const back = new Date(ms)
  // 2027-02-30 não existe: o Date.UTC "anda" para março e a volta não bate.
  if (back.getUTCFullYear() !== Number(match[1]) || back.getUTCMonth() !== Number(match[2]) - 1 || back.getUTCDate() !== Number(match[3])) return null
  return ms
}

function utcToYmd(ms) {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

// 'AAAA-MM-DD' -> 'DD/MM/AAAA' (texto da tela; a data gravada não muda).
export function brDate(date) {
  return YMD_RE.test(String(date || '')) ? String(date).split('-').reverse().join('/') : ''
}

function shortBrDate(date) {
  return YMD_RE.test(String(date || '')) ? String(date).split('-').slice(1).reverse().join('/') : ''
}

export function termRangeText(term) {
  return term && term.inicio && term.fim ? `${brDate(term.inicio)} a ${brDate(term.fim)}` : ''
}

// Divide o período em N etapas seguidas, do mesmo tamanho (a sobra de dias vai para as
// últimas), sem se cruzar e dentro das datas: a sugestão do formulário (o professor ajusta
// depois, por exemplo para o recesso de julho). null quando as datas não valem.
export function suggestStages(inicio, fim, count) {
  const start = ymdToUtc(inicio)
  const end = ymdToUtc(fim)
  const n = Math.round(Number(count))
  if (start === null || end === null || end <= start || !Number.isInteger(n) || n < 1 || n > MAX_TERM_STAGES) return null
  const DAY = 24 * 60 * 60 * 1000
  const days = Math.round((end - start) / DAY) + 1
  if (days < n) return null
  return Array.from({ length: n }, (_, index) => ({
    ordem: index + 1,
    nome: `${index + 1}ª etapa`,
    inicio: utcToYmd(start + Math.floor((index * days) / n) * DAY),
    fim: utcToYmd(start + (Math.floor(((index + 1) * days) / n) - 1) * DAY),
  }))
}

// Escola do curso como o servidor a lê (curso antigo sem escola é da escola padrão).
export function courseSchoolOf(course) {
  return String((course && course.schoolId) || '').trim() || 'escola_default'
}

// Períodos que a turma deste curso pode receber: abertos, de toda a instituição ou da
// escola do curso; o que a turma já tem entra sempre (mesmo encerrado ou de outra escola,
// para o seletor não trocar sozinho o que está gravado).
export function termOptionsForCourse(periodos, course, currentId = '') {
  const school = courseSchoolOf(course)
  return (Array.isArray(periodos) ? periodos : []).filter(term => term && (
    term.id === currentId || (term.situacao !== 'encerrado' && (!term.schoolId || term.schoolId === school))
  ))
}

export function termOptionLabel(term) {
  const base = `${term.nome} (${termRangeText(term)})`
  return term.situacao === 'encerrado' ? `${base} · encerrado` : base
}

function fmtMoment(ms) {
  if (!ms) return ''
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR')
}

const emptyStage = (ordem) => ({ ordem, nome: '', inicio: '', fim: '' })

function formFromTerm(term) {
  if (!term) return { mode: 'create', id: '', nome: '', schoolId: '', inicio: '', fim: '', etapas: [] }
  return {
    mode: 'edit',
    id: term.id,
    nome: term.nome || '',
    schoolId: term.schoolId || '',
    inicio: term.inicio || '',
    fim: term.fim || '',
    etapas: (term.etapas || []).map(stage => ({ ordem: stage.ordem, nome: stage.nome || '', inicio: stage.inicio || '', fim: stage.fim || '' })),
  }
}

// 'etapas[2].inicio' -> { stage: 2, field: 'inicio' }; 'nome' -> { field: 'nome' }.
function parseErrorField(field) {
  const match = /^etapas\[(\d+)\](?:\.(\w+))?$/.exec(String(field || ''))
  if (match) return { stage: Number(match[1]), field: match[2] || 'inicio' }
  return field ? { field: String(field) } : null
}

function TermForm({ open, form, setForm, escolas, saving, error, onClose, onSave, suggestedCount, suggestedFrom }) {
  const [count, setCount] = useState(suggestedCount)
  useEffect(() => { if (open) setCount(suggestedCount) }, [open, suggestedCount])
  if (!form) return null
  const where = parseErrorField(error?.field)
  const fieldError = (name) => (where && where.stage === undefined && where.field === name ? error.message : undefined)
  const stageError = (index, name) => (where && where.stage === index && (where.field === name || (name === 'inicio' && where.field === 'ordem')) ? error.message : undefined)
  // A recusa aparece no campo que o servidor apontou; sem campo conhecido, no topo.
  const shownInField = !!where && (where.stage === undefined
    ? ['nome', 'inicio', 'fim', 'schoolId'].includes(where.field)
    : where.stage < form.etapas.length && ['nome', 'inicio', 'fim', 'ordem'].includes(where.field))
  const generalError = error && !shownInField ? error.message : ''
  const canSuggest = !!suggestStages(form.inicio, form.fim, count)

  const setStage = (index, patch) => setForm(current => ({ ...current, etapas: current.etapas.map((stage, i) => (i === index ? { ...stage, ...patch } : stage)) }))
  const removeStage = (index) => setForm(current => ({ ...current, etapas: current.etapas.filter((_, i) => i !== index).map((stage, i) => ({ ...stage, ordem: i + 1 })) }))
  const addStage = () => setForm(current => (current.etapas.length >= MAX_TERM_STAGES ? current : { ...current, etapas: [...current.etapas, emptyStage(current.etapas.length + 1)] }))
  const applySuggestion = () => {
    const stages = suggestStages(form.inicio, form.fim, count)
    if (stages) setForm(current => ({ ...current, etapas: stages }))
  }

  return (
    <Modal open={open} onClose={onClose} size="lg" fullScreenOnPhone
      title={form.mode === 'edit' ? 'Editar período letivo' : 'Novo período letivo'}
      description="As datas do semestre ou do ano letivo e de cada etapa (bimestre, trimestre)."
      footer={<><Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button><Button loading={saving} onClick={onSave}>Salvar período</Button></>}>
      <div className="space-y-4">
        {generalError && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{generalError}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Nome do período" value={form.nome} maxLength={80} placeholder="Ex.: 2027 · 1º semestre" error={fieldError('nome')}
            onChange={event => setForm(current => ({ ...current, nome: event.target.value }))} />
          <Select label="Vale para" value={form.schoolId} error={fieldError('schoolId')} onChange={event => setForm(current => ({ ...current, schoolId: event.target.value }))}>
            <option value="">Toda a instituição</option>
            {escolas.map(school => <option key={school.id} value={school.id}>{school.nome}</option>)}
          </Select>
          <Input label="Início" type="date" value={form.inicio} error={fieldError('inicio')} onChange={event => setForm(current => ({ ...current, inicio: event.target.value }))} />
          <Input label="Fim" type="date" value={form.fim} error={fieldError('fim')} onChange={event => setForm(current => ({ ...current, fim: event.target.value }))} />
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <div>
            <h3 className="font-semibold text-text">Etapas</h3>
            <p className="text-xs text-subtle">Opcional. Aqui ficam só as datas de cada etapa; quantas contam na média e o peso de cada uma ficam nos critérios de avaliação do curso.</p>
          </div>
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-surface-2/50 p-3">
            <div className="w-full sm:w-48">
              <Select label="Dividir o período em" value={String(count)} onChange={event => setCount(Number(event.target.value))}>
                {Array.from({ length: MAX_TERM_STAGES }, (_, index) => index + 1).map(n => <option key={n} value={n}>{n === 1 ? '1 etapa' : `${n} etapas`}</option>)}
              </Select>
            </div>
            <Button variant="secondary" icon={Wand2} disabled={!canSuggest} onClick={applySuggestion} className="w-full sm:w-auto">Sugerir datas das etapas</Button>
            <p className="w-full text-xs text-subtle">{suggestedFrom
              ? `Os critérios de avaliação de ${suggestedFrom} têm ${suggestedCount} ${suggestedCount === 1 ? 'etapa' : 'etapas'}. A sugestão divide o período em partes iguais; ajuste as datas depois (recesso, por exemplo).`
              : 'A sugestão divide o período em partes iguais; ajuste as datas depois (recesso, por exemplo). Preencha o início e o fim primeiro.'}</p>
          </div>
          {form.etapas.length === 0 && <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted">Sem etapas: o período vale como um bloco só.</p>}
          <div className="space-y-3">
            {form.etapas.map((stage, index) => (
              <fieldset key={index} className="rounded-lg border border-border p-3">
                <legend className="px-1 text-sm font-medium text-text">{`Etapa ${index + 1}`}</legend>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                  <Input label={`Nome da etapa ${index + 1}`} value={stage.nome} maxLength={40} placeholder={`${index + 1}ª etapa`} error={stageError(index, 'nome')}
                    onChange={event => setStage(index, { nome: event.target.value })} />
                  <Input label={`Início da etapa ${index + 1}`} type="date" value={stage.inicio} error={stageError(index, 'inicio')}
                    onChange={event => setStage(index, { inicio: event.target.value })} />
                  <Input label={`Fim da etapa ${index + 1}`} type="date" value={stage.fim} error={stageError(index, 'fim')}
                    onChange={event => setStage(index, { fim: event.target.value })} />
                  <Button variant="ghost" icon={Trash2} aria-label={`Remover etapa ${index + 1}`} onClick={() => removeStage(index)}>Remover</Button>
                </div>
              </fieldset>
            ))}
          </div>
          <Button size="sm" variant="secondary" icon={Plus} disabled={form.etapas.length >= MAX_TERM_STAGES} onClick={addStage}>Adicionar etapa</Button>
        </div>
      </div>
    </Modal>
  )
}

function TermCard({ term, onEdit, onClose, onReopen, openClasses = [], onCloseClasses }) {
  const closed = term.situacao === 'encerrado'
  const hiddenClasses = Math.max(0, Number(term.totalTurmas || 0) - (term.turmas || []).length)
  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-text break-words">{term.nome}</h3>
            <Badge tone={closed ? 'neutral' : 'success'}>{term.situacaoRotulo || (closed ? 'Encerrado' : 'Aberto')}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">{termRangeText(term)} · {term.schoolId ? (term.escolaNome || term.schoolId) : 'Toda a instituição'}</p>
        </div>
        {term.podeAlterar && <div className="flex flex-wrap gap-2">
          {!closed && <Button size="sm" variant="secondary" icon={Pencil} aria-label={`Editar período ${term.nome}`} onClick={() => onEdit(term)}>Editar</Button>}
          {!closed && <Button size="sm" variant="ghost" icon={Lock} aria-label={`Encerrar período ${term.nome}`} onClick={() => onClose(term)}>Encerrar</Button>}
          {closed && <Button size="sm" variant="secondary" icon={LockOpen} aria-label={`Reabrir período ${term.nome}`} onClick={() => onReopen(term)}>Reabrir</Button>}
        </div>}
        {closed && onCloseClasses && openClasses.length > 0 && <Button size="sm" icon={Lock} aria-label={`Encerrar as turmas do período ${term.nome}`} onClick={() => onCloseClasses(openClasses)}>{openClasses.length === 1 ? 'Encerrar a turma' : `Encerrar as ${openClasses.length} turmas`}</Button>}
      </div>
      {(term.etapas || []).length > 0 && (
        <ul aria-label={`Etapas de ${term.nome}`} className="mt-3 flex flex-wrap gap-2">
          {term.etapas.map(stage => <li key={stage.ordem} className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-text">{stage.nome}: {shortBrDate(stage.inicio)} a {shortBrDate(stage.fim)}</li>)}
        </ul>
      )}
      <p className="mt-3 text-xs text-subtle">
        {(term.turmas || []).length === 0 && hiddenClasses === 0
          ? 'Nenhuma turma ligada. Ligue a turma no botão Editar da turma.'
          : `Turmas: ${(term.turmas || []).map(cls => `${cls.courseName} · ${cls.name}`).join(', ')}${hiddenClasses ? `${(term.turmas || []).length ? ' e ' : ''}${hiddenClasses} de outros cursos` : ''}`}
      </p>
      {closed && term.encerradoEm && <p className="mt-1 text-xs text-subtle">Encerrado em {fmtMoment(term.encerradoEm)}{term.encerradoPor ? ` por ${term.encerradoPor}` : ''}. Sem turma nova e sem mudar as datas até reabrir.</p>}
      {closed && onCloseClasses && openClasses.length > 0 && <p className="mt-1 text-xs text-subtle">{openClasses.length === 1 ? 'A turma ligada continua aberta.' : `${openClasses.length} turmas ligadas continuam abertas.`} Encerre-as para travar notas e presença; para matricular os alunos na turma do próximo período, use <Link className="text-primary underline" to="/diretorio">Alunos</Link> e "Matricular em turma".</p>}
      {!closed && term.reabertoEm && <p className="mt-1 text-xs text-subtle">Reaberto em {fmtMoment(term.reabertoEm)}{term.reabertoPor ? ` por ${term.reabertoPor}` : ''}.</p>}
    </li>
  )
}

// termsApi: o useApi('/api/admin/academic/terms') da tela Turmas (o mesmo alimenta o
// seletor do formulário da turma). course: o curso selecionado, para a sugestão do número
// de etapas (os critérios dele, quando ligados). onChanged: recarrega o resto da tela (as
// turmas mostram o período).
// canCloseClasses, classes e onCloseClasses (B10): o assistente de encerrar as turmas do
// período encerrado (classes: a lista de GET /api/admin/classes, que diz quais já estão
// encerradas).
export function AcademicTermsSection({ termsApi, course, onChanged, canCloseClasses = false, classes = [], onCloseClasses }) {
  const toast = useToast()
  const data = termsApi?.data || null
  const periodos = Array.isArray(data?.periodos) ? data.periodos : []
  const escolas = Array.isArray(data?.escolas) ? data.escolas : []
  const podeCriar = data?.podeCriar === true
  const [form, setForm] = useState(null)
  const [formError, setFormError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [closing, setClosing] = useState(null)
  const [reopening, setReopening] = useState(null)

  const criteria = course?.avaliacao && course.avaliacao.ativo !== false && Array.isArray(course.avaliacao.etapas) && course.avaliacao.etapas.length
    ? course.avaliacao.etapas.length : 0
  const suggestedCount = Math.min(MAX_TERM_STAGES, criteria || 2)
  // Turmas ligadas ao período que a conta vê e que ainda estão abertas.
  const openClassesOf = term => (term.turmas || [])
    .filter(item => !(classes || []).some(cls => cls.name === item.name && String(cls.courseId) === String(item.courseId) && cls.encerrada))
    .map(item => ({ courseId: item.courseId, courseName: item.courseName, name: item.name }))

  const refresh = async () => {
    await Promise.all([termsApi?.refetch?.(), onChanged?.()])
  }

  const openCreate = () => {
    setFormError(null)
    setForm({ ...formFromTerm(null), schoolId: '' })
  }
  const openEdit = (term) => {
    setFormError(null)
    setForm(formFromTerm(term))
  }

  async function save() {
    if (!form || saving) return
    setFormError(null)
    const payload = {
      nome: form.nome.trim(),
      inicio: form.inicio,
      fim: form.fim,
      schoolId: form.schoolId || null,
      etapas: form.etapas.map((stage, index) => ({ ordem: index + 1, nome: stage.nome.trim(), inicio: stage.inicio, fim: stage.fim })),
    }
    setSaving(true)
    try {
      const result = form.mode === 'edit'
        ? await api.post('/api/admin/academic/terms/update', { id: form.id, ...payload })
        : await api.post('/api/admin/academic/terms/create', payload)
      toast.success(result?.semMudanca ? 'Nada mudou no período letivo.' : form.mode === 'edit' ? 'Período letivo atualizado.' : 'Período letivo criado.')
      setForm(null)
      await refresh()
    } catch (error) {
      setFormError({ message: error.message, field: error?.data?.field || null })
    } finally {
      setSaving(false)
    }
  }

  async function confirmClose(reason) {
    const result = await api.post('/api/admin/academic/terms/close', { id: closing.id, ...(reason ? { reason } : {}) })
    const total = Array.isArray(result?.turmas) ? result.turmas.length : 0
    toast.success(total ? `Período encerrado. ${total === 1 ? 'A turma ligada continua aberta' : `As ${total} turmas ligadas continuam abertas`}, com as mesmas notas.` : 'Período encerrado.')
    const term = closing
    setClosing(null)
    await refresh()
    // Assistente (B10): oferece encerrar as turmas ligadas logo em seguida.
    const open = canCloseClasses && onCloseClasses && term ? openClassesOf(term) : []
    if (open.length) onCloseClasses(open)
  }

  async function confirmReopen(reason) {
    await api.post('/api/admin/academic/terms/reopen', { id: reopening.id, reason })
    toast.success('Período reaberto.')
    setReopening(null)
    await refresh()
  }

  return (
    <Card>
      <CardBody className="pt-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-semibold text-text"><CalendarRange size={18} className="text-muted" /> Períodos letivos</h2>
            <p className="text-xs text-subtle">A turma ligada a um período só tem aula dentro das datas dele. Turma sem período continua como sempre.</p>
          </div>
          {podeCriar && <Button size="sm" icon={Plus} onClick={openCreate}>Novo período letivo</Button>}
        </div>
        <PageState loading={termsApi?.loading && !data} error={termsApi?.error} onRetry={() => termsApi?.refetch?.()} skeleton={<Skeleton className="h-24" />}>
          {periodos.length === 0
            ? <EmptyState icon={CalendarRange} title="Nenhum período letivo" description={podeCriar ? 'Crie o período (por exemplo, 2027 · 1º semestre) e ligue as turmas a ele no formulário da turma.' : 'Quem gerencia as turmas cadastra os períodos letivos.'} />
            : <ul aria-label="Períodos letivos" className="space-y-3">{periodos.map(term => <TermCard key={term.id} term={term} onEdit={openEdit} onClose={setClosing} onReopen={setReopening}
              openClasses={canCloseClasses ? openClassesOf(term) : []} onCloseClasses={canCloseClasses ? onCloseClasses : undefined} />)}</ul>}
        </PageState>
      </CardBody>

      <TermForm open={!!form} form={form} setForm={setForm} escolas={escolas} saving={saving} error={formError}
        onClose={() => { if (!saving) setForm(null) }} onSave={save}
        suggestedCount={suggestedCount} suggestedFrom={criteria ? course?.name : ''} />

      <ConfirmDialog open={!!closing} onClose={() => setClosing(null)} onConfirm={confirmClose}
        title={closing ? `Encerrar o período ${closing.nome}?` : ''}
        message={closing ? `${Number(closing.totalTurmas || 0) === 0 ? 'Nenhuma turma está ligada a ele.' : `As turmas ligadas (${closing.totalTurmas}) continuam abertas, com as mesmas notas e chamadas.`} Encerrado, o período não recebe turma nova e as datas não mudam. Dá para reabrir depois, com o motivo.` : ''}
        askReason confirmLabel="Encerrar período" />

      <ConfirmDialog open={!!reopening} onClose={() => setReopening(null)} onConfirm={confirmReopen}
        title={reopening ? `Reabrir o período ${reopening.nome}?` : ''}
        message="O período volta a receber turma e a mudar de data. O motivo fica na Auditoria."
        requireReason reasonLabel="Motivo para reabrir" reasonPlaceholder="Ex.: datas do 2º bimestre mudaram" confirmLabel="Reabrir período" />
    </Card>
  )
}
