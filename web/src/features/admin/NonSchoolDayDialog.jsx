import { useEffect, useState } from 'react'
import { Save, Trash2 } from 'lucide-react'
import { Modal } from '../../components/ui/Modal'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { api } from '../../lib/api'

// Diálogos dos dias não letivos no Calendário do painel (B7 / P2-S6, FUN-15). Quem decide
// o que a conta pode é o servidor (GET /api/admin/calendar/non-school-days devolve os
// escopos que ela usa e podeAlterar em cada dia; as rotas de gravar conferem de novo).
//
// - NonSchoolDayDialog: cadastrar, alterar e excluir um dia (feriado, recesso de vários
//   dias, ponto facultativo, evento escolar), para a turma, o curso, a escola ou a
//   instituição, conforme os escopos que a conta tem. O erro de um campo aparece embaixo
//   dele (o servidor diz qual com field).
// - NationalHolidaysDialog: os feriados nacionais de um ano, calculados pelo servidor sem
//   internet, com caixas de marcar; o ponto facultativo (Carnaval, Corpus Christi) pode
//   ser desmarcado; o que já está cadastrado aparece marcado e travado.

const SCOPE_TEXT = {
  turma: (ctx) => `Só a turma ${ctx.studentClass || ''}`.trim(),
  curso: (ctx) => `Todo o curso ${ctx.courseName || ''}`.trim(),
  escola: (ctx) => (ctx.escolaNome ? `Toda a escola ${ctx.escolaNome}` : 'Toda a escola'),
  instituicao: () => 'Toda a instituição',
}

const DEFAULT_TYPES = [
  { value: 'feriado', label: 'Feriado' },
  { value: 'recesso', label: 'Recesso' },
  { value: 'ponto_facultativo', label: 'Ponto facultativo' },
  { value: 'evento_escolar', label: 'Evento escolar' },
  { value: 'outro', label: 'Outro' },
]

function blankDay(date, escopos) {
  const preferido = escopos.some((item) => item.value === 'turma') ? 'turma' : (escopos[0]?.value || 'turma')
  return { id: null, nome: '', tipo: 'feriado', inicio: date || '', fim: '', escopo: preferido }
}

function fromDay(day) {
  return { id: day.id, nome: day.nome || '', tipo: day.tipo || 'feriado', inicio: day.inicio || '', fim: day.fim && day.fim !== day.inicio ? day.fim : '', escopo: day.escopo }
}

// ' 2 presenças automáticas do acesso deixam de contar na frequência.' (vazio com 0).
// effect: 'sai' (deixa de contar) ou 'volta' (volta a contar).
function presencasText(count, effect) {
  if (!count) return ''
  const one = count === 1
  const verb = effect === 'volta' ? (one ? 'volta a contar' : 'voltam a contar') : (one ? 'deixa de contar' : 'deixam de contar')
  return ` ${count} ${one ? 'presença automática' : 'presenças automáticas'} do acesso ${verb} na frequência.`
}

// day: o dia a alterar (da lista do servidor) ou null para um novo; initialDate: a data
// clicada no calendário. context: { courseId, courseName, studentClass, schoolId,
// escolaNome }. escopos/tipos: as listas da resposta do servidor.
export function NonSchoolDayDialog({ open, onClose, onSaved, day = null, initialDate = '', context, escopos = [], tipos = DEFAULT_TYPES, toast }) {
  const [form, setForm] = useState(() => blankDay(initialDate, escopos))
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  // Cada abertura começa do dia escolhido (ou em branco), sem o erro da vez anterior.
  useEffect(() => {
    if (!open) return
    setForm(day ? fromDay(day) : blankDay(initialDate, escopos))
    setErrors({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, day, initialDate])

  const set = (patch) => setForm((current) => ({ ...current, ...patch }))
  // O dia de um escopo que a conta não usa (ex.: o da instituição aberto pelo professor)
  // não chega aqui: a tela abre só para leitura. Ao alterar, o escopo de hoje fica na
  // lista mesmo que o servidor não o ofereça para um dia novo.
  const scopeOptions = escopos.length ? escopos : [{ value: form.escopo, label: form.escopo }]
  const hasScope = (value) => scopeOptions.some((item) => item.value === value)

  function payload() {
    const out = {
      inicio: form.inicio,
      fim: form.fim || null,
      tipo: form.tipo,
      nome: form.nome.trim(),
      escopo: form.escopo,
    }
    if (form.escopo === 'escola') out.schoolId = day?.escopo === 'escola' && day.schoolId ? day.schoolId : (context.schoolId || null)
    if (form.escopo === 'curso' || form.escopo === 'turma') out.courseId = day && day.escopo === form.escopo && day.courseId ? day.courseId : context.courseId
    if (form.escopo === 'turma') out.studentClass = day && day.escopo === 'turma' && day.studentClass ? day.studentClass : context.studentClass
    if (form.id) out.id = form.id
    return out
  }

  async function save() {
    const local = {}
    if (!form.nome.trim()) local.nome = 'Informe o nome (por exemplo: Proclamação da República).'
    if (!form.inicio) local.inicio = 'Informe a data.'
    if (form.fim && form.inicio && form.fim < form.inicio) local.fim = 'A data de fim não pode ser antes da data de início.'
    if (Object.keys(local).length) { setErrors(local); return }
    setBusy(true)
    setErrors({})
    try {
      const result = form.id
        ? await api.post('/api/admin/calendar/non-school-days/update', payload())
        : await api.post('/api/admin/calendar/non-school-days/create', payload())
      if (result?.semMudanca) toast?.success('Nada mudou neste dia.')
      else if (form.id) toast?.success(`Dia não letivo alterado.${presencasText(result?.marcadas, 'sai')}${presencasText(result?.desmarcadas, 'volta')}`)
      else toast?.success(`Dia não letivo cadastrado.${presencasText(result?.presencasIgnoradas, 'sai')}`)
      onSaved?.()
      onClose()
    } catch (error) {
      const field = error?.data?.field
      if (field && ['nome', 'inicio', 'fim', 'tipo', 'escopo'].includes(field)) setErrors({ [field]: error.message })
      else setErrors({ geral: error.message })
    } finally { setBusy(false) }
  }

  async function remove() {
    const result = await api.post('/api/admin/calendar/non-school-days/delete', { id: form.id })
    toast?.success(`Dia não letivo excluído.${presencasText(result?.presencasDevolvidas, 'volta')}`)
    setConfirmRemove(false)
    onSaved?.()
    onClose()
  }

  return (
    <>
      <Modal
        open={open && !confirmRemove}
        onClose={() => { if (!busy) onClose() }}
        title={form.id ? 'Alterar dia não letivo' : 'Novo dia não letivo'}
        description="Nesse dia não há aula: a chamada não é cobrada e a presença automática do acesso não conta na frequência."
        fullScreenOnPhone
        footer={<>
          {form.id && <Button variant="destructive" icon={Trash2} disabled={busy} onClick={() => setConfirmRemove(true)}>Excluir</Button>}
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancelar</Button>
          <Button icon={Save} loading={busy} onClick={save}>Salvar</Button>
        </>}
      >
        <div className="space-y-3">
          <Input id="nl-nome" label="Nome" value={form.nome} maxLength={80} error={errors.nome} onChange={(event) => set({ nome: event.target.value })} placeholder="Ex.: Proclamação da República" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input id="nl-inicio" type="date" label="Data (ou início)" value={form.inicio} error={errors.inicio} onChange={(event) => set({ inicio: event.target.value })} />
            <Input id="nl-fim" type="date" label="Até (para vários dias)" value={form.fim} min={form.inicio || undefined} error={errors.fim} helper="Deixe em branco para um dia só." onChange={(event) => set({ fim: event.target.value })} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select id="nl-tipo" label="Tipo" value={form.tipo} error={errors.tipo} onChange={(event) => set({ tipo: event.target.value })}>
              {(tipos.length ? tipos : DEFAULT_TYPES).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </Select>
            <Select id="nl-escopo" label="Para quem vale" value={form.escopo} error={errors.escopo} onChange={(event) => set({ escopo: event.target.value })}>
              {!hasScope(form.escopo) && <option value={form.escopo}>{(SCOPE_TEXT[form.escopo] || (() => form.escopo))(context)}</option>}
              {scopeOptions.map((item) => <option key={item.value} value={item.value}>{(SCOPE_TEXT[item.value] || (() => item.label))(day && day.escopo === item.value && day.escopo === 'turma' ? { ...context, studentClass: day.studentClass } : context)}</option>)}
            </Select>
          </div>
          {errors.geral && <p role="alert" className="text-sm text-danger">{errors.geral}</p>}
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={remove}
        title="Excluir este dia não letivo?"
        message="O dia volta a ter aula pela grade: a chamada volta a ser cobrada e as presenças automáticas do acesso nesse dia voltam a contar na frequência."
        confirmLabel="Excluir"
        tone="danger"
      />
    </>
  )
}

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!match) return value || ''
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
  return date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

function holidayRange(item) {
  return item.fim && item.fim !== item.inicio ? `${formatDate(item.inicio)} a ${formatDate(item.fim)}` : formatDate(item.inicio)
}

// Feriados nacionais do ano: o servidor calcula a lista (GET .../national-holidays?ano=) e
// cria só os marcados que ainda não existem (POST .../national-holidays { ano, incluir }).
export function NationalHolidaysDialog({ open, onClose, onSaved, initialYear, toast }) {
  const thisYear = new Date().getFullYear()
  const [ano, setAno] = useState(initialYear || thisYear)
  const [state, setState] = useState({ loading: false, error: null, feriados: [] })
  const [chosen, setChosen] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => { if (open) { setAno(initialYear || thisYear); setSaveError('') } }, [open, initialYear, thisYear])

  useEffect(() => {
    if (!open) return undefined
    let alive = true
    setState({ loading: true, error: null, feriados: [] })
    api.get(`/api/admin/calendar/non-school-days/national-holidays?ano=${encodeURIComponent(ano)}`)
      .then((result) => {
        if (!alive) return
        const feriados = result?.feriados || []
        setState({ loading: false, error: null, feriados })
        // Todos marcados (o ponto facultativo também: desmarca quem tem aula nesse dia).
        setChosen(new Set(feriados.filter((item) => !item.jaCadastrado).map((item) => item.chave)))
      })
      .catch((error) => { if (alive) setState({ loading: false, error, feriados: [] }) })
    return () => { alive = false }
  }, [open, ano])

  const pending = state.feriados.filter((item) => !item.jaCadastrado)
  const toggle = (chave) => setChosen((current) => {
    const next = new Set(current)
    if (next.has(chave)) next.delete(chave)
    else next.add(chave)
    return next
  })

  async function add() {
    setBusy(true)
    setSaveError('')
    try {
      const incluir = pending.filter((item) => chosen.has(item.chave)).map((item) => item.chave)
      const result = await api.post('/api/admin/calendar/non-school-days/national-holidays', { ano, incluir })
      const criados = result?.criados?.length || 0
      toast?.success(criados
        ? `${criados} ${criados === 1 ? 'feriado adicionado' : 'feriados adicionados'} ao calendário de ${ano}.${presencasText(result?.presencasIgnoradas, 'sai')}`
        : `Os feriados de ${ano} já estavam no calendário.`)
      onSaved?.()
      onClose()
    } catch (error) {
      setSaveError(error.message)
    } finally { setBusy(false) }
  }

  const selectedCount = pending.filter((item) => chosen.has(item.chave)).length
  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose() }}
      title={`Adicionar feriados nacionais de ${ano}`}
      description="Valem para toda a instituição. Carnaval e Corpus Christi são ponto facultativo: desmarque se a escola tem aula nesses dias. Estaduais e municipais você cadastra em Dia não letivo."
      fullScreenOnPhone
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Cancelar</Button>
        <Button loading={busy} disabled={state.loading || !!state.error || selectedCount === 0} onClick={add}>
          {selectedCount ? `Adicionar ${selectedCount} ${selectedCount === 1 ? 'feriado' : 'feriados'}` : 'Adicionar'}
        </Button>
      </>}
    >
      <div className="space-y-3">
        <Select id="nl-ano" label="Ano" value={String(ano)} onChange={(event) => setAno(Number(event.target.value))}>
          {[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((year) => <option key={year} value={year}>{year}</option>)}
        </Select>
        {state.loading && <p className="text-sm text-muted">Calculando os feriados de {ano}…</p>}
        {state.error && <p role="alert" className="text-sm text-danger">{state.error.message}</p>}
        {!state.loading && !state.error && (
          <ul aria-label={`Feriados nacionais de ${ano}`} className="divide-y divide-border rounded-lg border border-border">
            {state.feriados.map((item) => {
              const id = `nl-feriado-${item.chave}`
              return (
                <li key={item.chave} className="flex items-start gap-3 px-3 py-2.5">
                  <input
                    id={id}
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0"
                    checked={item.jaCadastrado || chosen.has(item.chave)}
                    disabled={item.jaCadastrado || busy}
                    onChange={() => toggle(item.chave)}
                  />
                  <label htmlFor={id} className="min-w-0 flex-1 text-sm text-text">
                    <span className="font-medium">{item.nome}</span>
                    <span className="block text-xs text-muted">
                      {holidayRange(item)}
                      {' · '}{item.tipoRotulo || item.tipo}
                      {item.jaCadastrado ? ' · já está no calendário' : ''}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
        {!state.loading && !state.error && state.feriados.length > 0 && pending.length === 0 && (
          <p className="text-sm text-muted">Todos os feriados nacionais de {ano} já estão no calendário.</p>
        )}
        {saveError && <p role="alert" className="text-sm text-danger">{saveError}</p>}
      </div>
    </Modal>
  )
}
