import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from './Button'
const WIDTHS = {
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-6xl',
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }) {
  const dialogRef = useRef(null)
  const previousFocusRef = useRef(null)
  const onCloseRef = useRef(onClose)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement
    const dialog = dialogRef.current
    const focusable = () => Array.from(dialog?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])
    requestAnimationFrame(() => (focusable()[0] || dialog)?.focus())
    const onKey = (e) => {
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
      previousFocusRef.current?.focus?.()
    }
  }, [open])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[9998] grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" onClick={onClose} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1} className={`relative bg-surface border border-border rounded-xl shadow-lg w-full ${WIDTHS[size] || WIDTHS.md} max-h-[94vh] overflow-auto`}>
        <div className="flex items-start justify-between px-5 pt-5">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-text">{title}</h2>
            {description && <p id={descriptionId} className="text-sm text-muted mt-1">{description}</p>}
          </div>
          <button onClick={onClose} aria-label="Fechar" className="text-subtle hover:text-text"><X size={20} /></button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}
// note: texto opcional no lugar do aviso padrão (ex.: exclusão que vai para uma lixeira).
export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = 'Confirmar', danger, note }) {
  return (
    <Modal open={open} onClose={onClose} title={title} description={description}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant={danger ? 'destructive' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
      </>}>
      <p className="text-sm text-muted">{note || `Esta ação ${danger ? 'não pode ser desfeita.' : 'será aplicada imediatamente.'}`}</p>
    </Modal>
  )
}
