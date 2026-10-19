import { Component } from 'react'
import { useRouteError } from 'react-router-dom'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from './Button'
import { markRenderError, renderErrorDetails } from '../../lib/renderErrors'

// Tela de erro em português no lugar da tela padrão do roteador ("Unexpected Application
// Error!"). Na prova, as respostas já salvas continuam guardadas e a prova segue aberta.
// Os detalhes técnicos vêm sem endereços (o código do erro basta para o suporte).
export function ErrorScreen({ error, onReload }) {
  const message = renderErrorDetails(error)
  return (
    <div role="alert" className="app-canvas min-h-full flex flex-col items-center justify-center text-center px-4 py-16 text-text">
      <div className="w-14 h-14 grid place-items-center rounded-full bg-danger-soft text-danger mb-4"><AlertTriangle aria-hidden="true" size={26} /></div>
      <h1 className="text-lg font-semibold">Algo deu errado nesta tela</h1>
      <p className="text-sm text-muted mt-2 max-w-md">
        Recarregue a página para continuar. Se você estava fazendo uma prova, as respostas já salvas continuam guardadas e a prova não foi encerrada.
      </p>
      <Button className="mt-5" icon={RotateCw} onClick={() => (onReload ? onReload() : window.location.reload())}>Recarregar a página</Button>
      {message && (
        <details className="mt-6 max-w-md text-left text-xs text-muted">
          <summary className="cursor-pointer select-none">Detalhes técnicos</summary>
          <p className="mt-2 break-words">{message}</p>
        </details>
      )}
    </div>
  )
}

// Erro de renderização dentro de uma área (ex.: a prova): mostra a tela de erro (ou a
// fallback da área) e marca o erro antes de a área desmontar, para a prova não registrar
// isso como saída.
export class AppErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    markRenderError(error)
    return { error }
  }

  componentDidCatch(error) {
    markRenderError(error)
  }

  render() {
    if (this.state.error) {
      const Fallback = this.props.fallback || ErrorScreen
      return <Fallback error={this.state.error} />
    }
    return this.props.children
  }
}

// errorElement do roteador (main.jsx): qualquer erro de tela fora de uma área protegida.
export function RouteErrorScreen() {
  const error = useRouteError()
  markRenderError(error)
  return <ErrorScreen error={error} />
}
