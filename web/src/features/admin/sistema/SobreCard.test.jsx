import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { SobreCard, schemaText, shortInstallId, updateText } from './SobreCard'
import { APP_VERSION } from '../../../lib/appVersion'

const mocks = vi.hoisted(() => ({ result: { data: null, error: null, loading: false }, paths: [] }))
vi.mock('../../../hooks/useApi', () => ({
  useApi: (path) => { mocks.paths.push(path); return { ...mocks.result, refetch: vi.fn() } },
}))

const ABOUT = {
  success: true,
  versao: APP_VERSION,
  build: { id: 'abcdef123456', geradoEm: '2026-11-18T12:00:00.000Z', node: 'v22.23.5' },
  modo: 'desenvolvimento',
  node: 'v20.19.0',
  plataforma: 'Windows_NT 10.0.19045 (x64)',
  esquema: { aplicadas: 2, ultima: { id: '2026-11-p6-instalacao', nome: 'Identifica esta instalação (código e data em settings.install)', em: Date.parse('2026-11-18T13:00:00Z') }, pendentes: 0, desconhecidas: 0 },
  ultimaAtualizacao: { de: '3.0.0', para: '3.1.0', em: Date.parse('2026-11-18T13:00:00Z'), backup: 'pre-atualizacao_dados_20261118.zip', semBackup: false, instalacaoNova: false, migracoes: 2 },
  instalacao: { id: '9f1c2d3e-0000-4000-8000-123456789abc', criadaEm: Date.parse('2026-11-18T13:00:00Z'), licenciadoPara: null, licencaAceita: false },
}

function renderCard() {
  return render(<MemoryRouter><SobreCard /></MemoryRouter>)
}

// Cartão Sobre o IClass (fase 3, A1 / P6-S2: OPS-02, ENG-10, OPS-21).
describe('[UC-VERSAO-003] Sobre o IClass na tela Sistema', () => {
  afterEach(() => { cleanup(); mocks.paths.length = 0; mocks.result = { data: null, error: null, loading: false } })

  it('mostra versão, última atualização com o backup, versão dos dados, código da instalação e modo', () => {
    mocks.result = { data: ABOUT, error: null, loading: false }
    renderCard()
    expect(mocks.paths).toContain('/api/admin/system/about')
    expect(screen.getByRole('heading', { name: 'Sobre o IClass' })).toBeInTheDocument()
    expect(screen.getByText('Versão').nextSibling).toHaveTextContent(APP_VERSION)
    expect(screen.getByText('Última atualização').nextSibling).toHaveTextContent('de 3.0.0; backup antes da atualização: pre-atualizacao_dados_20261118.zip')
    expect(screen.getByText('Dados na versão').nextSibling).toHaveTextContent('2 atualizações aplicadas · última: Identifica esta instalação')
    expect(screen.getByText('Instalação').nextSibling).toHaveTextContent('9F1C2D3E')
    expect(screen.getByText('Licenciado para').nextSibling).toHaveTextContent('Não informado')
    expect(screen.getByText('Modo').nextSibling).toHaveTextContent('Pasta de desenvolvimento (git)')
    // Sem pastas para quem não é administrador (o servidor não manda).
    expect(screen.queryByText('Pasta dos dados')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ajuda' })).toHaveAttribute('href', '/ajuda')
  })

  it('o administrador vê as pastas; o navegador com o bundle de outra versão avisa que recarrega', () => {
    mocks.result = { data: { ...ABOUT, versao: '9.9.9', pastas: { programa: 'C:\\IClass\\programa\\3.1.0', dados: 'C:\\IClass\\dados', conteudo: 'C:\\IClass\\conteudo', cursosArquivados: 'C:\\IClass\\cursos-arquivados' } }, error: null, loading: false }
    renderCard()
    expect(screen.getByText('Pasta dos dados').nextSibling).toHaveTextContent('C:\\IClass\\dados')
    expect(screen.getByText('Versão').nextSibling).toHaveTextContent(`9.9.9 (esta tela ainda é da ${APP_VERSION}; ela recarrega sozinha)`)
  })

  it('Novidades abre o CHANGELOG na própria tela', async () => {
    mocks.result = { data: ABOUT, error: null, loading: false }
    renderCard()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Novidades' }))
    const dialog = await screen.findByRole('dialog', { name: 'Novidades do IClass' }, { timeout: 5000 })
    await waitFor(() => expect(dialog).toHaveTextContent('Não publicado'))
    expect(dialog).toHaveTextContent('Sobre o IClass')
  })

  it('erro do servidor aparece em português', () => {
    mocks.result = { data: null, error: { message: 'Tempo esgotado.' }, loading: false }
    renderCard()
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível consultar o servidor agora. Tempo esgotado.')
  })

  it('textos da última atualização e da versão dos dados', () => {
    expect(updateText(null)).toMatch(/^Nenhuma atualização registrada/)
    expect(updateText({ instalacaoNova: true, para: '3.1.0', em: Date.parse('2026-11-18T13:00:00Z') })).toMatch(/^Instalado em 18\/11\/2026/)
    expect(updateText({ de: null, para: '3.1.0', em: Date.parse('2026-11-18T13:00:00Z'), backup: null, semBackup: true })).toContain('de uma versão anterior; feita sem backup, a pedido')
    expect(schemaText({ aplicadas: 1, ultima: null, pendentes: 1, desconhecidas: 1 })).toBe('1 atualização aplicada · 1 pendente(s): reinicie o IClass · dados de uma versão mais nova do IClass')
    expect(shortInstallId('abcd1234-0000')).toBe('ABCD1234')
    expect(shortInstallId(null)).toBe('')
  })
})
