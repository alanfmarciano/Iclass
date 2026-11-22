import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RiskList } from './RiskList'
import { studentRouteKey } from '../../../lib/studentProfile'

afterEach(cleanup)

// C1 / P4-S3: o Dashboard abre a ficha pelo id estável do aluno (/alunos/alu_...), não
// pelo e-mail; o aluno sem e-mail não deixa o endereço interno na barra do navegador.
describe('[UC-IDENT-003] RiskList · abrir a ficha do aluno', () => {
  it('entrega o aluno inteiro ao onOpen, e a rota sai pelo id', () => {
    const student = { id: 'alu_00000000000000f2', email: 'aluno-alu_00000000000000f2@sem-email.invalid', name: 'Bruno Sem Email', riscoLevel: 'alto', media: null, faltas: 0 }
    const onOpen = vi.fn()
    render(<RiskList students={[student]} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /Bruno Sem Email/ }))
    expect(onOpen).toHaveBeenCalledWith(student)
    expect('/alunos/' + studentRouteKey(onOpen.mock.calls[0][0])).toBe('/alunos/alu_00000000000000f2')
    expect(document.body.textContent).not.toMatch(/sem-email\.invalid/)
  })

  it('sem id (resposta de antes da atualização), cai no e-mail codificado, que a ficha troca pelo id', () => {
    expect(studentRouteKey({ email: 'ana@teste.local' })).toBe('ana%40teste.local')
  })
})
