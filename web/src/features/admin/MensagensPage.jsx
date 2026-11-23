// Mensagens com os alunos no painel (/mensagens; fase 3, C14 / P5-S7b, FUN-14; D8 a D15
// do P5). Permissão page.messages (o professor tem por padrão; a Coordenação, a Secretaria
// e o Professor auxiliar não).
// - lista das conversas de quem vê (GET /api/admin/conversations): aluno (nome e
//   matrícula), turma, assunto, "há 2 h", selo "nova"; filtros Abertas, Encerradas e
//   Todas; "Esta turma" ou "Todas as minhas turmas"; busca pelo nome sem acento
//   (matchesSearch);
// - "Nova conversa": escolhe a turma (as do escopo da conta, pela mesma lista do seletor
//   de curso; começa na turma do painel) e um aluno ativo dela;
// - abre também sem turma escolhida (modo instituição, revisão do C14): a lista começa em
//   "Todas as minhas turmas";
// - a conversa (?c=<id>) em balões, com o campo preso ao fim da tela (Ctrl+Enter envia);
//   "Encerrar conversa" com motivo opcional (ConfirmDialog) e "Reabrir". Encerrada, o
//   aluno lê e não responde; o professor ainda pode escrever. Cadastro do aluno encerrado
//   ou anonimizado: só consulta;
// - administrador pleno (messages.readAll, resposta do Alan à pergunta 4): "Todas da
//   escola" lista as conversas dos outros professores sem o assunto (até ele abrir), e
//   abrir uma delas passa por "Ler como administrador", que fica na Auditoria
//   (POST /:id/admin-open); lendo, a faixa "Você está lendo uma conversa de outro
//   professor; isso fica registrado." e nada de responder;
// - aviso fixo no topo: "O administrador da escola pode ler estas mensagens.".
// No celular (até 1023 px), lista e conversa são telas separadas ("Voltar"). A lista não
// consulta sozinha: acompanha o contador do sino (que já consulta) e cada ação.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Eye, Info, Lock, MessageSquarePlus, MessagesSquare, RotateCcw, ShieldAlert, XCircle } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { EmptyState } from '../../components/ui/EmptyState'
import { Input } from '../../components/ui/Input'
import { Modal } from '../../components/ui/Modal'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageState } from '../../components/ui/PageState'
import { Select } from '../../components/ui/Select'
import { Textarea } from '../../components/ui/Textarea'
import { useAuth } from '../../context/AuthProvider'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { ADMIN_PERMISSIONS, canAccessAdminPermission } from '../../lib/adminPermissions'
import { cn } from '../../lib/cn'
import { requestNotificationsRefresh, useMessageCount } from '../../lib/messageCounter'
import { compareText, matchesSearch } from '../../lib/textSearch'
import { studentRouteKey } from '../../lib/studentProfile'
import { isAnonymizedStatus, isClosedStatus } from './studentDeletion'
import { useConversationThread } from '../mensagens/useConversationThread'
import { MessageComposer, MessageList } from '../mensagens/MessageThread'
import {
  ADMIN_READING_NOTICE, READ_NOTICE, REASON_MAX, STUDENT_INACTIVE_NOTICE, SUBJECT_MAX, TEXT_COUNTER_FROM, TEXT_MAX,
  actionErrorText, fullDateTime, timeAgo, unreadLabel,
} from '../mensagens/conversationFormat'

const BASE = '/api/admin/conversations'
export const STATUS_FILTERS = [
  { id: 'aberta', label: 'Abertas' },
  { id: 'encerrada', label: 'Encerradas' },
  { id: '', label: 'Todas' },
]
export const CLOSE_TEXT = 'O aluno continua lendo a conversa, mas não responde mais. Ele pode começar outra. Você pode reabrir depois. O encerramento fica na Auditoria.'
export const ADMIN_OPEN_TEXT = 'A leitura fica registrada na Auditoria, com o seu nome, a data e a hora. Você só lê: não responde nem encerra a conversa de outro professor.'

// Endereço da lista. scope: 'turma' (a do painel), 'minhas' (todas as turmas da conta) ou
// 'escola' (todas, só com messages.readAll).
export function adminConversationsPath({ courseId, className, scope, status }) {
  const params = new URLSearchParams()
  if (scope === 'turma') {
    if (!courseId || !className) return null
    params.set('courseId', courseId)
    params.set('studentClass', className)
  }
  if (scope === 'escola') params.set('todas', '1')
  if (status) params.set('status', status)
  const query = params.toString()
  return query ? `${BASE}?${query}` : BASE
}

function Notice({ icon: Icon = Info, tone = 'info', children }) {
  return (
    <p role="status" className={cn('flex items-start gap-2 rounded-lg border p-3 text-sm', tone === 'warning' ? 'border-warning/30 bg-warning-soft text-text' : 'border-border bg-surface-2 text-muted')}>
      <Icon aria-hidden="true" size={16} className={cn('mt-0.5 shrink-0', tone === 'warning' ? 'text-warning' : 'text-info')} />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

function studentName(student) {
  return (student?.nomeSocial && String(student.nomeSocial).trim()) || student?.name || student?.email || 'Aluno'
}

function canTalkTo(student) {
  return !!student && !isClosedStatus(student.status) && !isAnonymizedStatus(student.status)
}

function ConversationRow({ row, active, showClass }) {
  const unread = Number(row.naoLidas) || 0
  return (
    <li>
      <Link
        to={`/mensagens?c=${encodeURIComponent(row.id)}`}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex min-h-[64px] items-start gap-3 rounded-xl border p-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          active ? 'border-primary/60 bg-primary-soft' : 'border-border bg-surface hover:border-primary/40 hover:bg-surface-2/50',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={cn('truncate text-sm text-text', unread ? 'font-bold' : 'font-semibold')}>{row.aluno?.nome || 'Aluno'}</span>
            <span className="shrink-0 text-xs text-subtle">{timeAgo(row.ultimaMensagemEm)}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-subtle">
            {[row.aluno?.matricula ? `Matrícula ${row.aluno.matricula}` : '', showClass ? `${row.curso || row.courseId} · ${row.studentClass}` : '', row.participante === false ? `com ${row.instrutor?.nome || 'outro professor'}` : ''].filter(Boolean).join(' · ')}
          </span>
          <span className="mt-0.5 block truncate text-sm text-muted">{row.textoOculto ? 'Assunto visível depois de abrir' : (row.assunto || 'Sem assunto')}</span>
          {(unread > 0 || row.status === 'encerrada' || row.aluno?.ativo === false) && (
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              {unread > 0 && <Badge tone="info"><span aria-hidden="true">nova</span><span className="sr-only">{unreadLabel(unread)}</span></Badge>}
              {row.status === 'encerrada' && <Badge tone="neutral">Encerrada</Badge>}
              {row.aluno?.ativo === false && <Badge tone="warning">Cadastro encerrado</Badge>}
            </span>
          )}
        </span>
      </Link>
    </li>
  )
}

// Turmas em que a conta pode começar uma conversa: as do escopo dela (GET
// /api/admin/course-summaries, a lista do seletor de curso), ativas, por curso e nome.
export function classOptionsFromSummaries(summaries) {
  return (Array.isArray(summaries) ? summaries : [])
    .filter((course) => course && course.deleted !== true && course.status !== 'deleted' && course.status !== 'inactive' && !course.deletedAt)
    .flatMap((course) => (Array.isArray(course.classes) ? course.classes : []).map((cls) => ({
      key: `${course.id}::${cls.name}`,
      courseId: String(course.id),
      className: String(cls.name),
      label: `${course.name || course.id} · ${cls.name}`,
    })))
    .sort((a, b) => compareText(a.label, b.label))
}

function NewConversationDialog({ open, onClose, defaultCourseId, defaultClassName, limits, onCreated }) {
  const summaries = useApi(open ? '/api/admin/course-summaries' : null, [open])
  const classOptions = useMemo(() => classOptionsFromSummaries(summaries.data), [summaries.data])
  const [classKey, setClassKey] = useState('')
  const chosenClass = classOptions.find((option) => option.key === classKey) || null
  const courseId = chosenClass?.courseId || ''
  const className = chosenClass?.className || ''
  const students = useApi(open && courseId && className ? `/api/admin/students?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(className)}` : null, [open, courseId, className])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState('')
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [errors, setErrors] = useState({})
  const [sending, setSending] = useState(false)
  const textMax = Number(limits?.texto) || TEXT_MAX
  const subjectMax = Number(limits?.assunto) || SUBJECT_MAX

  useEffect(() => {
    if (!open) return
    setSearch(''); setSelected(''); setSubject(''); setText(''); setErrors({})
    setClassKey(defaultCourseId && defaultClassName ? `${defaultCourseId}::${defaultClassName}` : '')
  }, [open, defaultCourseId, defaultClassName])
  // Sem a turma do painel na lista (modo instituição ou turma fora do escopo): com uma
  // turma só, já vem escolhida; com várias, a pessoa escolhe.
  useEffect(() => {
    if (!open || !summaries.data) return
    if (classKey && classOptions.some((option) => option.key === classKey)) return
    setClassKey(classOptions.length === 1 ? classOptions[0].key : '')
  }, [open, summaries.data, classOptions, classKey])

  const options = useMemo(() => (Array.isArray(students.data) ? students.data : [])
    .filter(canTalkTo)
    .map((student) => ({ key: studentRouteKey(student) || student.email, student, label: student.matricula ? `${studentName(student)} (${student.matricula})` : studentName(student) }))
    .sort((a, b) => compareText(a.label, b.label)), [students.data])
  const filtered = options.filter((option) => option.key === selected || matchesSearch([option.label, option.student.name, option.student.nomeSocial], search))

  async function submit(event) {
    event.preventDefault()
    const option = options.find((item) => item.key === selected)
    const texto = text.trim()
    const nextErrors = {}
    if (!chosenClass) nextErrors.turma = 'Escolha a turma.'
    else if (!option) nextErrors.aluno = 'Escolha o aluno.'
    if (!texto) nextErrors.texto = 'Escreva a mensagem.'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    setSending(true)
    try {
      const target = typeof option.student.id === 'string' && option.student.id ? { studentId: option.student.id } : { studentEmail: option.student.email }
      const response = await api.post(BASE, { courseId, studentClass: className, ...target, assunto: subject.trim(), texto })
      onCreated(response)
    } catch (err) {
      const field = err?.data?.field === 'studentEmail' || err?.data?.code === 'student_not_in_class' ? 'aluno' : 'texto'
      setErrors({ [field]: actionErrorText(err) })
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal open={open} onClose={sending ? undefined : onClose} title="Nova conversa" description="Com um aluno de uma das suas turmas." fullScreenOnPhone
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={sending}>Cancelar</Button>
        <Button type="submit" form="nova-conversa-form" icon={MessageSquarePlus} loading={sending}>Enviar</Button>
      </>}>
      <form id="nova-conversa-form" onSubmit={submit} className="space-y-4" noValidate>
        <PageState loading={summaries.loading && !summaries.data} error={summaries.data ? null : summaries.error} onRetry={summaries.refetch} skeleton={<p className="text-sm text-muted">Carregando as turmas...</p>}>
          {classOptions.length === 0 ? (
            <Notice>Nenhuma turma no seu acesso.</Notice>
          ) : (
            <Select label="Turma" value={classKey} onChange={(event) => { setClassKey(event.target.value); setSelected(''); setSearch(''); setErrors((current) => ({ ...current, turma: '', aluno: '' })) }} error={errors.turma || undefined}>
              <option value="">Escolha a turma</option>
              {classOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </Select>
          )}
        </PageState>
        {chosenClass && (
          // Trocar a turma recarrega: enquanto isso, nada da turma anterior para escolher.
          <PageState loading={students.loading} error={students.loading ? null : students.error} onRetry={students.refetch} skeleton={<p className="text-sm text-muted">Carregando os alunos...</p>}>
            {options.length === 0 ? (
              <Notice>Nenhum aluno ativo nesta turma.</Notice>
            ) : (
              <>
                <Input label="Buscar aluno" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome ou matrícula" />
                <Select label="Aluno" value={selected} onChange={(event) => { setSelected(event.target.value); setErrors((current) => ({ ...current, aluno: '' })) }} error={errors.aluno || undefined}>
                  <option value="">{filtered.length ? 'Escolha o aluno' : 'Nenhum aluno com esse nome'}</option>
                  {filtered.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                </Select>
              </>
            )}
          </PageState>
        )}
        <Input label="Assunto (opcional)" value={subject} maxLength={subjectMax} counterFrom={Math.floor(subjectMax * 0.9)} onChange={(event) => setSubject(event.target.value)} />
        <Textarea label="Mensagem" value={text} maxLength={textMax} counterFrom={Math.min(TEXT_COUNTER_FROM, textMax)} rows={5}
          onChange={(event) => { setText(event.target.value); setErrors((current) => ({ ...current, texto: '' })) }} error={errors.texto || undefined} />
        <p className="text-xs text-muted">As mensagens ficam guardadas e não podem ser apagadas.</p>
      </form>
    </Modal>
  )
}

function ConversationView({ conversationId, onBack, onChanged, canSeeStudents }) {
  const [draft, setDraft] = useState('')
  const [sendError, setSendError] = useState('')
  const [sending, setSending] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [reopening, setReopening] = useState(false)
  const thread = useConversationThread({ basePath: BASE, conversationId, side: 'instrutor', onChange: onChanged })
  const conversa = thread.conversa
  const needsAdminOpen = thread.error?.data?.code === 'admin_open_required'

  useEffect(() => { setDraft(''); setSendError('') }, [conversationId])

  async function send(texto) {
    setSending(true)
    setSendError('')
    try {
      await thread.send(texto)
      setDraft('')
    } catch (err) {
      if (err?.data?.code === 'student_inactive') thread.reload()
      setSendError(actionErrorText(err))
    } finally {
      setSending(false)
    }
  }

  async function closeConversation(motivo) {
    const response = await api.post(`${BASE}/${encodeURIComponent(conversa.id)}/close`, { motivo: motivo || '' })
    if (response?.conversa) thread.updateConversation(response.conversa)
    setConfirmClose(false)
  }

  async function reopen() {
    setReopening(true)
    setSendError('')
    try {
      const response = await api.post(`${BASE}/${encodeURIComponent(conversa.id)}/reopen`, {})
      if (response?.conversa) thread.updateConversation(response.conversa)
    } catch (err) {
      setSendError(actionErrorText(err, 'Não foi possível reabrir agora. Tente de novo.'))
    } finally {
      setReopening(false)
    }
  }

  async function adminOpen() {
    await api.post(`${BASE}/${encodeURIComponent(conversationId)}/admin-open`, {})
    setConfirmOpen(false)
    await thread.reload()
    onChanged()
  }

  if (thread.loading && !conversa) return <Card className="p-5"><p className="text-sm text-muted">Carregando a conversa...</p></Card>
  if (needsAdminOpen) {
    return (
      <Card className="space-y-3 p-5">
        <button type="button" onClick={onBack} className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-text lg:hidden" aria-label="Voltar para as conversas"><ArrowLeft size={20} /></button>
        <h2 className="text-lg font-semibold text-text">Conversa de outro professor</h2>
        <p className="text-sm text-muted">{ADMIN_OPEN_TEXT}</p>
        <Button icon={Eye} onClick={() => setConfirmOpen(true)}>Ler como administrador</Button>
        <ConfirmDialog open={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={adminOpen}
          title="Ler a conversa de outro professor?" message={ADMIN_OPEN_TEXT} confirmLabel="Ler como administrador" tone="primary" />
      </Card>
    )
  }
  if (thread.error || !conversa) {
    const notFound = thread.error?.status === 404
    return (
      <Card className="space-y-3 p-5">
        <p className="text-sm text-text">{notFound ? 'Conversa não encontrada.' : actionErrorText(thread.error, 'Não foi possível abrir a conversa.')}</p>
        <div className="flex flex-wrap gap-2">
          {!notFound && <Button variant="secondary" onClick={thread.reload}>Tentar novamente</Button>}
          <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>Voltar para as conversas</Button>
        </div>
      </Card>
    )
  }

  const reading = thread.meta.leituraAdministrativa === true || conversa.participante === false
  const closed = conversa.status === 'encerrada'
  const studentActive = conversa.aluno?.ativo !== false
  const studentKey = conversa.aluno?.studentId || ''
  return (
    <section aria-labelledby="mensagens-conversa-titulo" className="space-y-4">
      <Card className="p-3 sm:p-4">
        <div className="flex flex-wrap items-start gap-2">
          <button type="button" onClick={onBack} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-text lg:hidden" aria-label="Voltar para as conversas"><ArrowLeft size={20} /></button>
          <div className="min-w-0 flex-1">
            <h2 id="mensagens-conversa-titulo" className="break-words text-lg font-semibold text-text">{conversa.aluno?.nome || 'Aluno'}</h2>
            <p className="break-words text-xs text-subtle">
              {[conversa.aluno?.matricula ? `Matrícula ${conversa.aluno.matricula}` : '', `${conversa.curso || conversa.courseId} · ${conversa.studentClass}`, reading ? `com ${conversa.instrutor?.nome || 'outro professor'}` : ''].filter(Boolean).join(' · ')}
            </p>
            <p className="mt-0.5 break-words text-sm text-muted">{conversa.assunto || 'Sem assunto'}</p>
            {closed && (
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <Badge tone="neutral" className="max-w-full">Encerrada{conversa.encerradaEm ? ` em ${fullDateTime(conversa.encerradaEm)}` : ''}</Badge>
                {conversa.motivoEncerramento ? <span className="min-w-0 break-words">Motivo: {conversa.motivoEncerramento}</span> : null}
              </p>
            )}
          </div>
          {/* No celular os botões vão para a linha de baixo (o nome não fica espremido). */}
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            {canSeeStudents && studentKey && studentActive && <Link to={`/alunos/${encodeURIComponent(studentKey)}`} className="inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium text-primary hover:bg-surface-2 sm:min-h-[32px]">Ver ficha</Link>}
            {!reading && !closed && <Button variant="secondary" size="sm" icon={XCircle} onClick={() => setConfirmClose(true)} className="min-h-[44px] sm:min-h-0">Encerrar conversa</Button>}
            {!reading && closed && studentActive && <Button variant="secondary" size="sm" icon={RotateCcw} loading={reopening} onClick={reopen} className="min-h-[44px] sm:min-h-0">Reabrir</Button>}
          </div>
        </div>
      </Card>

      {reading && <Notice icon={ShieldAlert} tone="warning">{ADMIN_READING_NOTICE}</Notice>}

      <MessageList mensagens={thread.mensagens} side="instrutor" temAnteriores={thread.temAnteriores} loadingOlder={thread.loadingOlder} onLoadOlder={thread.loadOlder} scrollKey={conversa.id} />

      {reading ? null : !studentActive ? (
        <Notice icon={Lock}>{STUDENT_INACTIVE_NOTICE}</Notice>
      ) : (
        <>
          {closed && <Notice icon={Lock}>Conversa encerrada: o aluno lê, mas não responde. Você ainda pode escrever ou reabrir.</Notice>}
          <MessageComposer id="mensagem-instrutor" value={draft} onChange={(value) => { setDraft(value); setSendError('') }} onSend={send} sending={sending} error={sendError} label="Responder" placeholder="Escreva a sua resposta" />
        </>
      )}
      {(reading || !studentActive) && sendError && <p role="alert" className="text-sm text-danger">{sendError}</p>}

      <ConfirmDialog open={confirmClose} onClose={() => setConfirmClose(false)} onConfirm={closeConversation}
        title="Encerrar a conversa?" message={CLOSE_TEXT} confirmLabel="Encerrar conversa" tone="primary"
        askReason reasonLabel="Motivo" reasonMaxLength={REASON_MAX} reasonPlaceholder="Ex.: assunto resolvido" />
    </section>
  )
}

export default function MensagensPage() {
  const { auth } = useAuth()
  const workspace = auth.activeWorkspace || {}
  const courseId = workspace.courseId || ''
  const className = workspace.className || ''
  const [params, setParams] = useSearchParams()
  const selected = params.get('c') || ''
  const [status, setStatus] = useState('aberta')
  const [scope, setScope] = useState('turma')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState('')
  const canReadAll = canAccessAdminPermission(auth, ADMIN_PERMISSIONS.MESSAGES_READ_ALL)
  const canSeeStudents = canAccessAdminPermission(auth, ADMIN_PERMISSIONS.PAGE_STUDENTS)
  const inClass = !!courseId && !!className
  const canStart = canSeeStudents && auth.readOnly !== true
  // Sem turma escolhida no painel (modo instituição), "Esta turma" não existe: a lista
  // começa em "Todas as minhas turmas".
  const effectiveScope = scope === 'escola' && !canReadAll ? (inClass ? 'turma' : 'minhas') : (scope === 'turma' && !inClass ? 'minhas' : scope)
  const listPath = adminConversationsPath({ courseId, className, scope: effectiveScope, status })
  const list = useApi(listPath, [listPath])
  const data = list.data || {}
  const rows = useMemo(() => (Array.isArray(data.conversas) ? data.conversas : []), [data.conversas])
  const visible = rows.filter((row) => matchesSearch([row.aluno?.nome, row.aluno?.matricula, row.textoOculto ? '' : row.assunto, row.instrutor?.nome], search))
  const counter = useMessageCount()
  const pollNowRef = useRef(list.pollNow)
  pollNowRef.current = list.pollNow

  const lastCounter = useRef(counter)
  useEffect(() => {
    if (lastCounter.current === counter) return
    lastCounter.current = counter
    pollNowRef.current()
  }, [counter])
  useEffect(() => {
    const onFocus = () => pollNowRef.current()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const back = useCallback(() => setParams({}), [setParams])
  const onChanged = useCallback(() => { pollNowRef.current() }, [])

  function onCreated(response) {
    setCreating(false)
    setNotice(response && response.criada === false ? 'A mensagem entrou na conversa aberta que você já tinha com este aluno.' : '')
    list.refetch()
    requestNotificationsRefresh()
    if (response?.conversa?.id) setParams({ c: response.conversa.id })
  }

  const scopes = [
    ...(inClass ? [{ id: 'turma', label: `Esta turma (${className})` }] : []),
    { id: 'minhas', label: 'Todas as minhas turmas' },
    ...(canReadAll ? [{ id: 'escola', label: 'Todas da escola' }] : []),
  ]

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="Mensagens" subtitle="Conversas particulares com os alunos das suas turmas." helpTopic="mensagens" helpClassName="h-11 w-11">
        {canStart && <Button icon={MessageSquarePlus} onClick={() => setCreating(true)} className="h-11 w-full sm:h-[38px] sm:w-auto">Nova conversa</Button>}
      </PageHeader>
      <Notice>{data.aviso || READ_NOTICE}</Notice>
      {notice && <Notice>{notice}</Notice>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:items-start">
        <section aria-labelledby="mensagens-lista-titulo" className={cn('min-w-0 space-y-3 lg:sticky lg:top-4', selected && 'hidden lg:block')}>
          <h2 id="mensagens-lista-titulo" className="sr-only">Conversas</h2>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Situação">
            {STATUS_FILTERS.map((filter) => (
              <button key={filter.id || 'todas'} type="button" aria-pressed={status === filter.id} onClick={() => setStatus(filter.id)}
                className={cn('min-h-[44px] rounded-lg border px-3 text-sm font-medium transition sm:min-h-[36px]', status === filter.id ? 'border-primary bg-primary-soft text-text' : 'border-border bg-surface text-muted hover:text-text')}>
                {filter.label}
              </button>
            ))}
          </div>
          <Select label="Turmas" value={effectiveScope} onChange={(event) => setScope(event.target.value)}>
            {scopes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </Select>
          {effectiveScope === 'escola' && <Notice icon={ShieldAlert} tone="warning">As conversas de outros professores aparecem sem o assunto. Abrir uma delas fica registrado na Auditoria.</Notice>}
          <Input label="Buscar" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome do aluno ou matrícula" />
          <PageState loading={list.loading && !list.data} error={list.data ? null : list.error} onRetry={list.refetch} skeleton={<p className="text-sm text-muted">Carregando as conversas...</p>}>
            {visible.length === 0 ? (
              <Card>
                <EmptyState icon={MessagesSquare}
                  title={rows.length ? 'Nenhuma conversa com esse nome' : 'Nenhuma conversa aqui'}
                  description={rows.length ? 'Tente outro nome ou limpe a busca.' : 'Quando um aluno escrever, a conversa aparece aqui e no sino. Para começar, use Nova conversa.'} />
              </Card>
            ) : (
              <ul className="space-y-2">
                {visible.map((row) => <ConversationRow key={row.id} row={row} active={row.id === selected} showClass={effectiveScope !== 'turma'} />)}
              </ul>
            )}
          </PageState>
        </section>

        <div className={cn('min-w-0', !selected && 'hidden lg:block')}>
          {selected ? (
            <ConversationView key={selected} conversationId={selected} onBack={back} onChanged={onChanged} canSeeStudents={canSeeStudents && inClass} />
          ) : (
            <Card><EmptyState icon={MessagesSquare} title="Escolha uma conversa" description="Abra uma conversa da lista para ler e responder." /></Card>
          )}
        </div>
      </div>

      {canStart && <NewConversationDialog open={creating} onClose={() => setCreating(false)} defaultCourseId={courseId} defaultClassName={className} limits={data.limites} onCreated={onCreated} />}
    </div>
  )
}
