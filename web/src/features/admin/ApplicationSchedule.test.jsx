import { useState } from 'react'
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApplicationScheduleBanner,
  ApplicationScheduleFields,
  initialSchedule,
  nextDay,
  scheduleFromView,
  schedulePayload,
  scheduleProblem,
} from './ApplicationSchedule'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))

function Fields(props) {
  const [value, setValue] = useState(props.initial || initialSchedule())
  return (
    <>
      <ApplicationScheduleFields value={value} onChange={setValue} studentClass="1DES" courseId="DES" durationMinutes={90} timerEnabled />
      <output data-testid="payload">{JSON.stringify(schedulePayload(value))}</output>
    </>
  )
}

const AGENDADA = {
  estado: 'agendada',
  abreEm: 1, fechaEm: 2,
  abreEmLabel: '20/11 às 08:00',
  fechaEmLabel: '20/11 às 09:30',
  janela: 'abre em 20/11 às 08:00 e fecha às 09:30',
  abreEmLocal: '2026-11-20T08:00',
  fechaEmLocal: '2026-11-20T09:30',
}

describe('ApplicationSchedule (P3-S12)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(cleanup)

  it('[UC-PROVA-008] "Agora" não manda agenda; agendar confere dia, horas e a ordem antes de mandar', () => {
    expect(schedulePayload(initialSchedule())).toEqual({})
    expect(scheduleProblem(initialSchedule())).toBeNull()
    const base = { mode: 'agendar', date: '', opensAt: '', closesAt: '' }
    expect(scheduleProblem(base)).toMatch(/dia/)
    expect(scheduleProblem({ ...base, date: '2026-11-20' })).toMatch(/abrir/)
    expect(scheduleProblem({ ...base, date: '2026-11-20', opensAt: '08:00' })).toMatch(/fechar/)
    expect(scheduleProblem({ ...base, date: '2026-11-20', opensAt: '08:00', closesAt: '07:30' })).toMatch(/depois do de abrir/)
    const ok = { ...base, date: '2026-11-20', opensAt: '08:00', closesAt: '09:30' }
    expect(scheduleProblem(ok)).toBeNull()
    expect(schedulePayload(ok)).toEqual({ agenda: { abreEmLocal: '2026-11-20T08:00', fechaEmLocal: '2026-11-20T09:30' } })
    // Fechando no dia seguinte (janela que passa da meia-noite), vinda do servidor.
    const overnight = scheduleFromView({ abreEmLocal: '2026-11-20T22:00', fechaEmLocal: '2026-11-21T01:00' })
    expect(overnight).toMatchObject({ mode: 'agendar', date: '2026-11-20', opensAt: '22:00', closesAt: '01:00', closeDate: '2026-11-21' })
    expect(scheduleProblem(overnight)).toBeNull()
    expect(schedulePayload(overnight).agenda.fechaEmLocal).toBe('2026-11-21T01:00')
  })

  it('[UC-PROVA-008] "Quando": escolher agendar mostra os campos, o resumo e o aviso de dia sem aula vindos do servidor', async () => {
    const user = userEvent.setup()
    mocks.get.mockResolvedValue({ avisos: [{ code: 'nao_letivo', texto: '20/11 é Consciência Negra (feriado).' }], janela: 'abre em 20/11 às 08:00 e fecha às 09:30' })
    render(<Fields />)
    expect(screen.getByRole('radio', { name: 'Eu abro pelo Monitor' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByLabelText('Dia')).toBeNull()
    await user.click(screen.getByRole('radio', { name: 'Agendar dia e horário' }))
    expect(screen.getByText(/O computador precisa estar ligado/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Dia'), { target: { value: '2026-11-20' } })
    fireEvent.change(screen.getByLabelText('Abre às'), { target: { value: '08:00' } })
    fireEvent.change(screen.getByLabelText('Fecha às'), { target: { value: '09:30' } })
    expect(await screen.findByTestId('schedule-summary')).toHaveTextContent('A prova abre em 20/11 às 08:00 e fecha às 09:30.')
    expect(screen.getByTestId('schedule-warnings')).toHaveTextContent('Consciência Negra')
    const url = mocks.get.mock.calls.at(-1)[0]
    expect(url).toContain('/api/admin/exam-applications/schedule-check?')
    expect(url).toContain('abreEmLocal=2026-11-20T08%3A00')
    expect(url).toContain('durationMinutes=90')
    expect(JSON.parse(screen.getByTestId('payload').textContent)).toEqual({ agenda: { abreEmLocal: '2026-11-20T08:00', fechaEmLocal: '2026-11-20T09:30' } })
  })

  it('[UC-PROVA-008] Monitor: agendada mostra "Abre sozinha" e cancelar pede confirmação sem caixa do navegador', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm')
    const onChanged = vi.fn()
    mocks.post.mockResolvedValue({ success: true, application: { id: 'app1', status: 'prepared', agenda: null, agendaView: null } })
    render(<ApplicationScheduleBanner application={{ id: 'app1', studentClass: '1DES', agendaView: AGENDADA }} onChanged={onChanged} toast={mocks.toast} />)
    const banner = screen.getByTestId('schedule-banner')
    expect(banner).toHaveAttribute('data-estado', 'agendada')
    expect(banner).toHaveTextContent('Abre sozinha em 20/11 às 08:00')
    expect(banner).toHaveTextContent('fecha sozinha às 09:30')
    await user.click(screen.getByRole('button', { name: 'Cancelar agendamento' }))
    expect(screen.getByText('Cancelar o agendamento?')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Cancelar agendamento' }).at(-1))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/exam-applications/app1/schedule', { cancelar: true }))
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 'app1', agendaView: null }))
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('[UC-PROVA-008] Monitor: a perdida avisa que não abriu e "Agendar de novo" manda o novo horário', async () => {
    const user = userEvent.setup()
    mocks.get.mockResolvedValue({ avisos: [], janela: 'abre em 27/11 às 08:00 e fecha às 09:30' })
    mocks.post.mockResolvedValue({ success: true, application: { id: 'app1', status: 'prepared', agendaView: { ...AGENDADA, abreEmLocal: '2026-11-27T08:00', fechaEmLocal: '2026-11-27T09:30' } } })
    const onChanged = vi.fn()
    render(<ApplicationScheduleBanner application={{ id: 'app1', studentClass: '1DES', agendaView: { ...AGENDADA, estado: 'perdida' } }} onChanged={onChanged} toast={mocks.toast} />)
    expect(screen.getByTestId('schedule-banner')).toHaveTextContent('A prova agendada não abriu')
    expect(screen.getByTestId('schedule-banner')).toHaveTextContent('O computador estava desligado entre 20/11 às 08:00 e 20/11 às 09:30')
    await user.click(screen.getByRole('button', { name: 'Agendar de novo' }))
    // A perdida volta sem o dia (que já passou): o professor escolhe.
    expect(screen.getByLabelText('Dia')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Salvar horário' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Escolha o dia da prova agendada.')
    expect(mocks.post).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Dia'), { target: { value: '2026-11-27' } })
    await user.click(screen.getByRole('button', { name: 'Salvar horário' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/exam-applications/app1/schedule', { abreEmLocal: '2026-11-27T08:00', fechaEmLocal: '2026-11-27T09:30' }))
    expect(onChanged).toHaveBeenCalled()
  })

  it('[UC-PROVA-008] Monitor: aberta pelo agendamento mostra "Fecha sozinha", o atraso do boot e "Não encerrar sozinha"', async () => {
    const user = userEvent.setup()
    mocks.post.mockResolvedValue({ success: true, application: { id: 'app1', status: 'running', agendaView: { ...AGENDADA, estado: 'fechamento_cancelado' } } })
    const view = { ...AGENDADA, estado: 'aberta', abertaAtrasada: true, atrasoSegundos: 1500, abertaEmLabel: '20/11 às 08:25', fechaEfetivaEm: 3, fechaEfetivaLabel: '20/11 às 09:40' }
    const { rerender } = render(<ApplicationScheduleBanner application={{ id: 'app1', agendaView: view }} toast={mocks.toast} />)
    const banner = screen.getByTestId('schedule-banner')
    expect(banner).toHaveTextContent('Fecha sozinha em 20/11 às 09:40')
    expect(banner).toHaveTextContent('Abriu às 08:25, 25 min depois do horário')
    expect(banner).toHaveTextContent('empurrado pelo tempo de pausa')
    await user.click(screen.getByRole('button', { name: 'Não encerrar sozinha' }))
    await user.click(screen.getAllByRole('button', { name: 'Não encerrar sozinha' }).at(-1))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/exam-applications/app1/schedule', { cancelar: true }))
    rerender(<ApplicationScheduleBanner application={{ id: 'app1', agendaView: { ...AGENDADA, estado: 'fechamento_cancelado' } }} toast={mocks.toast} />)
    expect(screen.getByTestId('schedule-banner')).toHaveTextContent('Sem fechamento automático')
    // Encerrada ou sem agenda: nenhum aviso.
    rerender(<ApplicationScheduleBanner application={{ id: 'app1', agendaView: { ...AGENDADA, estado: 'encerrada' } }} toast={mocks.toast} />)
    expect(screen.queryByTestId('schedule-banner')).toBeNull()
    rerender(<ApplicationScheduleBanner application={{ id: 'app1' }} toast={mocks.toast} />)
    expect(screen.queryByTestId('schedule-banner')).toBeNull()
  })
  it('[UC-PROVA-008] "Fecha no dia seguinte": a prova passa da meia-noite (antes a tela recusava) e fica em até 12 h', async () => {
    expect(nextDay('2026-11-20')).toBe('2026-11-21')
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
    expect(nextDay('2028-02-28')).toBe('2028-02-29')
    const late = { mode: 'agendar', date: '2026-11-20', opensAt: '22:00', closesAt: '01:00' }
    expect(scheduleProblem(late)).toMatch(/Fecha no dia seguinte/)
    expect(scheduleProblem({ ...late, closesNextDay: true })).toBeNull()
    expect(schedulePayload({ ...late, closesNextDay: true })).toEqual({ agenda: { abreEmLocal: '2026-11-20T22:00', fechaEmLocal: '2026-11-21T01:00' } })
    expect(scheduleProblem({ ...late, opensAt: '08:00', closesNextDay: true })).toMatch(/12 horas/)
    expect(scheduleProblem({ ...late, opensAt: '13:00', closesNextDay: true })).toBeNull()

    mocks.get.mockResolvedValue({ avisos: [], janela: 'abre em 20/11 às 22:00 e fecha em 21/11 às 01:00' })
    const user = userEvent.setup()
    render(<Fields initial={{ ...initialSchedule(), mode: 'agendar' }} />)
    fireEvent.change(screen.getByLabelText('Dia'), { target: { value: '2026-11-20' } })
    fireEvent.change(screen.getByLabelText('Abre às'), { target: { value: '22:00' } })
    fireEvent.change(screen.getByLabelText('Fecha às'), { target: { value: '01:00' } })
    expect(screen.getByText(/Se a prova passa da meia-noite/)).toBeInTheDocument()
    await user.click(screen.getByLabelText('Fecha no dia seguinte (depois da meia-noite)'))
    expect(screen.getByText('no dia 21/11/2026')).toBeInTheDocument()
    expect(JSON.parse(screen.getByTestId('payload').textContent)).toEqual({ agenda: { abreEmLocal: '2026-11-20T22:00', fechaEmLocal: '2026-11-21T01:00' } })
    // Trocar o dia leva o fechamento junto.
    fireEvent.change(screen.getByLabelText('Dia'), { target: { value: '2026-11-27' } })
    expect(JSON.parse(screen.getByTestId('payload').textContent).agenda.fechaEmLocal).toBe('2026-11-28T01:00')
    expect(await screen.findByTestId('schedule-summary')).toHaveTextContent('fecha em 21/11 às 01:00')
  })

  it('[UC-PROVA-008] Monitor: conta que não muda a agenda (Professor auxiliar, Coordenação) vê o aviso sem os botões', () => {
    const { rerender } = render(<ApplicationScheduleBanner application={{ id: 'app1', agendaView: AGENDADA }} toast={mocks.toast} canEdit={false} />)
    expect(screen.getByTestId('schedule-banner')).toHaveTextContent('Abre sozinha em 20/11 às 08:00')
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<ApplicationScheduleBanner application={{ id: 'app1', agendaView: { ...AGENDADA, estado: 'perdida' } }} toast={mocks.toast} canEdit={false} />)
    expect(screen.getByTestId('schedule-banner')).toHaveTextContent('quem prepara as provas pode agendar de novo')
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<ApplicationScheduleBanner application={{ id: 'app1', agendaView: { ...AGENDADA, estado: 'aberta', fechaEfetivaLabel: '20/11 às 09:30' } }} toast={mocks.toast} canEdit={false} />)
    expect(screen.getByTestId('schedule-banner')).toHaveTextContent('Fecha sozinha em 20/11 às 09:30')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
