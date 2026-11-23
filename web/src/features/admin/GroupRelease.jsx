// Liberação por grupo em Materiais (fase 3, C19 / P5-S5, CRIT-11; D18 do P5): uma apostila
// ou um gabarito pode ser liberado só para um grupo da turma (ex.: o Laboratório A),
// enquanto continua bloqueado para os outros. O aluno vê o item quando a turma liberou,
// quando um grupo dele liberou ou quando o professor liberou para ele, nessa ordem; a
// prova online não entra aqui (o grupo dela é o "Para quem" em Provas).
import { useEffect, useState } from 'react'
import { Users, X } from 'lucide-react'
import { Modal } from '../../components/ui/Modal'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { api } from '../../lib/api'
import { groupOptionLabel } from './useClassGroupOptions'

export async function setGroupRelease({ studentClass, courseId, itemKey, groupId, released }) {
  const response = await api.post('/api/admin/release-item', { studentClass, courseId, itemKey, groupId, released })
  return response?.groupReleases && typeof response.groupReleases === 'object' ? response.groupReleases : null
}

// Selos "Liberado para Laboratório A" de um item, com o "x" que tira a liberação do grupo.
export function GroupReleaseBadges({ itemKey, groups, canChange, onRemove }) {
  if (!Array.isArray(groups) || groups.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1.5" data-testid={`group-releases-${itemKey}`}>
      {groups.map((group) => (
        <span key={group.id} className="inline-flex items-center gap-1 rounded-md bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary">
          <Users size={11} aria-hidden="true" /> Liberado para {groupOptionLabel(group)}
          {canChange && (
            <button type="button" onClick={() => onRemove(group)} className="-mr-1 grid h-5 w-5 place-items-center rounded hover:bg-primary/15" aria-label={`Tirar a liberação do grupo ${group.nome}`}>
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

// Diálogo "Liberar para um grupo": escolhe um grupo ativo da turma que ainda não tem o item.
export function GroupReleaseDialog({ open, item, unitName, groups, releasedGroups, studentClass, courseId, toast, onClose, onSaved }) {
  const [groupId, setGroupId] = useState('')
  const [busy, setBusy] = useState(false)
  const taken = new Set((releasedGroups || []).map((group) => group.id))
  const choices = (groups || []).filter((group) => !taken.has(group.id))
  useEffect(() => { if (open) setGroupId('') }, [open, item?.key])

  async function save() {
    if (!groupId) return toast.error('Escolha o grupo')
    setBusy(true)
    try {
      const next = await setGroupRelease({ studentClass, courseId, itemKey: item.key, groupId, released: true })
      const group = choices.find((entry) => entry.id === groupId)
      toast.success(`Liberado para ${group ? groupOptionLabel(group) : 'o grupo'}`)
      onSaved(next)
      onClose()
    } catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Liberar para um grupo"
      description={item ? `${item.type}${unitName ? ` de ${unitName}` : ''}: os alunos do grupo veem o item; o resto da turma continua sem ele.` : ''}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon={Users} loading={busy} disabled={!choices.length} onClick={save}>Liberar para o grupo</Button>
      </>}
    >
      {choices.length === 0
        ? <p className="text-sm text-muted">{(groups || []).length ? 'Todos os grupos da turma já têm este item.' : 'A turma ainda não tem grupos. Crie em Alunos › Grupos.'}</p>
        : (
          <Select label="Grupo" value={groupId} onChange={(e) => setGroupId(e.target.value)} autoFocus>
            <option value="">Escolha o grupo…</option>
            {choices.map((group) => (
              <option key={group.id} value={group.id}>{groupOptionLabel(group)}{Number.isFinite(group.quantidade) ? ` (${group.quantidade} ${group.quantidade === 1 ? 'aluno' : 'alunos'})` : ''}</option>
            ))}
          </Select>
        )}
      <p className="mt-3 text-xs text-muted">A liberação acompanha o grupo: quem entra nele passa a ver o item e quem sai deixa de ver. Enquanto o grupo estiver arquivado, a liberação dele não vale.</p>
    </Modal>
  )
}
