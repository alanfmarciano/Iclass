// "Ver como aluno" (fase 3, C15 / P5-S6b; CRIT-08, D19 a D22 do P5): o botão em Turmas
// (na turma), em Materiais e liberação e no seletor de curso e turma do Dashboard abre o
// diálogo "Ver o portal como um aluno de 1DES", com o grupo opcional (P5-S4) e o aviso de
// que nada é gravado. "Abrir pré-visualização" pede a sessão de leitura ao servidor (POST
// /api/admin/preview-sessions), guarda a prévia nesta aba (AuthProvider.startPreview) e
// abre o portal na mesma aba; "Sair da pré-visualização" volta para esta tela.
//
// Quem vê o botão: a conta com o conteúdo das turmas (page.materials, a mesma regra do
// servidor) e que não é só consulta (a Coordenação recebe 403 read_only_account no POST).
// O seletor de grupo aparece para quem vê os grupos (page.students) e só com grupos ativos.
// Não há "ver como um aluno específico" (D22): a prévia é sempre a de um aluno da turma sem
// exceções individuais.
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Eye } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { Select } from '../../components/ui/Select'
import { useAuth } from '../../context/AuthProvider'
import { api } from '../../lib/api'
import { ADMIN_PERMISSIONS, canAccessAdminPermission } from '../../lib/adminPermissions'
import { PREVIEW_DIALOG_TEXT } from '../../lib/previewSession'

export function canPreviewAsStudent(auth) {
  return !!auth && auth.role !== 'student' && auth.readOnly !== true && canAccessAdminPermission(auth, ADMIN_PERMISSIONS.PAGE_MATERIALS)
}

function groupsPath(courseId, studentClass) {
  return `/api/admin/class-groups?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`
}

// Grupos ativos da turma para o seletor, por conjunto ('Laboratório · Laboratório A').
function groupOptions(data) {
  const grupos = Array.isArray(data?.grupos) ? data.grupos : []
  return grupos
    .filter((group) => group && group.id && !group.arquivado)
    .map((group) => ({ id: group.id, label: group.conjunto ? `${group.conjunto} · ${group.nome}` : group.nome }))
}

export function PreviewDialog({ open, onClose, courseId, studentClass, courseName = '' }) {
  const { auth, startPreview } = useAuth()
  const nav = useNavigate()
  const location = useLocation()
  const canSeeGroups = canAccessAdminPermission(auth, ADMIN_PERMISSIONS.PAGE_STUDENTS)
  const [groups, setGroups] = useState([])
  const [groupId, setGroupId] = useState('')
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return undefined
    setGroupId('')
    setError('')
    setGroups([])
    if (!canSeeGroups || !courseId || !studentClass) return undefined
    let active = true
    setLoadingGroups(true)
    // Sem os grupos (rede, permissão), a prévia abre só pela turma.
    Promise.resolve()
      .then(() => api.get(groupsPath(courseId, studentClass)))
      .then((data) => { if (active) setGroups(groupOptions(data)) })
      .catch(() => { if (active) setGroups([]) })
      .finally(() => { if (active) setLoadingGroups(false) })
    return () => { active = false }
  }, [open, canSeeGroups, courseId, studentClass])

  async function openPreview() {
    if (opening) return
    setOpening(true)
    setError('')
    try {
      const response = await api.post('/api/admin/preview-sessions', { courseId, studentClass, groupId: groupId || null })
      startPreview(response, { origem: `${location.pathname}${location.search || ''}` })
      onClose()
      nav('/aluno')
    } catch (err) {
      setError(err?.message || 'Não foi possível abrir a pré-visualização. Tente de novo.')
      setOpening(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!opening) onClose() }}
      title={`Ver o portal como um aluno de ${studentClass}`}
      description={courseName || undefined}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={opening}>Cancelar</Button>
        <Button icon={Eye} loading={opening} onClick={openPreview}>Abrir pré-visualização</Button>
      </>}
    >
      <div className="space-y-4 text-sm">
        <p className="text-text">{PREVIEW_DIALOG_TEXT}</p>
        <p className="text-muted">O portal abre nesta aba como um aluno da turma, sem as notas, o caderno e as exceções de nenhum aluno. A pré-visualização dura até 60 minutos.</p>
        {canSeeGroups && (loadingGroups ? (
          <p className="text-muted">Carregando os grupos da turma...</p>
        ) : groups.length > 0 && (
          <Select label="Ver como membro de um grupo (opcional)" value={groupId} onChange={(event) => setGroupId(event.target.value)} className="h-11 sm:h-[38px]">
            <option value="">Nenhum grupo: só a turma</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
          </Select>
        ))}
        {error && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger">{error}</p>}
      </div>
    </Modal>
  )
}

// O botão "Ver como aluno" com o diálogo. Não aparece para quem não pode abrir a prévia.
export function PreviewButton({ courseId, studentClass, courseName = '', size = 'sm', variant = 'secondary', className = '', stopPropagation = false }) {
  const { auth } = useAuth() || {}
  const [open, setOpen] = useState(false)
  if (!canPreviewAsStudent(auth) || !courseId || !studentClass) return null
  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        icon={Eye}
        className={className}
        aria-label={`Ver como aluno da turma ${studentClass}`}
        onClick={(event) => { if (stopPropagation) event.stopPropagation(); setOpen(true) }}
      >
        Ver como aluno
      </Button>
      {open && <PreviewDialog open onClose={() => setOpen(false)} courseId={courseId} studentClass={studentClass} courseName={courseName} />}
    </>
  )
}
