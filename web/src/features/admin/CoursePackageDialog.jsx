import { useEffect, useRef, useState } from 'react'
import { Download, FileArchive, Upload } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { ConfirmDialog, Modal } from '../../components/ui/Modal'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { api, downloadFile } from '../../lib/api'
import { useAuth } from '../../context/AuthProvider'
import { useToast } from '../../context/ToastProvider'
import { canAccessAdminPermission, isFullAdmin } from '../../lib/adminPermissions'

// Pacote de curso (P4-S14, D25 a D27): a prévia confere o ZIP sem gravar nada e diz o
// que vai entrar; a importação manda o mesmo arquivo de novo com o sha256 da prévia (o
// servidor recusa outro arquivo) e grava tudo ou nada.
// Os botões ("Exportar curso" e "Importar curso") ficam aqui, com o diálogo de cada um,
// para Cursos e turmas (TurmasPage) só pôr cada botão no lugar.

// Exportar e importar pedem course.manage (o administrador sempre tem; o professor só
// quando a conta recebeu a permissão, na escola dele).
export function useCanPackageCourses() {
  const { auth } = useAuth()
  return isFullAdmin(auth) || canAccessAdminPermission(auth, 'course.manage')
}
export const COURSE_PACKAGE_ACCEPT = '.zip,application/zip'
export const PACKAGE_PERSONAL_DATA_NOTE = 'O pacote não leva alunos, notas nem presença.'
export const PACKAGE_ANSWERS_WARNING = 'O arquivo tem as provas e os gabaritos: guarde como guardaria a prova impressa.'

const COUNT_LABELS = [
  ['modulos', 'módulo', 'módulos'],
  ['unidades', 'unidade', 'unidades'],
  ['apostilas', 'apostila', 'apostilas'],
  ['avaliacoes', 'avaliação', 'avaliações'],
  ['questoesNasAvaliacoes', 'questão nas avaliações', 'questões nas avaliações'],
  ['arquivos', 'arquivo anexado', 'arquivos anexados'],
  ['imagens', 'imagem das apostilas', 'imagens das apostilas'],
  ['biblioteca', 'item da Biblioteca', 'itens da Biblioteca'],
  ['questoesBanco', 'questão do banco', 'questões do banco'],
]

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`
}

function formatDate(value) {
  const date = new Date(Number(value))
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('pt-BR') : ''
}

const NO_SCHOOL_MESSAGE = 'Sua conta não tem escola atribuída para receber o curso. Peça ao administrador para atribuir a escola à sua conta.'

// Escolas que a conta pode escolher: as que o servidor devolveu na prévia
// (escolasPermitidas, a mesma regra da importação); sem o campo, todas as da lista.
function allowedSchools(schools, preview) {
  if (!preview || !Array.isArray(preview.escolasPermitidas)) return schools
  const allowed = new Set(preview.escolasPermitidas.map(String))
  return schools.filter(school => allowed.has(String(school.id)))
}

// Turmas modelo que a importação cria: as do pacote menos as que já nasceriam com alunos
// (turma gravada só pelo nome em cadastros antigos; o servidor não cria e avisa).
function creatableClasses(preview) {
  const skipped = new Set((preview?.turmasModeloComAlunos || []).map(item => item.nome))
  return (preview?.turmasModelo || []).filter(name => !skipped.has(name))
}

function packageForm(file, fields = {}) {
  const form = new FormData()
  form.append('arquivo', file)
  Object.entries(fields).forEach(([key, value]) => form.append(key, value))
  return form
}

// "Exportar curso": avisa que o arquivo leva as provas e os gabaritos e baixa o pacote.
// O erro do download fica no próprio diálogo (o ConfirmDialog mostra a mensagem).
export function CourseExportButton({ course }) {
  const canPackage = useCanPackageCourses()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  if (!canPackage || !course) return null
  async function exportCourse() {
    await downloadFile(`/api/admin/courses/${encodeURIComponent(course.id)}/package`, `curso_${course.id}.iclass-curso.zip`)
    toast.success('Pacote do curso baixado.')
    setOpen(false)
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" icon={Download} onClick={() => setOpen(true)}>Exportar curso</Button>
      <span className="text-xs text-subtle">Leva este curso para outro IClass.</span>
      <ConfirmDialog open={open} onClose={() => setOpen(false)} onConfirm={exportCourse} title="Exportar curso?"
        description={`Baixa um pacote (.iclass-curso.zip) de ${course.name} para importar em outro IClass: estrutura, apostilas, avaliações, arquivos e questões do banco ligadas às provas.`}
        note={`${PACKAGE_ANSWERS_WARNING}\n${PACKAGE_PERSONAL_DATA_NOTE}`} confirmLabel="Baixar pacote" />
    </div>
  )
}

// "Importar curso": abre o diálogo da prévia; no fim avisa o que entrou (e a turma modelo
// que não foi criada) e devolve o curso novo para a tela selecionar.
export function CourseImportButton({ schools = [], onImported, className = '' }) {
  const canPackage = useCanPackageCourses()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  if (!canPackage) return null
  function finish(result) {
    setOpen(false)
    const renamed = Number(result?.renomeadas || 0) + Number(result?.arquivosRenomeados || 0)
    toast.success(renamed ? `Curso importado como ${result.course.id}. Algumas chaves e arquivos ganharam o código do curso para não misturar com os daqui.` : `Curso importado como ${result.course.id}.`)
    const skipped = Array.isArray(result?.turmasPuladas) ? result.turmasPuladas : []
    if (skipped.length) toast.warning(`${skipped.length === 1 ? 'A turma modelo' : 'As turmas modelo'} ${skipped.map(item => item.nome).join(', ')} não ${skipped.length === 1 ? 'foi criada' : 'foram criadas'}: há alunos daqui com essa turma gravada só pelo nome. Crie a turma com outro nome em "Nova turma".`)
    onImported?.(result.course)
  }
  return (
    <>
      <Button variant="secondary" icon={Upload} className={className} onClick={() => setOpen(true)}>Importar curso</Button>
      <CoursePackageImportDialog open={open} onClose={() => setOpen(false)} schools={schools} onImported={finish} />
    </>
  )
}

export function CoursePackageImportDialog({ open, onClose, schools = [], onImported }) {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [form, setForm] = useState({ newId: '', newName: '', schoolId: '', incluirTurmasModelo: true })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fieldError, setFieldError] = useState({})
  const inputRef = useRef(null)

  // Cada abertura começa do zero (arquivo e prévia da vez anterior não ficam).
  useEffect(() => {
    if (!open) return
    setFile(null)
    setPreview(null)
    setError('')
    setFieldError({})
    setLoading(false)
    if (inputRef.current) inputRef.current.value = ''
  }, [open])

  async function choose(event) {
    const chosen = event.target.files?.[0] || null
    setFile(chosen)
    setPreview(null)
    setError('')
    setFieldError({})
    if (!chosen) return
    setLoading(true)
    try {
      const result = await api.post('/api/admin/course-packages/preview', packageForm(chosen), { timeoutMs: 0 })
      setPreview(result)
      const allowed = allowedSchools(schools, result)
      const creatable = creatableClasses(result)
      setForm({
        newId: result.sugestao?.newId || '',
        newName: result.sugestao?.newName || '',
        schoolId: allowed.some(school => school.id === form.schoolId) ? form.schoolId : (allowed[0]?.id || ''),
        incluirTurmasModelo: creatable.length > 0,
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function importPackage() {
    if (!file || !preview || loading) return
    const newId = form.newId.trim().toUpperCase()
    const newName = form.newName.trim()
    const missing = {}
    if (!newId) missing.newId = 'Informe o código do curso.'
    if (!newName) missing.newName = 'Informe o nome do curso.'
    if (!form.schoolId && schoolOptions.length) missing.schoolId = 'Escolha a escola.'
    if (noSchool) missing.schoolId = NO_SCHOOL_MESSAGE
    setFieldError(missing)
    if (Object.keys(missing).length) return
    setLoading(true)
    setError('')
    try {
      const result = await api.post('/api/admin/course-packages/import', packageForm(file, {
        sha256: preview.sha256,
        newId,
        newName,
        ...(form.schoolId ? { schoolId: form.schoolId } : {}),
        incluirTurmasModelo: form.incluirTurmasModelo ? 'sim' : 'nao',
      }), { timeoutMs: 0 })
      onImported?.(result)
    } catch (err) {
      const field = err.data?.field
      if (field === 'newId' || field === 'newName' || field === 'schoolId') setFieldError({ [field]: err.message })
      else setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const counts = preview?.contagens || {}
  const conflitos = preview?.conflitos || {}
  const turmasModelo = creatableClasses(preview)
  const typedId = form.newId.trim().toUpperCase()
  const suggestedId = preview?.sugestao?.newId || ''
  const example = conflitos.exemplos?.[0]
  // O exemplo do servidor vale para o código sugerido; com outro código, a chave ganha o
  // código digitado (e _2 no fim se esse nome também já existir aqui).
  const exampleText = !example ? '' : (!typedId || typedId === suggestedId)
    ? `${example.de} → ${example.para}`
    : `${example.de} → ${example.de}_${typedId}, ou com _2 no fim se esse nome também já existir`
  const schoolOptions = allowedSchools(schools, preview)
  // Conta sem escola atribuída (o professor só com turmas): a importação recusaria.
  const noSchool = !!preview && schools.length > 0 && schoolOptions.length === 0

  return (
    <Modal open={open} onClose={loading ? () => {} : onClose} size="lg" title="Importar curso"
      description="Escolha um pacote exportado de outro IClass (arquivo .iclass-curso.zip). Nada é gravado antes de você confirmar."
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={loading}>Cancelar</Button>
        <Button icon={Upload} loading={loading && !!preview} disabled={!preview || loading || noSchool} onClick={importPackage}>Importar curso</Button>
      </>}>
      <div className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-text">Pacote do curso</span>
          <input ref={inputRef} type="file" accept={COURSE_PACKAGE_ACCEPT} aria-label="Pacote do curso" disabled={loading}
            onChange={choose}
            className="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-surface-2 file:px-3 file:py-2 file:text-sm file:text-text" />
        </label>
        {loading && !preview && <p className="text-sm text-muted" role="status">Conferindo o pacote…</p>}
        {error && <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">{error}</p>}

        {preview && <>
          <div className="rounded-lg border border-border p-4">
            <p className="flex items-start gap-2 font-medium text-text"><FileArchive size={17} className="mt-0.5 shrink-0 text-muted" /><span className="min-w-0 [overflow-wrap:anywhere]">{preview.resumo?.nome} <span className="text-sm font-normal text-subtle">({preview.resumo?.codigo})</span></span></p>
            <p className="mt-1 text-xs text-subtle">
              {[preview.resumo?.exportadoEm ? `Exportado em ${formatDate(preview.resumo.exportadoEm)}` : '', preview.resumo?.versaoApp ? `IClass ${preview.resumo.versaoApp}` : ''].filter(Boolean).join(' · ')}
            </p>
            <ul className="mt-3 grid gap-1 text-sm text-text sm:grid-cols-2" aria-label="Conteúdo do pacote">
              {COUNT_LABELS.filter(([key]) => Number(counts[key] || 0) > 0).map(([key, one, many]) => <li key={key}>{plural(Number(counts[key]), one, many)}</li>)}
            </ul>
            <p className="mt-3 text-sm text-muted">{PACKAGE_PERSONAL_DATA_NOTE}</p>
          </div>

          {(conflitos.cursoExiste || conflitos.chavesRenomeadas > 0 || conflitos.arquivosRenomeados > 0 || (preview.avisos || []).length > 0) && (
            <div className="space-y-1.5 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-text [overflow-wrap:anywhere]" aria-label="Avisos da prévia">
              {conflitos.cursoExiste && <p>Já existe um curso {preview.resumo?.codigo}: será importado como {typedId || suggestedId}.</p>}
              {conflitos.chavesRenomeadas > 0 && <p>{plural(conflitos.chavesRenomeadas, 'apostila ou avaliação tem', 'apostilas ou avaliações têm')} o nome de um conteúdo que já existe aqui e {conflitos.chavesRenomeadas === 1 ? 'vai' : 'vão'} ganhar o código do curso no fim{exampleText ? ` (ex.: ${exampleText})` : ''}.</p>}
              {conflitos.arquivosRenomeados > 0 && <p>{plural(conflitos.arquivosRenomeados, 'arquivo tem', 'arquivos têm')} o nome de outro arquivo daqui e {conflitos.arquivosRenomeados === 1 ? 'vai' : 'vão'} entrar com outro nome; as apostilas são ajustadas.</p>}
              {(preview.avisos || []).map(aviso => <p key={aviso}>{aviso}</p>)}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Código do curso" value={form.newId} maxLength={64} error={fieldError.newId}
              onChange={event => setForm(current => ({ ...current, newId: event.target.value }))} />
            <Input label="Nome do curso" value={form.newName} maxLength={120} error={fieldError.newName}
              onChange={event => setForm(current => ({ ...current, newName: event.target.value }))} />
          </div>
          {schoolOptions.length > 0 && <Select label="Escola" value={form.schoolId} error={fieldError.schoolId}
            onChange={event => setForm(current => ({ ...current, schoolId: event.target.value }))}>
            {schoolOptions.map(school => <option key={school.id} value={school.id}>{school.name}</option>)}
          </Select>}
          {noSchool && <p role="alert" className="text-sm text-danger">{NO_SCHOOL_MESSAGE}</p>}
          {fieldError.schoolId && schoolOptions.length === 0 && !noSchool && <p role="alert" className="text-xs text-danger">{fieldError.schoolId}</p>}
          {turmasModelo.length > 0 && <label className="flex items-start gap-2 text-sm text-text">
            <input type="checkbox" className="mt-0.5" checked={form.incluirTurmasModelo}
              onChange={event => setForm(current => ({ ...current, incluirTurmasModelo: event.target.checked }))} />
            <span>Criar as turmas modelo ({turmasModelo.join(', ')}), vazias, com os horários do curso de origem</span>
          </label>}
        </>}
      </div>
    </Modal>
  )
}
