import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import AjudaPage from './AjudaPage'
import { HelpLink, HELP_LINK_LABEL, helpHref } from '../../components/ui/HelpLink'
import { PageHeader } from '../../components/ui/PageHeader'

function Where() {
  const location = useLocation()
  return <output data-testid="where">{`${location.pathname}${location.search}${location.hash}`}</output>
}

function renderAt(entry) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/ajuda" element={<><AjudaPage /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('[UC-AJUDA-001] tela Ajuda do painel', () => {
  afterEach(() => cleanup())

  it('abre o manual do professor com o índice dos cinco textos e das Novidades, e esconde tema sem texto', async () => {
    renderAt('/ajuda')
    expect(await screen.findByRole('heading', { level: 2, name: 'Manual do professor' }, { timeout: 5000 })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Assuntos da ajuda' })
    ;['Para o professor', 'Para o aluno', 'Instalação e rede', 'Perguntas frequentes', 'Quando algo dá errado', 'Novidades'].forEach((name) => {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument()
    })
    expect(within(nav).getByRole('link', { name: 'Para o professor' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { level: 3, name: 'Sistema' })).toBeInTheDocument()
    // Tema ainda sem texto (P5 escreve depois) não aparece. Tarefas ganhou texto no C7 e
    // Grupos no C12 e Ver como aluno no C15; o exemplo de tema vazio passou a ser
    // "Diretório de alunos" (P4, C22).
    expect(screen.queryByRole('heading', { level: 3, name: 'Diretório de alunos' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Ver como aluno' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Grupos' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Tarefas' })).toBeInTheDocument()
    // Recado de comentário não vai para a tela.
    expect(screen.queryByText(/Regras para escrever aqui/)).not.toBeInTheDocument()
  })

  it('a âncora da URL leva ao tema (o "?" de cada tela) e foca o título', async () => {
    renderAt('/ajuda#monitor')
    const heading = await screen.findByRole('heading', { level: 3, name: 'Monitor' }, { timeout: 5000 })
    expect(heading).toHaveAttribute('id', 'monitor')
    await waitFor(() => expect(document.activeElement).toBe(heading))
  })

  it('âncora de tema ainda sem texto avisa e mostra o resto', async () => {
    renderAt('/ajuda#diretorio')
    expect(await screen.findByText('O texto sobre esta tela ainda está sendo escrito. Veja os outros temas abaixo.')).toBeInTheDocument()
  })

  it('hash malformado na URL não derruba a tela: abre o manual sem âncora', async () => {
    renderAt('/ajuda#%E0%A4%A')
    expect(await screen.findByRole('heading', { level: 2, name: 'Manual do professor' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Sistema' })).toBeInTheDocument()
    expect(screen.queryByText(/ainda está sendo escrito/)).not.toBeInTheDocument()
  })

  it('?doc= escolhe o texto; o seletor do celular troca de texto; as Novidades vêm do CHANGELOG', async () => {
    renderAt('/ajuda?doc=novidades')
    expect(await screen.findByRole('heading', { level: 2, name: 'Novidades do IClass' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Não publicado' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Assunto' }), { target: { value: 'problemas' } })
    expect(await screen.findByRole('heading', { level: 2, name: 'Quando algo dá errado' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/ajuda?doc=problemas')
  })

  it('busca pelo título dos temas em todos os textos, sem acento', async () => {
    const user = userEvent.setup()
    renderAt('/ajuda')
    await screen.findByRole('heading', { level: 2, name: 'Manual do professor' }, { timeout: 5000 })
    await user.type(screen.getByRole('searchbox', { name: 'Buscar na ajuda' }), 'conexao')
    const results = await screen.findByRole('region', { name: 'Resultado da busca' }, { timeout: 5000 })
    await waitFor(() => expect(within(results).getByRole('link', { name: 'A prova travou ou a conexão caiu' })).toBeInTheDocument())
    expect(within(results).getByRole('link', { name: 'A prova travou ou a conexão caiu' })).toHaveAttribute('href', '/ajuda?doc=aluno#prova-e-conexao')
    // Tema sem texto não aparece na busca.
    await user.clear(screen.getByRole('searchbox', { name: 'Buscar na ajuda' }))
    await user.type(screen.getByRole('searchbox', { name: 'Buscar na ajuda' }), 'diretorio de alunos')
    expect(await within(screen.getByRole('region', { name: 'Resultado da busca' })).findByText('Nenhum tema com “diretorio de alunos” no título.')).toBeInTheDocument()
  })

  it('link para outra tela do IClass dentro do texto abre pelo roteador, sem recarregar', async () => {
    const user = userEvent.setup()
    renderAt('/ajuda?doc=aluno#conexao-segura')
    const link = await screen.findByRole('link', { name: 'Certificado' }, { timeout: 5000 })
    await user.click(link)
    expect(screen.getByTestId('where')).toHaveTextContent('/certificado')
  })
})

describe('[UC-AJUDA-001] HelpLink e o "?" do PageHeader', () => {
  afterEach(() => cleanup())

  it('helpTopic no PageHeader mostra o botão "Ajuda sobre esta tela" que leva ao tema', () => {
    render(<MemoryRouter><PageHeader title="Provas" helpTopic="provas" /></MemoryRouter>)
    expect(screen.getByRole('link', { name: HELP_LINK_LABEL })).toHaveAttribute('href', '/ajuda#provas')
  })

  it('sem helpTopic, nada muda no cabeçalho', () => {
    render(<PageHeader title="Provas" />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Provas' })).toBeInTheDocument()
  })

  it('helpHref monta o endereço do professor, do aluno e dos outros textos', () => {
    expect(helpHref('sistema')).toBe('/ajuda#sistema')
    expect(helpHref('esqueci-a-senha', 'aluno')).toBe('/ajuda/aluno#esqueci-a-senha')
    expect(helpHref('rede-e-firewall', 'instalacao-e-rede')).toBe('/ajuda?doc=instalacao-e-rede#rede-e-firewall')
    render(<MemoryRouter><HelpLink topic="" /></MemoryRouter>)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
