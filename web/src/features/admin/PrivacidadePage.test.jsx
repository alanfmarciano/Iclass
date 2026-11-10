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
    draft: { id: `rascunho_${kind}`, kind, title: label, markdown: MODEL, changeSummary: '', updatedAt: null, updatedBy: null, saved: false, sameAsCurrent: true, sameAsModel: true, hasModelNotice: false },
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
    modelNotice: 'Modelo de referência; não substitui orientação jurídica.',
    modelReviewHint: 'Revise este texto com a direção da escola e, se possível, com um advogado antes de publicar.',
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
    // O aviso do modelo aparece para o administrador, fora do texto.
    expect(screen.getByTestId('model-notice')).toHaveTextContent('Modelo de referência; não substitui orientação jurídica. Revise este texto')
    expect(screen.queryByText(/precisa aceitar/)).not.toBeInTheDocument()
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
    // A confirmação digitada fica com o foco depois que o Modal abre (antes o foco ia
    // para o botão Fechar e as teclas digitadas logo ao abrir se perdiam).
    const typed = within(dialog).getByLabelText('Digite PUBLICAR para confirmar')
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(typed).toHaveFocus()
    // Neste ponto ainda não há aceite pelos alunos (H8a-2): o diálogo não o promete.
    expect(within(dialog).getByText(/42 alunos com cadastro ativo passam a ver esta versão em Termos de Uso/)).toBeVisible()
    expect(within(dialog).queryByText(/aceitar/)).not.toBeInTheDocument()
    expect(within(dialog).getByText('As alterações ainda não salvas serão salvas antes.')).toBeVisible()
    // O texto mudou: nada de aviso de modelo sem mudança.
    expect(within(dialog).queryByTestId('publish-model-warning')).not.toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Publicar' })
    expect(confirm).toBeDisabled()
    await userEvent.keyboard('publicar')
    expect(typed).toHaveValue('publicar')
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
    // Publicar o modelo sem mudança pede conferência.
    expect(within(dialog).getByTestId('publish-model-warning')).toHaveTextContent('Você vai publicar o modelo do IClass sem nenhuma mudança.')
    await userEvent.type(within(dialog).getByLabelText('Digite PUBLICAR para confirmar'), 'PUBLICAR{Enter}')
    expect(await within(dialog).findByText(/O rascunho foi alterado depois que você abriu a página/)).toBeVisible()
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/lgpd/documents/publish', { kind: 'termos', confirm: 'PUBLICAR', draftUpdatedAt: null })
  })

  it('avisa quando o texto ainda traz o aviso do modelo para o administrador', async () => {
    const pasted = `> **Modelo de referência; não substitui orientação jurídica.** Revise este texto com a direção da escola.\n\n${MODEL}`
    mocks.get.mockResolvedValue(documentsResponse({
      termos: kindData('termos', { draft: { ...kindData('termos').draft, markdown: pasted, saved: true, updatedAt: '2026-03-10T14:00:00.000Z', sameAsCurrent: false, sameAsModel: false, hasModelNotice: true } }),
    }))
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Publicar versão 1' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('O texto ainda traz o aviso')
    expect(within(dialog).queryByTestId('publish-model-warning')).not.toBeInTheDocument()
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
