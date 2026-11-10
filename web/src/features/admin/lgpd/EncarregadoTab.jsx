import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardBody, CardHeader } from '../../../components/ui/Card'
import { Button } from '../../../components/ui/Button'
import { Input } from '../../../components/ui/Input'
import { Select } from '../../../components/ui/Select'
import { PageLoading } from '../../../components/ui/PageLoading'
import { api } from '../../../lib/api'
import { useToast } from '../../../context/ToastProvider'

// Aba "Controlador e encarregado" da página Privacidade (LGPD) (H8a-1).
// O controlador é a escola: os dados vêm do cadastro dela (Escolas) e entram nos textos
// pelos marcadores. O encarregado (DPO) é gravado só aqui (POST /api/admin/lgpd/dpo),
// com auditoria; editar a escola não o troca.

const CONTROLLER_FIELDS = [
  ['legalName', 'Razão social'],
  ['tradeName', 'Nome fantasia'],
  ['registrationId', 'CNPJ'],
  ['address', 'Endereço'],
  ['cityState', 'Cidade/UF'],
  ['zip', 'CEP'],
  ['email', 'E-mail'],
  ['phone', 'Telefone'],
  ['website', 'Site'],
]

const EMPTY_DPO = { dpoName: '', dpoEmail: '', dpoPhone: '' }

export function EncarregadoTab() {
  const toast = useToast()
  const [schools, setSchools] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [schoolId, setSchoolId] = useState('')
  const [form, setForm] = useState(EMPTY_DPO)
  const [applyToAll, setApplyToAll] = useState(false)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoadError('')
    try {
      const data = await api.get('/api/admin/lgpd/dpo')
      const list = data?.schools || []
      setSchools(list)
      setSchoolId((current) => (list.some((school) => school.id === current) ? current : (list[0]?.id || '')))
    } catch (error) {
      setLoadError(error.message || 'Não foi possível carregar os dados.')
    }
  }
  useEffect(() => { load() }, [])

  const school = (schools || []).find((item) => item.id === schoolId) || null
  useEffect(() => {
    setForm(school ? { ...EMPTY_DPO, ...school.dpo } : EMPTY_DPO)
    setErrors({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, schools])

  async function save(event) {
    event.preventDefault()
    setSaving(true); setErrors({})
    try {
      const result = await api.post('/api/admin/lgpd/dpo', { schoolId, applyToAll, ...form })
      setSchools(result.schools || [])
      toast?.success?.(result.changed ? 'Encarregado salvo.' : 'Nada mudou.')
    } catch (error) {
      const field = error?.data?.field
      if (field) setErrors({ [field]: error.message })
      else toast?.error?.(error.message || 'Não foi possível salvar.')
    } finally {
      setSaving(false)
    }
  }

  if (loadError) {
    return (
      <div role="alert" className="rounded-xl border border-border bg-surface p-5 space-y-3">
        <p className="text-sm">{loadError}</p>
        <Button variant="secondary" onClick={load}>Tentar de novo</Button>
      </div>
    )
  }
  if (!schools) return <PageLoading />
  if (!schools.length) return <p className="text-sm text-muted">Cadastre uma escola em Escolas para preencher os dados do controlador.</p>

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {schools.length > 1 && (
        <div className="lg:col-span-2 max-w-sm">
          <Select label="Escola" value={schoolId} onChange={(event) => setSchoolId(event.target.value)}>
            {schools.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
          </Select>
        </div>
      )}
      <Card>
        <CardHeader title="Controlador" subtitle="A escola responsável pelos dados. Estes campos preenchem os marcadores dos documentos." />
        <CardBody>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            {CONTROLLER_FIELDS.map(([key, label]) => (
              <div key={key} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="break-words">{school?.institution?.[key] || <span className="text-muted">não informado</span>}</dd>
              </div>
            ))}
          </dl>
          {school && <Link to={`/escolas/${encodeURIComponent(school.id)}`} className="mt-4 inline-block text-sm text-primary underline">Editar os dados da escola</Link>}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Encarregado pelo tratamento de dados (DPO)" subtitle="Quem responde aos alunos e responsáveis sobre dados pessoais. Aparece na Política de Privacidade e nos Termos." />
        <CardBody>
          <form className="space-y-3" onSubmit={save} noValidate>
            <Input label="Nome" value={form.dpoName} onChange={set('dpoName')} error={errors.dpoName} maxLength={120} autoComplete="off" />
            <Input label="E-mail" type="email" value={form.dpoEmail} onChange={set('dpoEmail')} error={errors.dpoEmail} maxLength={254} autoComplete="off" />
            <Input label="Telefone" value={form.dpoPhone} onChange={set('dpoPhone')} error={errors.dpoPhone} maxLength={40} autoComplete="off" />
            <p className="text-xs text-muted">Informe o nome e pelo menos um contato. Deixe tudo em branco para remover.</p>
            <p className="text-xs text-muted">O encarregado fica no cadastro da escola: restaurar um backup anterior volta ao encarregado que estava no backup. Confira esta aba depois de uma restauração.</p>
            {schools.length > 1 && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={applyToAll} onChange={(event) => setApplyToAll(event.target.checked)} />
                Usar este encarregado em todas as escolas
              </label>
            )}
            <Button type="submit" loading={saving}>Salvar encarregado</Button>
          </form>
        </CardBody>
      </Card>
    </div>
  )
}
