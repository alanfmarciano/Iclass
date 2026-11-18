import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './App'
import { appRoutes } from './appRoutes'
import { ThemeProvider } from './context/ThemeProvider'
import { ToastProvider } from './context/ToastProvider'
import { AuthProvider } from './context/AuthProvider'
import { ServerConnectionBanner } from './components/layout/ServerConnectionBanner'
import { BrandingProvider } from './context/BrandingProvider'
import { PreferencesProvider } from './context/PreferencesProvider'
import './index.css'
import './styles/lumen.css'

function Root() {
  return (
    <ThemeProvider>
      <AuthProvider>
        {/* Faixa "sem conexão / servidor reiniciando" (frente do H3), em todas as telas. */}
        <ServerConnectionBanner />
        <BrandingProvider>
          {/* Os avisos ficam por fora das preferências: a gravação recusada aparece na tela (H9b). */}
          <ToastProvider>
            <PreferencesProvider>
              <App />
            </PreferencesProvider>
          </ToastProvider>
        </BrandingProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

// Roteador de dados: permite à prova online confirmar a saída pelo voltar do navegador
// ou por um link (useBlocker, AVA-12). As rotas continuam declaradas no App; um erro de
// tela mostra a tela de erro em português (appRoutes).
const router = createBrowserRouter(appRoutes(<Root />))

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
)
