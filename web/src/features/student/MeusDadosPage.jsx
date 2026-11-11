import { useRef, useState } from 'react'
import { Download, Printer } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { useAuth } from '../../context/AuthProvider'
import { api } from '../../lib/api'
import { downloadDataExport, openPrintWindow, printDataExport } from '../../lib/dataExportPrint'

// Meus dados (/aluno/meus-dados, H8c reduzido; SEG-14, art. 18 da LGPD): o aluno baixa
// uma cópia dos dados pessoais que o IClass guarda sobre ele (GET /api/student/my-data)
// ou abre a versão para imprimir. O servidor decide o que entra; a tela só busca e mostra.
// O servidor aceita 5 cópias por hora: a cópia recebida fica guardada nesta tela por
// alguns minutos, para "baixar" e "imprimir" em seguida não gastarem duas.
const REUSE_MS = 10 * 60 * 1000

export default function MeusDadosPage() {
  const { auth } = useAuth()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const cache = useRef({ email: '', at: 0, data: null })

  const fetchData = async (purpose) => {
    const cached = cache.current
    if (cached.data && cached.email === auth.email && Date.now() - cached.at < REUSE_MS) return cached.data
    const data = await api.get(`/api/student/my-data?finalidade=${purpose}`)
    if (!data || typeof data !== 'object' || !data.profile) throw new Error('O servidor não mandou a cópia dos dados. Tente de novo.')
    cache.current = { email: auth.email, at: Date.now(), data }
    return data
  }

  const run = async (purpose) => {
    if (busy) return
    setError('')
    setNotice('')
    // A janela de impressão abre no clique: depois da espera o navegador a bloquearia.
    const win = purpose === 'imprimir' ? openPrintWindow() : null
    if (purpose === 'imprimir' && !win) {
      setError('O navegador bloqueou a janela de impressão. Permita janelas deste endereço e tente de novo.')
      return
    }
    setBusy(purpose)
    try {
      const data = await fetchData(purpose)
      if (purpose === 'imprimir') {
        if (!printDataExport(data, win)) setError('A janela de impressão foi fechada antes de a cópia ficar pronta. Tente de novo.')
      } else {
        const name = downloadDataExport(data)
        setNotice(`Arquivo ${name} salvo na pasta de downloads do navegador.`)
      }
    } catch (e) {
      if (win && !win.closed) win.close()
      setError(e && e.message ? e.message : 'Não foi possível buscar seus dados. Tente de novo.')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <PageHeader title="Meus dados" subtitle="Uma cópia dos dados pessoais que o IClass guarda sobre você." />
      <Card>
        <CardHeader title="Cópia dos seus dados" subtitle="Você pode salvar o arquivo ou imprimir. Até 5 cópias por hora." />
        <CardBody className="space-y-4 text-sm">
          <p className="text-muted">
            A cópia traz o seu cadastro, as turmas, o aceite dos termos, as notas e entregas já liberadas, a frequência,
            os certificados, as observações compartilhadas com você, suas dúvidas no fórum, os acessos ao portal e o que
            foi registrado durante as provas (saídas da tela e o resumo do teclado).
          </p>
          <p className="text-muted">
            Não entram as questões e o gabarito das provas, os dados de outros alunos nem as anotações internas da equipe.
            Para pedir correção, explicação ou exclusão de algum dado, fale com o professor ou com o encarregado de dados da escola.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button icon={Download} loading={busy === 'baixar'} disabled={!!busy && busy !== 'baixar'} onClick={() => run('baixar')}>Baixar meus dados (arquivo JSON)</Button>
            <Button variant="secondary" icon={Printer} loading={busy === 'imprimir'} disabled={!!busy && busy !== 'imprimir'} onClick={() => run('imprimir')}>Ver para imprimir</Button>
          </div>
          {error ? <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger">{error}</p> : null}
          {notice ? <p role="status" className="text-success">{notice}</p> : null}
        </CardBody>
      </Card>
    </div>
  )
}
