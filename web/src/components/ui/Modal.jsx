import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { ConfirmDialog as BaseConfirmDialog } from './ConfirmDialog'
const WIDTHS = {
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-6xl',
}

// Modais abertos, na ordem em que abriram (decisões §12, sobra do H6a): com um modal sobre
// outro (o "Copiar" do endereço da sala abre o ManualCopyModal por cima do Endereço da
// sala), Esc e Tab valem só para o de cima. Antes, cada modal ouvia o teclado da janela,
// e um Esc fechava os dois de uma vez.
const openModals = []

// fullScreenOnPhone: no celular (abaixo de 640 px) o diálogo ocupa a tela inteira, sem a
// margem nem a borda arredondada, e os botões do rodapé quebram em linhas inteiras em vez
// de espremer o texto (diálogos longos, como o "Corrigir gabarito" do P3-S6).
// drawer (fase 3, C8): gaveta à direita no computador (altura inteira, largura do size) e
// tela cheia no celular, com o rodapé dos botões fixo embaixo enquanto o corpo rola (o
// painel de correção das tarefas). O teclado (Esc, Tab) segue a mesma regra do modal.
export function Modal({ open, onClose, title, description, children, footer, size = 'md', fullScreenOnPhone = false, drawer = false }) {
  const dialogRef = useRef(null)
  const previousFocusRef = useRef(null)
  const onCloseRef = useRef(onClose)
  const titleId = useId()
  const descriptionId = useId()
  const wasOpenRef = useRef(false)
  // O foco de quem abriu é lido ao abrir, ainda na renderização: o campo com autoFocus
  // dentro do diálogo já recebe o foco antes dos efeitos rodarem.
  if (open && !wasOpenRef.current && typeof document !== 'undefined') previousFocusRef.current = document.activeElement
  wasOpenRef.current = open
  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    const focusable = () => Array.from(dialog?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])
    // Campo com autoFocus dentro do diálogo (ex.: TypedConfirm) já tem o foco: não o
    // troca pelo primeiro botão (o X), senão o que se digita logo depois de abrir se perde.
    requestAnimationFrame(() => {
      if (dialog && dialog.contains(document.activeElement)) return
      ;(focusable()[0] || dialog)?.focus()
    })
    const token = {}
    openModals.push(token)
    const onKey = (e) => {
      if (openModals[openModals.length - 1] !== token) return
      if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current?.(); return }
      if (e.key !== 'Tab') return
      const items = focusable()
      if (!items.length) { e.preventDefault(); dialog?.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const index = openModals.indexOf(token)
      if (index >= 0) openModals.splice(index, 1)
      previousFocusRef.current?.focus?.()
    }
  }, [open])
  if (!open) return null
  if (drawer) {
    return createPortal(
      <div className="fixed inset-0 z-[9998] flex justify-end">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" onClick={onClose} />
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1} className={`relative flex h-full max-h-full w-full flex-col bg-surface shadow-lg sm:border-l sm:border-border ${WIDTHS[size] || WIDTHS.md}`}>
          <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <h2 id={titleId} className="break-words text-lg font-semibold text-text">{title}</h2>
              {description && <p id={descriptionId} className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <button onClick={onClose} aria-label="Fechar" className="grid min-h-[44px] min-w-[44px] shrink-0 place-items-center text-subtle hover:text-text sm:min-h-0 sm:min-w-0"><X size={20} /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-5">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-surface px-4 py-3 sm:px-5">{footer}</div>}
        </div>
      </div>,
      document.body
    )
  }
  return createPortal(
    <div className={`fixed inset-0 z-[9998] grid place-items-center ${fullScreenOnPhone ? 'p-0 sm:p-4' : 'p-4'}`}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" onClick={onClose} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1} className={`relative bg-surface shadow-lg w-full ${WIDTHS[size] || WIDTHS.md} overflow-auto ${fullScreenOnPhone ? 'h-full max-h-full border-0 rounded-none sm:h-auto sm:max-h-[94vh] sm:border sm:border-border sm:rounded-xl' : 'border border-border rounded-xl max-h-[94vh]'}`}>
        <div className="flex items-start justify-between px-5 pt-5">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-text">{title}</h2>
            {description && <p id={descriptionId} className="text-sm text-muted mt-1">{description}</p>}
          </div>
          <button onClick={onClose} aria-label="Fechar" className="text-subtle hover:text-text"><X size={20} /></button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className={`flex justify-end gap-2 px-5 py-4 border-t border-border ${fullScreenOnPhone ? 'flex-wrap [&>button]:whitespace-nowrap' : ''}`}>{footer}</div>}
      </div>
    </div>,
    document.body
  )
}
// Chamadas antigas (fases 1 e 2) do diálogo de confirmação: o componente é o de
// ConfirmDialog.jsx (fase 3, C0a), com o mesmo texto de antes no corpo. note: texto
// opcional no lugar do aviso padrão (ex.: exclusão que vai para uma lixeira). Tela nova
// importa de './ConfirmDialog' e usa message e tone.
export function ConfirmDialog({ danger, note, tone, message, ...props }) {
  return (
    <BaseConfirmDialog {...props}
      tone={tone || (danger ? 'danger' : 'primary')}
      message={message ?? (note || `Esta ação ${danger ? 'não pode ser desfeita.' : 'será aplicada imediatamente.'}`)} />
  )
}
