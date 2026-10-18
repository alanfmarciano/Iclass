import { useCallback, useEffect, useRef, useState } from 'react'
import { useBlocker } from 'react-router-dom'
import { LogOut, RotateCw } from 'lucide-react'
import { ErrorScreen } from '../../../components/ui/ErrorScreen'
import { Modal } from '../../../components/ui/Modal'
import { Button } from '../../../components/ui/Button'
import { api, hasActiveSession } from '../../../lib/api'
import { clearInterruptedExam, interruptedExam } from '../../../lib/renderErrors'

// Erro de tela durante a prova em andamento (G4): a tela de erro toma o lugar da prova,
// que continua aberta e destravada (recarregar volta à mesma tentativa). Sair dela pelo
// voltar do navegador ou por um link é uma saída da prova como outra qualquer: pede
// confirmação e fica registrada no Monitor, e a prova trava até o professor liberar.
// Sair da PÁGINA (voltar para um endereço aberto antes da prova, fechar a aba) segue a
// regra da saída da página da prova: o navegador pede confirmação, a saída fica
// registrada e, se a mesma sessão voltar logo, a prova destrava sozinha.
// "Recarregar a página" e "Recarregar e continuar" (os botões desta tela) não são saída:
// vão ao Monitor como evento técnico neutro (exam_error_reload) e a prova não trava.
export const ERROR_RELOAD_EVENT = 'exam_error_reload'

export function ExamErrorScreen({ error }) {
  const [leaving, setLeaving] = useState(false)
  const actionRef = useRef(null)
  const reloadingRef = useRef(false) // recarga pedida nesta tela: sem o aviso "sair do site?"

  useEffect(() => {
    const onBeforeUnload = (event) => {
      if (reloadingRef.current || !interruptedExam() || !hasActiveSession()) return
      event.preventDefault()
      event.returnValue = ''
    }
    const onPageHide = () => {
      const context = interruptedExam()
      if (reloadingRef.current || !context || !hasActiveSession()) return
      api.post('/api/student/log-activity', {
        ...context,
        eventType: 'exam_left',
        details: 'Página da prova foi fechada ou recarregada (depois de um erro de tela)',
        pageExit: true,
      }, { keepalive: true }).catch(() => {})
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [])
  const blocker = useBlocker(useCallback(({ currentLocation, nextLocation, historyAction }) => {
    if (!interruptedExam()) return false
    if (currentLocation.pathname === nextLocation.pathname && currentLocation.search === nextLocation.search) return false
    // Sessão encerrada (logout, revogação): o portal manda para o login sem perguntar.
    if (!hasActiveSession()) return false
    actionRef.current = historyAction
    return true
  }, []))
  const blockerRef = useRef(blocker)
  blockerRef.current = blocker
  const blocked = blocker.state === 'blocked'

  function stay() {
    if (blockerRef.current.state === 'blocked') blockerRef.current.reset()
  }

  function reloadExam() {
    stay()
    reloadingRef.current = true
    const context = interruptedExam()
    if (context && hasActiveSession()) {
      api.post('/api/student/log-activity', {
        ...context,
        eventType: ERROR_RELOAD_EVENT,
        details: 'Recarregou a página da prova pelo botão da tela de erro',
      }, { keepalive: true }).catch(() => {})
    }
    window.location.reload()
  }

  async function leaveExam() {
    if (leaving) return
    setLeaving(true)
    const context = interruptedExam()
    if (context) {
      const details = actionRef.current === 'POP'
        ? 'Saiu da prova pelo botão voltar do navegador (depois de um erro de tela)'
        : 'Saiu da prova por um link do portal (depois de um erro de tela)'
      await api.post('/api/student/log-activity', { ...context, eventType: 'exam_left', details }).catch(() => {})
    }
    clearInterruptedExam()
    setLeaving(false)
    if (blockerRef.current.state === 'blocked') blockerRef.current.proceed()
  }

  return (
    <>
      <ErrorScreen error={error} onReload={reloadExam} />
      <Modal
        open={blocked}
        onClose={() => !leaving && stay()}
        title="Sair da prova agora?"
        description="A tela da prova teve um erro, mas a prova continua aberta."
        footer={<>
          <Button variant="ghost" icon={RotateCw} onClick={reloadExam} disabled={leaving}>Recarregar e continuar</Button>
          <Button icon={LogOut} onClick={leaveExam} loading={leaving}>Sair da prova</Button>
        </>}
      >
        <p className="text-sm text-text mb-2">{actionRef.current === 'POP' ? 'Você usou o botão voltar do navegador.' : 'Você tentou abrir outra página do portal.'}</p>
        <p className="text-sm text-muted">Recarregue a página para continuar de onde parou. Se sair, a saída fica registrada para o professor e a prova fica bloqueada até ele liberar.</p>
      </Modal>
    </>
  )
}
