import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/api'
import { usePolling } from './usePolling'
// Carrega dados de um endpoint GET com estados loading/erro/refetch padronizados.
// options.pollMs: consulta de novo a cada pollMs pelo usePolling (fase 2, H2-C): uma
// consulta por vez, pausa com a aba oculta, recuo quando o servidor falha e prazo de
// 10 s. Antes era um setInterval: com o servidor mais lento que pollMs, cada consulta
// nova invalidava a anterior pelo token abaixo e a tela nunca atualizava, enquanto as
// consultas se acumulavam.
export function useApi(path, deps = [], options = {}) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Token monotônico: só a requisição mais recente aplica seu resultado.
  // Evita que uma resposta antiga (troca rápida de curso/aluno) sobrescreva a
  // nova e evita setState após o componente desmontar.
  const activeRef = useRef(0)
  // Consulta em voo (o token dela): a consulta periódica não sai enquanto houver uma.
  const inFlightRef = useRef(0)
  // load(silent, requestOptions): devolve true quando a resposta chegou (para o recuo do
  // usePolling). refetch() explícito continua substituindo a requisição em voo.
  const load = useCallback(async (silent = false, requestOptions = undefined) => {
    if (!path) { setData(null); setLoading(false); setError(null); return true }
    const requestId = ++activeRef.current
    inFlightRef.current = requestId
    if (!silent) setLoading(true)
    setError(null)
    try {
      const result = await api.get(path, requestOptions && typeof requestOptions === 'object' ? requestOptions : undefined)
      if (requestId === activeRef.current) setData(result)
      return true
    } catch (e) {
      if (requestId === activeRef.current) setError(e)
      return false
    } finally {
      if (inFlightRef.current === requestId) inFlightRef.current = 0
      if (!silent && requestId === activeRef.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  useEffect(() => {
    load()
    // Invalida qualquer requisição em voo quando deps mudam ou desmonta.
    return () => { activeRef.current++; inFlightRef.current = 0 }
  }, [load, ...deps])
  const polling = usePolling(
    (requestOptions) => (inFlightRef.current ? true : load(true, requestOptions)),
    { intervalMs: options.pollMs, enabled: !!options.pollMs && !!path, immediate: false },
  )
  // Consulta agora sem furar a guarda (ex.: a janela voltou a ter o foco). Sem pollMs,
  // vale como um refetch silencioso.
  const pollNow = useCallback(() => {
    if (options.pollMs && path) polling.runNow()
    else load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.pollMs, path, polling.runNow, load])
  return { data, loading, error, refetch: load, pollNow, setData }
}
