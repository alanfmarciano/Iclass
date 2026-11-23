import { useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistenteHorariosWizard, DisciplinasModal, GradeEditor, courseModuleOptions, readCargaHoraria } from './TurmaPresencaConfig'

afterEach(cleanup)

function GradeHarness() {
  const [config, setConfig] = useState({ toleranciaMin: 10, limiarRiscoPct: 75, grade: {} })
  return <GradeEditor config={config} disciplinas={[{ id: 'MAT', nome: 'Matemática' }, { id: 'HIS', nome: 'História' }]} onChange={setConfig} />
}

describe('configuração de presença da turma', () => {
  it('[UC-PRESENCA-001] adiciona aula à grade e mantém horário e disciplina acessíveis', async () => {
    const user = userEvent.setup()
    render(<GradeHarness />)

    await user.click(screen.getAllByRole('button', { name: 'Adicionar aula' })[0])
    const inicio = screen.getByLabelText('Início da 1ª aula de Segunda')
    const disciplina = screen.getByLabelText('Disciplina da 1ª aula de Segunda')
    await user.type(inicio, '08:00')
    await user.selectOptions(disciplina, 'HIS')

    expect(inicio).toHaveValue('08:00')
    expect(disciplina).toHaveValue('HIS')
    expect(screen.getByText('1 aula(s)')).toBeVisible()
  })

  it('[UC-PRESENCA-001] cadastra uma nova disciplina no curso', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<DisciplinasModal open onClose={() => {}} course={{ name: 'Curso', disciplinas: [] }} onSave={onSave} saving={false} />)

    await user.click(screen.getByRole('button', { name: 'Adicionar disciplina' }))
    await user.type(screen.getByLabelText('Nome da disciplina'), 'Matemática')
    await user.clear(screen.getByLabelText('Código da disciplina'))
    await user.type(screen.getByLabelText('Código da disciplina'), 'MAT')
    await user.click(screen.getByRole('button', { name: 'Salvar disciplinas' }))

    // Desde o B8 a lista vai com os campos novos sempre preenchidos (vazio apaga no servidor).
    expect(onSave).toHaveBeenCalledWith([{ id: 'MAT', nome: 'Matemática', cor: '', cargaHoraria: null, professor: '', modulos: [] }])
  })
})

// Disciplinas com carga horária, professor e módulos (B8 / P2-S8, FUN-05). Antes o diálogo
// só tinha nome e código, e o código repetido não dizia nada (o botão não fazia nada).
describe('disciplinas do curso: carga horária, professor e módulos', () => {
  const course = {
    id: 'TI',
    name: 'Informática',
    structure: [{ id: 'M1', name: 'Redes' }, { id: 'M2', name: 'Banco de Dados' }, { name: 'Projeto' }],
    disciplinas: [
      { id: 'REDES', nome: 'Redes', cor: '#112233', cargaHoraria: 80, professor: 'Prof. Carlos', modulos: ['M1', 'M_ANTIGO'] },
      { id: 'BD', nome: 'Banco de Dados', cor: '' },
    ],
  }

  it('[UC-CURSO-002] mostra o que está gravado, trava o módulo de outra disciplina e manda tudo de volta', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<DisciplinasModal open onClose={() => {}} course={course} onSave={onSave} saving={false} />)

    expect(screen.getByLabelText('Carga horária de Redes (horas)')).toHaveValue('80')
    expect(screen.getByLabelText('Professor responsável por Redes')).toHaveValue('Prof. Carlos')
    const redesModules = screen.getByRole('group', { name: 'Módulos de Redes' })
    expect(within(redesModules).getByRole('checkbox', { name: 'Redes' })).toBeChecked()
    // O módulo que saiu da estrutura continua marcado (o servidor aceita) e avisa.
    expect(within(redesModules).getByRole('checkbox', { name: /M_ANTIGO \(não está mais na estrutura do curso\)/ })).toBeChecked()
    // Na outra disciplina, o módulo de Redes aparece travado com o nome dela.
    const bdModules = screen.getByRole('group', { name: 'Módulos de Banco de Dados' })
    expect(within(bdModules).getByRole('checkbox', { name: 'Redes (em Redes)' })).toBeDisabled()
    // Módulo sem id: o servidor usa o nome como id.
    await user.click(within(bdModules).getByRole('checkbox', { name: 'Banco de Dados' }))
    await user.click(within(bdModules).getByRole('checkbox', { name: 'Projeto' }))
    await user.type(screen.getByLabelText('Carga horária de Banco de Dados (horas)'), '60')
    await user.type(screen.getByLabelText('Professor responsável por Banco de Dados'), '  Profa. Bia ')
    // Limpar a carga de Redes apaga o valor.
    await user.clear(screen.getByLabelText('Carga horária de Redes (horas)'))
    await user.click(screen.getByRole('button', { name: 'Salvar disciplinas' }))

    expect(onSave).toHaveBeenCalledWith([
      { id: 'REDES', nome: 'Redes', cor: '#112233', cargaHoraria: null, professor: 'Prof. Carlos', modulos: ['M1', 'M_ANTIGO'] },
      { id: 'BD', nome: 'Banco de Dados', cor: '', cargaHoraria: 60, professor: 'Profa. Bia', modulos: ['M2', 'Projeto'] },
    ])
  })

  it('[UC-CURSO-002] carga horária que não é número e código repetido são avisados no campo, sem salvar', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<DisciplinasModal open onClose={() => {}} course={course} onSave={onSave} saving={false} />)
    const carga = screen.getByLabelText('Carga horária de Redes (horas)')
    await user.clear(carga)
    await user.type(carga, '80h')
    const codes = screen.getAllByLabelText('Código da disciplina')
    await user.clear(codes[1])
    await user.type(codes[1], 'REDES')
    await user.click(screen.getByRole('button', { name: 'Salvar disciplinas' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/Carga horária em horas: um número inteiro de 0 a 2000/)).toBeVisible()
    expect(screen.getByText('O código REDES já está na disciplina Redes. Cada disciplina tem um código.')).toBeVisible()
    expect(carga).toHaveAttribute('aria-invalid', 'true')
  })

  it('[UC-CURSO-002] courseModuleOptions e readCargaHoraria seguem o servidor', () => {
    expect(courseModuleOptions([{ id: 'M1', name: 'Redes' }, { key: 'K', title: 'Título' }, { name: 'Só nome' }, {}, null]))
      .toEqual([{ id: 'M1', nome: 'Redes' }, { id: 'K', nome: 'Título' }, { id: 'Só nome', nome: 'Só nome' }, { id: 'module_3', nome: 'module_3' }])
    expect(readCargaHoraria('')).toBe('')
    expect(readCargaHoraria(' 40 ')).toBe(40)
    expect(readCargaHoraria('2001')).toBeNull()
    expect(readCargaHoraria('4,5')).toBeNull()
  })
})

describe('assistente de horários', () => {
  const course = { name: 'Curso', disciplinas: [{ id: 'MAT', nome: 'Matemática', cor: '#0091ff' }, { id: 'HIS', nome: 'História', cor: '#e5484d' }] }

  it('monta a grade com horários calculados e intervalo individual, gerando o attendanceConfig esperado', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(true)
    render(<AssistenteHorariosWizard onCancel={() => {}} course={course} turma={{ name: '1DES', period: 'Manhã', attendanceConfig: null }} onSave={onSave} saving={false} />)

    // Passo 1: matérias já vêm selecionadas
    expect(screen.getByText('2 de 2 matérias selecionadas.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Continuar' }))

    // Passo 2: padrão (07:00, 55 min, 4 aulas, recreio de 20 min no meio) → termina 11:00.
    expect(await screen.findByText(/11:00/)).toBeVisible()
    // Ajusta o intervalo entre a 1ª e a 2ª aula para 10 min → empurra o dia em 10 min (11:10).
    const gap12 = screen.getByLabelText('Intervalo entre a 1ª e a 2ª aula')
    await user.clear(gap12)
    await user.type(gap12, '10')
    expect(await screen.findByText(/11:10/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Continuar' }))

    // Passo 3: preencher a 1ª aula (07:00) com Matemática em todos os dias marcados.
    const bulkFirst = screen.getByLabelText('Matéria da 1ª aula para todos os dias')
    await user.selectOptions(bulkFirst, 'MAT')
    await user.click(screen.getByRole('button', { name: 'Aplicar aos dias marcados' }))
    await user.click(screen.getByRole('button', { name: 'Continuar' }))

    // Passo 4: revisão + salvar
    expect(screen.getByText('aulas por semana')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Salvar grade horária' }))

    expect(onSave).toHaveBeenCalledTimes(1)
    const { attendanceConfig, newDisciplinas } = onSave.mock.calls[0][0]
    expect(newDisciplinas).toEqual([])
    expect(attendanceConfig.toleranciaMin).toBe(10)
    // 5 dias letivos por padrão (seg..sex → chaves 1..5), sábado/domingo fora.
    expect(Object.keys(attendanceConfig.grade).sort()).toEqual(['1', '2', '3', '4', '5'])
    const seg = attendanceConfig.grade['1']
    expect(seg).toHaveLength(4)
    // Intervalos [10, 20, 0] a partir das 07:00 com aulas de 55 min: 07:00, 08:05, 09:20, 10:15.
    expect(seg.map(a => a.inicio)).toEqual(['07:00', '08:05', '09:20', '10:15'])
    expect(seg[0]).toMatchObject({ ordem: 1, inicio: '07:00', disciplinaId: 'MAT' })
    expect(seg[1].disciplinaId).toBe('')
  })

  it('cria matéria nova pelo assistente e a inclui em newDisciplinas ao salvar', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(true)
    render(<AssistenteHorariosWizard onCancel={() => {}} course={course} turma={{ name: '1DES', period: 'Manhã', attendanceConfig: null }} onSave={onSave} saving={false} />)

    await user.type(screen.getByLabelText('Nova matéria'), 'Educação Física')
    await user.click(screen.getByRole('button', { name: 'Adicionar' }))
    expect(await screen.findByText('3 de 3 matérias selecionadas.')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Continuar' })) // → passo 2
    await user.click(screen.getByRole('button', { name: 'Continuar' })) // → passo 3
    await user.click(screen.getByRole('button', { name: 'Continuar' })) // → passo 4
    await user.click(screen.getByRole('button', { name: 'Salvar grade horária' }))

    const { newDisciplinas } = onSave.mock.calls[0][0]
    expect(newDisciplinas).toEqual([{ id: 'EDUCACAOFISICA', nome: 'Educação Física', cor: '#e5484d' }])
  })

  it('copia a grade de outra turma do mesmo curso ao selecionar no passo 1', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(true)
    const outraTurma = {
      courseId: 'DES', name: '2DES',
      attendanceConfig: { grade: { '3': [{ ordem: 1, inicio: '13:00', disciplinaId: 'HIS' }] } },
    }
    render(<AssistenteHorariosWizard onCancel={() => {}} course={{ ...course, id: 'DES' }} turma={{ name: '1DES', period: 'Manhã', attendanceConfig: null }} allClasses={[outraTurma]} professors={[]} onSave={onSave} saving={false} />)

    await user.selectOptions(screen.getByLabelText('Copiar grade de outra turma'), '2DES')
    // Avança até salvar; a grade copiada deve produzir só quarta (chave '3') às 13:00 com História.
    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 2
    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 3
    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 4
    await user.click(screen.getByRole('button', { name: 'Salvar grade horária' }))

    const { attendanceConfig } = onSave.mock.calls[0][0]
    expect(Object.keys(attendanceConfig.grade)).toEqual(['3'])
    expect(attendanceConfig.grade['3'][0]).toMatchObject({ inicio: '13:00', disciplinaId: 'HIS' })
  })

  it('copia a grade de um dia para outro no passo 3', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(true)
    render(<AssistenteHorariosWizard onCancel={() => {}} course={course} turma={{ name: '1DES', period: 'Manhã', attendanceConfig: null }} onSave={onSave} saving={false} />)

    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 2
    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 3

    // Define a 1ª aula de Segunda e copia o dia inteiro para Terça.
    await user.selectOptions(screen.getByLabelText('1ª aula de Segunda'), 'MAT')
    await user.click(screen.getByLabelText('Copiar grade de Segunda'))
    await user.click(await screen.findByRole('checkbox', { name: 'Terça' }))
    await user.click(screen.getByRole('button', { name: 'Copiar' }))

    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 4
    await user.click(screen.getByRole('button', { name: 'Salvar grade horária' }))

    const { attendanceConfig } = onSave.mock.calls[0][0]
    // Terça (chave '2') recebeu a 1ª aula de Segunda (chave '1').
    expect(attendanceConfig.grade['1'][0].disciplinaId).toBe('MAT')
    expect(attendanceConfig.grade['2'][0].disciplinaId).toBe('MAT')
  })

  it('salva um modelo reutilizável quando marcado e nomeado', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(true)
    render(<AssistenteHorariosWizard onCancel={() => {}} course={course} turma={{ name: '1DES', period: 'Manhã', attendanceConfig: null }} onSave={onSave} saving={false} />)

    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 2
    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 3
    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 4
    await user.click(screen.getByRole('checkbox', { name: /Salvar como modelo reutilizável/ }))
    await user.type(screen.getByLabelText('Nome do modelo'), 'Manhã padrão')
    await user.click(screen.getByRole('button', { name: 'Salvar grade horária' }))

    const { template } = onSave.mock.calls[0][0]
    expect(template).toMatchObject({ id: 'MANHAPADRAO', nome: 'Manhã padrão' })
    expect(template.rhythm.count).toBe(4)
  })

  it('avisa sobre conflito de professor no passo de revisão', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(true)
    const professors = [{ name: 'Ana', email: 'ana@x.com', assignedClasses: [{ courseId: 'DES', className: '1DES' }, { courseId: 'DES', className: '2DES' }] }]
    const allClasses = [{ courseId: 'DES', name: '2DES', attendanceConfig: { grade: { '1': [{ ordem: 1, inicio: '07:00', disciplinaId: 'HIS' }] } } }]
    render(<AssistenteHorariosWizard onCancel={() => {}} course={{ ...course, id: 'DES' }} turma={{ name: '1DES', period: 'Manhã', attendanceConfig: null }} allClasses={allClasses} professors={professors} onSave={onSave} saving={false} />)

    // A 1ª aula padrão começa 07:00 seg → conflita com a 2DES da Ana.
    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 2
    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 3
    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 4

    expect(await screen.findByText('Possível conflito de horário')).toBeVisible()
    expect(screen.getByText(/já tem aula na turma/)).toBeVisible()
  })

  it('pré-carrega a grade existente ao editar (dias, contagem e disciplinas)', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(true)
    const attendanceConfig = {
      toleranciaMin: 15, limiarRiscoPct: 80,
      grade: {
        '2': [{ ordem: 1, inicio: '08:00', disciplinaId: 'MAT' }, { ordem: 2, inicio: '09:00', disciplinaId: 'HIS' }],
      },
    }
    render(<AssistenteHorariosWizard onCancel={() => {}} course={course} turma={{ name: '1DES', period: 'Manhã', attendanceConfig }} onSave={onSave} saving={false} />)

    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 2
    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 3
    await user.click(screen.getByRole('button', { name: 'Continuar' })) // passo 4
    await user.click(screen.getByRole('button', { name: 'Salvar grade horária' }))

    const { attendanceConfig: out } = onSave.mock.calls[0][0]
    expect(out.toleranciaMin).toBe(15)
    expect(out.limiarRiscoPct).toBe(80)
    // Só terça estava marcada → só a chave '2' é salva, com 2 aulas.
    expect(Object.keys(out.grade)).toEqual(['2'])
    expect(out.grade['2'].map(a => a.disciplinaId)).toEqual(['MAT', 'HIS'])
    expect(out.grade['2'].map(a => a.inicio)).toEqual(['08:00', '09:00'])
  })
})
