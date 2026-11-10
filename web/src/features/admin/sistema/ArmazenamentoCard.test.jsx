import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArmazenamentoCard, ONEDRIVE_WARNING, compactResultText, databaseSizeText, formatBytes, freeSpaceText, topCollections, writeErrorText } from './ArmazenamentoCard'

const MB = 1024 * 1024

const mocks = vi.hoisted(() => ({
  result: { data: null, error: null },
  refetch: vi.fn(),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  calls: [],
}))

vi.mock('../../../hooks/useApi', () => ({
  useApi: (path) => { mocks.calls.push(path); return { ...mocks.result, loading: false, refetch: mocks.refetch } },
}))
vi.mock('../../../lib/api', () => ({ api: { post: mocks.post } }))
vi.mock('../../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

function storage(extra = {}) {
  return {
    success: true,
    activeApplications: 0,
    diskFreeBytes: 40 * 1024 * MB,
    canCompact: true,
    ...extra,
    storage: {
      databaseBytes: 120 * MB,
      walBytes: 2 * MB,
      freeBytes: 48 * MB,
      compactSuggested: true,
      inSyncedFolder: false,
      keystrokes: 152340,
      rows: { attendance: 9800, proctoringLogs: 52000, submissions: 1200, students: 140, notes: 300, auditLogs: 4200, branding: 1 },
      lastFullSaveAt: '2026-11-10T12:00:00Z',
      lastFullSaveMs: 840,
      commitP95Ms: 18,
      lastWriteError: null,
      pendingRetry: false,
      ...(extra.storage || {}),
    },
  }
}

describe('ArmazenamentoCard · Armazenamento', () => {
  beforeEach(() => { mocks.post.mockReset(); mocks.refetch.mockReset(); mocks.calls.length = 0 })
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('[UC-ARMAZENAMENTO-001] mostra banco, -wal, espaço recuperável, maiores coleções, teclas, gravação e p95', () => {
    mocks.result = { data: storage(), error: null }
    render(<ArmazenamentoCard />)
    expect(mocks.calls[0]).toBe('/api/admin/storage')
    expect(screen.getByText('Armazenamento')).toBeVisible()
    expect(screen.getByText('Vale compactar')).toBeVisible()
    expect(screen.getByText('122 MB no total, sendo 120 MB no arquivo principal e 2 MB de gravações recentes (-wal)')).toBeVisible()
    expect(screen.getByText('48 MB (40% do arquivo)')).toBeVisible()
    expect(screen.getByText('Registros do Monitor: 52.000 · Presenças: 9.800 · Auditoria: 4.200 · Entregas de prova: 1.200 · Caderno dos alunos: 300')).toBeVisible()
    expect(screen.getByText('152.340')).toBeVisible()
    expect(screen.getByText(/levou 840 ms$/)).toBeVisible()
    expect(screen.getByText('18 ms')).toBeVisible()
    expect(screen.queryByText(ONEDRIVE_WARNING)).toBeNull()
    expect(screen.getByRole('button', { name: /Compactar banco/ })).toBeEnabled()
  })

  it('[UC-ARMAZENAMENTO-001] pasta no OneDrive e última falha de gravação aparecem como alerta', () => {
    mocks.result = {
      data: storage({ storage: { inSyncedFolder: true, lastWriteError: { at: '2026-11-10T12:30:00Z', code: 'SQLITE_BUSY', message: 'x' }, pendingRetry: true } }),
      error: null,
    }
    render(<ArmazenamentoCard />)
    const alerts = screen.getAllByRole('alert')
    expect(alerts.some((node) => node.textContent.includes(ONEDRIVE_WARNING))).toBe(true)
    const failure = alerts.find((node) => node.textContent.includes('Última falha ao gravar'))
    expect(failure).toBeTruthy()
    // Antes aparecia só o código cru ("· SQLITE_BUSY").
    expect(failure.textContent).toMatch(/o banco estava ocupado por outro programa \(antivírus, OneDrive ou cópia de arquivos\) \(código SQLITE_BUSY\) · o IClass está tentando gravar de novo sozinho/)
    expect(failure.className).toMatch(/text-danger/)
  })

  it('[UC-ARMAZENAMENTO-001] professor vê o cartão sem o botão Compactar', () => {
    mocks.result = { data: storage({ canCompact: false }), error: null }
    render(<ArmazenamentoCard />)
    expect(screen.getByText('Armazenamento')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Compactar/ })).toBeNull()
  })

  it('[UC-ARMAZENAMENTO-001] com prova em andamento o botão fica desligado e diz por quê', () => {
    mocks.result = { data: storage({ activeApplications: 2 }), error: null }
    render(<ArmazenamentoCard />)
    expect(screen.getByRole('button', { name: /Compactar banco/ })).toBeDisabled()
    expect(screen.getByText('Há prova em andamento. Compacte o banco depois que as provas terminarem.')).toBeVisible()
  })

  it('[UC-ARMAZENAMENTO-001] Compactar pede COMPACTAR, não tem prazo no navegador e mostra antes e depois', async () => {
    const user = userEvent.setup()
    mocks.result = { data: storage(), error: null }
    mocks.post.mockResolvedValue({ success: true, antes: 122 * MB, depois: 72 * MB, recuperadoBytes: 48 * MB, ms: 2300, storage: {} })
    render(<ArmazenamentoCard />)
    await user.click(screen.getByRole('button', { name: /Compactar banco/ }))
    const confirm = screen.getByRole('button', { name: /^Compactar$/ })
    expect(confirm).toBeDisabled()
    await user.type(screen.getByLabelText('Digite COMPACTAR para confirmar'), 'compactar')
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/storage/compact', { confirm: 'COMPACTAR' }, { timeoutMs: 0 }))
    expect(mocks.toast.success).toHaveBeenCalledWith('Banco compactado em 2,3 s: 48 MB de espaço vazio devolvido ao disco. No disco, o banco foi de 122 MB para 72 MB (o antes inclui as gravações recentes do -wal).')
    expect(await screen.findByText('Banco compactado em 2,3 s: 48 MB de espaço vazio devolvido ao disco. No disco, o banco foi de 122 MB para 72 MB (o antes inclui as gravações recentes do -wal).', { selector: 'p' })).toBeVisible()
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('[UC-ARMAZENAMENTO-001] recusa do servidor (prova começou no meio) vira aviso', async () => {
    const user = userEvent.setup()
    mocks.result = { data: storage(), error: null }
    mocks.post.mockRejectedValue(Object.assign(new Error('Há prova em andamento. Compacte o banco depois que as provas terminarem.'), { status: 409 }))
    render(<ArmazenamentoCard />)
    await user.click(screen.getByRole('button', { name: /Compactar banco/ }))
    await user.type(screen.getByLabelText('Digite COMPACTAR para confirmar'), 'COMPACTAR{Enter}')
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Há prova em andamento. Compacte o banco depois que as provas terminarem.'))
  })

  it('[UC-ARMAZENAMENTO-001] textos auxiliares', () => {
    expect(formatBytes(0)).toBe('0 KB')
    expect(formatBytes(640 * 1024)).toBe('640 KB')
    expect(formatBytes(12.4 * MB)).toBe('12,4 MB')
    expect(formatBytes(1.25 * 1024 * MB)).toBe('1,3 GB')
    expect(freeSpaceText({ freeBytes: null })).toBe('ainda não medido')
    expect(freeSpaceText({ freeBytes: 0, databaseBytes: 4 * MB })).toBe('0 KB (0% do arquivo)')
    expect(topCollections({ a: 1, b: 5, c: 0 })).toEqual([{ name: 'b', label: 'b', rows: 5 }, { name: 'a', label: 'a', rows: 1 }])
    expect(compactResultText({ antes: 2 * MB, depois: MB, ms: 150 })).toBe('Banco compactado em 150 ms: de 2 MB para 1 MB.')
    expect(compactResultText({ antes: 2 * MB, depois: MB, recuperadoBytes: 512 * 1024, ms: 150 })).toBe('Banco compactado em 150 ms: 512 KB de espaço vazio devolvido ao disco. No disco, o banco foi de 2 MB para 1 MB (o antes inclui as gravações recentes do -wal).')
    expect(writeErrorText({ code: 'SQLITE_FULL' })).toBe('o disco está cheio (código SQLITE_FULL)')
    expect(writeErrorText({ code: 'SQLITE_IOERR_WRITE' })).toBe('o disco não deixou gravar (erro de leitura ou escrita) (código SQLITE_IOERR_WRITE)')
    expect(writeErrorText({ code: 'XYZ' })).toBe('erro inesperado ao gravar (código XYZ)')
    expect(writeErrorText({})).toBe('erro inesperado ao gravar')
  })

  it('[UC-ARMAZENAMENTO-001] banco recém-aberto em WAL: sem "1.014 KB" e com a proporção sobre o tamanho do servidor', () => {
    // Antes: "4 KB + 1.014 KB no arquivo de gravações recentes" e "(100% do arquivo)",
    // porque a proporção era sobre o database.db de 4 KB antes do checkpoint.
    expect(formatBytes(1014 * 1024)).toBe('1 MB')
    expect(formatBytes(999 * 1024)).toBe('999 KB')
    expect(formatBytes(1023.9 * MB)).toBe('1 GB')
    const wal = { databaseBytes: 4096, walBytes: 1014 * 1024, allocatedBytes: 1020 * 1024, freeBytes: 8192 }
    expect(databaseSizeText(wal)).toBe('1 MB no total, sendo 4 KB no arquivo principal e 1 MB de gravações recentes (-wal)')
    expect(freeSpaceText(wal)).toBe('8 KB (1% do arquivo)')
    expect(databaseSizeText({ databaseBytes: 3 * MB, walBytes: 0 })).toBe('3 MB')
    // Servidor antigo sem allocatedBytes: cai no databaseBytes.
    expect(freeSpaceText({ freeBytes: MB, databaseBytes: 4 * MB })).toBe('1 MB (25% do arquivo)')
  })
})
