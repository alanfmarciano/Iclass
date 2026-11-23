import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Archive, Info, Pencil, Plus, RotateCcw, Save } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Modal } from '../../components/ui/Modal'
import { PageState } from '../../components/ui/PageState'
import { Select } from '../../components/ui/Select'
import { Textarea } from '../../components/ui/Textarea'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { GradeReasonDialog, isReasonRequiredError } from './GradeReasonDialog'
import { fmtWeight } from './GradebookPanel'

// Plano de avaliação da turma em Resultados (fase 3, B9 / P2-S4; FUN-02). Uma linha por
// avaliação da turma (provas da estrutura, avaliações manuais e, depois, tarefas) com a
// etapa, o peso, "Recuperação de" e "Não conta"; e as avaliações manuais (trabalho,
// prática, seminário...), que o professor cria aqui e lança a nota em "Lançar nota". As
// regras são do servidor (GET/POST /api/admin/grading/plan e /grading/manual-items/*,
// B6): a tela só monta o pedido, mostra a recusa no campo que o servidor apontou e pede o
// motivo quando o servidor responde reason_required (nota já publicada). Nenhuma média é
// calculada aqui.
//
// plan: o resultado de useApi de GET /api/admin/grading/plan (Resultados também usa a
// lista de avaliações manuais no "Lançar nota"). onChanged: depois de gravar (o quadro e a
// lista de notas recarregam).

// Peso digitado ("2,5") -> número, ou NaN. Vazio = 1 (o padrão do servidor).
export function parseWeightInput(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return 1
  if (!/^\d{1,2}(?:[.,]\d)?$/.test(raw)) return NaN
  const n = Number(raw.replace(',', '.'))
  return n >= 0.1 && n <= 10 ? n : NaN
}

const EMPTY_MANUAL = { id: '', titulo: '', tipo: 'trabalho', data: '', moduloId: '', etapa: '', peso: '1', descricao: '' }

function draftOf(item) {
  return {
    etapa: item.etapa === null || item.etapa === undefined ? '' : String(item.etapa),
    peso: fmtWeight(item.peso ?? 1),
    recuperacaoDe: item.recuperacaoDe || '',
    fora: item.fora === true,
  }
}

// Itens que mudaram, no formato do POST /grading/plan. Devolve { itens, erros }.
export function planChanges(itens, drafts) {
  const out = {}
  const erros = {}
  ;(itens || []).forEach((item) => {
    const draft = drafts[item.id]
    if (!draft) return
    const base = draftOf(item)
    const peso = parseWeightInput(draft.peso)
    if (Number.isNaN(peso)) { erros[item.id] = 'Peso de 0,1 a 10 (ex.: 2 ou 1,5).'; return }
    const change = {}
    if (draft.etapa !== base.etapa) change.etapa = draft.etapa === '' ? null : Number(draft.etapa)
    if (peso !== parseWeightInput(base.peso)) change.peso = peso
    if (draft.recuperacaoDe !== base.recuperacaoDe) change.recuperacaoDe = draft.recuperacaoDe || null
    if (draft.fora !== base.fora) change.fora = draft.fora
    if (Object.keys(change).length) out[item.id] = change
  })
  return { itens: out, erros }
}

// 'itens.<id>.peso' -> { id, campo }.
function planErrorField(field) {
  const match = /^itens\.(.+)\.(etapa|peso|recuperacaoDe|fora)$/.exec(String(field || ''))
  return match ? { id: match[1], campo: match[2] } : null
}

const ORIGEM_ROTULO = { prova: 'Prova', manual: 'Avaliação da turma', tarefa: 'Tarefa' }

function ManualDialog({ open, form, setForm, plan, saving, error, onClose, onSave }) {
  if (!form) return null
  const etapas = plan?.etapas || []
  const fieldError = (name) => (error?.field === name ? error.message : undefined)
  const general = error && !['titulo', 'tipo', 'data', 'moduloId', 'etapa', 'peso', 'descricao'].includes(error.field) ? error.message : ''
  return (
    <Modal open={open} onClose={saving ? () => {} : onClose} fullScreenOnPhone
      title={form.id ? 'Alterar avaliação da turma' : 'Nova avaliação da turma'}
      description="Trabalho, prática, seminário ou participação: sem questões, você lança só a nota (0 a 10) em Lançar nota."
      footer={<><Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button><Button loading={saving} onClick={onSave}>Salvar</Button></>}>
      <div className="space-y-3">
        <Input label="Título" value={form.titulo} maxLength={120} error={fieldError('titulo')} onChange={(e) => setForm({ ...form, titulo: e.target.value })} placeholder="Ex.: Seminário de redes" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select label="Tipo" value={form.tipo} error={fieldError('tipo')} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
            {(plan?.tipos || []).map((tipo) => <option key={tipo.value} value={tipo.value}>{tipo.label}</option>)}
          </Select>
          <Input label="Data (opcional)" type="date" value={form.data} error={fieldError('data')} onChange={(e) => setForm({ ...form, data: e.target.value })} />
        </div>
        <Select label="Módulo (opcional)" value={form.moduloId} error={fieldError('moduloId')} onChange={(e) => setForm({ ...form, moduloId: e.target.value })}>
          <option value="">Sem módulo (fica em "Avaliações da turma")</option>
          {(plan?.modulos || []).map((modulo) => <option key={modulo.id} value={modulo.id}>{modulo.nome}</option>)}
        </Select>
        {plan?.ativo && (
          <div className="grid grid-cols-2 gap-3">
            <Select label="Etapa" value={form.etapa} error={fieldError('etapa')} onChange={(e) => setForm({ ...form, etapa: e.target.value })}>
              <option value="">{etapas.length === 1 ? `${etapas[0].nome} (padrão)` : 'Sem etapa'}</option>
              {etapas.length > 1 && etapas.map((etapa) => <option key={etapa.ordem} value={String(etapa.ordem)}>{etapa.nome}</option>)}
            </Select>
            <Input label="Peso" inputMode="decimal" value={form.peso} error={fieldError('peso')} onChange={(e) => setForm({ ...form, peso: e.target.value })} />
          </div>
        )}
        <Textarea label="Descrição (opcional)" value={form.descricao} maxLength={500} onChange={(e) => setForm({ ...form, descricao: e.target.value })} />
        {general && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{general}</p>}
      </div>
    </Modal>
  )
}

export function GradingPlanPanel({ plan, courseId, studentClass, onChanged }) {
  const toast = useToast()
  const data = plan?.data || null
  const [drafts, setDrafts] = useState({})
  const [rowErrors, setRowErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [reasonAsk, setReasonAsk] = useState(null)
  const [manualForm, setManualForm] = useState(null)
  const [manualError, setManualError] = useState(null)
  const [manualSaving, setManualSaving] = useState(false)

  // Plano novo do servidor (gravou, outra pessoa mudou): os rascunhos voltam ao gravado.
  useEffect(() => { setDrafts({}); setRowErrors({}) }, [data])

  const itens = useMemo(() => (data?.itens || []), [data])
  const ativos = itens.filter((item) => !item.arquivado)
  const arquivados = itens.filter((item) => item.arquivado)
  const etapas = data?.etapas || []
  const canEdit = data?.podeAlterar === true
  const planEditable = canEdit && data?.ativo === true
  const manualById = useMemo(() => new Map((data?.manuais || []).map((manual) => [manual.id, manual])), [data])
  const { itens: changes, erros: localErrors } = planChanges(itens, drafts)
  const changedCount = Object.keys(changes).length
  const context = { courseId, studentClass }

  const draft = (item) => drafts[item.id] || draftOf(item)
  const setDraft = (item, patch) => {
    setDrafts((current) => ({ ...current, [item.id]: { ...(current[item.id] || draftOf(item)), ...patch } }))
    setRowErrors((current) => { const next = { ...current }; delete next[item.id]; return next })
  }

  async function afterSave(message) {
    toast.success(message)
    await Promise.all([plan?.refetch?.(), onChanged?.()])
  }

  // Pede o motivo quando o servidor exige (nota publicada) e tenta de novo com ele.
  function withReason(send, { title, confirmLabel, success, onDone }) {
    return async () => {
      try {
        await send('')
        await afterSave(success)
        onDone?.()
      } catch (error) {
        if (!isReasonRequiredError(error)) throw error
        setReasonAsk({
          title,
          confirmLabel,
          note: error.message,
          onConfirm: async (reason) => {
            await send(reason)
            setReasonAsk(null)
            await afterSave(success)
            onDone?.()
          },
        })
      }
    }
  }

  async function savePlan() {
    if (Object.keys(localErrors).length) { setRowErrors(localErrors); return }
    if (!changedCount) return
    setSaving(true)
    try {
      await withReason((reason) => api.post('/api/admin/grading/plan', { ...context, itens: changes, ...(reason ? { reason } : {}) }), {
        title: 'Salvar o plano de avaliação?', confirmLabel: 'Salvar plano', success: 'Plano de avaliação salvo.',
      })()
    } catch (error) {
      const where = planErrorField(error?.data?.field)
      if (where) setRowErrors({ [where.id]: error.message })
      else toast.error(error.message || 'Não foi possível salvar o plano.')
    } finally {
      setSaving(false)
    }
  }

  function openManual(manual) {
    setManualError(null)
    if (!manual) { setManualForm({ ...EMPTY_MANUAL, tipo: data?.tipos?.[0]?.value || 'trabalho' }); return }
    const item = itens.find((entry) => entry.id === manual.id) || {}
    setManualForm({
      id: manual.id,
      titulo: manual.titulo || '',
      tipo: manual.tipo || 'outro',
      data: manual.data || '',
      moduloId: manual.moduloId || '',
      etapa: item.etapa ? String(item.etapa) : '',
      peso: fmtWeight(item.peso ?? 1),
      descricao: manual.descricao || '',
    })
  }

  async function saveManual() {
    const form = manualForm
    if (!form.titulo.trim()) { setManualError({ field: 'titulo', message: 'Informe o título da avaliação.' }); return }
    const peso = parseWeightInput(form.peso)
    if (data?.ativo && Number.isNaN(peso)) { setManualError({ field: 'peso', message: 'Peso de 0,1 a 10 (ex.: 2 ou 1,5).' }); return }
    const body = {
      ...context,
      ...(form.id ? { id: form.id } : {}),
      titulo: form.titulo.trim(),
      tipo: form.tipo,
      data: form.data || null,
      moduloId: form.moduloId || null,
      descricao: form.descricao.trim(),
      ...(data?.ativo ? { etapa: form.etapa === '' ? null : Number(form.etapa), peso } : {}),
    }
    const route = form.id ? '/api/admin/grading/manual-items/update' : '/api/admin/grading/manual-items/create'
    setManualSaving(true)
    setManualError(null)
    try {
      await withReason((reason) => api.post(route, { ...body, ...(reason ? { reason } : {}) }), {
        title: 'Alterar a avaliação com nota publicada?', confirmLabel: 'Salvar',
        success: form.id ? 'Avaliação alterada.' : 'Avaliação criada. Lance a nota em "Lançar nota".',
        onDone: () => setManualForm(null),
      })()
    } catch (error) {
      setManualError({ field: error?.data?.field || null, message: error.message || 'Não foi possível salvar.' })
    } finally {
      setManualSaving(false)
    }
  }

  function toggleArchive(manual, archive) {
    const publicadas = Number(manual.notasPublicadas || 0)
    setReasonAsk({
      title: archive ? `Arquivar "${manual.titulo}"?` : `Reativar "${manual.titulo}"?`,
      confirmLabel: archive ? 'Arquivar' : 'Reativar',
      danger: archive,
      reason: publicadas > 0 ? 'required' : 'optional',
      note: archive
        ? `As notas lançadas (${manual.notasLancadas || 0}) ficam guardadas e saem da média, com aviso no boletim. Dá para reativar depois.`
        : 'As notas lançadas voltam para a média.',
      onConfirm: async (reason) => {
        await api.post(`/api/admin/grading/manual-items/${archive ? 'archive' : 'restore'}`, { ...context, id: manual.id, ...(reason ? { reason } : {}) })
        setReasonAsk(null)
        await afterSave(archive ? 'Avaliação arquivada.' : 'Avaliação reativada.')
      },
    })
  }

  const etapaLabel = etapas.length === 1 ? `${etapas[0].nome} (padrão)` : 'Sem etapa'

  function renderItem(item) {
    const value = draft(item)
    const manual = manualById.get(item.id)
    const error = rowErrors[item.id]
    const disabled = !planEditable || saving
    return (
      <li key={item.id} className="rounded-xl border border-border bg-surface p-3" aria-label={item.titulo}>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_6rem_12rem_7rem] md:items-end">
          <div className="min-w-0">
            <p className="break-words font-medium text-text">{item.titulo}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
              <Badge tone={item.origem === 'prova' ? 'neutral' : 'info'}>{item.tipoRotulo || ORIGEM_ROTULO[item.origem] || item.origem}</Badge>
              {item.modulo && <span className="break-words">{item.modulo}</span>}
              <span>· {item.notasLancadas || 0} nota(s), {item.notasPublicadas || 0} publicada(s)</span>
            </p>
            {manual && canEdit && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => openManual(manual)} aria-label={`Alterar ${item.titulo}`}>Alterar</Button>
                <Button size="sm" variant="ghost" icon={Archive} onClick={() => toggleArchive(manual, true)} aria-label={`Arquivar ${item.titulo}`}>Arquivar</Button>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 md:contents">
            <Select label="Etapa" value={value.etapa} disabled={disabled} onChange={(e) => setDraft(item, { etapa: e.target.value })}>
              <option value="">{etapaLabel}</option>
              {etapas.length > 1 && etapas.map((etapa) => <option key={etapa.ordem} value={String(etapa.ordem)}>{etapa.nome}</option>)}
            </Select>
            <Input label="Peso" inputMode="decimal" value={value.peso} disabled={disabled} onChange={(e) => setDraft(item, { peso: e.target.value })} />
          </div>
          <Select label="Recuperação de" value={value.recuperacaoDe} disabled={disabled} onChange={(e) => setDraft(item, { recuperacaoDe: e.target.value })}>
            <option value="">Não é recuperação</option>
            {etapas.map((etapa) => <option key={etapa.ordem} value={`etapa:${etapa.ordem}`}>{`Recuperação da ${etapa.nome}`}</option>)}
            <option value="final">Recuperação final</option>
          </Select>
          <label className="flex h-[38px] items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={value.fora} disabled={disabled} onChange={(e) => setDraft(item, { fora: e.target.checked })} />
            Não conta
          </label>
        </div>
        {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      </li>
    )
  }

  return (
    <section className="space-y-3" aria-label="Plano de avaliação da turma">
      <PageState loading={plan?.loading && !data} error={plan?.error} onRetry={plan?.refetch}>
        {data && (
          <>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 max-w-2xl text-xs text-subtle">
                A etapa e o peso de cada avaliação da turma {studentClass}. As etapas e os pesos delas, a média mínima e a recuperação são os critérios do curso (Cursos e turmas &gt; Critérios de avaliação).
              </p>
              {canEdit && <Button size="sm" icon={Plus} onClick={() => openManual(null)}>Nova avaliação da turma</Button>}
            </div>
            {!data.ativo && (
              <p className="flex items-start gap-2 rounded-lg bg-info-soft px-3 py-2 text-sm text-info" role="status">
                <Info size={15} className="mt-0.5 shrink-0" />
                <span>Os critérios de avaliação deste curso estão desligados: a média é a simples de todas as notas, como sempre. Etapa, peso, recuperação e "Não conta" passam a valer quando os critérios forem ligados em Cursos e turmas. As avaliações da turma já podem ser criadas e entram na média.</span>
              </p>
            )}
            {data.encerrada && <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning" role="status">Esta turma foi encerrada: o plano não muda mais. Para mudar, reabra a turma em Cursos e turmas.</p>}
            {(data.avisos || []).map((aviso) => (
              <p key={aviso} className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning" role="status">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{aviso}</span>
              </p>
            ))}
            {ativos.length === 0
              ? <p className="rounded-xl border border-border bg-surface px-4 py-8 text-center text-sm text-muted">Nenhuma avaliação nesta turma ainda.</p>
              : <ul className="space-y-2">{ativos.map(renderItem)}</ul>}
            {planEditable && (
              <div className="sticky bottom-2 z-10 flex flex-wrap items-center justify-end gap-2 rounded-xl border border-border bg-surface px-3 py-2 shadow-lg">
                <span className="text-xs text-subtle">{changedCount ? `${changedCount} avaliação(ões) alterada(s)` : 'Nenhuma mudança'}</span>
                <Button variant="ghost" disabled={!changedCount || saving} onClick={() => { setDrafts({}); setRowErrors({}) }}>Desfazer</Button>
                <Button icon={Save} loading={saving} disabled={!changedCount} onClick={savePlan}>Salvar plano</Button>
              </div>
            )}
            {arquivados.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-text">Avaliações arquivadas (fora da média)</h3>
                <ul className="space-y-2">
                  {arquivados.map((item) => {
                    const manual = manualById.get(item.id)
                    return (
                      <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-border p-3">
                        <span className="min-w-0 break-words text-sm text-muted">{item.titulo} · {item.notasLancadas || 0} nota(s) guardada(s)</span>
                        {manual && canEdit && <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => toggleArchive(manual, false)}>Reativar</Button>}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </>
        )}
      </PageState>
      <ManualDialog open={!!manualForm} form={manualForm} setForm={setManualForm} plan={data} saving={manualSaving} error={manualError}
        onClose={() => setManualForm(null)} onSave={saveManual} />
      <GradeReasonDialog open={!!reasonAsk} onClose={() => setReasonAsk(null)} onConfirm={(reason) => reasonAsk.onConfirm(reason)}
        title={reasonAsk?.title} note={reasonAsk?.note} confirmLabel={reasonAsk?.confirmLabel} danger={!!reasonAsk?.danger}
        reason={reasonAsk?.reason || 'required'} />
    </section>
  )
}
