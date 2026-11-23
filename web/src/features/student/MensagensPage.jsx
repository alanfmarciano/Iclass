// Mensagens do aluno (/aluno/mensagens; fase 3, C14 / P5-S7b, FUN-14; D8 a D15 do P5):
// conversa particular com um professor da turma ativa.
// - lista das conversas da turma (GET /api/student/conversations): professor, assunto,
//   "há 2 h", selo "nova" e "Encerrada"; "Arquivadas" mostra as que o aluno arquivou;
// - "Nova mensagem": Para (os professores que atendem a turma, pelo identificador opaco
//   da lista; nenhum e-mail aparece), assunto opcional e texto;
// - a conversa (?c=<id>, o mesmo endereço que o sino abre) em balões, com o campo de
//   escrita preso ao fim da tela; "Arquivar" tira da lista só para ele (mensagem nova traz
//   de volta);
// - encerrada pelo professor: "O professor encerrou esta conversa. Você pode começar
//   outra."; durante a prova, o campo dá lugar a "Durante a prova, fale com o professor
//   pelo botão da prova." (o servidor recusa com 409 exam_in_progress);
// - aviso fixo no topo: "O administrador da escola pode ler estas mensagens." (resposta do
//   Alan à pergunta 4).
// No celular (até 1023 px), a lista e a conversa são telas separadas, com "Voltar". A
// lista não consulta sozinha: ela se atualiza quando o sino (que já consulta) muda o
// contador de mensagens, ao voltar para a aba e depois de cada ação.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Archive, ArchiveRestore, ArrowLeft, Info, Lock, MessageSquarePlus, MessagesSquare } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { HelpLink } from '../../components/ui/HelpLink'
import { Input } from '../../components/ui/Input'
import { PageState } from '../../components/ui/PageState'
import { Select } from '../../components/ui/Select'
import { Textarea } from '../../components/ui/Textarea'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { requestNotificationsRefresh, useMessageCount } from '../../lib/messageCounter'
import { useStudent } from './useStudent'
import { usePreview } from '../../hooks/usePreview'
import { PREVIEW_DISABLED_TEXT } from '../../lib/previewSession'
import { PreviewDisabledNote } from './PreviewBanner'
import { useConversationThread } from '../mensagens/useConversationThread'
import { MessageComposer, MessageList } from '../mensagens/MessageThread'
import {
  EXAM_NOTICE, READ_NOTICE, STUDENT_CLOSED_NOTICE, SUBJECT_MAX, TEXT_COUNTER_FROM, TEXT_MAX,
  actionErrorText, fullDateTime, timeAgo, unreadLabel,
} from '../mensagens/conversationFormat'

const BASE = '/api/student/conversations'

export function conversationsPath(courseId, studentClass, arquivadas = false) {
  if (!courseId || !studentClass) return null
  return `${BASE}?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}${arquivadas ? '&arquivadas=1' : ''}`
}

export function recipientsPath(courseId, studentClass) {
  if (!courseId || !studentClass) return null
  return `${BASE}/recipients?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`
}

function Notice({ icon: Icon = Info, tone = 'info', children, className }) {
  return (
    <p role="status" className={cn('flex items-start gap-2 rounded-lg border p-3 text-sm', tone === 'warning' ? 'border-warning/30 bg-warning-soft text-text' : 'border-border bg-surface-2 text-muted', className)}>
      <Icon aria-hidden="true" size={16} className={cn('mt-0.5 shrink-0', tone === 'warning' ? 'text-warning' : 'text-info')} />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

function ConversationRow({ row, active, href }) {
  const unread = Number(row.naoLidas) || 0
  return (
    <li>
      <Link
        to={href}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex min-h-[64px] items-start gap-3 rounded-xl border p-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          active ? 'border-primary/60 bg-primary-soft' : 'border-border bg-surface hover:border-primary/40 hover:bg-surface-2/50',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={cn('truncate text-sm', unread ? 'font-bold text-text' : 'font-semibold text-text')}>{row.instrutor?.nome || 'Professor'}</span>
            <span className="shrink-0 text-xs text-subtle">{timeAgo(row.ultimaMensagemEm)}</span>
          </span>
          <span className="mt-0.5 block truncate text-sm text-muted">{row.assunto || 'Sem assunto'}</span>
          {(unread > 0 || row.status === 'encerrada') && (
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              {unread > 0 && <Badge tone="info"><span aria-hidden="true">nova</span><span className="sr-only">{unreadLabel(unread)}</span></Badge>}
              {row.status === 'encerrada' && <Badge tone="neutral">Encerrada</Badge>}
            </span>
          )}
        </span>
      </Link>
    </li>
  )
}

function NewConversation({ courseId, studentClass, emProva, onCreated, onCancel, limits }) {
  const recipients = useApi(recipientsPath(courseId, studentClass), [courseId, studentClass])
  const options = Array.isArray(recipients.data?.destinatarios) ? recipients.data.destinatarios : []
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [errors, setErrors] = useState({})
  const textMax = Number(limits?.texto) || TEXT_MAX
  const subjectMax = Number(limits?.assunto) || SUBJECT_MAX
  // Pré-visualização como aluno (C15 / P5-S6b): a lista de professores aparece, o Enviar não.
  const preview = usePreview()

  // Um professor só: já vem escolhido.
  useEffect(() => {
    if (options.length === 1 && !to) setTo(options[0].ref)
    if (to && options.length && !options.some((option) => option.ref === to)) setTo('')
  }, [options, to])

  async function submit(event) {
    event.preventDefault()
    if (preview) return
    const texto = text.trim()
    const nextErrors = {}
    if (!to) nextErrors.destinatario = 'Escolha o professor.'
    if (!texto) nextErrors.texto = 'Escreva a mensagem.'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    setSending(true)
    try {
      const response = await api.post(BASE, { courseId, studentClass, destinatario: to, assunto: subject.trim(), texto })
      onCreated(response)
    } catch (err) {
      const code = err?.data?.code
      // O servidor reiniciou e a lista mudou de identificador, ou o professor saiu dela.
      if (code === 'invalid_recipient') { setTo(''); recipients.refetch() }
      const field = err?.data?.field === 'destinatario' || code === 'invalid_recipient' ? 'destinatario' : 'texto'
      setErrors({ [field]: actionErrorText(err) })
    } finally {
      setSending(false)
    }
  }

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <button type="button" onClick={onCancel} className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-text lg:hidden" aria-label="Voltar para as conversas"><ArrowLeft size={20} /></button>
        <h2 className="text-lg font-semibold text-text">Nova mensagem</h2>
      </div>
      {emProva ? (
        <Notice icon={Lock} tone="warning">{EXAM_NOTICE}</Notice>
      ) : (
        <PageState loading={recipients.loading && !recipients.data} error={recipients.data ? null : recipients.error} onRetry={recipients.refetch} skeleton={<p className="text-sm text-muted">Carregando os professores...</p>}>
          {options.length === 0 ? (
            <Notice>Nenhum professor desta turma está recebendo mensagens agora. Fale com ele na aula.</Notice>
          ) : (
            <form onSubmit={submit} className="space-y-4" noValidate>
              <Select label="Para" value={to} onChange={(event) => { setTo(event.target.value); setErrors((current) => ({ ...current, destinatario: '' })) }} error={errors.destinatario || undefined}>
                <option value="">Escolha o professor</option>
                {options.map((option) => <option key={option.ref} value={option.ref}>{option.papel ? `${option.nome} (${option.papel})` : option.nome}</option>)}
              </Select>
              <Input label="Assunto (opcional)" value={subject} maxLength={subjectMax} counterFrom={Math.floor(subjectMax * 0.9)} onChange={(event) => setSubject(event.target.value)} placeholder="Ex.: Revisão da prova" />
              <Textarea
                label="Mensagem"
                value={text}
                maxLength={textMax}
                counterFrom={Math.min(TEXT_COUNTER_FROM, textMax)}
                onChange={(event) => { setText(event.target.value); setErrors((current) => ({ ...current, texto: '' })) }}
                error={errors.texto || undefined}
                rows={5}
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted">As mensagens ficam guardadas e não podem ser apagadas.</p>
              <PreviewDisabledNote />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" icon={MessageSquarePlus} loading={sending} disabled={!!preview} title={preview ? PREVIEW_DISABLED_TEXT : undefined} className="h-11 w-full sm:h-[38px] sm:w-auto">Enviar</Button>
                <Button type="button" variant="ghost" onClick={onCancel} disabled={sending} className="h-11 w-full sm:h-[38px] sm:w-auto">Cancelar</Button>
              </div>
            </form>
          )}
        </PageState>
      )}
    </Card>
  )
}

function ConversationView({ conversationId, emProvaLista, onBack, onChanged, onNew }) {
  const [draft, setDraft] = useState('')
  const [sendError, setSendError] = useState('')
  const [sending, setSending] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [examBlocked, setExamBlocked] = useState(false)
  const thread = useConversationThread({ basePath: BASE, conversationId, side: 'aluno', onChange: onChanged })
  const conversa = thread.conversa
  const emProva = examBlocked || thread.meta.emProva === true || (thread.meta.emProva === undefined && emProvaLista)

  useEffect(() => { setDraft(''); setSendError(''); setExamBlocked(false) }, [conversationId])
  // A prova acabou: a consulta seguinte traz emProva false e o campo volta.
  useEffect(() => { if (thread.meta.emProva === false) setExamBlocked(false) }, [thread.meta.emProva])

  async function send(texto) {
    setSending(true)
    setSendError('')
    try {
      await thread.send(texto)
      setDraft('')
    } catch (err) {
      const code = err?.data?.code
      if (code === 'exam_in_progress') setExamBlocked(true)
      else if (code === 'conversation_closed') thread.reload()
      setSendError(code === 'exam_in_progress' ? '' : actionErrorText(err))
    } finally {
      setSending(false)
    }
  }

  async function toggleArchive() {
    if (!conversa) return
    setArchiving(true)
    try {
      const response = await api.post(`${BASE}/${encodeURIComponent(conversa.id)}/archive`, { arquivada: !conversa.arquivada })
      if (response?.conversa) thread.updateConversation(response.conversa)
      if (response?.conversa?.arquivada) onBack()
    } catch (err) {
      setSendError(actionErrorText(err, 'Não foi possível arquivar agora. Tente de novo.'))
    } finally {
      setArchiving(false)
    }
  }

  if (thread.loading && !conversa) return <Card className="p-5"><p className="text-sm text-muted">Carregando a conversa...</p></Card>
  if (thread.error || !conversa) {
    const notFound = thread.error?.status === 404
    return (
      <Card className="p-5 space-y-3">
        <p className="text-sm text-text">{notFound ? 'Conversa não encontrada. Ela pode ser de outra turma.' : actionErrorText(thread.error, 'Não foi possível abrir a conversa.')}</p>
        <div className="flex flex-wrap gap-2">
          {!notFound && <Button variant="secondary" onClick={thread.reload}>Tentar novamente</Button>}
          <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>Voltar para as conversas</Button>
        </div>
      </Card>
    )
  }

  const closed = conversa.status === 'encerrada'
  return (
    <section aria-labelledby="mensagens-conversa-titulo" className="space-y-4">
      <Card className="p-3 sm:p-4">
        <div className="flex flex-wrap items-start gap-2">
          <button type="button" onClick={onBack} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-text lg:hidden" aria-label="Voltar para as conversas"><ArrowLeft size={20} /></button>
          <div className="min-w-0 flex-1">
            <h2 id="mensagens-conversa-titulo" className="break-words text-lg font-semibold text-text">{conversa.instrutor?.nome || 'Professor'}</h2>
            <p className="break-words text-sm text-muted">{conversa.assunto || 'Sem assunto'}</p>
            {closed && <Badge tone="neutral" className="mt-1.5 max-w-full">Encerrada{conversa.encerradaEm ? ` em ${fullDateTime(conversa.encerradaEm)}` : ''}</Badge>}
          </div>
          {/* No celular o botão vai para a linha de baixo (o nome e a data não ficam espremidos). */}
          <div className="flex w-full justify-end sm:w-auto">
            <Button variant="secondary" size="sm" icon={conversa.arquivada ? ArchiveRestore : Archive} loading={archiving} onClick={toggleArchive} className="min-h-[44px] shrink-0 sm:min-h-0">
              {conversa.arquivada ? 'Tirar do arquivo' : 'Arquivar'}
            </Button>
          </div>
        </div>
      </Card>

      <MessageList mensagens={thread.mensagens} side="aluno" temAnteriores={thread.temAnteriores} loadingOlder={thread.loadingOlder} onLoadOlder={thread.loadOlder} scrollKey={conversa.id} />

      {closed ? (
        <div className="space-y-2">
          <Notice icon={Lock}>{STUDENT_CLOSED_NOTICE}</Notice>
          <Button variant="secondary" icon={MessageSquarePlus} onClick={onNew} disabled={emProva} className="h-11 w-full sm:h-[38px] sm:w-auto">Nova mensagem</Button>
        </div>
      ) : emProva ? (
        <Notice icon={Lock} tone="warning">{EXAM_NOTICE}</Notice>
      ) : (
        <MessageComposer id="mensagem-aluno" value={draft} onChange={(value) => { setDraft(value); setSendError('') }} onSend={send} sending={sending} error={sendError} label="Responder" placeholder="Escreva a sua resposta" maxLength={Number(thread.meta.limites?.texto) || TEXT_MAX} />
      )}
      {closed && sendError && <p role="alert" className="text-sm text-danger">{sendError}</p>}
    </section>
  )
}

export default function MensagensPage() {
  const { courseId, studentClass } = useStudent()
  const [params, setParams] = useSearchParams()
  const selected = params.get('c') || ''
  const creating = params.get('nova') === '1' && !selected
  const [archived, setArchived] = useState(false)
  const [notice, setNotice] = useState('')
  const listPath = conversationsPath(courseId, studentClass, archived)
  const list = useApi(listPath, [listPath])
  const data = list.data || {}
  const rows = useMemo(() => (Array.isArray(data.conversas) ? data.conversas : []), [data.conversas])
  const emProva = data.emProva === true
  const counter = useMessageCount()
  const pollNowRef = useRef(list.pollNow)
  pollNowRef.current = list.pollNow

  // O sino mudou o contador (mensagem nova ou lida em outra aba): a lista acompanha.
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

  const open = useCallback((id) => setParams(id ? { c: id } : {}), [setParams])
  const back = useCallback(() => setParams({}), [setParams])
  const startNew = useCallback(() => { setNotice(''); setParams({ nova: '1' }) }, [setParams])
  const onChanged = useCallback(() => { pollNowRef.current() }, [])

  function onCreated(response) {
    const id = response?.conversa?.id
    setNotice(response && response.criada === false ? 'A mensagem entrou na conversa que você já tinha com este professor.' : '')
    if (archived) setArchived(false)
    list.refetch()
    requestNotificationsRefresh()
    if (id) open(id)
  }

  const hasSide = selected || creating
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-bold text-text">Mensagens</h1>
            <HelpLink topic="mensagens" doc="aluno" className="h-11 w-11" />
          </div>
          <p className="text-sm text-muted">Converse em particular com os professores da turma.</p>
        </div>
        <Button icon={MessageSquarePlus} onClick={startNew} disabled={emProva} className="h-11 w-full sm:h-[38px] sm:w-auto">Nova mensagem</Button>
      </div>
      <Notice>{data.aviso || READ_NOTICE}</Notice>
      {emProva && <Notice icon={Lock} tone="warning">{EXAM_NOTICE}</Notice>}
      {notice && <Notice>{notice}</Notice>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:items-start">
        <section aria-labelledby="mensagens-lista-titulo" className={cn('min-w-0 space-y-3 lg:sticky lg:top-4', hasSide && 'hidden lg:block')}>
          <h2 id="mensagens-lista-titulo" className="sr-only">Conversas</h2>
          <div className="flex gap-2" role="group" aria-label="Mostrar">
            {[{ id: false, label: 'Conversas' }, { id: true, label: 'Arquivadas' }].map((tab) => (
              <button key={String(tab.id)} type="button" aria-pressed={archived === tab.id}
                onClick={() => setArchived(tab.id)}
                className={cn('min-h-[44px] rounded-lg border px-4 text-sm font-medium transition sm:min-h-[36px]', archived === tab.id ? 'border-primary bg-primary-soft text-text' : 'border-border bg-surface text-muted hover:text-text')}>
                {tab.label}
              </button>
            ))}
          </div>
          <PageState loading={list.loading && !list.data} error={list.data ? null : list.error} onRetry={list.refetch} skeleton={<p className="text-sm text-muted">Carregando as conversas...</p>}>
            {rows.length === 0 ? (
              <Card>
                <EmptyState
                  icon={MessagesSquare}
                  title={archived ? 'Nenhuma conversa arquivada' : 'Nenhuma conversa ainda'}
                  description={archived ? 'As conversas que você arquivar ficam aqui.' : 'Para falar em particular com um professor da turma, toque em Nova mensagem.'}
                />
              </Card>
            ) : (
              <ul className="space-y-2">
                {rows.map((row) => <ConversationRow key={row.id} row={row} active={row.id === selected} href={`/aluno/mensagens?c=${encodeURIComponent(row.id)}`} />)}
              </ul>
            )}
          </PageState>
        </section>

        <div className={cn('min-w-0', !hasSide && 'hidden lg:block')}>
          {creating ? (
            <NewConversation courseId={courseId} studentClass={studentClass} emProva={emProva} limits={data.limites} onCreated={onCreated} onCancel={back} />
          ) : selected ? (
            <ConversationView key={selected} conversationId={selected} emProvaLista={emProva} onBack={back} onChanged={onChanged} onNew={startNew} />
          ) : (
            <Card><EmptyState icon={MessagesSquare} title="Escolha uma conversa" description="Toque numa conversa da lista para ler e responder." /></Card>
          )}
        </div>
      </div>
    </div>
  )
}
