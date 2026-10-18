import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './App'
import { ThemeProvider } from './context/ThemeProvider'
import { ToastProvider } from './context/ToastProvider'
import { AuthProvider } from './context/AuthProvider'
import { BrandingProvider } from './context/BrandingProvider'
import { PreferencesProvider } from './context/PreferencesProvider'
import './index.css'
import './styles/lumen.css'

function Root() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrandingProvider>
          <PreferencesProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </PreferencesProvider>
        </BrandingProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

// Roteador de dados: permite à prova online confirmar a saída pelo voltar do navegador
// ou por um link (useBlocker, AVA-12). As rotas continuam declaradas no App.
const router = createBrowserRouter([{ path: '*', element: <Root /> }])

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
)
