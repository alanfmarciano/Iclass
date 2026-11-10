import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SistemaPage, { BackupHistory, maintenanceClassOptions } from './SistemaPage'

const IN_CLASS = { courseId: 'DES', courseName: 'Técnico em TI', className: '1DES' }
const INSTITUTION = { courseId: '', courseName: '', className: '' }
// Espera dos waitFor/findBy dos casos de manutenção: o padrão de 1 s falhou uma vez com
// a CPU cheia (J1). 5 s por espera e 20 s por caso.
const SLOW = { timeout: 5000 }
const CASE_MS = 20000

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  downloadFile: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  workspace: null,
  restart: { readServerHealth: vi.fn(), waitForServerRestart: vi.fn() },
  apiData: {
    '/api/admin/classes': [
      { name: '1DES', courseId: 'DES' },
      { name: '2DES', courseId: 'DES' },
      { name: '1ADM', courseId: 'ADM' },
      { name: 'Antiga', courseId: 'DES', deletedAt: '2026-01-01' },
    ],
    '/api/courses': [{ id: 'DES', name: 'Técnico em TI' }, { id: 'ADM', name: 'Administração' }],
  },
}))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post }, downloadFile: mocks.downloadFile }))
vi.mock('../../hooks/useApi', () => ({ useApi: (path) => ({ data: (path && mocks.apiData[path]) || null, loading: false, error: null, refetch: vi.fn() }) }))
vi.mock('./sistema/serverRestart', () => ({
  RESTART_WAIT_MS: 90000,
  readServerHealth: (...args) => mocks.restart.readServerHealth(...args),
  waitForServerRestart: (...args) => mocks.restart.waitForServerRestart(...args),
}))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({
  useAuth: () => ({ auth: { role: 'admin', accountRole: 'admin', activeWorkspace: mocks.workspace?.className ? mocks.workspace : null } }),
}))
vi.mock('../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => mocks.workspace,
}))

function preview({ blocked = false } = {}) {
  return {
    success: true,
    studentClass: '1DES',
    restart: { activeApplications: [{ id: 'app-1', examKey: 'Avaliacao_X', examTitle: 'Prova X', status: 'running', studentClass: '2DES' }] },
    applications: [{ id: 'app-2', examKey: 'Avaliacao_Y', examTitle: 'Prova Y', status: 'finished' }],
    flush: {
      blockedBy: blocked ? [{ id: 'app-3', examTitle: 'Prova Z', status: 'running' }] : [],
      counts: { examStates: 3, pendingAnswers: 1, messages: 2 },
      preserved: { proctoringLogs: 5, keystrokes: 7 },
    },
    reset: {
      activeApplications: [{ id: 'app-4', examKey: 'Avaliacao_W', examTitle: 'Prova W', status: 'running', inProgressAttempts: 4, waitingToStart: 1 }],
      counts: { sessions: 6, examStates: 0, messages: 1 },
    },
  }
}

describe('SistemaPage · manutenção', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.workspace = IN_CLASS
    mocks.get.mockResolvedValue(preview())
    mocks.post.mockResolvedValue({ success: true, message: 'ok' })
    mocks.restart.readServerHealth.mockResolvedValue({ status: 'ok', instanceId: 'antes' })
    mocks.restart.waitForServerRestart.mockResolvedValue({ ok: true, health: { status: 'ok', instanceId: 'depois' } })
  })
  afterEach(cleanup)

  it('[UC-MANUT-001] "Limpar estado de prova" abre a confirmação com o que será apagado e só envia com LIMPAR (UXI-02, OPS-X3)', async () => {
    const user = userEvent.setup()
    render(<SistemaPage />)
    await user.click(screen.getByRole('button', { name: 'Limpar estado de prova' }))
    expect(mocks.post).not.toHaveBeenCalled()
    expect(await screen.findByText(/3 estados de tentativa sem entrega/, {}, SLOW)).toBeVisible()
    expect(screen.getByText(/1 com respostas não entregues/)).toBeVisible()
    expect(screen.getByText(/5 registros de monitoramento/)).toBeVisible()
    expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining('studentClass=1DES'))

    const confirmButton = screen.getByRole('button', { name: 'Limpar estado' })
    expect(confirmButton).toBeDisabled()
    await user.type(screen.getByLabelText('Digite LIMPAR para confirmar'), 'LIMPAR')
    expect(confirmButton).toBeEnabled()
    await user.click(confirmButton)
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/flush-exam-state', expect.objectContaining({ studentClass: '1DES', courseId: 'DES', confirm: 'LIMPAR' }), { timeoutMs: 0 }), SLOW)
  }, CASE_MS)

  it('[UC-MANUT-001] limpeza fica travada com prova em andamento na turma', async () => {
    const user = userEvent.setup()
    mocks.get.mockResolvedValue(preview({ blocked: true }))
    render(<SistemaPage />)
    await user.click(screen.getByRole('button', { name: 'Limpar estado de prova' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Prova Z/)
    expect(screen.getByRole('button', { name: 'Limpar estado' })).toBeDisabled()
    expect(screen.queryByLabelText('Digite LIMPAR para confirmar')).not.toBeInTheDocument()
  }, CASE_MS)

  it('[UC-MANUT-001] "Reiniciar servidor" pede confirmação e avisa das provas em andamento (CONF-10)', async () => {
    const user = userEvent.setup()
    render(<SistemaPage />)
    await user.click(screen.getByRole('button', { name: 'Reiniciar servidor' }))
    expect(mocks.post).not.toHaveBeenCalled()
    expect(await screen.findByText(/1 prova em andamento/, {}, SLOW)).toBeVisible()
    expect(screen.getByText(/2DES · Prova X/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Reiniciar agora' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/server/restart', { confirm: 'REINICIAR' }), SLOW)
  }, CASE_MS)

  it('[UC-MANUT-001] confirmação do reinício lista também a prova de turma fora da conta (vale para o servidor inteiro)', async () => {
    const user = userEvent.setup()
    const data = preview()
    data.restart.activeApplications.push({ id: 'app-9', examKey: 'Avaliacao_Q', examTitle: 'Prova Q', status: 'running', studentClass: '3RED', outsideScope: true })
    mocks.get.mockResolvedValue(data)
    render(<SistemaPage />)
    await user.click(screen.getByRole('button', { name: 'Reiniciar servidor' }))
    expect(await screen.findByText(/2 provas em andamento/, {}, SLOW)).toBeVisible()
    expect(screen.getByText(/3RED · Prova Q/)).toHaveTextContent('(turma de outro professor)')
    expect(screen.getByText(/2DES · Prova X/)).not.toHaveTextContent('outro professor')
    expect(screen.getByText(/vale para o servidor inteiro, com as provas de todas as turmas/)).toBeVisible()
    expect(screen.queryByText('Nenhuma prova em andamento agora.')).not.toBeInTheDocument()
  }, CASE_MS)

  it('[UC-MANUT-001] o reinício promete o que o servidor faz: ninguém entra de novo e o tempo parado volta (H3c, CONF-12)', async () => {
    const user = userEvent.setup()
    render(<SistemaPage />)
    await user.click(screen.getByRole('button', { name: 'Reiniciar servidor' }))
    expect(await screen.findByText(/1 prova em andamento/, {}, SLOW)).toBeVisible()
    expect(screen.getByText('O IClass fica fora do ar por alguns segundos e volta sozinho. Ninguém precisa entrar de novo.')).toBeVisible()
    expect(screen.getByText(/Quem estiver fazendo prova pode continuar respondendo: as respostas são enviadas quando a conexão voltar e o tempo parado é devolvido automaticamente \(até 15 minutos\)\./)).toBeVisible()
    expect(screen.queryByText(/precisam entrar de novo/)).not.toBeInTheDocument()
    expect(screen.queryByText(/derruba/)).not.toBeInTheDocument()
  }, CASE_MS)

  it('[UC-MANUT-001] depois de confirmar mostra "Reiniciando…" e espera o instanceId novo: "Servidor reiniciado." ao voltar', async () => {
    const user = userEvent.setup()
    let finish
    mocks.restart.waitForServerRestart.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    render(<SistemaPage />)
    await user.click(screen.getByRole('button', { name: 'Reiniciar servidor' }))
    await screen.findByText(/1 prova em andamento/, {}, SLOW)
    await user.click(screen.getByRole('button', { name: 'Reiniciar agora' }))
    await waitFor(() => expect(mocks.restart.waitForServerRestart).toHaveBeenCalledWith(expect.objectContaining({ previousInstanceId: 'antes' })), SLOW)
    expect(mocks.restart.readServerHealth.mock.invocationCallOrder[0]).toBeLessThan(mocks.post.mock.invocationCallOrder[0])
    expect(screen.getByRole('button', { name: 'Reiniciando…' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Reiniciando…')
    expect(mocks.toast.success).not.toHaveBeenCalled()
    finish({ ok: true, health: { status: 'ok', instanceId: 'depois' } })
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Servidor reiniciado.'), SLOW)
    expect(screen.getByRole('button', { name: 'Reiniciar servidor' })).toBeEnabled()
  }, CASE_MS)

  it('[UC-MANUT-001] se o servidor não voltar em 90 s, diz para olhar a janela do IClass', async () => {
    const user = userEvent.setup()
    mocks.restart.waitForServerRestart.mockResolvedValue({ ok: false })
    render(<SistemaPage />)
    await user.click(screen.getByRole('button', { name: 'Reiniciar servidor' }))
    await screen.findByText(/1 prova em andamento/, {}, SLOW)
    await user.click(screen.getByRole('button', { name: 'Reiniciar agora' }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('O servidor não voltou em 90 s. Veja a janela do IClass.'), SLOW)
    expect(mocks.toast.success).not.toHaveBeenCalled()
  }, CASE_MS)

  it('[UC-MANUT-001] reinício recusado pelo servidor mostra o erro e não fica esperando', async () => {
    const user = userEvent.setup()
    mocks.post.mockRejectedValue(new Error('Reinício indisponível neste modo.'))
    render(<SistemaPage />)
    await user.click(screen.getByRole('button', { name: 'Reiniciar servidor' }))
    await screen.findByText(/1 prova em andamento/, {}, SLOW)
    await user.click(screen.getByRole('button', { name: 'Reiniciar agora' }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Reinício indisponível neste modo.'), SLOW)
    expect(mocks.restart.waitForServerRestart).not.toHaveBeenCalled()
  }, CASE_MS)

  it('[UC-MANUT-001] "Resetar sala" nomeia a turma, mostra as provas que serão encerradas e envia a confirmação ao servidor (CONF-X3)', async () => {
    const user = userEvent.setup()
    render(<SistemaPage />)
    expect(screen.getByText(/Só na turma 1DES · Técnico em TI/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Resetar sala' }))
    expect(await screen.findByText(/Prova W/, {}, SLOW)).toBeVisible()
    expect(screen.getByText(/4 tentativas em andamento/)).toBeVisible()
    expect(screen.getByText(/6 alunos desconectados/)).toBeVisible()
    // O backup é de todos os dados: restaurá-lo volta todas as turmas, e isso fica dito.
    expect(screen.getByText(/a restauração volta todas as turmas ao momento do reset/)).toBeVisible()
    await user.type(screen.getByLabelText('Digite RESETAR para confirmar'), 'RESETAR')
    await user.click(screen.getByRole('button', { name: 'Confirmar reset' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/reset', { studentClass: '1DES', courseId: 'DES', confirm: 'RESETAR' }, { timeoutMs: 0 }), SLOW)
  }, CASE_MS)

  it('[UC-MANUT-001] no Ambiente da instituição (sem turma ativa) a turma é escolhida no próprio card de Manutenção (UXI-02, OPS-X3, CONF-X3)', async () => {
    const user = userEvent.setup()
    mocks.workspace = INSTITUTION
    render(<SistemaPage />)
    const flushButton = screen.getByRole('button', { name: 'Limpar estado de prova' })
    const resetButton = screen.getByRole('button', { name: 'Resetar sala' })
    expect(flushButton).toBeDisabled()
    expect(resetButton).toBeDisabled()
    expect(screen.queryByText(/no topo/)).not.toBeInTheDocument()

    const select = screen.getByLabelText('Turma')
    expect([...select.options].map((option) => option.textContent)).toEqual(['Escolha a turma…', '1ADM · Administração', '1DES · Técnico em TI', '2DES · Técnico em TI'])
    await user.selectOptions(select, 'DES::2DES')
    expect(flushButton).toBeEnabled()
    expect(resetButton).toBeEnabled()
    expect(screen.getByText(/Só na turma 2DES · Técnico em TI/)).toBeVisible()

    await user.click(flushButton)
    await screen.findByText(/3 estados de tentativa sem entrega/, {}, SLOW)
    expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/studentClass=2DES&courseId=DES/))
    await user.type(screen.getByLabelText('Digite LIMPAR para confirmar'), 'LIMPAR')
    await user.click(screen.getByRole('button', { name: 'Limpar estado' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/flush-exam-state', expect.objectContaining({ studentClass: '2DES', courseId: 'DES', confirm: 'LIMPAR' }), { timeoutMs: 0 }), SLOW)

    await user.selectOptions(select, 'ADM::1ADM')
    await user.click(resetButton)
    await screen.findByText(/Prova W/, {}, SLOW)
    await user.type(screen.getByLabelText('Digite RESETAR para confirmar'), 'RESETAR')
    await user.click(screen.getByRole('button', { name: 'Confirmar reset' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/reset', { studentClass: '1ADM', courseId: 'ADM', confirm: 'RESETAR' }, { timeoutMs: 0 }), SLOW)
  }, CASE_MS)

  it('opções de turma: sem turmas excluídas, com o nome do curso e com a turma ativa mesmo antes da lista carregar', () => {
    const options = maintenanceClassOptions(mocks.apiData['/api/admin/classes'], mocks.apiData['/api/courses'], null)
    expect(options.map((option) => option.key)).toEqual(['ADM::1ADM', 'DES::1DES', 'DES::2DES'])
    const early = maintenanceClassOptions(null, null, { courseId: 'DES', className: '1DES', courseName: 'Técnico em TI' })
    expect(early).toEqual([{ key: 'DES::1DES', className: '1DES', courseId: 'DES', courseName: 'Técnico em TI' }])
  })
})

describe('Sistema · histórico de backup', () => {
  afterEach(cleanup)
  it('[UC-BACKUP-001] mostra restaurações, falhas e cópias com quem fez e quando', () => {
    // Antes nenhuma tela mostrava os registros de restauração.
    const entries = [
      { id: 'a3', action: 'backup_server_created', actor: 'prof@x.local', timestamp: Date.parse('2026-10-18T12:00:00Z'), ip: '10.0.0.2', file: 'manual_2026-10-18.json' },
      { id: 'a2', action: 'backup_restored', actor: 'admin@x.local', timestamp: Date.parse('2026-10-18T11:00:00Z'), ip: '10.0.0.1', file: 'escola.json', format: 'json' },
      { id: 'a1', action: 'backup_restore_failed', actor: 'admin@x.local', timestamp: Date.parse('2026-10-18T10:00:00Z'), file: 'velho.json', error: 'Arquivo de backup inválido.' },
      { id: 'a0', action: 'backup_downloaded', actor: 'admin@x.local', timestamp: Date.parse('2026-10-18T09:00:00Z'), format: 'zip' },
    ]
    render(<BackupHistory entries={entries} />)
    const list = screen.getByRole('list', { name: 'Histórico de backup' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent('Cópia gerada no servidor')
    expect(items[0]).toHaveTextContent('prof@x.local')
    expect(items[1]).toHaveTextContent('Restauração concluída')
    expect(items[1]).toHaveTextContent('escola.json')
    expect(items[2]).toHaveTextContent('Restauração com falha')
    expect(items[2]).toHaveTextContent('Arquivo de backup inválido.')
    expect(within(items[2]).getByText('Falhou')).toBeInTheDocument()
    expect(items[3]).toHaveTextContent('Backup baixado (ZIP)')
  })

  it('[UC-BACKUP-001] sem registros avisa que ainda não há histórico', () => {
    render(<BackupHistory entries={[]} />)
    expect(screen.getByText('Nenhum registro ainda.')).toBeInTheDocument()
  })
})

describe('Sistema · restaurar backup de versão anterior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.workspace = INSTITUTION
    mocks.get.mockResolvedValue(preview())
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('[UC-BACKUP-001] avisa antes que o backup é de versão anterior e o que acontece com as aplicações; só restaura depois de confirmar', async () => {
    const warning = 'Este backup é de uma versão anterior do IClass e não traz as aplicações de prova. Ao restaurar, as aplicações de prova atuais serão descartadas.'
    // O envio vai pelo cliente da API (lib/api.js), que devolve a recusa com status e corpo.
    const restoreReplies = [
      () => Promise.reject(Object.assign(new Error(warning), { status: 409, data: { error: warning, legacyBackup: true, exportedAt: '2026-10-18T20:08:31.000Z' } })),
      () => Promise.resolve({ success: true, accountsNotRestored: 0, legacyApplications: true, applicationsDiscarded: 3, applicationsRebuilt: 1 }),
    ]
    mocks.post.mockImplementation((url) => (url === '/api/admin/backup/restore' ? restoreReplies.shift()() : Promise.resolve({ success: true })))
    const restoreCalls = () => mocks.post.mock.calls.filter(([url]) => url === '/api/admin/backup/restore')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    const { container } = render(<SistemaPage />)
    await user.upload(container.querySelector('input[type="file"]'), new File(['{}'], 'backup-antigo.json', { type: 'application/json' }))
    await user.type(screen.getByLabelText('Digite RESTAURAR para confirmar'), 'RESTAURAR')
    await user.click(screen.getByRole('button', { name: 'Restaurar' }))

    // 1º envio: o servidor não restaura e devolve o aviso, que a tela mostra.
    const dialog = await screen.findByRole('dialog', { name: 'Backup de uma versão anterior' })
    expect(dialog).toHaveTextContent('versão anterior do IClass')
    expect(dialog).toHaveTextContent('aplicações de prova atuais serão descartadas')
    expect(restoreCalls()).toHaveLength(1)
    expect(restoreCalls()[0][1]).toBeInstanceOf(FormData)
    expect(restoreCalls()[0][1].get('acceptLegacy')).toBeNull()
    expect(restoreCalls()[0][2]).toEqual({ timeoutMs: 0 })
    expect(mocks.toast.success).not.toHaveBeenCalled()
    expect(mocks.toast.error).not.toHaveBeenCalled()

    // Confirmado no aviso: manda de novo com a confirmação e informa o que foi feito.
    await user.click(within(dialog).getByRole('button', { name: 'Restaurar mesmo assim' }))
    await waitFor(() => expect(restoreCalls()).toHaveLength(2))
    expect(restoreCalls()[1][1].get('acceptLegacy')).toBe('1')
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalled())
    expect(mocks.toast.success.mock.calls[0][0]).toMatch(/aplicações de prova foram refeitas a partir das turmas do backup \(3 aplicações atuais descartadas, 1 refeita\)/)
    expect(window.confirm).toHaveBeenCalledTimes(1)
  })

  it('[UC-BACKUP-001] restaurar usa a confirmação digitada padrão: o botão só libera com o arquivo e RESTAURAR', async () => {
    mocks.post.mockResolvedValue({ success: true, accountsNotRestored: 0 })
    const restoreCalls = () => mocks.post.mock.calls.filter(([url]) => url === '/api/admin/backup/restore')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    const { container } = render(<SistemaPage />)
    const button = screen.getByRole('button', { name: 'Restaurar' })
    const field = screen.getByLabelText('Digite RESTAURAR para confirmar')
    expect(button).toBeDisabled()
    await user.type(field, 'restaurar')
    expect(button).toBeDisabled()
    await user.upload(container.querySelector('input[type="file"]'), new File(['{}'], 'backup.json', { type: 'application/json' }))
    expect(button).toBeEnabled()
    await user.clear(field)
    await user.type(field, 'RESTAURA')
    expect(button).toBeDisabled()
    await user.type(field, 'R{Enter}')
    await waitFor(() => expect(restoreCalls()).toHaveLength(1))
    expect(restoreCalls()[0][1].get('confirm')).toBe('RESTAURAR')
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalled())
  })

  it('[UC-BACKUP-001] RESTAURAR digitado sem arquivo: Enter avisa que falta o arquivo e não envia nada', async () => {
    const user = userEvent.setup()
    render(<SistemaPage />)
    const field = screen.getByLabelText('Digite RESTAURAR para confirmar')
    expect(screen.queryByText('Escolha o arquivo de backup para liberar o botão Restaurar.')).not.toBeInTheDocument()
    await user.type(field, 'RESTAURAR')
    expect(screen.getByText('Escolha o arquivo de backup para liberar o botão Restaurar.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restaurar' })).toBeDisabled()
    await user.type(field, '{Enter}')
    expect(mocks.toast.error).toHaveBeenCalledWith('Escolha o arquivo de backup')
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('[UC-BACKUP-001] baixar e restaurar vão pelo cliente da API: sem rede, a mensagem em português (antes "Failed to fetch")', async () => {
    const offline = 'Sem conexão com o servidor do IClass. Confira a rede e tente de novo.'
    const networkError = () => Object.assign(new Error(offline), { status: 0, network: true })
    mocks.downloadFile.mockResolvedValueOnce('iclass-backup.json').mockRejectedValueOnce(networkError())
    mocks.post.mockImplementation((url) => (url === '/api/admin/backup/restore' ? Promise.reject(networkError()) : Promise.resolve({ success: true })))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    const { container } = render(<SistemaPage />)
    await user.click(screen.getByRole('button', { name: 'Baixar dados (JSON)' }))
    expect(mocks.downloadFile).toHaveBeenCalledWith('/api/admin/backup/data', 'iclass-backup.json')
    expect(mocks.toast.error).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Baixar completo (ZIP)' }))
    expect(mocks.downloadFile).toHaveBeenLastCalledWith('/api/admin/backup/full', 'iclass-backup.zip')
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(offline))

    await user.upload(container.querySelector('input[type="file"]'), new File(['{}'], 'backup.json', { type: 'application/json' }))
    await user.type(screen.getByLabelText('Digite RESTAURAR para confirmar'), 'RESTAURAR')
    await user.click(screen.getByRole('button', { name: 'Restaurar' }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(2))
    expect(mocks.toast.error).toHaveBeenLastCalledWith(offline)
    expect(screen.queryByRole('dialog', { name: 'Backup de uma versão anterior' })).not.toBeInTheDocument()
  })

  it('[UC-BACKUP-001] histórico anota a restauração de backup de versão anterior', () => {
    render(<BackupHistory entries={[{ id: 'r1', action: 'backup_restored', actor: 'admin@x.local', timestamp: Date.parse('2026-10-18T11:00:00Z'), file: 'antigo.json', legacyApplications: true, applicationsDiscarded: 1, applicationsRebuilt: 2 }]} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Backup de versão anterior: as aplicações de prova foram refeitas a partir das turmas do backup (1 aplicação atual descartada, 2 refeitas).')
  })
})
