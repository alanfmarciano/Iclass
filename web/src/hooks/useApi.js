import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/api'
// Carrega dados de um endpoint GET com estados loading/erro/refetch padronizados.
export function useApi(path, deps = [], options = {}) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Token monotônico: só a requisição mais recente aplica seu resultado.
  // Evita que uma resposta antiga (troca rápida de curso/aluno) sobrescreva a
  // nova e evita setState após o componente desmontar.
  const activeRef = useRef(0)
  const load = useCallback(async (silent = false) => {
    if (!path) { setData(null); setLoading(false); setError(null); return }
    const requestId = ++activeRef.current
    if (!silent) setLoading(true)
    setError(null)
    try {
      const result = await api.get(path)
      if (requestId === activeRef.current) setData(result)
    } catch (e) {
      if (requestId === activeRef.current) setError(e)
    } finally {
      if (!silent && requestId === activeRef.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  useEffect(() => {
    load()
    // Invalida qualquer requisição em voo quando deps mudam ou desmonta.
    return () => { activeRef.current++ }
  }, [load, ...deps])
  useEffect(() => {
    if (!options.pollMs || !path) return undefined
    const id = setInterval(() => load(true), options.pollMs)
    return () => clearInterval(id)
  }, [load, options.pollMs, path])
  return { data, loading, error, refetch: load, setData }
}
