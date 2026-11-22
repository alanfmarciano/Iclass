import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Save, Send } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { Input } from '../../../components/ui/Input'
import { Select } from '../../../components/ui/Select'
import { Textarea } from '../../../components/ui/Textarea'
import { Tabs } from '../../../components/ui/Tabs'
import { PageHeader } from '../../../components/ui/PageHeader'
import { PageState } from '../../../components/ui/PageState'
import { useApi } from '../../../hooks/useApi'
import { useAdminWorkspace } from '../../../hooks/useAdminWorkspace'
import { useAuth } from '../../../context/AuthProvider'
import { useToast } from '../../../context/ToastProvider'
import { api } from '../../../lib/api'
import { markdownToHtml } from '../../../lib/contentMarkdown'
import { createBody, deadlineChanged, emptyForm, formFieldOf, formFromAssignment, limitsOf, updateBody, validateForm } from './assignmentForm'
import { hidePlaceholderEmails, latePolicyText } from './assignmentText'

// Formulário "Nova tarefa" e "Editar tarefa" (fase 3, C7 / P1-e; FUN-01, D6, D8 e D17 do
// P1). Rotas /tarefas/nova e /tarefas/:id/editar.
//
// - Campos: título, instruções (Markdown das apostilas, com prévia), módulo e unidade
//   (opcionais), materiais de apoio da Biblioteca, "O aluno responde com" (arquivo, texto,
//   link), tipos de arquivo com o nome em português e exemplos, formatos do curso, número
//   e tamanho dos arquivos, prazo, encerramento (opcional), "Aparecer para os alunos"
//   (ao publicar ou numa data), regra depois do prazo e "Conta na média".
// - Opções, limites e padrões vêm de GET /api/admin/assignments/form-options (a mesma lista
//   que o servidor confere); a turma é a da tarefa (editar) ou a do curso escolhido (nova).
// - A tela confere antes de mandar, com as mensagens do servidor (assignmentForm.js); a
//   recusa do servidor aparece no campo que ele indicar.
// - Tarefa arquivada e conta só de consulta (Coordenação) veem o formulário sem poder mudar.

const FIELD_IDS = Object.freeze({
  title: 'tarefa-titulo',
  instructions: 'tarefa-instrucoes',
  moduleId: 'tarefa-modulo',
  unitKey: 'tarefa-unidade',
  libraryIds: 'tarefa-materiais',
  response: 'tarefa-resposta',
  'files.types': 'tarefa-tipos',
  'files.extraExtensions': 'tarefa-formatos',
  'files.maxFiles': 'tarefa-max-arquivos',
  'files.maxSizeMb': 'tarefa-max-mb',
  dueDate: 'tarefa-prazo-data',
  dueTime: 'tarefa-prazo-hora',
  closeDate: 'tarefa-encerra-data',
  closeTime: 'tarefa-encerra-hora',
  opensDate: 'tarefa-abre-data',
  opensTime: 'tarefa-abre-hora',
  'latePolicy.mode': 'tarefa-atraso',
  'latePolicy.penaltyPerDayPct': 'tarefa-desconto-dia',
  'latePolicy.penaltyMaxPct': 'tarefa-desconto-max',
  reason: 'tarefa-motivo',
})

const LATE_OPTIONS = Object.freeze([
  { mode: 'aceitar', label: 'Aceitar e marcar como atrasada' },
  { mode: 'desconto', label: 'Aceitar com desconto na nota' },
  { mode: 'bloquear', label: 'Não aceitar' },
])

// Exemplo de extensões no nome do tipo: 'Código e texto (.py, .html, .c...)'.
function typeLabel(type) {
  const list = Array.isArray(type.extensions) ? type.extensions : []
  const shown = list.slice(0, 3).join(', ')
  return shown ? `${type.label} (${shown}${list.length > 3 ? '...' : ''})` : type.label
}

export default function TarefaForm() {
  const { id } = useParams()
  const editing = !!id
  const navigate = useNavigate()
  const toast = useToast()
  const { auth } = useAuth()
  const workspace = useAdminWorkspace()
  const detail = useApi(editing ? `/api/admin/assignments/${encodeURIComponent(id)}` : null, [id])
  const assignment = detail.data?.assignment || null
  const courseId = editing ? assignment?.courseId : workspace.courseId
  const studentClass = editing ? assignment?.studentClass : workspace.className
  const optionsQuery = courseId && studentClass ? new URLSearchParams({ courseId, studentClass }).toString() : ''
  const optionsState = useApi(optionsQuery ? `/api/admin/assignments/form-options?${optionsQuery}` : null, [optionsQuery])
  const options = optionsState.data

  const [initial, setInitial] = useState(null)
  const [form, setForm] = useState(null)
  const [errors, setErrors] = useState({})
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [instructionsTab, setInstructionsTab] = useState('escrever')
  const [opensMode, setOpensMode] = useState('publicar')
  const [serverAskedReason, setServerAskedReason] = useState(false)
  const summaryRef = useRef(null)

  // Monta o formulário quando a tarefa (editar) e as opções chegam.
  useEffect(() => {
    if (!options || (editing && !assignment) || initial) return
    const start = editing ? formFromAssignment(assignment, options) : emptyForm(options)
    setInitial(start)
    setForm(start)
    setOpensMode(start.opensDate ? 'data' : 'publicar')
  }, [options, assignment, editing, initial])

  const limits = limitsOf(options)
  const archived = assignment?.status === 'arquivada'
  const readOnly = auth?.readOnly === true
  const locked = readOnly || archived || busy
  const published = assignment?.status === 'publicada'
  const hasDeliveries = (assignment?.counts?.enviadas || 0) > 0 || serverAskedReason
  const needsReason = editing && !!form && !!initial && hasDeliveries && deadlineChanged(initial, form)
  const modules = useMemo(() => (Array.isArray(options?.modules) ? options.modules : []), [options])
  const units = useMemo(() => modules.find((module) => module.id === form?.moduleId)?.units || [], [modules, form?.moduleId])
  const library = Array.isArray(options?.library) ? options.library : []
  const fileTypes = Array.isArray(options?.fileTypes) ? options.fileTypes : []
  const previewHtml = useMemo(() => (instructionsTab === 'previa' && form ? markdownToHtml(form.instructions || '') : ''), [instructionsTab, form])

  function change(patch) {
    setForm((current) => ({ ...current, ...patch }))
    const keys = Object.keys(patch)
    setErrors((current) => {
      const next = { ...current }
      keys.forEach((key) => { delete next[key] })
      if (keys.includes('maxFiles')) delete next['files.maxFiles']
      if (keys.includes('maxSizeMb')) delete next['files.maxSizeMb']
      if (keys.includes('types') || keys.includes('extraExtensions')) { delete next['files.types']; delete next['files.extraExtensions'] }
      if (keys.some((key) => key.startsWith('penalty') || key === 'lateMode')) Object.keys(next).filter((key) => key.startsWith('latePolicy')).forEach((key) => delete next[key])
      return next
    })
  }

  function showError(field, message) {
    const error = hidePlaceholderEmails(message)
    const key = formFieldOf(field) || ''
    setErrors(key ? { [key]: error } : {})
    setSummary(error)
    requestAnimationFrame(() => {
      const element = key && FIELD_IDS[key] ? document.getElementById(FIELD_IDS[key]) : null
      if (element && typeof element.focus === 'function') element.focus()
      else summaryRef.current?.focus?.()
    })
  }

  async function save(publish) {
    if (!form || locked) return
    const willPublish = publish || published
    const problem = validateForm(form, options, { publish: willPublish, needsReason })
    if (problem) return showError(problem.field, problem.error)
    setBusy(true)
    setSummary('')
    try {
      if (!editing) {
        await api.post('/api/admin/assignments', createBody(form, options, { courseId, studentClass, publish }))
        toast.success(publish ? 'Tarefa publicada' : 'Tarefa salva como rascunho')
        navigate('/tarefas')
        return
      }
      const base = `/api/admin/assignments/${encodeURIComponent(assignment.id)}`
      const body = updateBody(initial, form, options, { withReason: needsReason })
      let changed = false
      if (Object.keys(body).length) {
        const result = await api.post(`${base}/update`, body)
        changed = result?.changed !== false
      }
      if (publish && assignment.status === 'rascunho') {
        await api.post(`${base}/publish`, {})
        toast.success('Tarefa publicada')
      } else {
        toast.success(changed ? 'Alterações salvas' : 'Nada mudou')
      }
      navigate('/tarefas')
    } catch (error) {
      if (error?.data?.code === 'reason_required') setServerAskedReason(true)
      showError(error?.data?.field, error?.message || 'Não foi possível salvar a tarefa.')
    } finally {
      setBusy(false)
    }
  }

  const title = editing ? (archived || readOnly ? 'Tarefa' : 'Editar tarefa') : 'Nova tarefa'
  const loading = (editing && detail.loading) || optionsState.loading || (!form && !detail.error && !optionsState.error)
  const loadError = detail.error || optionsState.error

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <PageHeader title={title} subtitle={studentClass ? `Turma ${studentClass}${options?.timezone ? ` · horários no relógio da escola (${options.timezone})` : ''}` : ''} helpTopic="tarefas">
        <Button variant="ghost" icon={ArrowLeft} className="min-h-[44px] sm:min-h-0" onClick={() => navigate('/tarefas')}>Voltar para Tarefas</Button>
      </PageHeader>

      <PageState loading={loading} error={loadError} onRetry={() => { detail.refetch(); optionsState.refetch() }}>
        {form && (
          <form noValidate onSubmit={(event) => { event.preventDefault(); save(false) }} className="space-y-5">
            {(archived || readOnly) && (
              <p role="status" className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-text">
                {archived ? 'Esta tarefa está arquivada. Reative a tarefa em Tarefas > Arquivadas para alterar.' : 'Sua conta é só de consulta: você vê a tarefa, mas não altera.'}
              </p>
            )}
            {summary && (
              <p ref={summaryRef} tabIndex={-1} role="alert" className="rounded-lg border border-danger bg-danger-soft px-4 py-3 text-sm text-danger">{summary}</p>
            )}

            <fieldset disabled={locked} className="space-y-5 min-w-0">
              <Card className="p-4 space-y-4">
                <h2 className="text-base font-semibold text-text">A tarefa</h2>
                <Input id={FIELD_IDS.title} label="Título" value={form.title} maxLength={limits.titleMax} counterFrom={limits.titleMax - 20}
                  onChange={(event) => change({ title: event.target.value })} error={errors.title} placeholder="Ex.: Relatório da prática de redes" />
                <div className="space-y-2">
                  <p className="text-sm font-medium text-text">Instruções</p>
                  <Tabs tabs={[{ id: 'escrever', label: 'Escrever' }, { id: 'previa', label: 'Prévia' }]} active={instructionsTab} onChange={setInstructionsTab} />
                  {instructionsTab === 'escrever' ? (
                    <Textarea id={FIELD_IDS.instructions} aria-label="Instruções" value={form.instructions} maxLength={limits.instructionsMax} counterFrom={limits.instructionsMax - 1000}
                      onChange={(event) => change({ instructions: event.target.value })} error={errors.instructions} className="min-h-[160px]"
                      placeholder="O que o aluno precisa fazer e entregar. Aceita **negrito**, listas e links, como nas apostilas." />
                  ) : (
                    <div className="min-h-[160px] rounded-md border border-border bg-surface px-3 py-2">
                      {form.instructions.trim()
                        ? <div className="prose-iclass break-words [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto" dangerouslySetInnerHTML={{ __html: previewHtml }} />
                        : <p className="text-sm text-muted">Sem instruções. O aluno vê só o título e o que enviar.</p>}
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Select id={FIELD_IDS.moduleId} label="Módulo (opcional)" value={form.moduleId} error={errors.moduleId}
                    onChange={(event) => change({ moduleId: event.target.value, unitKey: '' })}>
                    <option value="">Nenhum</option>
                    {modules.map((module) => <option key={module.id} value={module.id}>{module.name}</option>)}
                  </Select>
                  <Select id={FIELD_IDS.unitKey} label="Unidade (opcional)" value={form.unitKey} error={errors.unitKey} disabled={!form.moduleId || !units.length}
                    onChange={(event) => change({ unitKey: event.target.value })}>
                    <option value="">{form.moduleId ? 'Nenhuma' : 'Escolha o módulo antes'}</option>
                    {units.map((unit) => <option key={unit.key} value={unit.key}>{unit.name}</option>)}
                  </Select>
                </div>
                <fieldset id={FIELD_IDS.libraryIds} tabIndex={-1} className="space-y-1 min-w-0">
                  <legend className="text-sm font-medium text-text">Materiais de apoio da Biblioteca (opcional)</legend>
                  {library.length ? (
                    <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                      {library.map((entry) => {
                        const checked = form.libraryIds.includes(entry.id)
                        const full = !checked && form.libraryIds.length >= limits.libraryIdsMax
                        return (
                          <label key={entry.id} className="flex min-h-[44px] min-w-0 items-center gap-2 text-sm text-text">
                            <input type="checkbox" checked={checked} disabled={full}
                              onChange={() => change({ libraryIds: checked ? form.libraryIds.filter((item) => item !== entry.id) : [...form.libraryIds, entry.id] })} />
                            <span className="min-w-0 break-words">{entry.name}</span>
                          </label>
                        )
                      })}
                    </div>
                  ) : <p className="text-sm text-muted">A Biblioteca desta turma ainda não tem materiais.</p>}
                  <p className="text-xs text-subtle">Até {limits.libraryIdsMax} materiais. O aluno abre pela tarefa.</p>
                  {errors.libraryIds && <p role="alert" className="text-xs text-danger">{errors.libraryIds}</p>}
                </fieldset>
              </Card>

              <Card className="p-4 space-y-4">
                <fieldset id={FIELD_IDS.response} tabIndex={-1} className="space-y-1 min-w-0">
                  <legend className="text-base font-semibold text-text">O aluno responde com</legend>
                  <div className="flex flex-wrap gap-x-6">
                    {[['files', 'Arquivo'], ['text', 'Texto'], ['link', 'Link']].map(([key, label]) => (
                      <label key={key} className="flex min-h-[44px] items-center gap-2 text-sm text-text">
                        <input type="checkbox" checked={form.response[key]} onChange={(event) => change({ response: { ...form.response, [key]: event.target.checked } })} />
                        {label}
                      </label>
                    ))}
                  </div>
                  {errors.response && <p role="alert" className="text-xs text-danger">{errors.response}</p>}
                </fieldset>

                {form.response.files && (
                  <div className="space-y-4">
                    <fieldset id={FIELD_IDS['files.types']} tabIndex={-1} className="space-y-1 min-w-0">
                      <legend className="text-sm font-medium text-text">Tipos de arquivo aceitos</legend>
                      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                        {fileTypes.map((type) => {
                          const checked = form.types.includes(type.key)
                          return (
                            <label key={type.key} className="flex min-h-[44px] min-w-0 items-center gap-2 text-sm text-text">
                              <input type="checkbox" checked={checked}
                                onChange={() => change({ types: checked ? form.types.filter((item) => item !== type.key) : fileTypes.map((item) => item.key).filter((key) => key === type.key || form.types.includes(key)) })} />
                              <span className="min-w-0 break-words">{typeLabel(type)}</span>
                            </label>
                          )
                        })}
                      </div>
                      {errors['files.types'] && <p role="alert" className="text-xs text-danger">{errors['files.types']}</p>}
                    </fieldset>
                    <Input id={FIELD_IDS['files.extraExtensions']} label="Formatos do curso (opcional)" value={form.extraExtensions}
                      onChange={(event) => change({ extraExtensions: event.target.value })} error={errors['files.extraExtensions']}
                      helper={`Extensões de programas do curso, separadas por vírgula (ex.: .pkt do Packet Tracer, .fzz, .dwg). Até ${limits.extraExtensionsMax}. Executáveis nunca são aceitos.`} />
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Input id={FIELD_IDS['files.maxFiles']} type="number" inputMode="numeric" min={limits.maxFilesMin} max={limits.maxFilesMax} label="Até quantos arquivos por envio"
                        value={form.maxFiles} onChange={(event) => change({ maxFiles: event.target.value })} error={errors['files.maxFiles']}
                        helper={`De ${limits.maxFilesMin} a ${limits.maxFilesMax}.`} />
                      <Input id={FIELD_IDS['files.maxSizeMb']} type="number" inputMode="numeric" min={limits.maxSizeMbMin} max={limits.maxSizeMbMax} label="Tamanho máximo de cada arquivo (MB)"
                        value={form.maxSizeMb} onChange={(event) => change({ maxSizeMb: event.target.value })} error={errors['files.maxSizeMb']}
                        helper={`Até ${limits.maxSizeMbMax} MB (limite das entregas em Sistema)${limits.maxMbPorEnvio ? `; cada envio vai até ${limits.maxMbPorEnvio} MB no total` : ''}.`} />
                    </div>
                  </div>
                )}
              </Card>

              <Card className="p-4 space-y-4">
                <h2 className="text-base font-semibold text-text">Prazo</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Input id={FIELD_IDS.dueDate} type="date" label="Prazo: data" value={form.dueDate} onChange={(event) => change({ dueDate: event.target.value })} error={errors.dueDate}
                    helper="Obrigatório para publicar. O rascunho pode ficar sem prazo." />
                  <Input id={FIELD_IDS.dueTime} type="time" label="Prazo: hora" value={form.dueTime} onChange={(event) => change({ dueTime: event.target.value })} error={errors.dueTime} />
                  <Input id={FIELD_IDS.closeDate} type="date" label="Encerrar envios em (opcional)" value={form.closeDate} onChange={(event) => change({ closeDate: event.target.value })} error={errors.closeDate}
                    helper="Depois desta data, nem com atraso. Sem ela, a regra abaixo vale para sempre." />
                  <Input id={FIELD_IDS.closeTime} type="time" label="Encerrar envios: hora" value={form.closeTime} onChange={(event) => change({ closeTime: event.target.value })} error={errors.closeTime} />
                </div>
                <fieldset className="space-y-1 min-w-0">
                  <legend className="text-sm font-medium text-text">Aparecer para os alunos</legend>
                  <div className="flex flex-wrap gap-x-6">
                    <label className="flex min-h-[44px] items-center gap-2 text-sm text-text">
                      <input type="radio" name="tarefa-abertura" checked={opensMode === 'publicar'} onChange={() => { setOpensMode('publicar'); change({ opensDate: '', opensTime: '' }) }} />
                      Assim que publicar
                    </label>
                    <label className="flex min-h-[44px] items-center gap-2 text-sm text-text">
                      <input type="radio" name="tarefa-abertura" checked={opensMode === 'data'} onChange={() => { setOpensMode('data'); if (!form.opensTime) change({ opensTime: '07:00' }) }} />
                      Em uma data
                    </label>
                  </div>
                  {opensMode === 'data' && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Input id={FIELD_IDS.opensDate} type="date" label="Aparecer em: data" value={form.opensDate} onChange={(event) => change({ opensDate: event.target.value })} error={errors.opensDate} />
                      <Input id={FIELD_IDS.opensTime} type="time" label="Aparecer em: hora" value={form.opensTime} onChange={(event) => change({ opensTime: event.target.value })} error={errors.opensTime} />
                    </div>
                  )}
                </fieldset>
                {needsReason && (
                  <Textarea id={FIELD_IDS.reason} label="Motivo da mudança de prazo" value={form.reason} maxLength={limits.reasonMax}
                    onChange={(event) => change({ reason: event.target.value })} error={errors.reason}
                    placeholder="Esta tarefa já tem entregas. O motivo fica na Auditoria." className="min-h-[70px]" />
                )}
              </Card>

              <Card className="p-4 space-y-4">
                <fieldset id={FIELD_IDS['latePolicy.mode']} tabIndex={-1} className="space-y-1 min-w-0">
                  <legend className="text-base font-semibold text-text">Depois do prazo</legend>
                  {LATE_OPTIONS.map((option) => (
                    <label key={option.mode} className="flex min-h-[44px] items-center gap-2 text-sm text-text">
                      <input type="radio" name="tarefa-atraso" checked={form.lateMode === option.mode} onChange={() => change({ lateMode: option.mode })} />
                      {option.label}
                    </label>
                  ))}
                </fieldset>
                {form.lateMode === 'desconto' && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Input id={FIELD_IDS['latePolicy.penaltyPerDayPct']} type="number" inputMode="numeric" min={1} max={100} label="Desconto por dia de atraso (%)"
                      value={form.penaltyPerDayPct} onChange={(event) => change({ penaltyPerDayPct: event.target.value })} error={errors['latePolicy.penaltyPerDayPct']} />
                    <Input id={FIELD_IDS['latePolicy.penaltyMaxPct']} type="number" inputMode="numeric" min={1} max={100} label="Desconto máximo (%)"
                      value={form.penaltyMaxPct} onChange={(event) => change({ penaltyMaxPct: event.target.value })} error={errors['latePolicy.penaltyMaxPct']} />
                  </div>
                )}
                <p className="text-sm text-muted">O aluno lê: “{latePolicyText({ mode: form.lateMode, penaltyPerDayPct: form.penaltyPerDayPct, penaltyMaxPct: form.penaltyMaxPct })}”</p>
                <label className="flex min-h-[44px] items-center gap-2 text-sm text-text">
                  <input type="checkbox" checked={form.countsInAverage} onChange={(event) => change({ countsInAverage: event.target.checked })} />
                  Conta na média
                </label>
              </Card>
            </fieldset>

            {!locked || busy ? (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="ghost" className="min-h-[44px] sm:min-h-0" disabled={busy} onClick={() => navigate('/tarefas')}>Cancelar</Button>
                {(!editing || assignment?.status === 'rascunho') && (
                  <Button type="submit" variant="secondary" icon={Save} loading={busy} className="min-h-[44px] sm:min-h-0">{editing ? 'Salvar rascunho' : 'Salvar como rascunho'}</Button>
                )}
                {(!editing || assignment?.status === 'rascunho') ? (
                  <Button type="button" icon={Send} loading={busy} className="min-h-[44px] sm:min-h-0" onClick={() => save(true)}>{editing ? 'Salvar e publicar' : 'Publicar'}</Button>
                ) : (
                  <Button type="submit" icon={Save} loading={busy} className="min-h-[44px] sm:min-h-0">Salvar alterações</Button>
                )}
              </div>
            ) : null}
          </form>
        )}
      </PageState>
    </div>
  )
}
