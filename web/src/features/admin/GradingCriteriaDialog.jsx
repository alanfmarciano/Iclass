import { useEffect, useRef, useState } from 'react'
import { Eye, Plus, Trash2 } from 'lucide-react'
import { Modal } from '../../components/ui/Modal'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Switch } from '../../components/ui/Switch'
import { Badge } from '../../components/ui/Badge'
import { PageState } from '../../components/ui/PageState'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { fmtGradeValue } from '../../lib/grades'
import { useToast } from '../../context/ToastProvider'
import { GradeReasonDialog, isReasonRequiredError } from './GradeReasonDialog'

// Critérios de avaliação do curso (fase 3, B9 / P2-S4; FUN-02): média mínima, frequência
// mínima, etapas com peso, regra de recuperação na etapa e no fim, menções e a unidade da
// situação. Lê e grava em /api/admin/grading/criteria (B6): quem tem course.manage altera;
// quem só abre Resultados (professor, Coordenação) vê os critérios sem alterar
// (podeAlterar). A prévia (POST /grading/preview) diz quem muda de média e de situação
// antes de gravar. A conta é toda do servidor (C1 do P2); a tela só monta o pedido.

// Menções sugeridas ao ligar (a mais baixa sempre a partir de 0,0).
export const MENCOES_SUGERIDAS = [
  { sigla: 'MB', nome: 'Muito bom', min: '9' },
  { sigla: 'B', nome: 'Bom', min: '7' },
  { sigla: 'R', nome: 'Regular', min: '6' },
  { sigla: 'I', nome: 'Insuficiente', min: '0' },
]

const numText = (value) => (value === null || value === undefined ? '' : String(value).replace('.', ','))

// Formulário (textos digitados) a partir dos critérios do servidor.
export function formFromCriteria(data) {
  const c = data?.criterios || data?.padrao || {}
  return {
    ativo: data?.ativo === true,
    mediaMinima: numText(c.mediaMinima ?? 6),
    frequenciaMinima: numText(c.frequenciaMinima ?? 75),
    etapas: (Array.isArray(c.etapas) && c.etapas.length ? c.etapas : [{ ordem: 1, nome: 'Etapa única', peso: 1 }])
      .map((etapa) => ({ nome: etapa.nome || '', peso: numText(etapa.peso ?? 1) })),
    recuperacaoEtapa: c.recuperacao?.etapa || 'nenhuma',
    recuperacaoFinal: c.recuperacao?.final || 'substitui_se_maior',
    usarMencoes: Array.isArray(c.mencoes) && c.mencoes.length > 0,
    mencoes: (Array.isArray(c.mencoes) && c.mencoes.length ? c.mencoes : MENCOES_SUGERIDAS)
      .map((item) => ({ sigla: item.sigla || '', nome: item.nome || '', min: numText(item.min) })),
    unidadeSituacao: c.unidadeSituacao || 'disciplina',
  }
}

// Corpo do pedido (números com vírgula vão como texto: o servidor aceita a vírgula).
export function criteriaPayload(form) {
  const num = (text) => {
    const value = String(text ?? '').trim()
    return value === '' ? undefined : value
  }
  return {
    ativo: form.ativo === true,
    mediaMinima: num(form.mediaMinima),
    frequenciaMinima: num(form.frequenciaMinima),
    etapas: form.etapas.map((etapa, index) => ({ ordem: index + 1, nome: String(etapa.nome || '').trim() || `Etapa ${index + 1}`, peso: num(etapa.peso) })),
    recuperacao: { etapa: form.recuperacaoEtapa, final: form.recuperacaoFinal },
    mencoes: form.usarMencoes
      ? form.mencoes.map((item) => ({ sigla: String(item.sigla || '').trim(), nome: String(item.nome || '').trim(), min: num(item.min) }))
      : null,
    unidadeSituacao: form.unidadeSituacao,
  }
}

// Exemplo em uma frase de cada regra de recuperação (números de exemplo, sem conta).
export function recoveryExample(rule, mediaMinimaText) {
  const minima = String(mediaMinimaText || '').trim() || '6,0'
  if (rule === 'substitui_se_maior') return 'Ex.: média 4,0 e recuperação 7,0: fica 7,0. Recuperação 3,0: fica 4,0.'
  if (rule === 'media') return 'Ex.: média 4,0 e recuperação 7,0: fica 5,5 (a média das duas), se for maior que 4,0.'
  if (rule === 'ate_a_minima') return `Ex.: média 4,0 e recuperação 9,0: fica ${minima} (a média mínima).`
  return 'A nota fica como está; a recuperação não muda a média.'
}

// Campo do erro do servidor (com ou sem o prefixo "criterios." da prévia).
function errorField(error) {
  return String(error?.data?.field || '').replace(/^criterios\./, '')
}

export function GradingCriteriaDialog({ open, onClose, course, onSaved }) {
  const toast = useToast()
  const courseId = course?.id ? String(course.id) : ''
  const criteriaApi = useApi(open && courseId ? `/api/admin/grading/criteria?courseId=${encodeURIComponent(courseId)}` : null, [open])
  const data = criteriaApi.data
  const [form, setForm] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [reasonOpen, setReasonOpen] = useState(false)
  // A prévia aparece no fim do formulário: rola até ela quando chega (no celular o Salvar
  // fica preso embaixo e a prévia poderia ficar fora da tela).
  const previewRef = useRef(null)
  useEffect(() => { if (preview) previewRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }) }, [preview])

  useEffect(() => {
    if (!open) { setForm(null); setError(null); setPreview(null); return }
    if (data) setForm(formFromCriteria(data))
  }, [open, data])

  const canEdit = data?.podeAlterar === true
  const limites = data?.limites || { etapasMax: 6, mencoesMax: 8 }
  const field = errorField(error)
  const fieldError = (name) => (error && field === name ? error.message : undefined)
  const general = error && !/^(mediaMinima|frequenciaMinima|unidadeSituacao|etapas\[\d+\]\.\w+|mencoes\[\d+\]\.\w+|recuperacao\.\w+)$/.test(field) ? error.message : ''

  const update = (patch) => { setForm((current) => ({ ...current, ...patch })); setError(null); setPreview(null) }
  const updateEtapa = (index, patch) => update({ etapas: form.etapas.map((etapa, i) => (i === index ? { ...etapa, ...patch } : etapa)) })
  const updateMention = (index, patch) => update({ mencoes: form.mencoes.map((item, i) => (i === index ? { ...item, ...patch } : item)) })

  // Devolve true quando a prévia chegou (o Salvar só grava depois de mostrá-la).
  async function runPreview() {
    setPreviewing(true)
    setError(null)
    try {
      const { ativo, ...criterios } = criteriaPayload(form)
      setPreview(await api.post('/api/admin/grading/preview', { courseId, criterios: { ...criterios, ativo } }))
      return true
    } catch (e) {
      setError(e)
      return false
    } finally {
      setPreviewing(false)
    }
  }

  async function send(reason = '') {
    const result = await api.post('/api/admin/grading/criteria', { courseId, ...criteriaPayload(form), ...(reason ? { reason } : {}) })
    toast.success(result?.semMudanca ? 'Nada mudou nos critérios.' : (form.ativo ? 'Critérios de avaliação salvos.' : 'Critérios desligados: o curso volta à média de sempre.'))
    setReasonOpen(false)
    await criteriaApi.refetch()
    onSaved?.()
    onClose?.()
  }

  async function save() {
    // Critérios ligados: a prévia (quem muda de média e de situação) aparece antes de
    // gravar. O primeiro Salvar sem prévia mostra a prévia; o segundo grava (a prévia some
    // a cada mudança no formulário, e o Salvar volta a mostrá-la).
    if (form.ativo && !preview) { await runPreview(); return }
    // Com nota publicada no curso, o motivo é pedido antes (o servidor confere de novo).
    if (data?.temNotaPublicada && (form.ativo || data?.ativo)) { setReasonOpen(true); return }
    setSaving(true)
    setError(null)
    try {
      await send('')
    } catch (e) {
      if (isReasonRequiredError(e)) setReasonOpen(true)
      else setError(e)
    } finally {
      setSaving(false)
    }
  }

  const footer = canEdit
    ? <><Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>{form?.ativo && <Button variant="secondary" icon={Eye} loading={previewing} onClick={runPreview}>Ver prévia</Button>}<Button loading={saving || (previewing && !preview)} onClick={save} disabled={!form}>Salvar critérios</Button></>
    : <Button variant="secondary" onClick={onClose}>Fechar</Button>

  return (
    <>
      <Modal open={open} onClose={saving ? () => {} : onClose} size="lg" fullScreenOnPhone
        title="Critérios de avaliação"
        description={`${data?.courseName || course?.name || ''}: como a média final e a situação do aluno são calculadas em todas as turmas do curso.`}
        footer={footer}>
        <PageState loading={criteriaApi.loading && !data} error={criteriaApi.error} onRetry={criteriaApi.refetch}>
          {form && (
            <div className="space-y-4">
              {!canEdit && <p className="rounded-lg bg-info-soft px-3 py-2 text-sm text-info">Você vê os critérios do curso. Só quem gerencia cursos pode alterá-los.</p>}
              <Switch id="criterios-ativo" checked={form.ativo} disabled={!canEdit} onChange={(ativo) => update({ ativo })} label="Usar critérios de avaliação neste curso" />
              {!form.ativo && (
                <p className="text-sm text-muted">Desligado, a média do aluno é a média das notas publicadas, como sempre, e a média mínima é 6,0. Os valores abaixo ficam guardados para quando você ligar.</p>
              )}
              {data?.temNotaPublicada && canEdit && <p className="text-xs text-warning">O curso já tem notas publicadas: ao salvar, pedimos um motivo, que fica na auditoria.</p>}

              <fieldset disabled={!canEdit} className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Input label="Média mínima (0 a 10)" inputMode="decimal" value={form.mediaMinima} error={fieldError('mediaMinima')} onChange={(e) => update({ mediaMinima: e.target.value })} />
                  <Input label="Frequência mínima (%)" inputMode="numeric" value={form.frequenciaMinima} error={fieldError('frequenciaMinima')} onChange={(e) => update({ frequenciaMinima: e.target.value })} />
                  <Select label="Situação do aluno" value={form.unidadeSituacao} error={fieldError('unidadeSituacao')} onChange={(e) => update({ unidadeSituacao: e.target.value })}>
                    {(data?.unidades || [{ value: 'disciplina', label: 'Por disciplina' }, { value: 'turma', label: 'Uma situação para a turma' }]).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </Select>
                </div>

                <section aria-label="Etapas" className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-text">Etapas</h3>
                    <Button size="sm" variant="secondary" icon={Plus} disabled={form.etapas.length >= limites.etapasMax}
                      onClick={() => update({ etapas: [...form.etapas, { nome: `${form.etapas.length + 1}ª etapa`, peso: '1' }] })}>Adicionar etapa</Button>
                  </div>
                  <p className="text-xs text-subtle">A média final é a média das etapas pelo peso de cada uma (de 1 a {limites.etapasMax} etapas).</p>
                  {fieldError('etapas') && <p role="alert" className="text-sm text-danger">{fieldError('etapas')}</p>}
                  <ol className="space-y-2">
                    {form.etapas.map((etapa, index) => (
                      <li key={index} className="grid grid-cols-[1fr_6rem_auto] items-end gap-2">
                        <Input label={`Nome da etapa ${index + 1}`} value={etapa.nome} maxLength={40} error={fieldError(`etapas[${index}].nome`) || fieldError(`etapas[${index}].ordem`)} onChange={(e) => updateEtapa(index, { nome: e.target.value })} />
                        <Input label="Peso" inputMode="decimal" value={etapa.peso} error={fieldError(`etapas[${index}].peso`)} onChange={(e) => updateEtapa(index, { peso: e.target.value })} />
                        <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Tirar a etapa ${index + 1}`} disabled={form.etapas.length <= 1}
                          onClick={() => update({ etapas: form.etapas.filter((_, i) => i !== index) })} />
                      </li>
                    ))}
                  </ol>
                </section>

                <section aria-label="Recuperação" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Select label="Recuperação de cada etapa" value={form.recuperacaoEtapa} error={fieldError('recuperacao.etapa')} onChange={(e) => update({ recuperacaoEtapa: e.target.value })}>
                      {(data?.regrasRecuperacao || []).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </Select>
                    <p className="mt-1 text-xs text-subtle">{recoveryExample(form.recuperacaoEtapa, form.mediaMinima)}</p>
                  </div>
                  <div>
                    <Select label="Recuperação final" value={form.recuperacaoFinal} error={fieldError('recuperacao.final')} onChange={(e) => update({ recuperacaoFinal: e.target.value })}>
                      {(data?.regrasRecuperacao || []).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </Select>
                    <p className="mt-1 text-xs text-subtle">{recoveryExample(form.recuperacaoFinal, form.mediaMinima)}</p>
                  </div>
                </section>

                <section aria-label="Menções" className="space-y-2">
                  <Switch id="criterios-mencoes" checked={form.usarMencoes} disabled={!canEdit} onChange={(usarMencoes) => update({ usarMencoes })} label="Mostrar menção (conceito) além da nota" />
                  {fieldError('mencoes') && <p role="alert" className="text-sm text-danger">{fieldError('mencoes')}</p>}
                  {form.usarMencoes && (
                    <>
                      <p className="text-xs text-subtle">Cada menção vale da nota mínima dela para cima. A mais baixa começa em 0,0.</p>
                      <ol className="space-y-2">
                        {form.mencoes.map((item, index) => (
                          <li key={index} className="grid grid-cols-[4.5rem_1fr_5.5rem_auto] items-end gap-2">
                            <Input label="Sigla" value={item.sigla} maxLength={4} error={fieldError(`mencoes[${index}].sigla`)} onChange={(e) => updateMention(index, { sigla: e.target.value })} />
                            <Input label="Nome" value={item.nome} maxLength={30} error={fieldError(`mencoes[${index}].nome`)} onChange={(e) => updateMention(index, { nome: e.target.value })} />
                            <Input label="A partir de" inputMode="decimal" value={item.min} error={fieldError(`mencoes[${index}].min`)} onChange={(e) => updateMention(index, { min: e.target.value })} />
                            <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Tirar a menção ${item.sigla || index + 1}`} disabled={form.mencoes.length <= 1}
                              onClick={() => update({ mencoes: form.mencoes.filter((_, i) => i !== index) })} />
                          </li>
                        ))}
                      </ol>
                      <Button size="sm" variant="secondary" icon={Plus} disabled={form.mencoes.length >= limites.mencoesMax}
                        onClick={() => update({ mencoes: [...form.mencoes, { sigla: '', nome: '', min: '' }] })}>Adicionar menção</Button>
                    </>
                  )}
                </section>
              </fieldset>

              {general && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{general}</p>}

              {preview && (
                <section ref={previewRef} aria-label="Prévia" aria-live="polite" className="space-y-2 rounded-xl border border-border bg-surface-2 p-3">
                  <p className="text-sm font-medium text-text">{preview.resumo}</p>
                  {(preview.mudancas || []).length > 0 && (
                    <ul className="max-h-56 divide-y divide-border overflow-auto text-sm">
                      {preview.mudancas.slice(0, 50).map((item) => (
                        <li key={`${item.studentClass}:${item.email}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                          <span className="min-w-0 truncate text-text">{item.nome} <span className="text-xs text-subtle">· {item.studentClass}</span></span>
                          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                            {item.mediaAntes !== item.mediaDepois && <span className="tabular-nums">{fmtGradeValue(item.mediaAntes, '-')} → {fmtGradeValue(item.mediaDepois, '-')}</span>}
                            {item.situacaoAntesRotulo !== item.situacaoDepoisRotulo && <Badge tone="info">{item.situacaoAntesRotulo || 'Média de sempre'} → {item.situacaoDepoisRotulo || 'Média de sempre'}</Badge>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-subtle">Prévia: nada foi gravado ainda. Confira e toque em Salvar critérios para gravar.</p>
                </section>
              )}
            </div>
          )}
        </PageState>
      </Modal>
      <GradeReasonDialog open={reasonOpen} onClose={() => setReasonOpen(false)} onConfirm={async (reason) => {
        try { await send(reason) } catch (e) { if (!isReasonRequiredError(e)) { setReasonOpen(false); setError(e) } else throw e }
      }}
        title="Salvar os critérios de avaliação?" confirmLabel="Salvar critérios" reason="required"
        note="O curso já tem notas publicadas e a regra muda a média dos alunos. O motivo fica na auditoria." />
    </>
  )
}
