import { useEffect, useRef, useState } from 'react'
import { Archive, ArchiveRestore, Edit3, Library, Plus, Trash2 } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { EmptyState } from '../../components/ui/EmptyState'
import { Input } from '../../components/ui/Input'
import { Modal } from '../../components/ui/Modal'
import { Select } from '../../components/ui/Select'
import { Switch } from '../../components/ui/Switch'
import { useToast } from '../../context/ToastProvider'
import { api } from '../../lib/api'
import { QuestionCard } from './QuestionEditor'
import {
  QUESTION_TYPE_OPTIONS,
  answerSummary,
  editorQuestion,
  formatPointsLabel,
  questionProblems,
  questionTypeLabel,
} from './questionEditorModel'
import {
  BANK_CATEGORY_MAX,
  BANK_DIFFICULTY_LABELS,
  BANK_DIFFICULTY_TONES,
  BANK_FILTER_DIFFICULTIES,
  EMPTY_BANK_FILTERS,
  bankAccuracyText,
  bankExcerpt,
  bankItemPayload,
  bankQuery,
  bankUsageText,
  hasBankFilters,
} from './questionBankModel'

// Banco de questões do professor (fase 3, P3-S9a: AVA-15; desenho P3, telas.professor
// "Provas > Banco de questões"). Abre pela tela Provas ("Ver banco de questões") e pelo
// editor da prova ("Banco de questões", com "Adicionar" em cada item):
// - filtros por busca, categoria, tipo, dificuldade e etiqueta, e "Mostrar arquivadas";
//   o servidor filtra (GET /api/admin/question-bank?...) e manda as categorias e
//   etiquetas existentes;
// - cada item em cartão (cabe a 375 px): tipo, dificuldade, pontos, enunciado, categoria,
//   resposta, etiquetas, uso ("Usada em 3 aplicações") e % de acerto, calculados pelo
//   servidor só com as entregas consideradas das turmas de quem vê;
// - "Editar" e "Nova questão" usam o mesmo cartão do editor da prova (os seis tipos, com
//   os metadados em "Mais detalhes"); "Arquivar" tira da lista sem apagar; "Excluir" pede
//   confirmação no ConfirmDialog (contrato C12 do P3).
const CATEGORY_COUNTER_FROM = 450
const SEARCH_DELAY_MS = 300

function capitalize(text) {
  const value = String(text || '')
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function mergeFacet(list, value) {
  const text = String(value || '').trim()
  if (!text || (list || []).some((item) => item.toLocaleLowerCase('pt-BR') === text.toLocaleLowerCase('pt-BR'))) return list || []
  return [...(list || []), text].sort((a, b) => a.localeCompare(b, 'pt-BR'))
}

export default function QuestionBankPanel({ open, onClose, onAddToExam = null, defaultCategory = '' }) {
  const toast = useToast()
  const [filters, setFilters] = useState(EMPTY_BANK_FILTERS)
  const [search, setSearch] = useState('')
  const [data, setData] = useState({ questions: [], categorias: [], etiquetas: [], total: 0, archivedCount: 0 })
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [busyKey, setBusyKey] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const requestRef = useRef(0)
  const query = bankQuery(filters)

  useEffect(() => {
    if (!open) return undefined
    const timer = setTimeout(() => setFilters((current) => (current.q === search ? current : { ...current, q: search })), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [search, open])

  useEffect(() => {
    if (!open) {
      setEditing(null)
      return
    }
    const id = requestRef.current + 1
    requestRef.current = id
    setLoading(true)
    setLoadError('')
    api.get(`/api/admin/question-bank${query}`)
      .then((response) => {
        if (requestRef.current !== id) return
        setData({
          questions: Array.isArray(response?.questions) ? response.questions : [],
          categorias: Array.isArray(response?.categorias) ? response.categorias : [],
          etiquetas: Array.isArray(response?.etiquetas) ? response.etiquetas : [],
          total: Number(response?.total) || 0,
          archivedCount: Number(response?.archivedCount) || 0,
        })
      })
      .catch((error) => { if (requestRef.current === id) setLoadError(error.message) })
      .finally(() => { if (requestRef.current === id) setLoading(false) })
  }, [open, query])

  const setFilter = (field, value) => setFilters((current) => ({ ...current, [field]: value }))
  const clearFilters = () => { setSearch(''); setFilters((current) => ({ ...EMPTY_BANK_FILTERS, arquivadas: current.arquivadas })) }

  function upsert(item) {
    setData((current) => {
      const exists = current.questions.some((question) => question.key === item.key)
      const visible = !item.archived || filters.arquivadas
      const questions = exists
        ? current.questions.map((question) => (question.key === item.key ? item : question)).filter((question) => question.key !== item.key || visible)
        : (visible ? [...current.questions, item] : current.questions)
      return {
        ...current,
        questions,
        categorias: mergeFacet(current.categorias, item.category),
        etiquetas: (Array.isArray(item.tags) ? item.tags : []).reduce(mergeFacet, current.etiquetas),
      }
    })
  }

  function startEdit(item) {
    setEditing({ key: item.key, category: item.category || '', question: editorQuestion(item), showProblems: false })
  }

  function startNew() {
    setEditing({ key: null, category: String(defaultCategory || '').slice(0, BANK_CATEGORY_MAX), question: editorQuestion(), showProblems: false })
  }

  async function saveEditing() {
    if (!editing) return
    const [problem] = questionProblems(editing.question)
    if (problem) {
      setEditing((current) => ({ ...current, showProblems: true }))
      toast.error(capitalize(problem))
      return
    }
    setSaving(true)
    try {
      const payload = bankItemPayload(editing.question, { category: editing.category })
      const response = editing.key
        ? await api.post('/api/admin/question-bank/update', { key: editing.key, ...payload })
        : await api.post('/api/admin/question-bank/create', payload)
      if (response?.question) upsert(response.question)
      setEditing(null)
      if (!editing.key) toast.success('Questão criada no banco')
      else toast.success(response?.unchanged ? 'Nada mudou na questão' : 'Questão do banco atualizada')
    } catch (error) {
      toast.error(error.message)
    } finally {
      setSaving(false)
    }
  }

  async function toggleArchive(item) {
    setBusyKey(item.key)
    try {
      const response = await api.post('/api/admin/question-bank/archive', { key: item.key, archived: !item.archived })
      if (response?.question) upsert(response.question)
      setData((current) => ({ ...current, archivedCount: Math.max(0, current.archivedCount + (item.archived ? -1 : 1)) }))
      toast.success(item.archived ? 'Questão de volta à lista do banco' : 'Questão arquivada: ela sai da lista, mas continua guardada')
    } catch (error) {
      toast.error(error.message)
    } finally {
      setBusyKey(null)
    }
  }

  // Erro da exclusão aparece no próprio diálogo, que continua aberto.
  async function confirmDelete() {
    const item = deleting
    if (!item) return
    await api.post('/api/admin/question-bank/delete', { key: item.key })
    setData((current) => ({ ...current, questions: current.questions.filter((question) => question.key !== item.key) }))
    setDeleting(null)
    toast.success('Questão excluída do banco')
  }

  function addToExam(item) {
    onAddToExam?.(item)
  }

  const questions = data.questions
  const filtered = hasBankFilters(filters) || search.trim() !== ''

  return (
    <>
      <Modal
        open={open}
        onClose={() => { if (!saving) onClose?.() }}
        title="Banco de questões"
        description={editing
          ? (editing.key ? 'Editar a questão do banco.' : 'Nova questão no banco.')
          : (onAddToExam ? 'Adicione questões à prova ou cuide do acervo reutilizável.' : 'O acervo de questões reutilizáveis, com o uso e o acerto de cada uma.')}
        size={editing ? 'xl' : 'lg'}
        footer={editing ? (
          <>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>Voltar</Button>
            <Button onClick={saveEditing} loading={saving}>{editing.key ? 'Salvar alterações' : 'Salvar no banco'}</Button>
          </>
        ) : null}
      >
        {editing ? (
          <div className="min-w-0 space-y-3">
            <Input
              label="Categoria"
              value={editing.category}
              maxLength={BANK_CATEGORY_MAX}
              counterFrom={CATEGORY_COUNTER_FROM}
              placeholder="Ex.: Redes, Sub-redes, Linux"
              onChange={(event) => setEditing((current) => ({ ...current, category: event.target.value }))}
            />
            <QuestionCard
              question={editing.question}
              index={0}
              label={editing.key ? 'Questão do banco' : 'Nova questão do banco'}
              showProblems={editing.showProblems}
              onChange={(question) => setEditing((current) => ({ ...current, question }))}
            />
          </div>
        ) : (
          <div className="min-w-0 space-y-3">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
              <div className="col-span-2 lg:col-span-1">
                <Input label="Buscar" value={search} maxLength={80} placeholder="Texto, etiqueta..." onChange={(event) => setSearch(event.target.value)} />
              </div>
              <Select label="Categoria" value={filters.categoria} onChange={(event) => setFilter('categoria', event.target.value)}>
                <option value="">Todas</option>
                {data.categorias.map((category) => <option key={category} value={category}>{category}</option>)}
              </Select>
              <Select label="Tipo" value={filters.tipo} onChange={(event) => setFilter('tipo', event.target.value)}>
                <option value="">Todos</option>
                {QUESTION_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
              <Select label="Dificuldade" value={filters.dificuldade} onChange={(event) => setFilter('dificuldade', event.target.value)}>
                {BANK_FILTER_DIFFICULTIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
              <Select label="Etiqueta" value={filters.tag} onChange={(event) => setFilter('tag', event.target.value)}>
                <option value="">Todas</option>
                {data.etiquetas.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
              </Select>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Switch
                id="banco-mostrar-arquivadas"
                checked={filters.arquivadas}
                onChange={(value) => setFilter('arquivadas', value)}
                label={`Mostrar arquivadas${data.archivedCount ? ` (${data.archivedCount})` : ''}`}
              />
              <div className="flex flex-wrap gap-2">
                {filtered && <Button size="sm" variant="ghost" onClick={clearFilters}>Limpar filtros</Button>}
                <Button size="sm" variant="secondary" icon={Plus} onClick={startNew}>Nova questão</Button>
              </div>
            </div>
            <p className="text-xs text-subtle" role="status">
              {loading ? 'Carregando o banco...' : `${questions.length} ${questions.length === 1 ? 'questão' : 'questões'} na lista${filtered ? ' com estes filtros' : ''}.`}
            </p>
            {loadError && <p role="alert" className="rounded-md border border-danger/50 bg-danger-soft px-3 py-2 text-sm text-danger">{loadError}</p>}
            <ul className="max-h-[60vh] space-y-2 overflow-y-auto overflow-x-hidden" aria-label="Questões do banco">
              {questions.map((item) => {
                const difficulty = BANK_DIFFICULTY_LABELS[item.difficulty]
                const answer = answerSummary(item)
                const tags = Array.isArray(item.tags) ? item.tags : []
                return (
                  <li key={item.key} className={`min-w-0 space-y-2 rounded-lg border p-3 ${item.archived ? 'border-dashed border-border bg-surface-2/50' : 'border-border'}`} aria-label={bankExcerpt(item.questionText, 80) || 'Questão sem enunciado'}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="info">{questionTypeLabel(item.type)}</Badge>
                      {difficulty && <Badge tone={BANK_DIFFICULTY_TONES[item.difficulty]}>{difficulty}</Badge>}
                      {item.archived && <Badge tone="warning">Arquivada</Badge>}
                      <span className="text-xs text-muted">{formatPointsLabel(item.points ?? 1)}</span>
                      {item.revision > 1 && <span className="text-xs text-subtle">Revisão {item.revision}</span>}
                    </div>
                    <p className="break-words text-sm font-medium text-text [overflow-wrap:anywhere]">{bankExcerpt(item.questionText) || 'Questão sem enunciado'}</p>
                    <p className="break-words text-xs text-subtle [overflow-wrap:anywhere]">{item.category || 'Geral'}{answer ? ` · resposta ${answer}` : ''}</p>
                    {tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {tags.map((tag) => <span key={tag} className="max-w-full break-words rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted [overflow-wrap:anywhere]">{tag}</span>)}
                      </div>
                    )}
                    <p className="text-xs text-muted">{bankUsageText(item.stats)} · {bankAccuracyText(item.stats)}</p>
                    <div className="flex flex-wrap gap-2">
                      {onAddToExam && !item.archived && <Button size="sm" icon={Plus} onClick={() => addToExam(item)}>Adicionar</Button>}
                      <Button size="sm" variant="secondary" icon={Edit3} onClick={() => startEdit(item)}>Editar</Button>
                      <Button size="sm" variant="ghost" icon={item.archived ? ArchiveRestore : Archive} loading={busyKey === item.key} onClick={() => toggleArchive(item)}>
                        {item.archived ? 'Desarquivar' : 'Arquivar'}
                      </Button>
                      <Button size="sm" variant="ghost" icon={Trash2} aria-label="Excluir questão do banco" onClick={() => setDeleting(item)} />
                    </div>
                  </li>
                )
              })}
            </ul>
            {!loading && !loadError && questions.length === 0 && (
              filtered || (filters.arquivadas === false && data.archivedCount > 0)
                ? <EmptyState icon={Library} title="Nenhuma questão com estes filtros" description="Mude ou limpe os filtros, ou ligue “Mostrar arquivadas”." />
                : <EmptyState icon={Library} title="Banco vazio" description="Use “Nova questão” ou “Salvar no banco” numa questão da prova para iniciar o acervo." />
            )}
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        tone="danger"
        title="Excluir a questão do banco?"
        message={deleting ? `"${deleting.questionText}" sai do banco de vez. Para só tirar da lista, use “Arquivar”.` : ''}
        confirmLabel="Excluir"
      />
    </>
  )
}
