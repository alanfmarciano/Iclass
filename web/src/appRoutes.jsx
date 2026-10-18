import { RouteErrorScreen } from './components/ui/ErrorScreen'

// Rotas do roteador de dados (main.jsx). As rotas de verdade continuam declaradas no App;
// o errorElement troca a tela padrão do roteador, em inglês, por uma tela de erro em
// português com o botão de recarregar.
export function appRoutes(root) {
  return [{ path: '*', element: root, errorElement: <RouteErrorScreen /> }]
}
