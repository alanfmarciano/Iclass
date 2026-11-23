import { useEffect, useRef } from 'react'
import { Send } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Textarea } from '../../components/ui/Textarea'
import { cn } from '../../lib/cn'
import { KEEP_NOTICE, TEXT_COUNTER_FROM, TEXT_MAX, fullDateTime, isOwnMessage, messageTime } from './conversationFormat'

// Balões da conversa (fase 3, C14 / P5-S7b, FUN-14; D9 do P5): só texto, mostrado como
// texto (o React escapa; nada de HTML nem link clicável), com as quebras de linha
// (white-space: pre-wrap) e palavra comprida quebrando no meio (overflow-wrap: anywhere),
// balão até 85% da largura. As mensagens de quem vê ficam à direita.
// side: 'aluno' (portal: autor 'voce') ou 'instrutor' (painel: voce true).
export function MessageList({ mensagens, side, temAnteriores, loadingOlder, onLoadOlder, scrollKey }) {
  const listRef = useRef(null)
  const lastId = mensagens.length ? mensagens[mensagens.length - 1].id : ''
  const ownLast = mensagens.length ? isOwnMessage(mensagens[mensagens.length - 1], side) : false
  const firstRender = useRef(true)
  // Se a pessoa estava no fim antes da mensagem nova chegar (lido no rolar, antes de
  // desenhar a mensagem nova; olhar depois contaria a altura dela como "longe do fim").
  const wasAtEnd = useRef(true)

  useEffect(() => { firstRender.current = true }, [scrollKey])
  useEffect(() => {
    const scroller = scrollParent(listRef.current)
    if (!scroller) return undefined
    const target = scroller === document.scrollingElement || scroller === document.documentElement ? window : scroller
    const onScroll = () => { wasAtEnd.current = distanceToEnd(scroller) <= NEAR_END_PX }
    target.addEventListener('scroll', onScroll, { passive: true })
    return () => target.removeEventListener('scroll', onScroll)
  }, [scrollKey])

  // Ao abrir a conversa e a cada mensagem nova no fim, mostra a última. O campo de
  // escrita vem logo depois da lista e fica preso ao pé da tela (sticky): rolar só até o
  // fim da lista deixava a última mensagem por baixo dele (revisão do C14). Por isso a
  // rolagem vai até o fim do rolador, onde o campo volta ao lugar dele, abaixo da lista.
  // (Mensagens anteriores entram no começo e não mexem na rolagem.)
  useEffect(() => {
    if (!lastId) return
    const scroller = scrollParent(listRef.current)
    if (!scroller) return
    if (firstRender.current || ownLast || wasAtEnd.current) {
      scrollToEnd(scroller, firstRender.current ? 'auto' : 'smooth')
      wasAtEnd.current = true
    }
    firstRender.current = false
  }, [lastId, ownLast])

  return (
    <div ref={listRef} className="space-y-3">
      {temAnteriores && (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" loading={loadingOlder} onClick={onLoadOlder} className="min-h-[44px] sm:min-h-0">Mensagens anteriores</Button>
        </div>
      )}
      <ol className="space-y-3" aria-label="Mensagens da conversa">
        {mensagens.map((message) => {
          const own = isOwnMessage(message, side)
          return (
            <li key={message.id} className={cn('flex', own ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-3.5 py-2.5 shadow-sm',
                  own ? 'rounded-br-md bg-primary text-primary-fg' : 'rounded-bl-md border border-border bg-surface-2 text-text',
                )}
              >
                <p className={cn('text-xs font-semibold', own ? 'text-primary-fg' : 'text-muted')}>{own ? 'Você' : (message.nome || 'Professor')}</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{message.texto}</p>
                <p className={cn('mt-1 text-right text-[11px]', own ? 'text-primary-fg' : 'text-muted')}>
                  <time dateTime={new Date(Number(message.criadaEm) || 0).toISOString()} title={fullDateTime(message.criadaEm)}>{messageTime(message.criadaEm)}</time>
                </p>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

const NEAR_END_PX = 160

// O rolador da tela: o primeiro ancestral com rolagem vertical (o <main> do painel e do
// portal) ou, sem nenhum, a própria página.
export function scrollParent(element) {
  if (typeof window === 'undefined' || !element) return null
  let node = element.parentElement
  while (node && node !== document.body && node !== document.documentElement) {
    const overflowY = window.getComputedStyle ? window.getComputedStyle(node).overflowY : ''
    if (/(auto|scroll|overlay)/.test(overflowY || '')) return node
    node = node.parentElement
  }
  return document.scrollingElement || document.documentElement
}

function distanceToEnd(scroller) {
  return (Number(scroller.scrollHeight) || 0) - (Number(scroller.scrollTop) || 0) - (Number(scroller.clientHeight) || 0)
}

function scrollToEnd(scroller, behavior) {
  const top = Number(scroller.scrollHeight) || 0
  if (typeof scroller.scrollTo === 'function') {
    try { scroller.scrollTo({ top, behavior }); return } catch { /* navegador antigo: cai no scrollTop */ }
  }
  scroller.scrollTop = top
}

// Campo de escrita preso ao fim da tela (também com o teclado do celular aberto): texto
// de 1 a 2.000 caracteres, contador a partir de 1.800, Enviar (botão de 44 px no celular)
// e Ctrl+Enter (ou Cmd+Enter) para enviar. O aviso de que as mensagens ficam guardadas
// fica embaixo do campo (D9).
export function MessageComposer({ value, onChange, onSend, sending, error, disabled, maxLength = TEXT_MAX, label = 'Escreva uma mensagem', placeholder = 'Escreva a sua mensagem', id }) {
  const trimmed = String(value || '').trim()
  function submit(event) {
    event?.preventDefault?.()
    if (!trimmed || sending || disabled) return
    onSend(trimmed)
  }
  function onKeyDown(event) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit(event)
  }
  return (
    <form onSubmit={submit} className="mensagens-composer space-y-2 rounded-xl border border-border bg-surface p-3 shadow-[var(--shadow-float,0_8px_24px_rgba(0,0,0,.12))]" noValidate>
      <Textarea
        id={id}
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        maxLength={maxLength}
        counterFrom={Math.min(TEXT_COUNTER_FROM, maxLength)}
        placeholder={placeholder}
        disabled={disabled || sending}
        error={error || undefined}
        rows={3}
        className="min-h-[76px] text-base sm:text-sm"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">{KEEP_NOTICE}</p>
        <Button type="submit" icon={Send} loading={sending} disabled={!trimmed || disabled} className="h-11 min-w-[112px] sm:h-[38px]">Enviar</Button>
      </div>
    </form>
  )
}
