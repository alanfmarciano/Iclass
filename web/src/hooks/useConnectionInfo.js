import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchConnectionInfo } from '../lib/adminAccess'

// Como o servidor trata o painel do professor neste aparelho (GET /api/connection,
// SEG-03). O administrador pode trocar a regra em Sistema → Rede com esta tela aberta
// em outro aparelho: a consulta é refeita quando a tela volta a ficar visível, ganha o
// foco ou a rede volta, e quando quem usa a tela pede (refresh). Sem consulta periódica.
//
// - connection: a última resposta (null até a primeira; falha de rede mantém a anterior);
// - checking: consulta em andamento;
// - refresh({ force }): consulta de novo (sem force, ignora pedidos a menos de 1 s do
//   anterior: o foco e a volta da aba chegam juntos);
// - override(updater): aplica o que um 403 com adminAccess acabou de dizer, e descarta
//   a consulta que ainda estiver em andamento (ela é anterior à recusa).
// enabled: false (a tela já recebeu a resposta de outro lugar) não consulta nada.
const MIN_GAP_MS = 1000

export function useConnectionInfo({ enabled = true } = {}) {
  const [connection, setConnection] = useState(null)
  const [checking, setChecking] = useState(false)
  const seqRef = useRef(0)
  const lastRef = useRef(0)

  const refresh = useCallback(async ({ force = false } = {}) => {
    const now = Date.now()
    if (!force && now - lastRef.current < MIN_GAP_MS) return
    lastRef.current = now
    const seq = ++seqRef.current
    setChecking(true)
    const info = await fetchConnectionInfo()
    if (seq !== seqRef.current) return
    setChecking(false)
    if (info) setConnection(info)
  }, [])

  const override = useCallback((updater) => {
    seqRef.current += 1
    setChecking(false)
    setConnection(updater)
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    refresh({ force: true })
    const onVisible = () => { if (document.visibilityState !== 'hidden') refresh() }
    const onFocus = () => refresh()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onFocus)
    return () => {
      seqRef.current += 1
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onFocus)
    }
  }, [enabled, refresh])

  return { connection, checking, refresh, override }
}
