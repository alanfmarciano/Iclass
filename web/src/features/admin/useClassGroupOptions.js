// Grupos ativos da turma para os seletores "Um grupo" (fase 3, C19 / P5-S5, CRIT-11; D18
// do P5): Avisos (destino 'grupo') e onde mais a tela não recebe os grupos junto com os
// dados dela. Lê GET /api/admin/class-groups (page.students); sem a permissão, sem rede
// ou sem grupos, a lista vem vazia e a tela simplesmente não oferece o grupo.
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { compareText } from '../../lib/textSearch'

// 'Laboratório · Laboratório A' (o conjunto ajuda quando há nomes parecidos).
export function groupOptionLabel(group) {
  if (!group) return ''
  return group.conjunto ? `${group.conjunto} · ${group.nome}` : group.nome
}

// Grupos ativos, por conjunto e nome: [{ id, nome, conjunto, quantidade, label }].
export function activeGroupOptions(grupos) {
  return (Array.isArray(grupos) ? grupos : [])
    .filter((group) => group && group.id && !group.arquivado)
    .map((group) => ({
      id: group.id,
      nome: group.nome,
      conjunto: group.conjunto || '',
      quantidade: Number.isFinite(group.quantidade) ? group.quantidade
        : Number.isFinite(group.membrosNaTurma) ? group.membrosNaTurma
          : Array.isArray(group.membros) ? group.membros.length : null,
      label: groupOptionLabel(group),
    }))
    .sort((a, b) => compareText(a.conjunto, b.conjunto) || compareText(a.nome, b.nome))
}

export function useClassGroupOptions({ courseId, studentClass, enabled = true }) {
  const [state, setState] = useState({ groups: [], loading: false })
  useEffect(() => {
    if (!enabled || !courseId || !studentClass) { setState({ groups: [], loading: false }); return undefined }
    let active = true
    setState((current) => ({ ...current, loading: true }))
    Promise.resolve()
      .then(() => api.get(`/api/admin/class-groups?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`))
      .then((data) => { if (active) setState({ groups: activeGroupOptions(data?.grupos), loading: false }) })
      .catch(() => { if (active) setState({ groups: [], loading: false }) })
    return () => { active = false }
  }, [enabled, courseId, studentClass])
  return state
}
