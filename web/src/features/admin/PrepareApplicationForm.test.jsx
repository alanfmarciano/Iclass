import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// "Para quem" da aplicação (fase 3, P3-S7: AVA-09; D15, D16 e D17 do desenho do P3).
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))

import {
  ApplicationAudienceFields,
  ApplicationAudienceModal,
  DEFAULT_SESSION_POLICY,
  PrepareApplicationForm,
  RECUPERACAO_VISIVEL,
  SessionPolicySelect,
  sessionPolicyDescription,
  audiencePayload,
  audienceProblem,
  initialAudience,
} from './PrepareApplicationForm'
import { drawAvailability, drawPayload, drawProblem } from './ApplicationDraw'

const CANDIDATES = {
  success: true,
  students: [
    { email: 'alice@x.local', name: 'Alice Souza', fezRegular: true },
    { email: 'bruno@x.local', name: 'Bruno Lima', fezRegular: false },
    { email: 'carla@x.local', name: 'Carla Dias', fezRegular: false },
  ],
  segundaChamada: ['bruno@x.local', 'carla@x.local'],
}

function Harness({ candidates = CANDIDATES, timerMode = 'per_attempt', onValue }) {
  const [value, setValue] = useState(initialAudience())
  return (
    <>
      <ApplicationAudienceFields value={value} onChange={(next) => { setValue(next); onValue?.(next) }} candidates={candidates} timerMode={timerMode} />
      <output data-testid="payload">{JSON.stringify(audiencePayload(value, { timerMode }))}</output>
    </>
  )
}

const payload = () => JSON.parse(screen.getByTestId('payload').textContent)

beforeEach(() => { mocks.get.mockReset(); mocks.post.mockReset() })
afterEach(() => cleanup())

describe('[UC-PROVA-006] Para quem da aplicação', () => {
  it('J2 (X3): Recuperação aparece no Para quem; os alunos marcados vão com a finalidade recuperacao', () => {
    // Escondida até a J2 (D17): o gradebook (P2-S3) já conta a recuperação como recuperação.
    expect(RECUPERACAO_VISIVEL).toBe(true)
    render(<Harness />)
    const group = screen.getByRole('radiogroup', { name: 'Para quem' })
    expect(within(group).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Turma inteira', 'Segunda chamada', 'Escolher alunos', 'Recuperação'])
    // Sem mudança: turma inteira, como antes.
    expect(payload()).toEqual({ finalidade: 'regular', participants: null })
    fireEvent.click(screen.getByRole('radio', { name: 'Recuperação' }))
    expect(screen.getByRole('radio', { name: 'Recuperação' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Só os alunos marcados fazem a recuperação. A nota entra como recuperação pelos critérios do curso.')).toBeInTheDocument()
    // Ninguém marcado: o pedido não sai (o servidor também recusa).
    expect(audienceProblem({ mode: 'recuperacao', selected: [], overrides: {} })).toBe('Escolha pelo menos um aluno para esta aplicação.')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bruno Lima' }))
    expect(payload()).toEqual({ finalidade: 'recuperacao', participants: ['bruno@x.local'] })
  })

  it('segunda chamada vem marcada com quem não fez; desmarcar e marcar muda a lista do pedido', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('radio', { name: 'Segunda chamada' }))
    expect(screen.getByRole('checkbox', { name: 'Bruno Lima' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Carla Dias' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Alice Souza' })).not.toBeChecked()
    expect(screen.getByText('Já fez')).toBeVisible()
    expect(payload()).toEqual({ finalidade: 'segunda_chamada', participants: ['bruno@x.local', 'carla@x.local'] })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Carla Dias' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alice Souza' }))
    expect(payload().participants).toEqual(['bruno@x.local', 'alice@x.local'])
    // Busca sem acento.
    fireEvent.change(screen.getByLabelText('Buscar aluno'), { target: { value: 'carla' } })
    expect(screen.queryByRole('checkbox', { name: 'Bruno Lima' })).not.toBeInTheDocument()
  })

  it('nova segunda chamada: quem entregou a anterior continua marcado, com "Fez a segunda chamada"', () => {
    const candidates = {
      ...CANDIDATES,
      students: CANDIDATES.students.map((student) => (student.email === 'bruno@x.local' ? { ...student, fezSegundaChamada: true } : student)),
    }
    render(<Harness candidates={candidates} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Segunda chamada' }))
    expect(screen.getByRole('checkbox', { name: 'Bruno Lima' })).toBeChecked()
    const row = screen.getByRole('checkbox', { name: 'Bruno Lima' }).closest('label')
    expect(within(row).getByText('Fez a segunda chamada')).toBeVisible()
    expect(screen.getAllByText('Fez a segunda chamada')).toHaveLength(1)
    expect(payload().participants).toEqual(['bruno@x.local', 'carla@x.local'])
  })

  it('segunda chamada escolhida antes de a lista chegar marca quem não fez assim que ela chega', () => {
    const { rerender } = render(<Harness candidates={null} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Segunda chamada' }))
    rerender(<Harness candidates={CANDIDATES} />)
    // O Harness guarda o estado: o efeito marca a lista quando os candidatos chegam.
    expect(screen.getByRole('checkbox', { name: 'Bruno Lima' })).toBeChecked()
  })

  it('escolher alunos sem ninguém marcado não deixa preparar', () => {
    let last = null
    render(<Harness onValue={(value) => { last = value }} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Escolher alunos' }))
    expect(audienceProblem(last)).toBe('Escolha pelo menos um aluno para esta aplicação.')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bruno Lima' }))
    expect(audienceProblem(last)).toBeNull()
  })

  it('exceção por aluno: tentativa extra e prazo para começar (só com o cronômetro por aluno)', () => {
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Aluno'), { target: { value: 'bruno@x.local' } })
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }))
    const row = screen.getByTestId('exception-bruno@x.local')
    fireEvent.change(within(row).getByLabelText('Tentativas extras'), { target: { value: '2' } })
    fireEvent.change(within(row).getByLabelText('Pode começar até'), { target: { value: '2026-11-20T08:00' } })
    fireEvent.change(within(row).getByLabelText('Motivo (opcional)'), { target: { value: 'Atestado' } })
    expect(payload().studentOverrides).toEqual({ 'bruno@x.local': { extraAttempts: 2, prazoAteLocal: '2026-11-20T08:00', motivo: 'Atestado' } })
    fireEvent.click(within(row).getByRole('button', { name: /Retirar a exceção/ }))
    expect(payload().studentOverrides).toEqual({ 'bruno@x.local': null })
  })

  it('com o cronômetro junto da turma não há prazo por aluno', () => {
    render(<Harness timerMode="collective" />)
    fireEvent.change(screen.getByLabelText('Aluno'), { target: { value: 'carla@x.local' } })
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }))
    expect(screen.queryByLabelText('Pode começar até')).not.toBeInTheDocument()
    expect(payload().studentOverrides).toEqual({ 'carla@x.local': { extraAttempts: 1, prazoAte: null, motivo: '' } })
  })

  it('nomes da tela batem com a Ajuda do professor ("Escolher alunos")', async () => {
    const help = (await import('../help/conteudo/instrutor.md?raw')).default
    for (const label of ['Turma inteira', 'Segunda chamada', 'Escolher alunos', 'Recuperação', 'Já fez', 'Fez a segunda chamada', 'Alunos desta aplicação', 'Exceção por aluno', 'Pode começar até', 'Tirar o prazo']) {
      expect(help).toContain(`**${label}**`)
    }
    expect(help).not.toContain('Alunos escolhidos')
  })

  it('a lista de alunos recolhe e o resumo continua dizendo quantos estão marcados', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('radio', { name: 'Segunda chamada' }))
    const list = screen.getByTestId('audience-list')
    expect(list).toHaveAttribute('open')
    const summary = within(list).getByText(/2 de 3 alunos marcados/)
    fireEvent.click(summary)
    expect(list).not.toHaveAttribute('open')
    expect(summary).toBeVisible()
  })

  it('lista atualizada com a tela aberta: quem entregou a regular sai da segunda chamada, com aviso', () => {
    const onRetry = vi.fn()
    function Live({ candidates }) {
      const [value, setValue] = useState(initialAudience())
      return (
        <>
          <ApplicationAudienceFields value={value} onChange={setValue} candidates={candidates} timerMode="per_attempt" onRetry={onRetry} />
          <output data-testid="payload">{JSON.stringify(audiencePayload(value, { timerMode: 'per_attempt' }))}</output>
        </>
      )
    }
    const { rerender } = render(<Live candidates={CANDIDATES} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Segunda chamada' }))
    // O professor marca a Alice de propósito (já fez): ela fica.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alice Souza' }))
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
    expect(onRetry).toHaveBeenCalled()
    // Chega a lista nova: o Bruno entregou a regular enquanto a tela estava aberta.
    rerender(<Live candidates={{ ...CANDIDATES, students: CANDIDATES.students.map((student) => student.email === 'bruno@x.local' ? { ...student, fezRegular: true } : student), segundaChamada: ['carla@x.local'] }} />)
    expect(screen.getByRole('checkbox', { name: 'Bruno Lima' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Alice Souza' })).toBeChecked()
    expect(screen.getByTestId('late-deliveries')).toHaveTextContent('Bruno Lima entregou a prova regular agora há pouco')
    expect(payload().participants).toEqual(['carla@x.local', 'alice@x.local'])
  })

  it('Alunos desta aplicação: "Tirar o prazo" retira só o prazo e mantém a tentativa extra', async () => {
    mocks.get.mockResolvedValue({
      ...CANDIDATES,
      students: CANDIDATES.students.map((student) => student.email === 'bruno@x.local' ? { ...student, override: { extraAttempts: 1, prazoAte: Date.UTC(2099, 11, 1, 11, 0), prazoAteLabel: '01/12 às 08:00', motivo: 'Atestado' } } : student),
      application: { id: 'app_3', status: 'prepared', timerMode: 'per_attempt', finalidade: 'regular', participants: null },
    })
    mocks.post.mockResolvedValue({ success: true, application: { id: 'app_3' } })
    const toast = { success: vi.fn(), error: vi.fn() }
    render(<ApplicationAudienceModal open application={{ id: 'app_3', status: 'prepared' }} onClose={vi.fn()} toast={toast} />)
    const row = await screen.findByTestId('exception-bruno@x.local')
    // O prazo atual vem no relógio da escola (do servidor), não no fuso do aparelho.
    expect(within(row).getByText('Prazo atual: até 01/12 às 08:00. Escolha outra data para mudar.')).toBeVisible()
    fireEvent.click(within(row).getByRole('button', { name: 'Tirar o prazo de Bruno Lima' }))
    expect(within(row).queryByRole('button', { name: /Tirar o prazo/ })).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Salvar' })) })
    await waitFor(() => expect(mocks.post).toHaveBeenCalled())
    expect(mocks.post.mock.calls[0][1].studentOverrides).toEqual({ 'bruno@x.local': { extraAttempts: 1, prazoAte: null, motivo: 'Atestado' } })
  })

  it('Alunos desta aplicação: com a prova em andamento só acrescenta; salva pela rota de participantes', async () => {
    mocks.get.mockResolvedValue({
      ...CANDIDATES,
      students: CANDIDATES.students.map((student) => student.email === 'bruno@x.local' ? { ...student, override: { extraAttempts: 1, prazoAte: null, motivo: '' } } : student),
      application: { id: 'app_2', status: 'running', timerMode: 'per_attempt', finalidade: 'segunda_chamada', participants: ['bruno@x.local'] },
    })
    mocks.post.mockResolvedValue({ success: true, application: { id: 'app_2' } })
    const toast = { success: vi.fn(), error: vi.fn() }
    const onSaved = vi.fn()
    const onClose = vi.fn()
    render(<ApplicationAudienceModal open application={{ id: 'app_2', status: 'running' }} onClose={onClose} onSaved={onSaved} toast={toast} />)
    const bruno = await screen.findByRole('checkbox', { name: 'Bruno Lima' })
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/exam-applications/participant-candidates?applicationId=app_2')
    expect(bruno).toBeChecked()
    expect(bruno).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Turma inteira' })).toBeDisabled()
    expect(screen.getByTestId('exception-bruno@x.local')).toBeVisible()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Carla Dias' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Salvar' })) })
    await waitFor(() => expect(mocks.post).toHaveBeenCalled())
    const [url, body] = mocks.post.mock.calls[0]
    expect(url).toBe('/api/admin/exam-applications/app_2/participants')
    expect(body.finalidade).toBe('segunda_chamada')
    expect(body.participants).toEqual(['bruno@x.local', 'carla@x.local'])
    expect(body.studentOverrides).toEqual({ 'bruno@x.local': { extraAttempts: 1, prazoAte: null, motivo: '' } })
    expect(onSaved).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})

// Junção J1 (A3 + C1): o aluno sem e-mail aparece como "sem e-mail" na lista do "Para quem"
// e nas mensagens da exceção; o endereço interno só vai no pedido (é a chave do cadastro).
describe('[UC-PROVA-006] [UC-IDENT-001] Para quem com aluno sem e-mail', () => {
  const INTERNAL = 'aluno-alu_00000000000000f2@sem-email.invalid'
  const candidates = {
    success: true,
    students: [
      { email: 'alice@x.local', name: 'Alice Souza', fezRegular: true },
      { email: INTERNAL, name: 'Bruno Sem Email', fezRegular: false },
    ],
    segundaChamada: [INTERNAL],
  }

  it('a lista mostra "sem e-mail", nunca o endereço interno, e o pedido leva o endereço interno', () => {
    render(<Harness candidates={candidates} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Segunda chamada' }))
    const row = screen.getByRole('checkbox', { name: 'Bruno Sem Email' }).closest('label')
    expect(within(row).getByText('sem e-mail')).toBeVisible()
    // Fora do pedido (a saída do Harness), nada na tela tem o endereço interno.
    const shown = document.body.textContent.replace(screen.getByTestId('payload').textContent, '')
    expect(shown).not.toMatch(/sem-email\.invalid/)
    expect(payload().participants).toEqual([INTERNAL])
  })

  it('a mensagem da exceção fala do aluno sem e-mail sem mostrar o endereço interno', () => {
    const problem = audienceProblem({ mode: 'turma', selected: [], overrides: { [INTERNAL]: { extraAttempts: '9', motivo: '' } } })
    expect(problem).toBe('Tentativas extras de aluno sem e-mail: use um número de 0 a 5.')
  })
})

// "Outro aparelho no meio da prova" (fase 3, P3-S13: AVA-17; D28 e P-B4).
describe('[UC-TENTATIVA-005] Outro aparelho no meio da prova', () => {
  function FormHarness({ onValue }) {
    const [value, setValue] = useState({
      entry: { label: 'Prova 1', questionCount: 2 },
      availableVersions: 1,
      onlineVersions: 1,
      durationMinutes: 30,
      waitingRoomMinutes: 0,
      timerEnabled: true,
      timerMode: 'per_attempt',
      tokenEnabled: false,
      accessToken: 'ABCDE',
      maxAttempts: '1',
      keystrokeMode: 'eventos',
      audience: initialAudience(),
    })
    return (
      <PrepareApplicationForm
        value={value}
        onChange={(next) => { setValue(next); onValue(next) }}
        candidates={{ data: CANDIDATES, loading: false, refreshing: false, error: '', refetch: () => {} }}
        tokenTools={{ normalize: (text) => text, generate: () => 'ABCDE' }}
      />
    )
  }

  it('padrão "Travar até eu liberar"; "Só avisar" muda o valor e a explicação', () => {
    const onValue = vi.fn()
    render(<FormHarness onValue={onValue} />)
    const select = screen.getByLabelText('Outro aparelho no meio da prova')
    expect(select).toHaveValue(DEFAULT_SESSION_POLICY)
    expect(DEFAULT_SESSION_POLICY).toBe('travar')
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Travar até eu liberar (recomendado)', 'Só avisar no Monitor'])
    expect(screen.getByText(/trava no aparelho novo até você liberar pelo Monitor/)).toBeVisible()
    fireEvent.change(select, { target: { value: 'avisar' } })
    expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({ sessionPolicy: 'avisar' }))
    expect(screen.getByText(/A prova continua no aparelho novo/)).toBeVisible()
    expect(sessionPolicyDescription('qualquer')).toMatch(/trava/)
  })

  it('o seletor sozinho (montagem online em Provas) lê valor desconhecido como o padrão', () => {
    render(<SessionPolicySelect value={undefined} onChange={() => {}} />)
    expect(screen.getByLabelText('Outro aparelho no meio da prova')).toHaveValue('travar')
  })
})

// "Quando" na preparação a partir do histórico (fase 3, P3-S12: AVA-20; D25).
describe('[UC-PROVA-008] Quando da aplicação', () => {
  function ScheduleHarness({ onValue, withSchedule = true }) {
    const [value, setValue] = useState({
      entry: { label: 'Prova 1', questionCount: 2 },
      availableVersions: 1,
      onlineVersions: 1,
      durationMinutes: 30,
      waitingRoomMinutes: 0,
      timerEnabled: true,
      timerMode: 'per_attempt',
      tokenEnabled: false,
      accessToken: 'ABCDE',
      maxAttempts: '1',
      keystrokeMode: 'eventos',
      audience: initialAudience(),
      ...(withSchedule ? { schedule: { mode: 'agora', date: '', opensAt: '', closesAt: '' } } : {}),
    })
    return (
      <PrepareApplicationForm
        value={value}
        onChange={(next) => { setValue(next); onValue?.(next) }}
        candidates={{ data: CANDIDATES, loading: false, refreshing: false, error: '', refetch: () => {} }}
        tokenTools={{ normalize: (text) => text, generate: () => 'ABCDE' }}
        studentClass="1DES"
        courseId="DES"
      />
    )
  }

  it('agendar na preparação guarda dia e horas no estado e consulta os avisos com a duração da prova', async () => {
    mocks.get.mockResolvedValue({ avisos: [{ code: 'janela_curta', texto: 'A janela é menor que a duração da prova.' }], janela: 'abre em 20/11 às 08:00 e fecha às 08:20' })
    const onValue = vi.fn()
    render(<ScheduleHarness onValue={onValue} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Agendar dia e horário' }))
    fireEvent.change(screen.getByLabelText('Dia'), { target: { value: '2026-11-20' } })
    fireEvent.change(screen.getByLabelText('Abre às'), { target: { value: '08:00' } })
    fireEvent.change(screen.getByLabelText('Fecha às'), { target: { value: '08:20' } })
    expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({ schedule: expect.objectContaining({ mode: 'agendar', date: '2026-11-20', opensAt: '08:00', closesAt: '08:20' }) }))
    expect(await screen.findByTestId('schedule-warnings')).toHaveTextContent('menor que a duração')
    await waitFor(() => expect(mocks.get.mock.calls.some(([url]) => url.includes('schedule-check') && url.includes('durationMinutes=30') && url.includes('studentClass=1DES'))).toBe(true))
  })

  it('sem "schedule" no estado (chamadas antigas), o "Quando" não aparece', () => {
    render(<ScheduleHarness withSchedule={false} />)
    expect(screen.queryByTestId('application-schedule')).toBeNull()
  })
})

// "Como montar" na preparação a partir do histórico (fase 3, P3-S11: AVA-16; D24).
describe('[UC-PROVA-007] Como montar na preparação', () => {
  function DrawHarness({ onValue }) {
    const [value, setValue] = useState({
      entry: { id: 'eh_9', label: 'Online #1', questionCount: 3, questionNumbers: [1, 2, 3] },
      availableVersions: 2,
      onlineVersions: 2,
      durationMinutes: 30,
      waitingRoomMinutes: 0,
      timerEnabled: true,
      timerMode: 'per_attempt',
      tokenEnabled: false,
      accessToken: 'ABCDE',
      maxAttempts: '1',
      keystrokeMode: 'eventos',
      audience: initialAudience(),
    })
    return (
      <>
        <PrepareApplicationForm
          value={value}
          onChange={(next) => { setValue(next); onValue?.(next) }}
          candidates={{ data: CANDIDATES, loading: false, refreshing: false, error: '', refetch: () => {} }}
          tokenTools={{ normalize: (text) => text, generate: () => 'ABCDE' }}
          studentClass="1DES"
          courseId="DES"
          examKey="Avaliacao_1"
        />
        <output data-testid="draw-payload">{JSON.stringify(drawPayload(value.draw))}</output>
      </>
    )
  }

  it('padrão "Versões"; o sorteio lê as questões da configuração salva e conta quantas cabem no grupo', async () => {
    mocks.get.mockResolvedValue({ questions: [
      { number: 1, origem: 'avaliacao', categoria: '', dificuldade: 'facil', tags: [] },
      { number: 2, origem: 'avaliacao', categoria: '', dificuldade: 'facil', tags: [] },
      { number: 3, origem: 'banco', categoria: 'Redes', dificuldade: 'media', tags: [] },
    ], categorias: ['Redes'], etiquetas: [] })
    render(<DrawHarness />)
    expect(screen.getByRole('radio', { name: 'Versões (máx. 4)' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('Versões online')).toHaveAttribute('max', '2')
    expect(screen.getByTestId('draw-payload')).toHaveTextContent('{}')
    expect(mocks.get).not.toHaveBeenCalledWith(expect.stringContaining('draw-pool'))

    fireEvent.click(screen.getByRole('radio', { name: 'Sorteio por aluno' }))
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining('/api/admin/exam-applications/draw-pool?')))
    const url = mocks.get.mock.calls.find(([item]) => item.includes('draw-pool'))[0]
    expect(url).toContain('historyId=eh_9')
    expect(url).toContain('examKey=Avaliacao_1')
    const group = screen.getByRole('group', { name: 'Grupo 1' })
    expect(await within(group).findByText('3 questões combinam com o filtro.')).toBeInTheDocument()
    fireEvent.change(within(group).getByLabelText('Origem'), { target: { value: 'banco' } })
    fireEvent.change(within(group).getByLabelText('Categoria do banco'), { target: { value: 'redes' } })
    expect(within(group).getByText('1 questão combina com o filtro.')).toBeInTheDocument()
    fireEvent.change(within(group).getByLabelText('Quantidade'), { target: { value: '1' } })
    expect(screen.getByTestId('draw-summary')).toHaveTextContent('Cada aluno recebe 1 de 3 questões')
    expect(JSON.parse(screen.getByTestId('draw-payload').textContent)).toEqual({ sorteio: { modo: 'por_aluno', grupos: [{ filtro: { origem: 'banco', categoria: 'redes' }, quantidade: 1 }] } })
  })

  it('as contas da tela são as do servidor: a questão que serve para dois grupos fica no primeiro', () => {
    const pool = [
      { number: 1, origem: 'avaliacao', dificuldade: 'facil', tags: ['Redes'] },
      { number: 2, origem: 'avaliacao', dificuldade: 'facil', tags: [] },
    ]
    const draw = { modo: 'por_aluno', grupos: [{ quantidade: '1', tag: 'redes' }, { quantidade: '2', dificuldade: 'facil' }] }
    expect(drawAvailability(pool, draw)).toEqual([1, 1])
    expect(drawProblem(draw, pool)).toBe('Grupo 2: pediu 2 questões fáceis, mas a montagem só tem 1 (a questão que serve para dois grupos fica no primeiro).')
    expect(drawProblem({ modo: 'por_aluno', grupos: [{ quantidade: '' }] }, null)).toBe('Grupo 1: informe quantas questões sortear (um número inteiro a partir de 1).')
    expect(drawProblem({ modo: 'versoes', grupos: [] }, pool)).toBeNull()
    expect(drawPayload({ modo: 'versoes' })).toEqual({})
    // Etiqueta que não existe: o filtro não combina com nada, sem a frase dos dois grupos.
    const missingTag = { modo: 'por_aluno', grupos: [{ quantidade: '1', dificuldade: 'facil' }, { quantidade: '1', tag: 'inexistente' }] }
    expect(drawProblem(missingTag, pool)).toBe('Grupo 2: nenhuma questão da montagem combina com o filtro (questões com a etiqueta inexistente).')
  })

  it('"Como montar" anda pelas setas do teclado e só a opção marcada entra no Tab; origem e dificuldade com 44 px', async () => {
    mocks.get.mockResolvedValue({ questions: [], categorias: [], etiquetas: [] })
    render(<DrawHarness />)
    const versions = screen.getByRole('radio', { name: 'Versões (máx. 4)' })
    const perStudent = screen.getByRole('radio', { name: 'Sorteio por aluno' })
    expect(versions).toHaveAttribute('tabindex', '0')
    expect(perStudent).toHaveAttribute('tabindex', '-1')
    versions.focus()
    fireEvent.keyDown(versions, { key: 'ArrowRight' })
    expect(perStudent).toHaveAttribute('aria-checked', 'true')
    expect(perStudent).toHaveFocus()
    expect(perStudent).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(perStudent, { key: 'ArrowDown' })
    expect(versions).toHaveAttribute('aria-checked', 'true')
    expect(versions).toHaveFocus()
    fireEvent.keyDown(versions, { key: 'End' })
    expect(perStudent).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(perStudent, { key: 'Home' })
    expect(versions).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(versions, { key: 'ArrowLeft' })
    expect(perStudent).toHaveAttribute('aria-checked', 'true')
    const group = await screen.findByRole('group', { name: 'Grupo 1' })
    // min-height vence o h-[38px] do Select (cn não mescla classes de altura).
    expect(within(group).getByLabelText('Origem').className).toContain('min-h-[44px]')
    expect(within(group).getByLabelText('Dificuldade').className).toContain('min-h-[44px]')
  })
})
