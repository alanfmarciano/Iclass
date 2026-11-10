import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '../../components/ui/PageHeader'
import { Tabs } from '../../components/ui/Tabs'
import { DocumentosTab } from './lgpd/DocumentosTab'
import { EncarregadoTab } from './lgpd/EncarregadoTab'

// Página Privacidade (LGPD), só do administrador (H8a-1; SEG-08, OPS-12).
// - Documentos: os Termos de Uso e a Política de Privacidade. O administrador revisa o
//   texto modelo, grava o rascunho, confere a prévia com os dados de cada escola e
//   publica. Enquanto nada é publicado, os alunos veem o modelo e ninguém precisa
//   aceitar nada (decisão P4).
// - Controlador e encarregado: os dados da escola que entram nos textos e o encarregado
//   pelo tratamento de dados pessoais (DPO), gravado só aqui.
// A aba fica no endereço (?aba=), para abrir direto por link.
const TABS = [
  { id: 'documentos', label: 'Documentos' },
  { id: 'encarregado', label: 'Controlador e encarregado' },
]

export default function PrivacidadePage() {
  const [params, setParams] = useSearchParams()
  const active = TABS.some((tab) => tab.id === params.get('aba')) ? params.get('aba') : 'documentos'
  const choose = (id) => {
    const next = new URLSearchParams(params)
    if (id === 'documentos') next.delete('aba')
    else next.set('aba', id)
    setParams(next, { replace: true })
  }
  return (
    <div className="space-y-5">
      <PageHeader title="Privacidade (LGPD)" subtitle="Termos de Uso, Política de Privacidade e encarregado pelo tratamento de dados pessoais." />
      <Tabs tabs={TABS} active={active} onChange={choose} />
      {active === 'documentos' ? <DocumentosTab /> : <EncarregadoTab />}
    </div>
  )
}
