import { createContext, useContext, useState, useCallback } from 'react'
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react'
const ToastCtx = createContext()
const ICONS = { success: CheckCircle2, error: XCircle, warning: AlertTriangle, info: Info }
// Classes estáticas (o Tailwind não compila classes montadas dinamicamente).
const ICON_COLOR = { success: 'text-success', error: 'text-danger', warning: 'text-warning', info: 'text-info' }
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const remove = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const push = useCallback((type, msg) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, type, msg }])
    setTimeout(() => remove(id), type === 'error' ? 7000 : 4000)
  }, [remove])
  const toast = { success: (m) => push('success', m), error: (m) => push('error', m), warning: (m) => push('warning', m), info: (m) => push('info', m) }
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2" aria-live="polite">
        {toasts.map((t) => {
          const Icon = ICONS[t.type]
          return (
            <div key={t.id} className="flex items-center gap-3 bg-surface border border-border rounded-lg shadow-lg px-4 py-3 min-w-[260px]">
              <Icon size={20} className={ICON_COLOR[t.type] || 'text-info'} aria-hidden />
              <span className="text-sm text-text flex-1">{t.msg}</span>
              <button onClick={() => remove(t.id)} aria-label="Fechar" className="text-subtle hover:text-text"><X size={16} /></button>
            </div>
          )
        })}
      </div>
    </ToastCtx.Provider>
  )
}
export const useToast = () => useContext(ToastCtx)
