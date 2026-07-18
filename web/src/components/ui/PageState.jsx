import { AlertTriangle } from 'lucide-react'
import { Skeleton } from './Skeleton'
import { Button } from './Button'
// Envolve telas que carregam dados: mostra skeleton, erro (com retry) ou o conteúdo.
export function PageState({ loading, error, onRetry, children, skeleton }) {
  if (loading) return skeleton || (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
      </div>
      <Skeleton className="h-64" />
    </div>
  )
  if (error) return (
    <div className="flex flex-col items-center text-center py-16">
      <div className="w-14 h-14 grid place-items-center rounded-full bg-danger-soft text-danger mb-4"><AlertTriangle size={26} /></div>
      <h3 className="text-[16px] font-semibold text-text">Não foi possível carregar</h3>
      <p className="text-sm text-muted mt-1 max-w-sm">{error.message || 'Erro de conexão com o servidor.'}</p>
      {onRetry && <Button className="mt-4" onClick={onRetry}>Tentar novamente</Button>}
    </div>
  )
  return children
}
