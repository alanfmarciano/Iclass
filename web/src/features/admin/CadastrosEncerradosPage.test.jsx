import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CadastrosEncerradosPage from './CadastrosEncerradosPage'
import { getAdminNavGroups } from '../../components/layout/Sidebar'
import { canAccessAdminPath } from '../../lib/adminPermissions'

const YEAR = 365.25 * 24 * 60 * 60 * 1000
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  refetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  data: null,
}))
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: mocks.post } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: {} }) }))
vi.mock('../../context/BrandingProvider', () => ({ useBranding: () => ({ branding: {} }) }))
vi.mock('../../hooks/useApi', () => ({ useApi: () => ({ data: mocks.data, loading: false, error: null, refetch: mocks.refetch }) }))

function row(extra) {
  return {
    email: 'x@x.local', name: 'X', nomeSocial: '', matricula: '', status: 'Inativo', since: null, by: null, reason: '',
    classes: [{ name: '1DES', courseId: 'DES' }], anonymizedAt: null, anonymized: false,
    counts: { submissions: 2, attendance: 10, certificates: 1 },
    ...extra,
  }
}

beforeEach(() => {
  const now = Date.now()
  mocks.data = {
    success: true,
    lastBackupAt: Date.parse('2026-11-09T03:00:00.000Z'),
    items: [
      row({ email: 'velha@x.local', name: 'Vera Velha', matricula: 'M-1', status: 'Evadido', since: now - 6 * YEAR, by: 'admin@x.local', reason: 'Parou de vir' }),
      row({ email: 'anonimizado-aaa@anonimizado.invalid', name: 'Aluno anonimizado AAAAAA', status: 'Anonimizado', since: now - 3 * YEAR, anonymized: true, anonymizedAt: now - YEAR }),
      row({ email: 'nova@x.local', name: 'Nina Nova', status: 'Transferido', since: now - 30 * 24 * 60 * 60 * 1000 }),
      row({ email: 'semdata@x.local', name: 'Saulo Sem Data', status: 'Inativo', since: null }),
    ],
  }
  mocks.post.mockReset()
  mocks.post.mockResolvedValue({ success: true, updated: 1, skipped: [], name: 'Aluno anonimizado BBBBBB' })
  mocks.refetch.mockClear()
})
afterEach(cleanup)

function renderPage() {
  return render(<MemoryRouter><CadastrosEncerradosPage /></MemoryRouter>)
}
const cards = () => screen.getAllByTestId('cadastro-encerrado')

describe('[UC-ENCERRADOS-003] Cadastros encerrados (/encerrados)', () => {
  it('só o administrador: menu Gestão acadêmica e permissão da rota', () => {
    const adminPaths = getAdminNavGroups({ accountRole: 'admin', activeWorkspace: null }).flatMap((group) => group.items.map((item) => item.to))
    expect(adminPaths).toContain('/encerrados')
    const professor = { accountRole: 'professor', activeWorkspace: null, additionalPermissions: [] }
    const professorPaths = getAdminNavGroups(professor).flatMap((group) => group.items.map((item) => item.to))
    expect(professorPaths).not.toContain('/encerrados')
    expect(canAccessAdminPath(professor, '/encerrados')).toBe(false)
    expect(canAccessAdminPath({ accountRole: 'admin' }, '/encerrados')).toBe(true)
  })

  it('lista do mais antigo para o mais novo, com data, motivo e contagens; sem data aparece "data não registrada"', () => {
    renderPage()
    const list = cards()
    expect(list.map((card) => card.querySelector('p.break-all').textContent.split(' ')[0])).toEqual([
      'velha@x.local', 'anonimizado-aaa@anonimizado.invalid', 'nova@x.local', 'semdata@x.local',
    ])
    expect(within(list[0]).getByText(/há 6 anos/)).toBeTruthy()
    expect(within(list[0]).getByText('Motivo: Parou de vir')).toBeTruthy()
    expect(within(list[0]).getByText('Guardados: 2 notas, 10 presenças, 1 certificado.')).toBeTruthy()
    expect(within(list[3]).getByText(/data não registrada/)).toBeTruthy()
    // Anonimizado: sem Reativar nem Anonimizar, só Apagar de vez.
    expect(within(list[1]).queryByRole('button', { name: 'Reativar' })).toBeNull()
    expect(within(list[1]).queryByRole('button', { name: 'Anonimizar' })).toBeNull()
    expect(within(list[1]).getByRole('button', { name: 'Apagar de vez' })).toBeTruthy()
  })

  it('filtra por situação e por "encerrados há mais de N anos" (sem data fica de fora, com aviso)', async () => {
    renderPage()
    await userEvent.type(screen.getByLabelText('Encerrados há mais de (anos)'), '5')
    expect(cards()).toHaveLength(1)
    expect(screen.getByText(/1 cadastro sem data registrada ficou de fora/)).toBeTruthy()
    await userEvent.clear(screen.getByLabelText('Encerrados há mais de (anos)'))
    await userEvent.selectOptions(screen.getByLabelText('Situação'), 'Anonimizado')
    expect(cards()).toHaveLength(1)
    expect(within(cards()[0]).getByText(/Anonimizado em/)).toBeTruthy()
  })

  it('situação sem acento de banco antigo ("Concluido") entra no filtro Concluído', async () => {
    mocks.data.items.push(row({ email: 'antiga@x.local', name: 'Clara Antiga', status: 'Concluido', since: Date.now() - YEAR }))
    renderPage()
    await userEvent.selectOptions(screen.getByLabelText('Situação'), 'Concluído')
    expect(cards()).toHaveLength(1)
    expect(within(cards()[0]).getByText('Clara Antiga')).toBeTruthy()
  })

  it('anonimizar só com ANONIMIZAR e motivo; lembra do backup, da lixeira de arquivos e da compactação', async () => {
    renderPage()
    await userEvent.click(within(cards()[0]).getByRole('button', { name: 'Anonimizar' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/ainda têm os dados deste aluno/)).toBeTruthy()
    expect(within(dialog).getByText(/documentos e atestados enviados vão para a lixeira de arquivos com o código no lugar do nome/)).toBeTruthy()
    expect(within(dialog).getByText(/até ser compactado/)).toBeTruthy()
    const confirm = within(dialog).getByRole('button', { name: 'Anonimizar' })
    expect(confirm).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Motivo'), 'Pedido do responsável')
    expect(confirm).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Digite ANONIMIZAR para confirmar'), 'anonimizar')
    expect(confirm).not.toBeDisabled()
    await userEvent.click(confirm)
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/students/anonymize', { email: 'velha@x.local', confirm: 'anonimizar', reason: 'Pedido do responsável' }))
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('apagar de vez pede APAGAR; reativar chama o bulk-status com Ativo', async () => {
    renderPage()
    await userEvent.click(within(cards()[2]).getByRole('button', { name: 'Apagar de vez' }))
    let dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Motivo'), 'Cadastro duplicado')
    await userEvent.type(within(dialog).getByLabelText('Digite APAGAR para confirmar'), 'APAGAR')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apagar de vez' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/students/purge', { email: 'nova@x.local', confirm: 'APAGAR', reason: 'Cadastro duplicado' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await userEvent.click(within(cards()[3]).getByRole('button', { name: 'Reativar' }))
    dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Motivo (opcional)'), 'Voltou')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reativar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/student/bulk-status', { emails: ['semdata@x.local'], status: 'Ativo', reason: 'Voltou' }))
  })
})
