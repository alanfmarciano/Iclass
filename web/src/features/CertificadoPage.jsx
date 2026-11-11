import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Download, ExternalLink, Lock, ShieldAlert, ShieldCheck } from 'lucide-react'
import { api } from '../lib/api'
import { Button } from '../components/ui/Button'
import { PageLoading } from '../components/ui/PageLoading'
import { CA_DOWNLOAD_PATH, formatCertificateDate } from '../lib/adminAccess'

// Guia público /certificado (H6c, OPS-08): como instalar, uma vez por aparelho, o
// certificado da CA deste IClass, para o endereço seguro (https) abrir sem o aviso
// "Sua conexão não é particular". Abre sem login, em http e em https, também no celular.
// A impressão digital vem do servidor (GET /api/connection/certificate) e é para comparar
// com a que aparece no computador do IClass (Sistema → Rede): o arquivo é baixado antes
// de existir confiança, e é essa comparação que garante que ele é o desta escola.

export const PLATFORM_STEPS = [
  {
    id: 'android',
    title: 'Android (celular ou tablet)',
    steps: [
      'Toque em "Baixar certificado" e salve o arquivo iclass-ca.crt.',
      'Abra Configurações → Segurança (ou "Segurança e privacidade") → Mais configurações de segurança → Criptografia e credenciais → Instalar um certificado → Certificado de CA. O caminho muda um pouco conforme o fabricante: procure por "certificado" nas Configurações.',
      'Toque em "Instalar mesmo assim", escolha o arquivo iclass-ca.crt na pasta Downloads e confirme com o bloqueio de tela.',
      'O aviso "A rede pode ser monitorada" é normal com um certificado instalado pela escola.',
    ],
  },
  {
    id: 'ios',
    title: 'iPhone e iPad',
    steps: [
      'Abra esta página no Safari, toque em "Baixar certificado" e em "Permitir" para baixar o perfil.',
      'Abra Ajustes → Geral → VPN e Gerenciamento de Dispositivos (ou toque em "Perfil Baixado", no alto dos Ajustes) e toque em "Instalar".',
      'Ative a confiança: Ajustes → Geral → Sobre → Ajustes de Confiança de Certificado → ligue a chave do "IClass – CA local". Sem este passo o Safari continua avisando.',
    ],
  },
  {
    id: 'windows',
    title: 'Windows (Chrome e Edge)',
    steps: [
      'Baixe o certificado e abra o arquivo iclass-ca.crt com dois cliques → "Instalar Certificado...".',
      'Escolha "Máquina Local" (pede a senha de administrador; vale para todos os usuários) ou "Usuário Atual".',
      'Marque "Colocar todos os certificados no repositório a seguir" → Procurar → "Autoridades de Certificação Raiz Confiáveis" → Avançar → Concluir.',
      'Feche e abra o navegador de novo.',
    ],
    note: 'Nos computadores do laboratório, o técnico pode instalar em todos de uma vez (certutil -addstore Root iclass-ca.crt, ou por política de grupo).',
  },
  {
    id: 'mac',
    title: 'Mac',
    steps: [
      'Baixe o certificado e abra o arquivo iclass-ca.crt com dois cliques: ele entra no Acesso às Chaves.',
      'No Acesso às Chaves, abra o "IClass – CA local", expanda "Confiar" e escolha "Confiar Sempre". Feche a janela e confirme com a senha do Mac.',
    ],
  },
  {
    id: 'firefox',
    title: 'Firefox (qualquer sistema)',
    steps: [
      'O Firefox usa a própria lista de certificados. Abra Configurações → Privacidade e Segurança → Certificados → Ver certificados → Autoridades → Importar.',
      'Escolha o arquivo iclass-ca.crt e marque "Confiar nesta CA para identificar sites".',
    ],
    note: 'No Windows, outra opção é instalar no Windows (acima) e, em about:config, deixar security.enterprise_roots.enabled como true.',
  },
  {
    id: 'chromebook',
    title: 'Chromebook',
    steps: [
      'Abra chrome://settings/certificates (Configurações → Privacidade e segurança → Segurança → Gerenciar certificados) → Autoridades → Importar.',
      'Escolha o arquivo iclass-ca.crt e marque "Confiar neste certificado para identificar websites".',
    ],
    note: 'Chromebook gerenciado pela escola pode bloquear a importação: nesse caso, quem administra os Chromebooks instala o certificado pelo painel de administração.',
  },
]

export default function CertificadoPage() {
  const [state, setState] = useState({ loading: true, error: '', data: null })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setState((current) => ({ ...current, loading: true, error: '' }))
    api.get('/api/connection/certificate', { auth: false })
      .then((data) => { if (active) setState({ loading: false, error: '', data }) })
      .catch((error) => { if (active) setState({ loading: false, error: error?.message || 'Não foi possível carregar os dados do certificado.', data: null }) })
    return () => { active = false }
  }, [attempt])

  useEffect(() => { document.title = 'Conexão segura do IClass' }, [])

  const data = state.data
  const available = data?.available === true
  const onHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'

  return (
    <main className="min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
        <nav className="mb-6 text-sm">
          <Link to="/" className="inline-flex items-center gap-1.5 text-muted hover:text-text">
            <ArrowLeft aria-hidden="true" size={16} /> Voltar ao IClass
          </Link>
        </nav>

        <article className="rounded-xl border border-border bg-surface p-5 sm:p-8 shadow-sm space-y-6">
          <header className="space-y-2">
            <h1 className="text-2xl font-bold inline-flex items-center gap-2"><Lock aria-hidden="true" size={22} className="text-primary" /> Conexão segura do IClass</h1>
            <p className="text-sm text-text">
              Para abrir o IClass pelo endereço seguro (https) sem o aviso &quot;Sua conexão não é particular&quot;, instale uma vez, em cada aparelho, o certificado do IClass desta escola.
              Com ele, a senha e os dados passam cifrados pela rede da sala.
            </p>
            <p className="text-sm text-muted">
              O certificado vale só para os endereços da rede da escola (os que começam com 10., 172.16 a 172.31 e 192.168., e os nomes terminados em .local): ele não serve para nenhum site da internet.
            </p>
          </header>

          {state.loading && !data && <PageLoading />}

          {state.error && !data && (
            <div role="alert" className="rounded-lg border border-border bg-surface-2 p-4 text-sm space-y-3">
              <p>{state.error}</p>
              <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>Tentar de novo</Button>
            </div>
          )}

          {data && !available && (
            <div role="status" data-testid="certificate-unavailable" className="flex items-start gap-2.5 rounded-lg border border-warning bg-warning-soft px-4 py-3 text-sm text-text">
              <ShieldAlert aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-warning" />
              <p>{data.error || 'Conexão segura indisponível.'} Avise o administrador: o motivo aparece em Sistema → Rede, no computador do IClass.</p>
            </div>
          )}

          {available && (
            <section className="space-y-3" aria-labelledby="cert-download">
              <h2 id="cert-download" className="text-lg font-semibold">1. Baixe o certificado</h2>
              <a href={CA_DOWNLOAD_PATH} download="iclass-ca.crt"
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-fg hover:opacity-90">
                <Download aria-hidden="true" size={16} /> Baixar certificado
              </a>
              <div className="rounded-lg border border-border bg-surface-2 p-4 text-sm space-y-1.5">
                <p className="font-semibold inline-flex items-center gap-2"><ShieldCheck aria-hidden="true" size={16} className="text-success" /> Confira a impressão digital (SHA-256)</p>
                <p className="font-mono text-xs break-all" data-testid="certificate-fingerprint">{data.fingerprintSha256}</p>
                <p className="text-muted">Ela precisa ser igual à que aparece no computador do IClass, em Sistema → Rede. Se for diferente, não instale e avise o professor.</p>
                <p className="text-muted">Válido até {formatCertificateDate(data.validTo)}.</p>
              </div>
            </section>
          )}

          <section className="space-y-3" aria-labelledby="cert-install">
            <h2 id="cert-install" className="text-lg font-semibold">{available ? '2. ' : ''}Instale no aparelho</h2>
            <div className="space-y-2">
              {PLATFORM_STEPS.map((platform) => (
                <details key={platform.id} className="rounded-lg border border-border bg-surface px-4 py-3 text-sm" data-testid={`platform-${platform.id}`}>
                  <summary className="cursor-pointer font-semibold text-text">{platform.title}</summary>
                  <ol className="mt-3 list-decimal space-y-1.5 pl-5">
                    {platform.steps.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                  {platform.note && <p className="mt-2 text-muted">{platform.note}</p>}
                </details>
              ))}
            </div>
          </section>

          {available && (
            <section className="space-y-2" aria-labelledby="cert-open">
              <h2 id="cert-open" className="text-lg font-semibold">3. Abra o endereço seguro</h2>
              {onHttps ? (
                <p className="text-sm">Você já está no endereço seguro. Se o navegador ainda avisar, confira se a confiança no certificado ficou ligada e abra o navegador de novo.</p>
              ) : (
                <>
                  <p className="text-sm">Depois de instalar, abra o IClass pelo endereço seguro (repare no <strong>https</strong> e no número da porta):</p>
                  {data.httpsUrl ? (
                    <a href={`${data.httpsUrl.replace(/\/+$/, "")}/login`} className="inline-flex items-center gap-2 font-mono text-sm font-semibold text-text underline break-all" data-testid="certificate-https-url">
                      <ExternalLink aria-hidden="true" size={15} className="shrink-0" /> {data.httpsUrl}
                    </a>
                  ) : (
                    // O servidor não dá endereço seguro para este aparelho: o IP da rede da
                    // escola não entra no certificado (faixa que não é de rede local).
                    <p role="status" data-testid="certificate-no-https-url" className="text-sm text-warning">
                      O endereço seguro ainda não funciona nesta rede. Avise o administrador: o motivo aparece em Sistema → Rede, no computador do IClass. Enquanto isso, continue pelo endereço de sempre (http).
                    </p>
                  )}
                </>
              )}
            </section>
          )}
        </article>
      </div>
    </main>
  )
}
