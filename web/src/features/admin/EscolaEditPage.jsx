import { useMemo, useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Save, Trash2, Building2 } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { PageState } from '../../components/ui/PageState'
import { PageHeader } from '../../components/ui/PageHeader'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'

const emptyInfo = { tradeName: '', legalName: '', registrationId: '', address: '', cityState: '', zip: '', phone: '', email: '', website: '', directorName: '', directorRole: '', signatureUrl: '' }

function InfoFields({ value, onName, onInfo }) {
  const info = value.info || {}
  return (
    <div className="space-y-4">
      <Input label="Nome (rótulo interno)" value={value.name || ''} onChange={(e) => onName(e.target.value)} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="Nome fantasia" value={info.tradeName || ''} onChange={(e) => onInfo({ tradeName: e.target.value })} />
        <Input label="Razão social" value={info.legalName || ''} onChange={(e) => onInfo({ legalName: e.target.value })} />
        <Input label="CNPJ / registro" value={info.registrationId || ''} onChange={(e) => onInfo({ registrationId: e.target.value })} />
        <Input label="Telefone" value={info.phone || ''} onChange={(e) => onInfo({ phone: e.target.value })} />
        <Input label="E-mail" type="email" value={info.email || ''} onChange={(e) => onInfo({ email: e.target.value })} />
        <Input label="Site" value={info.website || ''} onChange={(e) => onInfo({ website: e.target.value })} />
      </div>
      <Input label="Endereço" value={info.address || ''} onChange={(e) => onInfo({ address: e.target.value })} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="Cidade / UF" value={info.cityState || ''} onChange={(e) => onInfo({ cityState: e.target.value })} />
        <Input label="CEP" value={info.zip || ''} onChange={(e) => onInfo({ zip: e.target.value })} />
        <Input label="Responsável" value={info.directorName || ''} onChange={(e) => onInfo({ directorName: e.target.value })} />
        <Input label="Cargo do responsável" value={info.directorRole || ''} onChange={(e) => onInfo({ directorRole: e.target.value })} />
      </div>
      <Input label="Assinatura (URL da imagem)" value={info.signatureUrl || ''} onChange={(e) => onInfo({ signatureUrl: e.target.value })} placeholder="opcional" />
    </div>
  )
}

export default function EscolaEditPage() {
  const { id } = useParams()
  const isNew = id === 'novo'
  const nav = useNavigate()
  const toast = useToast()
  const schools = useApi('/api/admin/schools')
  const { data: courses } = useApi('/api/courses')
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)

  const school = useMemo(() => isNew ? null : (schools.data || []).find((s) => s.id === decodeURIComponent(id || '')), [schools.data, id, isNew])
  const courseCount = useMemo(() => school ? (courses || []).filter((c) => !c.deleted && c.schoolId === school.id).length : 0, [courses, school])

  useEffect(() => {
    if (form) return
    if (isNew) { setForm({ name: '', info: { ...emptyInfo } }); return }
    if (school) setForm({ id: school.id, name: school.name || '', info: { ...emptyInfo, ...(school.info || {}) } })
  }, [school, isNew, form])

  async function save() {
    if (!form.name.trim()) return toast.error('Informe o nome da escola')
    setSaving(true)
    try {
      if (isNew) await api.post('/api/admin/schools/create', { name: form.name, info: form.info })
      else await api.post('/api/admin/schools/update', { id: form.id, name: form.name, info: form.info })
      toast.success(isNew ? 'Escola criada' : 'Escola atualizada')
      nav('/escolas')
    } catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }
  async function remove() {
    try { await api.post('/api/admin/schools/delete', { id: form.id }); toast.success('Escola removida'); nav('/escolas') }
    catch (e) { toast.error(e.message) }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <button onClick={() => nav('/escolas')} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-text"><ArrowLeft size={16} />Voltar às escolas</button>

      <PageState loading={schools.loading && !form} error={schools.error} onRetry={schools.refetch}>
        {!isNew && !school && !schools.loading ? (
          <Card className="p-6"><p className="text-sm text-muted">Escola não encontrada.</p></Card>
        ) : form ? (
          <div className="space-y-5">
            <PageHeader title={isNew ? 'Nova escola' : (form.name || 'Escola')} subtitle={isNew ? 'Dados institucionais' : `${courseCount} curso(s) vinculado(s)`}>
              <div className="flex gap-2">
                {!isNew && <Button variant="destructive" icon={Trash2} onClick={() => setConfirmDel(true)}>Excluir</Button>}
                <Button icon={Save} loading={saving} onClick={save}>{isNew ? 'Criar' : 'Salvar'}</Button>
              </div>
            </PageHeader>

            {confirmDel && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3">
                <p className="text-sm text-text">Excluir {form.name}? Só é possível excluir escolas sem cursos vinculados.</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDel(false)}>Cancelar</Button>
                  <Button size="sm" variant="destructive" onClick={remove}>Excluir</Button>
                </div>
              </div>
            )}

            <Card className="p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-9 h-9 rounded-md bg-primary-soft text-primary grid place-items-center"><Building2 size={18} /></span>
                <p className="text-sm font-medium text-text">Dados da instituição</p>
              </div>
              <InfoFields value={form} onName={(v) => setForm((f) => ({ ...f, name: v }))} onInfo={(p) => setForm((f) => ({ ...f, info: { ...f.info, ...p } }))} />
            </Card>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => nav('/escolas')}>Cancelar</Button>
              <Button icon={Save} loading={saving} onClick={save}>{isNew ? 'Criar' : 'Salvar'}</Button>
            </div>

            {!isNew && <p className="text-xs text-subtle">A identidade visual desta escola (cores, logo) é editada em Identidade Visual.</p>}
          </div>
        ) : null}
      </PageState>
    </div>
  )
}
