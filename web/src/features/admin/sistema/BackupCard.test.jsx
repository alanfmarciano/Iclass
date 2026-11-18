import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupCard, DESTINATION_DATA_WARNING, DOWNLOAD_PASSWORD_REASON, backupBand } from './BackupCard'
import { ActionQueue } from '../dashboard/ActionQueue'

const HOUR = 3600000
const NOW = Date.parse('2026-11-11T12:00:00Z')

const mocks = vi.hoisted(() => ({
  data: {},
  refetch: vi.fn(),
  post: vi.fn(),
  downloadFile: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('../../../hooks/useApi', () => ({
  useApi: (path) => ({ data: (path && mocks.data[path]) || null, loading: false, error: null, refetch: mocks.refetch }),
}))
vi.mock('../../../lib/api', () => ({ api: { post: mocks.post }, downloadFile: mocks.downloadFile }))
vi.mock('../../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

function status(extra = {}) {
  return {
    success: true,
    configurado: true,
    destino: 'E:\\Backups',
    pasta: 'E:\\Backups\\IClass-SALA1',
    guardarExterno: 14,
    local: { ultimoSucesso: new Date(Date.now() - 2 * HOUR).toISOString(), arquivo: 'automatico_dados_x.zip', bytes: 5 * 1024 * 1024, origem: 'automatico' },
    externo: { ultimoSucesso: new Date(Date.now() - 2 * HOUR).toISOString(), arquivo: 'automatico_completo_x.zip', bytes: 80 * 1024 * 1024, acessivel: true, mesmoDisco: false },
    ultimaFalha: null,
    adiadoPorProva: null,
    emAndamento: null,
    proximoAutomatico: new Date(Date.now() + 18 * HOUR).toISOString(),
    ...extra,
  }
}

const LIST = {
  success: true,
  destino: 'E:\\Backups',
  pasta: 'E:\\Backups\\IClass-SALA1',
  externoAcessivel: true,
  itens: [
    { local: 'externo', nome: 'automatico_completo_2026-11-11T08-00-00-000Z.zip', origem: 'automatico', variante: 'completo', formato: 'zip-2', bytes: 80 * 1024 * 1024, criadoEm: '2026-11-11T08:00:00.000Z' },
    { local: 'servidor', nome: 'automatico_dados_2026-11-11T08-00-00-000Z.zip', origem: 'automatico', variante: 'dados', formato: 'zip-2', bytes: 5 * 1024 * 1024, criadoEm: '2026-11-11T08:00:00.000Z' },
  ],
}

function setData({ statusData = status(), list = LIST, config = { success: true, destino: 'E:\\Backups', guardarExterno: 14, limites: { guardarExterno: { min: 1, max: 90 } }, sugestao: '' } } = {}) {
  mocks.data = {
    '/api/admin/backup/status': statusData,
    '/api/admin/backup/list': list,
    '/api/admin/backup/config': config,
    '/api/admin/backup/history': { entries: [] },
  }
}

describe('backupBand: a faixa do cartão Backup', () => {
  it('[UC-BACKUP-004] falha é vermelha com o motivo; atraso é vermelho; só neste computador é amarela; em dia é verde', () => {
    const failed = backupBand(status({ ultimaFalha: { em: '2026-11-11T08:00:00Z', alvo: 'externo', etapa: 'externo', mensagem: 'O destino externo não está acessível.' } }), { now: NOW })
    expect(failed.tone).toBe('danger')
    expect(failed.title).toMatch(/cópia no destino externo falhou/)
    expect(failed.text).toBe('O destino externo não está acessível.')

    const late = backupBand(status({ local: { ultimoSucesso: new Date(NOW - 3 * 24 * HOUR).toISOString() } }), { now: NOW })
    expect(late.tone).toBe('danger')
    expect(late.title).toBe('Último backup há 3 dias')
    expect(backupBand(status({ local: { ultimoSucesso: null } }), { now: NOW }).title).toBe('Nenhum backup feito ainda')
    // Adiado por prova: não acusa atraso.
    expect(backupBand(status({ local: { ultimoSucesso: new Date(NOW - 30 * HOUR).toISOString() }, adiadoPorProva: { desde: 'x', aplicacoes: 1 } }), { now: NOW }).tone).not.toBe('danger')

    const local = backupBand(status({ configurado: false, externo: null, local: { ultimoSucesso: new Date(NOW - HOUR).toISOString() } }), { now: NOW })
    expect(local).toMatchObject({ tone: 'warning', title: 'Backup só neste computador' })
    expect(backupBand(status({ configurado: false, externo: null, local: { ultimoSucesso: new Date(NOW - HOUR).toISOString() } }), { now: NOW, isAdmin: false }).text).toMatch(/Peça ao administrador/)
    expect(backupBand(status({ externo: { acessivel: false } , local: { ultimoSucesso: new Date(NOW - HOUR).toISOString() } }), { now: NOW }).title).toBe('Destino externo desconectado')
    expect(backupBand(status({ local: { ultimoSucesso: new Date(NOW - HOUR).toISOString() }, externo: { acessivel: true, ultimoSucesso: new Date(NOW - HOUR).toISOString() } }), { now: NOW }).tone).toBe('success')
  })

  it('[UC-BACKUP-004] destino no mesmo disco do IClass é amarelo, não "Backup em dia" (desenho H4, Tela Sistema)', () => {
    const recent = new Date(NOW - HOUR).toISOString()
    const sameDisk = status({ local: { ultimoSucesso: recent }, externo: { acessivel: true, mesmoDisco: true, ultimoSucesso: recent } })
    const band = backupBand(sameDisk, { now: NOW })
    expect(band).toMatchObject({ tone: 'warning', title: 'Destino externo no mesmo disco do IClass' })
    expect(band.text).toMatch(/pendrive, HD externo ou pasta de rede/)
    expect(backupBand(sameDisk, { now: NOW, isAdmin: false }).text).toMatch(/Peça ao administrador/)
    // Falha e atraso continuam na frente do aviso de mesmo disco.
    expect(backupBand({ ...sameDisk, ultimaFalha: { em: recent, alvo: 'local', mensagem: 'x' } }, { now: NOW }).tone).toBe('danger')
  })
})

describe('BackupCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setData()
  })
  afterEach(cleanup)

  it('[UC-BACKUP-004] mostra a situação, faz o backup agora e avisa quando só a cópia externa falhou', async () => {
    setData({ statusData: status({ ultimaFalha: { em: '2026-11-11T08:00:00Z', alvo: 'local', etapa: 'local', mensagem: 'O disco ficou sem espaço durante a gravação do backup.' } }) })
    mocks.post.mockResolvedValue({ success: true, fileName: 'manual_dados_x.zip', externo: null, externoErro: 'O destino externo não está acessível (pendrive ou HD desconectado, ou pasta removida): E:\\Backups.' })
    const user = userEvent.setup()
    render(<BackupCard isAdmin />)
    const band = screen.getByRole('alert', { name: 'Situação do backup' })
    expect(band).toHaveTextContent('O backup falhou')
    expect(band).toHaveTextContent('O disco ficou sem espaço')
    expect(screen.getAllByText('Neste computador')[0]).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Fazer backup agora' }))
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/backup/server', {}, { timeoutMs: 0 })
    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledWith(expect.stringMatching(/a cópia externa falhou: O destino externo não está acessível/)))
  })

  it('[UC-BACKUP-004] destino externo: testa e salva; a recusa aparece no campo; o aviso de dados pessoais fica à vista', async () => {
    setData({ config: { success: true, destino: '', guardarExterno: 14, limites: { guardarExterno: { min: 1, max: 90 } }, sugestao: 'F:\\IClass-Backup' } })
    const user = userEvent.setup()
    render(<BackupCard isAdmin />)
    const section = screen.getByRole('region', { name: 'Destino externo' })
    expect(section).toHaveTextContent(DESTINATION_DATA_WARNING)
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('Escolha uma pasta fora da pasta do IClass (pendrive, HD externo ou pasta de rede).'), { status: 400, data: { field: 'destino' } }))
    await user.type(within(section).getByLabelText('Pasta do destino'), 'C:\\IClass\\data')
    await user.click(within(section).getByRole('button', { name: 'Testar e salvar' }))
    expect(await within(section).findByRole('alert')).toHaveTextContent('fora da pasta do IClass')

    mocks.post.mockResolvedValueOnce({ success: true, destino: 'E:\\Backups', pasta: 'E:\\Backups\\IClass-SALA1', guardarExterno: 14, livreBytes: 30 * 1024 * 1024 * 1024, mesmoDisco: true })
    await user.clear(within(section).getByLabelText('Pasta do destino'))
    await user.type(within(section).getByLabelText('Pasta do destino'), 'E:\\Backups')
    await user.click(within(section).getByRole('button', { name: 'Testar e salvar' }))
    expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/backup/config', { destino: 'E:\\Backups', guardarExterno: 14 }, { timeoutMs: 0 })
    const result = await within(section).findByRole('status')
    expect(result).toHaveTextContent('Gravação testada em E:\\Backups\\IClass-SALA1')
    expect(result).toHaveTextContent('30 GB livres')
    expect(result).toHaveTextContent('mesmo disco do IClass')
  })

  it('[UC-BACKUP-006] baixar da lista pede a senha de novo com o motivo em uma linha; senha errada fica no diálogo', async () => {
    const user = userEvent.setup()
    render(<BackupCard isAdmin />)
    const list = screen.getByRole('list', { name: 'Lista de backups' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).getByText('Destino externo')).toBeVisible()
    await user.click(within(list).getByRole('button', { name: `Baixar ${LIST.itens[1].nome}` }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirme a senha para baixar' })
    expect(dialog).toHaveTextContent(DOWNLOAD_PASSWORD_REASON)
    expect(mocks.downloadFile).not.toHaveBeenCalled()

    mocks.post.mockRejectedValueOnce(Object.assign(new Error('Senha incorreta.'), { status: 400, data: { field: 'password' } }))
    await user.type(within(dialog).getByLabelText('Senha do administrador'), 'errada{Enter}')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Senha incorreta.')
    expect(mocks.downloadFile).not.toHaveBeenCalled()

    mocks.post.mockResolvedValueOnce({ success: true, ticket: 'bilhete-1' })
    await user.clear(within(dialog).getByLabelText('Senha do administrador'))
    await user.type(within(dialog).getByLabelText('Senha do administrador'), 'certa')
    await user.click(within(dialog).getByRole('button', { name: 'Baixar' }))
    expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/backup/download-ticket', { tipo: 'arquivo', local: 'servidor', nome: LIST.itens[1].nome, password: 'certa' }, { timeoutMs: 0 })
    await waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledWith(`/api/admin/backup/file?local=servidor&nome=${encodeURIComponent(LIST.itens[1].nome)}&ticket=bilhete-1`, LIST.itens[1].nome))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Confirme a senha para baixar' })).not.toBeInTheDocument())
  })

  it('[UC-BACKUP-006] restaurar da lista abre a prévia do backup escolhido', async () => {
    mocks.post.mockResolvedValue({ success: true, token: 't', formato: 'zip-2', variante: 'completo', geradoEm: '2026-11-11T08:00:00Z', contagens: [{ colecao: 'auditLogs', rotulo: 'Auditoria', backup: 10, atual: 12, nota: 'mantida e somada à do backup' }], arquivos: { inclui: ['data/uploads'], quantidade: 3, bytes: 1024 }, ficaraoVazias: [], provasEmAndamento: [], avisos: [], contas: { noBackup: 1, foraDaqui: 0 }, integridade: { verificada: true, texto: 'ok' } })
    const user = userEvent.setup()
    render(<BackupCard isAdmin />)
    await user.click(screen.getByRole('button', { name: `Restaurar ${LIST.itens[0].nome}` }))
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/backup/restore/preview', { local: 'externo', nome: LIST.itens[0].nome }, { timeoutMs: 0 })
    const dialog = await screen.findByRole('dialog', { name: 'Conferir antes de restaurar' })
    // A auditoria de hoje não sai na restauração: a linha diz isso (decisões §12).
    expect(within(dialog).getByRole('table', { name: 'No backup e hoje' })).toHaveTextContent('Auditoriamantida e somada à do backup')
  })

  it('[UC-BACKUP-004] a linha do destino externo mostra ao administrador onde fica a cópia; ao professor, não', () => {
    render(<BackupCard isAdmin />)
    const lines = screen.getByText('No destino externo').closest('div')
    expect(lines).toHaveTextContent('Em E:\\Backups\\IClass-SALA1')
    cleanup()
    // O status do professor vem sem o caminho (destino e pasta vazios).
    setData({ statusData: status({ destino: '', pasta: '' }) })
    render(<BackupCard isAdmin={false} />)
    expect(screen.getByText('No destino externo').closest('div')).not.toHaveTextContent('IClass-SALA1')
  })

  it('[UC-BACKUP-001] professor vê a situação e faz o backup, sem baixar, restaurar nem mexer no destino', () => {
    render(<BackupCard isAdmin={false} />)
    expect(screen.getByRole('button', { name: 'Fazer backup agora' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Baixar completo (ZIP)' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Destino externo' })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Lista de backups' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Arquivo de backup')).not.toBeInTheDocument()
  })
})

describe('ActionQueue: itens do backup', () => {
  afterEach(cleanup)
  it('[UC-BACKUP-004] falha e atraso não têm "adiar 24h"; "sem destino" tem', () => {
    const items = [
      { id: 'backup_falhou', tipo: 'backup_falhou', titulo: 'O backup falhou', detalhe: 'x', count: 1, tone: 'danger', href: '/sistema', adiavel: false },
      { id: 'backup_sem_destino', tipo: 'backup_sem_destino', titulo: 'Backup só neste computador', detalhe: 'y', count: 2, tone: 'warning', href: '/sistema' },
    ]
    render(<ActionQueue items={items} onOpen={() => {}} onSnooze={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Adiar "O backup falhou" por 24 horas' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Adiar "Backup só neste computador" por 24 horas' })).toBeInTheDocument()
  })
})
