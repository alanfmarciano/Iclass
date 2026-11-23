// Grupos da turma (fase 3, P5-S4, CRIT-11): equipes e subturmas por conjunto ("Projeto
// integrador", "Laboratório"), com criar, alterar quem está em cada um, sortear, arquivar e
// reativar. O aluno fica em no máximo um grupo ativo de cada conjunto (o servidor confere).
// Rotas: /api/admin/class-groups (backend/routes/adminGroups.js). A coordenação (só
// consulta) vê a tela sem os botões; o servidor recusa o resto.
import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Archive, ArrowLeft, Pencil, Plus, RotateCcw, Shuffle, Users } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card, CardBody } from '../../components/ui/Card'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { EmptyState } from '../../components/ui/EmptyState'
import { Input } from '../../components/ui/Input'
import { Modal } from '../../components/ui/Modal'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageState } from '../../components/ui/PageState'
import { Select } from '../../components/ui/Select'
import { Switch } from '../../components/ui/Switch'
import { useAuth } from '../../context/AuthProvider'
import { useToast } from '../../context/ToastProvider'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { displayEmail } from '../../lib/studentProfile'
import { matchesSearch, normalizeSearch } from '../../lib/textSearch'
import { TOUCH, TOUCH_SQUARE } from './tarefas/touch'

export { groupsPath } from './grupos/groupsPath'

const DEFAULT_SET = 'Grupos'
const TYPE_OPTIONS = [
  { value: 'equipe', label: 'Equipe' },
  { value: 'subturma', label: 'Subturma' },
]
const STALE_MESSAGE = 'Outra pessoa mudou este grupo enquanto você editava. A lista foi atualizada: confira e salve de novo.'

const sameSet = (a, b) => normalizeSearch(a) === normalizeSearch(b)
const countText = (n, one, many) => `${n} ${n === 1 ? one : many}`

// Grupo ativo do mesmo conjunto (fora o que está sendo editado) em que o aluno já está.
function otherGroupOf(groups, conjunto, email, exceptId) {
  return groups.find(group => !group.arquivado && group.id !== exceptId && sameSet(group.conjunto, conjunto)
    && group.membros.some(member => member.email === email)) || null
}

function MemberLine({ member }) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 py-1 text-sm">
      <span className="min-w-0 break-words text-text">{member.nome}</span>
      {member.matricula && <span className="text-xs text-subtle">{member.matricula}</span>}
      {!member.naTurma && <Badge tone="warning">Saiu da turma</Badge>}
    </li>
  )
}

function GroupCard({ group, readOnly, onEdit, onArchive, onRestore }) {
  const outside = group.membros.length - group.membrosNaTurma
  return (
    <div className={`min-w-0 rounded-lg border border-border p-4 ${group.arquivado ? 'opacity-75' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words font-semibold text-text">{group.nome}</h3>
          <p className="text-xs text-muted">
            {countText(group.membrosNaTurma, 'aluno', 'alunos')}
            {outside > 0 ? ` · ${countText(outside, 'saiu da turma', 'saíram da turma')}` : ''}
            {group.sorteio ? ' · sorteado' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="info">{group.tipoTexto}</Badge>
          {group.arquivado && <Badge tone="neutral">Arquivado</Badge>}
        </div>
      </div>
      {group.membros.length === 0
        ? <p className="mt-3 text-sm text-muted">Nenhum aluno neste grupo ainda.</p>
        : <ul className="mt-2 divide-y divide-border">{group.membros.map(member => <MemberLine key={member.email} member={member} />)}</ul>}
      {!readOnly && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          {group.arquivado
            ? <Button size="sm" variant="secondary" icon={RotateCcw} className={TOUCH} onClick={() => onRestore(group)}>Reativar</Button>
            : <>
              <Button size="sm" variant="secondary" icon={Pencil} className={TOUCH} aria-label={`Editar o grupo ${group.nome}`} onClick={() => onEdit(group)}>Editar</Button>
              <Button size="sm" variant="ghost" icon={Archive} className={TOUCH} aria-label={`Arquivar o grupo ${group.nome}`} onClick={() => onArchive(group)}>Arquivar</Button>
            </>}
        </div>
      )}
    </div>
  )
}

// Criar ou editar: nome, conjunto, tipo e quem está no grupo. Na edição, marcar quem está
// em outro grupo do mesmo conjunto tira o aluno de lá ("mover", avisado antes de salvar).
function GroupFormModal({ open, mode, group, data, courseId, className, onClose, onSaved, onStale }) {
  const groups = data?.grupos || []
  const alunos = data?.alunos || []
  const [nome, setNome] = useState(group?.nome || '')
  const [conjunto, setConjunto] = useState(group?.conjunto || (data?.conjuntos || []).find(set => groups.some(g => !g.arquivado && sameSet(g.conjunto, set))) || DEFAULT_SET)
  const [tipo, setTipo] = useState(group?.tipo || 'equipe')
  const [selected, setSelected] = useState(() => new Set((group?.membros || []).map(member => member.email)))
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const limits = data?.limites || {}

  const exceptId = group?.id || null
  // A turma e, na edição, quem está no grupo e já saiu dela (aparece marcado; desmarque para tirar).
  const people = useMemo(() => {
    const list = alunos.map(aluno => ({ ...aluno, naTurma: true }))
    ;(group?.membros || []).forEach(member => { if (!member.naTurma) list.push({ email: member.email, nome: member.nome, matricula: member.matricula, naTurma: false }) })
    return list
  }, [alunos, group])
  const visible = people.filter(person => !search.trim() || matchesSearch([person.nome, person.matricula, displayEmail(person.email)].join(' '), search))
  const moving = [...selected].filter(email => otherGroupOf(groups, conjunto, email, exceptId) && !(group?.membros || []).some(member => member.email === email))
  const conjuntoOptions = (data?.conjuntos || []).filter(Boolean)

  function toggle(email) {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })
  }

  async function save() {
    if (saving) return
    const cleanName = nome.trim()
    if (!cleanName) { setError('Escreva o nome do grupo.'); return }
    setSaving(true)
    setError('')
    try {
      if (mode === 'create') {
        const result = await api.post('/api/admin/class-groups', { courseId, studentClass: className, nome: cleanName, conjunto: conjunto.trim() || DEFAULT_SET, tipo, membros: [...selected] })
        onSaved(`Grupo "${result.grupo.nome}" criado.`)
      } else {
        const before = new Set(group.membros.map(member => member.email))
        const adicionar = [...selected].filter(email => !before.has(email))
        const remover = [...before].filter(email => !selected.has(email))
        const result = await api.post(`/api/admin/class-groups/${encodeURIComponent(group.id)}/update`, {
          nome: cleanName, conjunto: conjunto.trim() || DEFAULT_SET, tipo, adicionar, remover, atualizadoEm: group.atualizadoEm, mover: moving.length > 0,
        })
        onSaved(result.changed ? `Grupo "${result.grupo.nome}" salvo.` : 'Nada mudou no grupo.')
      }
    } catch (err) {
      if (err?.data?.code === 'group_changed') { onStale(STALE_MESSAGE); return }
      setError(err?.message || 'Não foi possível salvar o grupo.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!saving) onClose() }} size="lg" fullScreenOnPhone
      title={mode === 'create' ? 'Novo grupo' : `Editar ${group?.nome || 'grupo'}`}
      description="Cada aluno fica em no máximo um grupo de cada conjunto."
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={save} loading={saving}>{mode === 'create' ? 'Criar grupo' : 'Salvar'}</Button>
      </>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Nome do grupo" value={nome} maxLength={limits.nameMax || 60} onChange={event => setNome(event.target.value)} placeholder="Equipe 1" />
          <Select label="Tipo" value={tipo} onChange={event => setTipo(event.target.value)}>
            {TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </div>
        <Input label="Conjunto" value={conjunto} maxLength={limits.setMax || 40} list="grupos-conjuntos" onChange={event => setConjunto(event.target.value)}
          helper="Junta os grupos de uma mesma divisão da turma, como &quot;Projeto integrador&quot; ou &quot;Laboratório&quot;." />
        <datalist id="grupos-conjuntos">{conjuntoOptions.map(option => <option key={option} value={option} />)}</datalist>
        <div className="space-y-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <p className="text-[13px] font-medium text-muted">Alunos ({selected.size} marcados)</p>
          </div>
          <Input aria-label="Buscar aluno" value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar por nome ou matrícula" />
          {people.length === 0
            ? <p className="text-sm text-muted">Nenhum aluno ativo nesta turma.</p>
            : (
              <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {visible.map(person => {
                  const other = otherGroupOf(groups, conjunto, person.email, exceptId)
                  const blocked = mode === 'create' && !!other
                  const checked = selected.has(person.email)
                  return (
                    <li key={person.email}>
                      <label className={`flex min-h-[44px] cursor-pointer items-center gap-3 px-3 py-2 text-sm ${blocked ? 'cursor-not-allowed opacity-60' : 'hover:bg-surface-2'}`}>
                        <input type="checkbox" className="h-4 w-4 shrink-0" checked={checked} disabled={blocked} onChange={() => toggle(person.email)} />
                        <span className="min-w-0 flex-1">
                          <span className="block break-words text-text">{person.nome}</span>
                          <span className="block text-xs text-subtle">
                            {[person.matricula, displayEmail(person.email)].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        {!person.naTurma && <Badge tone="warning">Saiu da turma</Badge>}
                        {other && <Badge tone={checked ? 'warning' : 'neutral'}>{checked && !blocked ? `Sai de ${other.nome}` : `Em ${other.nome}`}</Badge>}
                      </label>
                    </li>
                  )
                })}
                {visible.length === 0 && <li className="px-3 py-3 text-sm text-muted">Nenhum aluno encontrado.</li>}
              </ul>
            )}
          {mode === 'create' && <p className="text-xs text-subtle">Quem já está em outro grupo deste conjunto fica de fora aqui; para trocar, edite o grupo depois de criado.</p>}
          {moving.length > 0 && <p role="status" className="text-sm text-warning">{moving.length === 1 ? '1 aluno vai sair' : `${moving.length} alunos vão sair`} de outro grupo deste conjunto ao salvar.</p>}
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}

// Sortear: primeiro a proposta (nada é gravado), depois "Criar estes grupos" cria
// exatamente a proposta mostrada (mesma semente; se a turma mudou, o servidor pede outra).
function DrawModal({ open, data, courseId, className, onClose, onSaved }) {
  const groups = data?.grupos || []
  const firstSet = (data?.conjuntos || []).find(set => groups.some(group => !group.arquivado && sameSet(group.conjunto, set)))
  const [conjunto, setConjunto] = useState(firstSet ? '' : DEFAULT_SET)
  const [tipo, setTipo] = useState('equipe')
  const [criterio, setCriterio] = useState('quantidade')
  const [valor, setValor] = useState('4')
  const [nomeBase, setNomeBase] = useState('')
  const [somenteSemGrupo, setSomenteSemGrupo] = useState(true)
  const [proposal, setProposal] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const limits = data?.limites || {}
  const setInUse = groups.some(group => !group.arquivado && sameSet(group.conjunto, conjunto))

  function params() {
    return {
      courseId, studentClass: className, conjunto: conjunto.trim() || DEFAULT_SET, tipo, criterio,
      valor: Number(valor), nomeBase: nomeBase.trim() || undefined, somenteSemGrupo: setInUse ? somenteSemGrupo : true,
    }
  }

  function changed(setter) {
    return value => { setter(value); setProposal(null); setError('') }
  }

  async function propose() {
    setBusy(true)
    setError('')
    try {
      setProposal(await api.post('/api/admin/class-groups/draw', params()))
    } catch (err) {
      setProposal(null)
      setError(err?.message || 'Não foi possível sortear.')
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    if (!proposal) return
    setBusy(true)
    setError('')
    try {
      const result = await api.post('/api/admin/class-groups/draw', { ...params(), semente: proposal.semente, assinatura: proposal.assinatura, confirmar: true })
      onSaved(`${countText(result.grupos.length, 'grupo criado', 'grupos criados')} pelo sorteio.`)
    } catch (err) {
      if (err?.data?.code === 'roster_changed') {
        setProposal(null)
        setError('A turma mudou depois do sorteio (aluno entrou, saiu ou já ganhou grupo). Sorteie de novo.')
      } else {
        setError(err?.message || 'Não foi possível criar os grupos.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose() }} size="lg" fullScreenOnPhone title="Sortear grupos"
      description="O sorteio só vale depois de você conferir e tocar em Criar estes grupos."
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
        {proposal
          ? <><Button variant="secondary" icon={Shuffle} onClick={propose} loading={busy}>Sortear de novo</Button><Button onClick={confirm} loading={busy}>Criar estes grupos</Button></>
          : <Button icon={Shuffle} onClick={propose} loading={busy}>Sortear</Button>}
      </>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Conjunto" value={conjunto} maxLength={limits.setMax || 40} list="sorteio-conjuntos" onChange={event => changed(setConjunto)(event.target.value)} placeholder="Projeto integrador" />
          <datalist id="sorteio-conjuntos">{(data?.conjuntos || []).map(option => <option key={option} value={option} />)}</datalist>
          <Select label="Tipo" value={tipo} onChange={event => changed(setTipo)(event.target.value)}>
            {TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
          <Select label="Dividir por" value={criterio} onChange={event => changed(setCriterio)(event.target.value)}>
            <option value="quantidade">Quantidade de grupos</option>
            <option value="tamanho">Alunos por grupo (no máximo)</option>
          </Select>
          <Input label={criterio === 'quantidade' ? 'Quantos grupos' : 'Alunos por grupo'} type="number" inputMode="numeric" min={limits.drawMin || 2} max={limits.drawMax || 20}
            value={valor} onChange={event => changed(setValor)(event.target.value)} />
        </div>
        <Input label="Começo do nome (opcional)" value={nomeBase} maxLength={limits.drawBaseMax || 40} placeholder="Grupo" onChange={event => changed(setNomeBase)(event.target.value)}
          helper="Os grupos saem numerados: Grupo 1, Grupo 2..." />
        {setInUse && (
          <div className="rounded-lg border border-border p-3">
            <Switch checked={somenteSemGrupo} onChange={changed(setSomenteSemGrupo)} label="Sortear só quem está sem grupo neste conjunto" />
            {!somenteSemGrupo && <p className="mt-2 text-xs text-warning">Este conjunto já tem grupos. Para sortear a turma toda, use outro conjunto ou arquive os grupos dele antes.</p>}
          </div>
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {proposal && (
          <div className="space-y-2">
            <p className="text-sm text-muted">{countText(proposal.alunos, 'aluno', 'alunos')} em {countText(proposal.proposta.length, 'grupo', 'grupos')} no conjunto {proposal.conjunto}:</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {proposal.proposta.map(item => (
                <div key={item.nome} className="min-w-0 rounded-lg border border-border p-3">
                  <p className="break-words text-sm font-semibold text-text">{item.nome} <span className="font-normal text-subtle">({item.membros.length})</span></p>
                  <ul className="mt-1 text-sm text-muted">{item.membros.map(member => <li key={member.email} className="break-words">{member.nome}</li>)}</ul>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

export default function GruposPage() {
  const params = useParams()
  const nav = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const { auth } = useAuth()
  const readOnly = auth?.readOnly === true
  const courseId = decodeURIComponent(params.courseId || '')
  const className = decodeURIComponent(params.className || '')
  const back = location.state?.voltar === '/alunos' ? '/alunos' : '/turmas'
  const path = courseId && className ? `/api/admin/class-groups?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(className)}&arquivados=1` : null
  const groupsApi = useApi(path, [path])
  const [showArchived, setShowArchived] = useState(false)
  const [form, setForm] = useState(null)
  const [drawOpen, setDrawOpen] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState(null)
  const [restoreTarget, setRestoreTarget] = useState(null)

  const data = groupsApi.data
  const groups = data?.grupos || []
  const visibleGroups = groups.filter(group => showArchived || !group.arquivado)
  const archivedCount = groups.filter(group => group.arquivado).length
  const sets = []
  visibleGroups.forEach(group => { if (!sets.some(set => sameSet(set, group.conjunto))) sets.push(group.conjunto) })
  const studentName = new Map((data?.alunos || []).map(aluno => [aluno.email, aluno.nome]))
  const notFound = groupsApi.error?.status === 404

  function saved(message) {
    setForm(null)
    setDrawOpen(false)
    toast.success(message)
    groupsApi.refetch()
  }

  function stale(message) {
    setForm(null)
    toast.error(message)
    groupsApi.refetch()
  }

  async function archive(reason) {
    await api.post(`/api/admin/class-groups/${encodeURIComponent(archiveTarget.id)}/archive`, { motivo: reason || undefined })
    setArchiveTarget(null)
    toast.success('Grupo arquivado.')
    groupsApi.refetch()
  }

  async function restore() {
    await api.post(`/api/admin/class-groups/${encodeURIComponent(restoreTarget.id)}/restore`, {})
    setRestoreTarget(null)
    toast.success('Grupo reativado.')
    groupsApi.refetch()
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <button type="button" onClick={() => nav(back)} className={`inline-flex items-center gap-1.5 text-sm text-muted hover:text-text ${TOUCH}`}>
        <ArrowLeft size={16} />{back === '/alunos' ? 'Voltar para Alunos' : 'Voltar para cursos e turmas'}
      </button>
      <PageHeader title="Grupos" helpTopic="grupos" helpClassName={TOUCH_SQUARE}
        subtitle={data?.turma ? `${data.turma.curso} · ${data.turma.nome}` : className}>
        {!readOnly && data && <>
          <Button variant="secondary" icon={Shuffle} className={TOUCH} onClick={() => setDrawOpen(true)} disabled={(data.alunos || []).length < 2}>Sortear grupos</Button>
          <Button icon={Plus} className={TOUCH} onClick={() => setForm({ mode: 'create' })}>Novo grupo</Button>
        </>}
      </PageHeader>

      {notFound
        ? <Card><CardBody className="pt-5"><p className="text-sm text-muted">Turma não encontrada. Ela pode ter sido removida ou renomeada.</p></CardBody></Card>
        : (
          <PageState loading={groupsApi.loading && !data} error={groupsApi.error} onRetry={groupsApi.refetch}>
            {data && (
              <>
                {archivedCount > 0 && (
                  <Switch checked={showArchived} onChange={setShowArchived} label={`Mostrar arquivados (${archivedCount})`} />
                )}
                {visibleGroups.length === 0
                  ? (
                    <EmptyState icon={Users} title="Nenhum grupo nesta turma"
                      description={readOnly ? 'Os professores da turma ainda não criaram grupos.' : 'Crie um grupo ou sorteie a turma em equipes.'}
                      action={readOnly ? undefined : 'Novo grupo'} onAction={readOnly ? undefined : () => setForm({ mode: 'create' })} />
                  )
                  : sets.map(set => {
                    const setGroups = visibleGroups.filter(group => sameSet(group.conjunto, set))
                    const free = (data.semGrupo?.[set] || [])
                    return (
                      <section key={set} className="space-y-3" aria-label={`Conjunto ${set}`}>
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <h2 className="break-words text-lg font-semibold text-text">{set}</h2>
                          <span className="text-xs text-muted">{countText(setGroups.filter(group => !group.arquivado).length, 'grupo ativo', 'grupos ativos')}</span>
                        </div>
                        {free.length > 0 && setGroups.some(group => !group.arquivado) && (
                          <p className="break-words rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted">
                            <span className="font-medium text-text">Sem grupo neste conjunto ({free.length}):</span> {free.map(email => studentName.get(email) || displayEmail(email)).join(', ')}
                          </p>
                        )}
                        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                          {setGroups.map(group => (
                            <GroupCard key={group.id} group={group} readOnly={readOnly}
                              onEdit={target => setForm({ mode: 'edit', group: target })}
                              onArchive={setArchiveTarget} onRestore={setRestoreTarget} />
                          ))}
                        </div>
                      </section>
                    )
                  })}
              </>
            )}
          </PageState>
        )}

      {form && data && (
        <GroupFormModal open key={form.group?.id || 'novo'} mode={form.mode} group={form.group} data={data}
          courseId={courseId} className={className} onClose={() => setForm(null)} onSaved={saved} onStale={stale} />
      )}
      {drawOpen && data && (
        <DrawModal open data={data} courseId={courseId} className={className} onClose={() => setDrawOpen(false)} onSaved={saved} />
      )}
      <ConfirmDialog open={!!archiveTarget} onClose={() => setArchiveTarget(null)} onConfirm={archive}
        title={`Arquivar ${archiveTarget?.nome || 'grupo'}?`} confirmLabel="Arquivar" askReason reasonLabel="Motivo" reasonMaxLength={data?.limites?.reasonMax || 200}
        message="O grupo sai da lista e os alunos dele ficam livres para outro grupo do mesmo conjunto. Você pode reativá-lo depois em Mostrar arquivados." />
      <ConfirmDialog open={!!restoreTarget} onClose={() => setRestoreTarget(null)} onConfirm={restore}
        title={`Reativar ${restoreTarget?.nome || 'grupo'}?`} confirmLabel="Reativar"
        message="O grupo volta com os mesmos alunos. Se algum deles entrou em outro grupo do mesmo conjunto, o IClass avisa e não reativa." />
    </div>
  )
}
