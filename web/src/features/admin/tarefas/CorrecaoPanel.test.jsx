import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CorrecaoPanel } from './CorrecaoPanel'
import { NOW, SEM_EMAIL, TZ, assignmentData, rosterData, submissionData } from '../../../test/tarefasCorrecaoFixtures'

// Painel de correção (fase 3, C8 / P1-f; FUN-01, D9 e D10 do P1): desconto de atraso,
// salvar/devolver, refazer, prorrogar, entrega em mãos, motivo da nota já devolvida e a
// pergunta antes de descartar. Antes do C8 o painel não existia.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('../../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post }, downloadFile: vi.fn(), fetchBlob: vi.fn(() => new Promise(() => {})) }))
vi.mock('../../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

const BASE = '/api/admin/assignments/asg_1_aaaaaa'
let roster

function refusal(status, data, message) {
  return Object.assign(new Error(message), { status, data })
}

function renderPanel(row, props = {}) {
  const handlers = { onClose: vi.fn(), onNavigate: vi.fn(), onChanged: vi.fn() }
  const queue = roster.map((item) => item.studentEmail)
  render(<CorrecaoPanel open assignment={assignmentData()} row={row} queue={queue} timezone={TZ} serverNow={NOW} {...handlers} {...props} />)
  return handlers
}

async function openPanel(name) {
  const panel = await screen.findByRole('dialog', { name })
  if (roster.find((row) => row.name === name)?.submissionId) await within(panel).findByText(/Recebida em/)
  return panel
}

beforeEach(() => {
  roster = rosterData()
  mocks.get.mockImplementation(async (path) => {
    const id = decodeURIComponent(path.split('/').pop())
    const row = roster.find((item) => item.submissionId === id)
    if (!row) throw new Error(`GET inesperado ${path}`)
    return { success: true, submission: submissionData(row), serverNow: NOW, timezone: TZ }
  })
  mocks.post.mockResolvedValue({ success: true, changed: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('CorrecaoPanel', () => {
  it('entrega atrasada: mostra o desconto pela conta do servidor, dispensa e salva com o aluno sem e-mail como chave', async () => {
    const user = userEvent.setup()
    renderPanel(roster[1])
    const panel = await openPanel('Bia Reis')
    expect(within(panel).getByText(/Atrasada 2 dias/)).toBeInTheDocument()
    await user.type(within(panel).getByLabelText('Nota (0 a 10)'), '8')
    expect(within(panel).getByText('Atraso de 2 dias: -20%, nota final 6,4.')).toBeInTheDocument()
    await user.click(within(panel).getByRole('checkbox', { name: 'Dispensar desconto' }))
    expect(within(panel).getByText('Atraso de 2 dias: desconto de 20% dispensado.')).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(`${BASE}/grade`, {
      studentEmail: SEM_EMAIL, action: 'salvar', grade: '8', comment: '', version: 1, waivePenalty: true,
    }))
    expect(mocks.toast.success).toHaveBeenCalledWith('Correção salva')
    // O endereço interno é só a chave da rota: nunca aparece no painel.
    expect(document.body.textContent).not.toContain('sem-email.invalid')
    expect(within(panel).getByText(/sem e-mail/)).toBeInTheDocument()
  })

  it('o texto do aluno é texto puro e o link abre em outra aba sem acesso à página', async () => {
    renderPanel(roster[0])
    const panel = await openPanel('Ana Lima')
    expect(within(panel).getByText('Minha resposta <b>não é HTML</b>')).toBeInTheDocument()
    expect(panel.querySelector('b')).toBeNull()
    const open = within(panel).getByRole('link', { name: 'Abrir' })
    expect(open).toHaveAttribute('href', 'https://example.com/diagrama')
    expect(open).toHaveAttribute('target', '_blank')
    expect(open).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('troca de versão: a corrigida é a escolhida', async () => {
    const user = userEvent.setup()
    renderPanel(roster[0])
    const panel = await openPanel('Ana Lima')
    const select = within(panel).getByLabelText('Versão')
    expect(select).toHaveValue('2')
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Versão 1 de 2', 'Versão 2 de 2 (a mais nova)'])
    await user.selectOptions(select, '1')
    await user.type(within(panel).getByLabelText('Nota (0 a 10)'), '7,5')
    await user.click(within(panel).getByRole('button', { name: 'Devolver ao aluno' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(`${BASE}/grade`, expect.objectContaining({ action: 'devolver', grade: '7,5', version: 1 })))
  })

  it('sem entrega: pede a nota antes de enviar e mostra no campo a recusa do servidor', async () => {
    const user = userEvent.setup()
    renderPanel(roster[3])
    const panel = await openPanel('Davi Souza')
    expect(within(panel).getByText(/Nenhuma versão enviada pelo sistema/)).toBeInTheDocument()
    expect(within(panel).getByText(/Sem entrega: só a nota zero/)).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Pedir para refazer' })).not.toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Salvar' }))
    expect(within(panel).getByText('Informe a nota (de 0 a 10).')).toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalled()

    mocks.post.mockRejectedValueOnce(refusal(409, { code: 'no_delivery', field: 'grade' }, 'Sem entrega, só a nota zero.'))
    await user.type(within(panel).getByLabelText('Nota (0 a 10)'), '5')
    await user.click(within(panel).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(within(panel).getByLabelText('Nota (0 a 10)')).toHaveAttribute('aria-invalid', 'true'))
    // Uma vez só (no campo), não repetida no aviso do painel.
    expect(within(panel).getAllByText('Sem entrega, só a nota zero.')).toHaveLength(1)
    // Zero explícito vai sem versão: o servidor escolhe.
    mocks.post.mockResolvedValueOnce({ success: true, changed: true })
    await user.clear(within(panel).getByLabelText('Nota (0 a 10)'))
    await user.type(within(panel).getByLabelText('Nota (0 a 10)'), '0')
    await user.click(within(panel).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenLastCalledWith(`${BASE}/grade`, { studentEmail: 'davi@x.com', action: 'salvar', grade: '0', comment: '', waivePenalty: false }))
  })

  it('nota já devolvida: mudar pede o motivo antes e manda junto', async () => {
    const user = userEvent.setup()
    renderPanel(roster[4])
    const panel = await openPanel('Eva Rocha')
    expect(within(panel).getByLabelText('Nota (0 a 10)')).toHaveValue('9,0')
    expect(within(panel).queryByRole('button', { name: 'Devolver ao aluno' })).not.toBeInTheDocument()
    await user.clear(within(panel).getByLabelText('Nota (0 a 10)'))
    await user.type(within(panel).getByLabelText('Nota (0 a 10)'), '9,5')
    await user.click(within(panel).getByRole('button', { name: 'Salvar alteração' }))
    const dialog = await screen.findByRole('dialog', { name: 'Alterar a nota já devolvida?' })
    expect(mocks.post).not.toHaveBeenCalled()
    await user.type(within(dialog).getByLabelText(/Motivo/), 'Revisão pedida pela aluna')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar alteração' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(`${BASE}/grade`, {
      studentEmail: 'eva@x.com', action: 'salvar', grade: '9,5', comment: 'Ótimo', version: 1, waivePenalty: false, reason: 'Revisão pedida pela aluna',
    }))
    expect(mocks.toast.success).toHaveBeenCalledWith('Correção alterada')
  })

  it('o servidor pede o motivo (devolvida nesse meio-tempo): o diálogo abre e reenvia com ele', async () => {
    const user = userEvent.setup()
    mocks.post.mockRejectedValueOnce(refusal(400, { code: 'reason_required' }, 'Informe o motivo.'))
    renderPanel(roster[2])
    const panel = await openPanel('Caio Melo')
    await user.clear(within(panel).getByLabelText('Nota (0 a 10)'))
    await user.type(within(panel).getByLabelText('Nota (0 a 10)'), '6')
    await user.click(within(panel).getByRole('button', { name: 'Salvar' }))
    const dialog = await screen.findByRole('dialog', { name: 'Alterar a nota já devolvida?' })
    await user.type(within(dialog).getByLabelText(/Motivo/), 'Erro de soma')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar alteração' }))
    await waitFor(() => expect(mocks.post).toHaveBeenLastCalledWith(`${BASE}/grade`, expect.objectContaining({ grade: '6', reason: 'Erro de soma' })))
    expect(mocks.post).toHaveBeenCalledTimes(2)
  })

  it('pedir para refazer: comentário e prazo novo (sugere 7 dias depois, às 23:59, no relógio da escola)', async () => {
    const user = userEvent.setup()
    renderPanel(roster[0])
    const panel = await openPanel('Ana Lima')
    await user.click(within(panel).getByRole('button', { name: 'Pedir para refazer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Pedir para refazer?' })
    expect(within(dialog).getByLabelText('Novo prazo: data')).toHaveValue('2026-11-29')
    expect(within(dialog).getByLabelText('Novo prazo: hora')).toHaveValue('23:59')
    const confirm = within(dialog).getByRole('button', { name: 'Pedir para refazer' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('O que o aluno precisa refazer (comentário)'), 'Refaça a parte 2')
    await user.click(confirm)
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(`${BASE}/grade`, {
      studentEmail: 'ana@x.com', action: 'refazer', grade: '', comment: 'Refaça a parte 2', version: 2, waivePenalty: false, redoDueDate: '2026-11-29', redoDueTime: '23:59',
    }))
    expect(mocks.toast.success).toHaveBeenCalledWith('Pedido para refazer enviado ao aluno')
  })

  it('prorrogar prazo: só com o motivo, que vai no corpo', async () => {
    const user = userEvent.setup()
    mocks.post.mockResolvedValueOnce({ success: true, changed: true, row: { ...roster[3], extension: { dueAt: NOW + 7 * 86400000, closeAt: null, reason: 'Atestado médico' } } })
    const handlers = renderPanel(roster[3])
    const panel = await openPanel('Davi Souza')
    await user.click(within(panel).getByRole('button', { name: 'Prorrogar prazo' }))
    const dialog = await screen.findByRole('dialog', { name: 'Prorrogar o prazo do aluno?' })
    const confirm = within(dialog).getByRole('button', { name: 'Prorrogar' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Motivo da prorrogação'), 'Atestado médico')
    await user.click(confirm)
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(`${BASE}/extension`, { studentEmail: 'davi@x.com', dueDate: '2026-11-29', dueTime: '23:59', reason: 'Atestado médico' }))
    expect(handlers.onChanged).toHaveBeenCalledWith(expect.objectContaining({ extension: expect.objectContaining({ reason: 'Atestado médico' }) }))
    expect(mocks.toast.success).toHaveBeenCalledWith('Prazo do aluno prorrogado')
  })

  it('entrega em mãos: observação, nota opcional e devolver agora', async () => {
    const user = userEvent.setup()
    renderPanel(roster[3])
    const panel = await openPanel('Davi Souza')
    await user.click(within(panel).getByRole('button', { name: 'Entrega em mãos' }))
    const dialog = await screen.findByRole('dialog', { name: 'Registrar entrega em mãos?' })
    const returnNow = within(dialog).getByRole('checkbox', { name: 'Devolver ao aluno agora' })
    expect(returnNow).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Observação (opcional)'), 'pendrive')
    await user.type(within(dialog).getByLabelText('Nota (0 a 10, opcional)'), '11')
    expect(within(dialog).getByRole('button', { name: 'Registrar' })).toBeDisabled()
    await user.clear(within(dialog).getByLabelText('Nota (0 a 10, opcional)'))
    await user.type(within(dialog).getByLabelText('Nota (0 a 10, opcional)'), '7')
    await user.click(returnNow)
    await user.click(within(dialog).getByRole('button', { name: 'Registrar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(`${BASE}/manual-entry`, { studentEmail: 'davi@x.com', note: 'pendrive', returnNow: true, grade: '7' }))
    expect(mocks.toast.success).toHaveBeenCalledWith('Entrega em mãos registrada e devolvida')
  })

  it('correção digitada e não salva: "Próximo aluno" e fechar perguntam antes', async () => {
    const user = userEvent.setup()
    const handlers = renderPanel(roster[0])
    const panel = await openPanel('Ana Lima')
    expect(within(panel).getByText(/Aluno 1 de 5/)).toBeInTheDocument()
    await user.type(within(panel).getByLabelText('Nota (0 a 10)'), '6')
    await user.click(within(panel).getByRole('button', { name: 'Próximo aluno' }))
    let ask = await screen.findByRole('dialog', { name: 'Descartar a correção não salva?' })
    await user.click(within(ask).getByRole('button', { name: 'Cancelar' }))
    expect(handlers.onNavigate).not.toHaveBeenCalled()
    expect(within(panel).getByLabelText('Nota (0 a 10)')).toHaveValue('6')

    await user.click(within(panel).getByRole('button', { name: 'Próximo aluno' }))
    ask = await screen.findByRole('dialog', { name: 'Descartar a correção não salva?' })
    await user.click(within(ask).getByRole('button', { name: 'Descartar' }))
    expect(handlers.onNavigate).toHaveBeenCalledWith(SEM_EMAIL)

    // Sem nada digitado, fecha direto.
    handlers.onClose.mockClear()
    await user.click(within(panel).getByRole('button', { name: /Fechar/ }))
    expect(handlers.onClose).toHaveBeenCalled()
  })

  it('conta só de consulta e tarefa arquivada: vê a entrega, sem os botões de mudar', async () => {
    renderPanel(roster[0], { readOnly: true })
    let panel = await openPanel('Ana Lima')
    expect(within(panel).getByText(/só de consulta/)).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Salvar' })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Pedir para refazer' })).not.toBeInTheDocument()
    expect(within(panel).getByLabelText('Nota (0 a 10)')).toBeDisabled()
    cleanup()
    render(<CorrecaoPanel open assignment={assignmentData({ status: 'arquivada' })} row={roster[0]} queue={[]} timezone={TZ} serverNow={NOW} onClose={vi.fn()} />)
    panel = await openPanel('Ana Lima')
    expect(within(panel).getByText(/está arquivada/)).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Devolver ao aluno' })).not.toBeInTheDocument()
  })
})
