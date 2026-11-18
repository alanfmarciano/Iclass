import { Component, useEffect } from 'react'
import { useRouteError } from 'react-router-dom'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from './Button'
import { markRenderError, renderErrorDetails } from '../../lib/renderErrors'
import { reportClientError } from '../../lib/clientErrors'

// Texto padrão da tela de erro (raiz e prova). As áreas de erro dos layouts trocam por
// um texto próprio (prop description): lá o menu continua à vista (fase 2, H9c: ENG-05).
const DEFAULT_DESCRIPTION = 'Recarregue a página para continuar. Se você estava fazendo uma prova, as respostas já salvas continuam guardadas e a prova não foi encerrada.'
export const ADMIN_ERROR_DESCRIPTION = 'Recarregue a página ou escolha outra opção no menu. O que já foi salvo continua guardado.'
export const STUDENT_ERROR_DESCRIPTION = 'Recarregue a página ou escolha outra opção no menu.'

// Tela de erro em português no lugar da tela padrão do roteador ("Unexpected Application
// Error!"). Na prova, as respostas já salvas continuam guardadas e a prova segue aberta.
// Os detalhes técnicos vêm sem endereços (o código do erro basta para o suporte).
export function ErrorScreen({ error, onReload, description }) {
  const message = renderErrorDetails(error)
  return (
    <div role="alert" className="app-canvas min-h-full flex flex-col items-center justify-center text-center px-4 py-16 text-text">
      <div className="w-14 h-14 grid place-items-center rounded-full bg-danger-soft text-danger mb-4"><AlertTriangle aria-hidden="true" size={26} /></div>
      <h1 className="text-lg font-semibold">Algo deu errado nesta tela</h1>
      <p className="text-sm text-muted mt-2 max-w-md">{description || DEFAULT_DESCRIPTION}</p>
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
// Nos layouts (fase 2, H9c: ENG-05) a área fica em volta do Outlet, dentro do div com
// key={pathname}: um erro numa página troca só a página pela tela de erro (o menu
// continua à vista) e trocar de página pelo menu zera a área. Props:
// - area ('admin', 'aluno', 'prova'): registra o erro no servidor (reportClientError);
// - description: texto da tela de erro no lugar do padrão;
// - fallback: tela própria da área (a prova usa a ExamErrorScreen).
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
    if (this.props.area) reportClientError(this.props.area, error)
  }

  render() {
    if (this.state.error) {
      const Fallback = this.props.fallback || ErrorScreen
      return <Fallback error={this.state.error} description={this.props.description} />
    }
    return this.props.children
  }
}

// errorElement do roteador (main.jsx): qualquer erro de tela fora de uma área protegida
// (ex.: no próprio layout). Também vai para o registro do servidor, como área 'raiz'.
export function RouteErrorScreen() {
  const error = useRouteError()
  markRenderError(error)
  useEffect(() => { reportClientError('raiz', error) }, [error])
  return <ErrorScreen error={error} />
}
