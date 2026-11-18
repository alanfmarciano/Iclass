import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import { copyText } from '../../lib/clipboard'
import { useToast } from '../../context/ToastProvider'

// Último plano B do "Copiar" (fase 2, H6a): o navegador não deixou copiar nem pela API
// nem pelo execCommand. O texto aparece num campo somente leitura, já selecionado, para a
// pessoa copiar com Ctrl+C (ou segurar o dedo no celular).
export function ManualCopyModal({ open, text, label = 'Texto', onClose }) {
  const inputRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(id)
  }, [open, text])
  return (
    <Modal open={open} onClose={onClose} title="Selecione e copie (Ctrl+C)"
      description="O navegador não deixou copiar sozinho nesta conexão. O texto já está selecionado."
      footer={<Button onClick={onClose}>Pronto</Button>}>
      <label className="block text-sm font-medium text-text" htmlFor="manual-copy-text">{label}</label>
      <input
        id="manual-copy-text"
        ref={inputRef}
        readOnly
        autoFocus
        value={text || ''}
        onFocus={(event) => event.target.select()}
        onClick={(event) => event.target.select()}
        className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-text"
      />
    </Modal>
  )
}

// Copiar com aviso e plano B: copy(text, { success, label }) mostra o aviso de sucesso
// ou abre o ManualCopyModal; manualCopy é o elemento que a tela põe no JSX.
export function useCopyText() {
  const toast = useToast()
  const [manual, setManual] = useState(null)
  const copy = useCallback(async (text, { success = 'Copiado', label } = {}) => {
    const result = await copyText(text)
    if (result === 'copied') toast?.success?.(success)
    else setManual({ text: String(text ?? ''), label })
    return result
  }, [toast])
  const manualCopy = (
    <ManualCopyModal open={!!manual} text={manual?.text} label={manual?.label} onClose={() => setManual(null)} />
  )
  return { copy, manualCopy }
}
