import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LegalDocumentPage, { MODEL_NOTICE, legalVersionLine } from './LegalDocumentPage'
import { createRequire } from 'node:module'
import { legalMarkdownToHtml } from '../lib/legalMarkdown'

// Renderização de verdade, do servidor ao HTML: os marcadores preenchidos por
// renderLegalMarkdown (backend/utils/legalDocuments.js) passam pelo mesmo marked + DOMPurify
// da página.
const legal = createRequire(import.meta.url)('../../../backend/utils/legalDocuments.js')

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../lib/api', () => ({ api: { get: mocks.get } }))

function response(extra = {}) {
  return {
    success: true,
    published: false,
    school: { id: 'escola_a', name: 'Escola Alfa' },
    terms: { kind: 'termos', documentId: 'modelo-2026.1:termos', version: null, publishedAt: null, isModel: true, notice: 'Modelo de referência; não substitui orientação jurídica.', title: 'Termos de Uso', markdown: '# Termos\n\nTexto dos termos.' },
    privacy: { kind: 'privacidade', documentId: 'modelo-2026.1:privacidade', version: null, publishedAt: null, isModel: true, title: 'Política de Privacidade', markdown: '# Política\n\nTexto da política.' },
    ...extra,
  }
}

function renderAt(entry, kind) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/termos" element={<LegalDocumentPage kind="termos" />} />
        <Route path="/privacidade" element={<LegalDocumentPage kind="privacidade" />} />
        <Route path="/" element={<p>Início</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => { mocks.get.mockReset() })
afterEach(() => { cleanup() })

describe('[UC-LGPD-001] páginas públicas /termos e /privacidade (H8a-1)', () => {
  it('sem publicação mostra o modelo com o aviso de que não foi revisado, sem login', async () => {
    mocks.get.mockResolvedValue(response())
    renderAt('/termos?courseId=curso_b&outro=1')
    expect(await screen.findByRole('heading', { level: 1, name: 'Termos de Uso' })).toBeVisible()
    expect(screen.getByTestId('legal-version')).toHaveTextContent(MODEL_NOTICE)
    // O aviso do modelo vem à parte (notice), fora do texto.
    expect(screen.getByTestId('legal-notice')).toHaveTextContent('Modelo de referência; não substitui orientação jurídica.')
    expect(screen.getByText('Texto dos termos.')).toBeVisible()
    expect(screen.getByText('Escola Alfa')).toBeVisible()
    // Só os parâmetros da escola vão para a API, sem a sessão de ninguém.
    expect(mocks.get).toHaveBeenCalledWith('/api/legal/documents?courseId=curso_b', { auth: false })
    // O link para o outro documento leva o mesmo curso.
    expect(screen.getByRole('link', { name: /Política de Privacidade/ })).toHaveAttribute('href', '/privacidade?courseId=curso_b')
    // O "# Termos" do texto desce para h2: a página tem um só h1 (o título dela).
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 2, name: 'Termos' })).toBeVisible()
  })

  it('títulos do texto descem um nível; h6 continua h6', () => {
    const html = legalMarkdownToHtml('# Um\n\n## Dois\n\n###### Seis')
    expect(html).toMatch(/<h2[^>]*>Um<\/h2>/)
    expect(html).toMatch(/<h3[^>]*>Dois<\/h3>/)
    expect(html).toMatch(/<h6[^>]*>Seis<\/h6>/)
    expect(html).not.toMatch(/<h1/)
  })

  it('versão publicada mostra número e data; o HTML do texto é limpo', async () => {
    mocks.get.mockResolvedValue(response({
      published: true,
      privacy: {
        kind: 'privacidade', documentId: 'privacidade_v2', version: 2, publishedAt: '2026-03-10T15:00:00.000Z', isModel: false,
        title: 'Política de Privacidade da Escola',
        markdown: 'Texto <img src="x" onerror="window.__xss = 1"> com <script>window.__xss = 2</script> fim.\n\n[link](javascript:alert(1))',
      },
    }))
    const { container } = renderAt('/privacidade')
    expect(await screen.findByRole('heading', { level: 1, name: 'Política de Privacidade da Escola' })).toBeVisible()
    expect(screen.getByTestId('legal-version')).toHaveTextContent('Versão 2, publicada em 10/03/2026')
    expect(screen.queryByTestId('legal-notice')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
    expect(container.querySelector('a[href^="javascript"]')).toBeNull()
    expect(window.__xss).toBeUndefined()
  })

  it('falha ao carregar mostra o erro e tenta de novo', async () => {
    mocks.get.mockRejectedValueOnce(Object.assign(new Error('Sem conexão com o servidor.'), { status: 0 }))
    mocks.get.mockResolvedValueOnce(response())
    renderAt('/termos')
    expect(await screen.findByRole('alert')).toHaveTextContent('Sem conexão com o servidor.')
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Termos de Uso' })).toBeVisible())
  })

  it('linha da versão', () => {
    expect(legalVersionLine({ isModel: true })).toBe(MODEL_NOTICE)
    expect(legalVersionLine({ isModel: false, version: 3, publishedAt: 'x' })).toBe('Versão 3')
  })

  // Regressão do H8a-1: a barra que o servidor punha antes de '_' e '~' quebrava o link
  // automático do GFM. 'joao_silva@escola.com.br' virava link para silva@escola.com.br e
  // o site com '_' ou '~' ficava com %5C no endereço.
  it('e-mail e site do cadastro viram link com o endereço exato; o resto fica como texto', () => {
    const { markdown } = legal.renderLegalMarkdown('Contato: {{contato_instituicao}}. Encarregado: {{encarregado_nome}}, {{encarregado_contato}}. Escola: {{instituicao}}.', {
      contato_instituicao: [
        { text: 'joao_silva@escola.com.br', link: 'email' },
        { text: '(81) 3333-4444' },
        { text: 'https://escola.example/~curso/a_b', link: 'url' },
      ],
      encarregado_nome: 'Maria **DPO** <b>x</b>',
      encarregado_contato: [{ text: 'maria_dpo@escola.local', link: 'email' }, { text: 'www.escola_tecnica.com.br', link: 'url' }],
      instituicao: 'Escola [link](http://evil.example) www.evil.example joao_x@evil.example ~a~ _b_',
    })
    const box = document.createElement('div')
    box.innerHTML = legalMarkdownToHtml(markdown)
    const links = Array.from(box.querySelectorAll('a')).map((a) => [a.textContent, a.getAttribute('href')])
    expect(links).toEqual([
      ['joao_silva@escola.com.br', 'mailto:joao_silva@escola.com.br'],
      ['https://escola.example/~curso/a_b', 'https://escola.example/~curso/a_b'],
      ['maria_dpo@escola.local', 'mailto:maria_dpo@escola.local'],
      ['www.escola_tecnica.com.br', 'http://www.escola_tecnica.com.br'],
    ])
    expect(box.textContent.trim()).toBe('Contato: joao_silva@escola.com.br, (81) 3333-4444, https://escola.example/~curso/a_b. '
      + 'Encarregado: Maria **DPO** <b>x</b>, maria_dpo@escola.local, www.escola_tecnica.com.br. '
      + 'Escola: Escola [link](http://evil.example) www.evil.example joao_x@evil.example ~a~ _b_.')
    expect(box.querySelector('b, strong, em, del')).toBeNull()
    expect(box.innerHTML).not.toContain('%5C')
  })
})
