import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PrivacidadePage from './PrivacidadePage'
import { getAdminNavGroups } from '../../components/layout/Sidebar'
import { canAccessAdminPath } from '../../lib/adminPermissions'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: {} }) }))
vi.mock('../../context/BrandingProvider', () => ({ useBranding: () => ({ branding: {} }) }))
vi.mock('../../hooks/useApi', () => ({ useApi: () => ({ data: null }) }))

const MODEL = '# Termos\n\nTexto do modelo de {{nome_fantasia}}.'

function kindData(kind, extra = {}) {
  const label = kind === 'termos' ? 'Termos de Uso' : 'Política de Privacidade'
  return {
    kind,
    label,
    current: { documentId: `modelo-2026.1:${kind}`, version: null, publishedAt: null, publishedBy: null, isModel: true, title: label },
    draft: { id: `rascunho_${kind}`, kind, title: label, markdown: MODEL, changeSummary: '', updatedAt: null, updatedBy: null, saved: false, sameAsCurrent: true },
    preview: { markdown: '# Termos\n\nTexto do modelo de Escola Alfa.', unknownPlaceholders: [] },
    history: [],
    ...extra,
  }
}

function documentsResponse(overrides = {}) {
  return {
    success: true,
    modelId: 'modelo-2026.1',
    markdownMax: 100000,
    placeholders: [{ key: 'nome_fantasia', label: 'Nome fantasia da escola' }],
    schools: [{ id: 'escola_a', name: 'Escola Alfa' }],
    school: { id: 'escola_a', name: 'Escola Alfa' },
    activeStudents: 42,
    documents: { termos: kindData('termos'), privacidade: kindData('privacidade'), ...overrides },
  }
}

function renderPage(entry = '/lgpd') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes><Route path="/lgpd" element={<PrivacidadePage />} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mocks.get.mockReset(); mocks.post.mockReset()
  mocks.toast.success.mockReset(); mocks.toast.error.mockReset()
})
afterEach(() => { cleanup() })

describe('[UC-LGPD-002] Privacidade (LGPD): documentos (H8a-1)', () => {
  it('mostra o modelo não publicado e publica só com PUBLICAR, salvando antes o que foi editado', async () => {
    let published = false
    mocks.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/admin/lgpd/documents')) {
        return published
          ? documentsResponse({ termos: kindData('termos', { current: { documentId: 'termos_v1', version: 1, publishedAt: '2026-03-10T15:00:00.000Z', publishedBy: 'admin@x.local', isModel: false, title: 'Termos de Uso' }, history: [{ id: 'termos_v1', version: 1, title: 'Termos de Uso', changeSummary: 'Primeira', publishedAt: '2026-03-10T15:00:00.000Z', publishedBy: 'admin@x.local' }] }) })
          : documentsResponse()
      }
      throw new Error(`GET inesperado ${path}`)
    })
    mocks.post.mockImplementation(async (path, body) => {
      if (path === '/api/admin/lgpd/documents/draft') return { success: true, draft: { ...kindData('termos').draft, ...body, saved: true, updatedAt: '2026-03-10T14:59:00.000Z', updatedBy: 'admin@x.local', sameAsCurrent: false } }
      if (path === '/api/admin/lgpd/documents/preview') return { success: true, markdown: body.markdown.replace('{{nome_fantasia}}', 'Escola Alfa'), unknownPlaceholders: body.markdown.includes('{{escola}}') ? ['escola'] : [] }
      if (path === '/api/admin/lgpd/documents/publish') { published = true; return { success: true, document: { id: 'termos_v1', version: 1 }, activeStudents: 42 } }
      throw new Error(`POST inesperado ${path}`)
    })
    renderPage()
    expect(await screen.findByText('Não publicado')).toBeVisible()
    expect(screen.getByText(/Ninguém precisa aceitar nada até a publicação/)).toBeVisible()
    expect(screen.getByTestId('legal-preview')).toHaveTextContent('Texto do modelo de Escola Alfa.')
    expect(screen.getByRole('link', { name: /Ver a página pública/ })).toHaveAttribute('href', '/termos?escola=escola_a')

    // Edita: marcador desconhecido aparece como aviso na prévia.
    const textarea = screen.getByLabelText('Texto (markdown)')
    await userEvent.type(textarea, ' Mais {{{{escola}}')
    expect(screen.getByText('Alterações não salvas.')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Atualizar prévia' }))
    expect(await screen.findByText(/Marcador desconhecido: \{\{escola\}\}/)).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: 'Publicar versão 1' }))
    const dialog = await screen.findByRole('dialog')
    // O Modal põe o foco no primeiro botão logo depois de abrir: digitar antes disso
    // mandaria parte das teclas para o botão Fechar.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Fechar' })).toHaveFocus())
    expect(within(dialog).getByText(/42 alunos com cadastro ativo precisarão ler e aceitar esta versão/)).toBeVisible()
    expect(within(dialog).getByText('As alterações ainda não salvas serão salvas antes.')).toBeVisible()
    const confirm = within(dialog).getByRole('button', { name: 'Publicar' })
    expect(confirm).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Digite PUBLICAR para confirmar'), 'publicar')
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/lgpd/documents/publish', { kind: 'termos', confirm: 'publicar', draftUpdatedAt: '2026-03-10T14:59:00.000Z' }))
    const order = mocks.post.mock.calls.map(([path]) => path)
    expect(order.indexOf('/api/admin/lgpd/documents/draft')).toBeLessThan(order.indexOf('/api/admin/lgpd/documents/publish'))
    expect(mocks.post.mock.calls.find(([path]) => path === '/api/admin/lgpd/documents/draft')[1].markdown).toContain('Mais {{escola}}')
    expect(await screen.findByText('Versão 1 publicada em 10/03/2026')).toBeVisible()
    expect(screen.getByText('Primeira')).toBeVisible()
    expect(mocks.toast.success).toHaveBeenCalledWith('Termos de Uso: versão 1 publicada.')
  })

  it('erro da publicação aparece no diálogo e nada some', async () => {
    mocks.get.mockResolvedValue(documentsResponse())
    mocks.post.mockRejectedValue(Object.assign(new Error('O rascunho foi alterado depois que você abriu a página. Recarregue e confira o texto antes de publicar.'), { status: 409, data: { code: 'draft_changed' } }))
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Publicar versão 1' }))
    const dialog = await screen.findByRole('dialog')
    // O Modal põe o foco no primeiro botão logo depois de abrir: digitar antes disso
    // mandaria parte das teclas para o botão Fechar.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Fechar' })).toHaveFocus())
    await userEvent.type(within(dialog).getByLabelText('Digite PUBLICAR para confirmar'), 'PUBLICAR{Enter}')
    expect(await within(dialog).findByText(/O rascunho foi alterado depois que você abriu a página/)).toBeVisible()
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/lgpd/documents/publish', { kind: 'termos', confirm: 'PUBLICAR', draftUpdatedAt: null })
  })

  it('rascunho igual à versão publicada não deixa publicar', async () => {
    mocks.get.mockResolvedValue(documentsResponse({
      termos: kindData('termos', { current: { documentId: 'termos_v3', version: 3, publishedAt: '2026-03-10T15:00:00.000Z', publishedBy: 'admin@x.local', isModel: false, title: 'Termos de Uso' } }),
    }))
    renderPage()
    expect(await screen.findByRole('button', { name: 'Publicar versão 4' })).toBeDisabled()
    expect(screen.getByText(/O rascunho é igual à versão publicada/)).toBeVisible()
  })
})

describe('[UC-LGPD-003] Privacidade (LGPD): controlador e encarregado (H8a-1)', () => {
  it('mostra os dados da escola e grava o encarregado, com o erro no campo', async () => {
    const school = { id: 'escola_a', name: 'Escola Alfa', institution: { legalName: 'Instituto Alfa Ltda.', registrationId: '12.345.678/0001-90' }, dpo: { dpoName: '', dpoEmail: '', dpoPhone: '' } }
    mocks.get.mockResolvedValue({ success: true, schools: [school] })
    mocks.post
      .mockRejectedValueOnce(Object.assign(new Error('Informe um e-mail válido para o encarregado.'), { status: 400, data: { field: 'dpoEmail' } }))
      .mockResolvedValueOnce({ success: true, changed: 1, schools: [{ ...school, dpo: { dpoName: 'Maria Souza', dpoEmail: 'dpo@alfa.local', dpoPhone: '' } }] })
    renderPage('/lgpd?aba=encarregado')
    expect(await screen.findByText('Instituto Alfa Ltda.')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Editar os dados da escola' })).toHaveAttribute('href', '/escolas/escola_a')
    await userEvent.type(screen.getByLabelText('Nome'), 'Maria Souza')
    await userEvent.type(screen.getByLabelText('E-mail'), 'errado')
    await userEvent.click(screen.getByRole('button', { name: 'Salvar encarregado' }))
    expect(await screen.findByText('Informe um e-mail válido para o encarregado.')).toBeVisible()
    await userEvent.clear(screen.getByLabelText('E-mail'))
    await userEvent.type(screen.getByLabelText('E-mail'), 'dpo@alfa.local')
    await userEvent.click(screen.getByRole('button', { name: 'Salvar encarregado' }))
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Encarregado salvo.'))
    expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/lgpd/dpo', { schoolId: 'escola_a', applyToAll: false, dpoName: 'Maria Souza', dpoEmail: 'dpo@alfa.local', dpoPhone: '' })
  })
})

describe('[UC-LGPD-004] Privacidade (LGPD) só para o administrador', () => {
  it('o item do menu e a rota existem para o administrador e não para o professor', () => {
    const items = (auth) => getAdminNavGroups(auth).flatMap((group) => group.items.map((item) => item.to))
    expect(items({ accountRole: 'admin' })).toContain('/lgpd')
    expect(items({ accountRole: 'professor', additionalPermissions: ['students.security'] })).not.toContain('/lgpd')
    expect(canAccessAdminPath({ accountRole: 'admin' }, '/lgpd')).toBe(true)
    expect(canAccessAdminPath({ accountRole: 'professor' }, '/lgpd')).toBe(false)
  })
})
