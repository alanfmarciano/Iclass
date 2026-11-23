import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 3, C15 / P5-S6b (CRIT-08, D19 a D22 do P5): "Ver como aluno" abre o diálogo com o
// grupo opcional e o aviso de que nada é gravado; abrir pede a sessão de leitura e leva
// ao portal na mesma aba, guardando de onde veio.
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), startPreview: vi.fn(), auth: null }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth, startPreview: mocks.startPreview }) }))

import { PreviewButton, canPreviewAsStudent } from './PreviewLauncher'

const PROFESSOR = { role: 'admin', accountRole: 'professor', effectivePermissions: ['page.materials', 'page.classes', 'page.students'], readOnly: false }
const RESPONSE = { success: true, previewToken: 'tok', expiraEm: Date.now() + 3600000, rotulo: 'Pré-visualização como aluno de 1DES', aluno: { email: 'previa-x@previa.invalid', classes: [{ name: '1DES', courseId: 'redes' }] } }

function renderButton() {
  return render(
    <MemoryRouter initialEntries={['/turmas?curso=redes']}>
      <Routes>
        <Route path="/turmas" element={<PreviewButton courseId="redes" studentClass="1DES" courseName="Redes" />} />
        <Route path="/aluno" element={<p>Portal do aluno</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mocks.auth = { ...PROFESSOR }
  mocks.get.mockResolvedValue({
    success: true,
    grupos: [
      { id: 'grp_1', nome: 'Laboratório A', conjunto: 'Laboratório', arquivado: false },
      { id: 'grp_2', nome: 'Laboratório B', conjunto: 'Laboratório', arquivado: true },
    ],
  })
  mocks.post.mockResolvedValue(RESPONSE)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('[UC-PREVIA-004] Ver como aluno no painel', () => {
  it('só aparece para quem tem o conteúdo das turmas e não é só consulta', () => {
    expect(canPreviewAsStudent(PROFESSOR)).toBe(true)
    expect(canPreviewAsStudent({ ...PROFESSOR, readOnly: true })).toBe(false)
    expect(canPreviewAsStudent({ ...PROFESSOR, effectivePermissions: ['page.classes', 'page.students'] })).toBe(false)
    expect(canPreviewAsStudent({ role: 'student' })).toBe(false)
    mocks.auth = { ...PROFESSOR, readOnly: true }
    renderButton()
    expect(screen.queryByRole('button', { name: /Ver como aluno/ })).not.toBeInTheDocument()
  })

  it('o diálogo mostra o aviso e só os grupos ativos; abrir manda o grupo e leva ao portal guardando a origem', async () => {
    renderButton()
    fireEvent.click(screen.getByRole('button', { name: 'Ver como aluno da turma 1DES' }))
    expect(screen.getByRole('dialog', { name: 'Ver o portal como um aluno de 1DES' })).toBeInTheDocument()
    expect(screen.getByText('Nada do que você fizer na pré-visualização é gravado. A prova não começa.')).toBeInTheDocument()
    const select = await screen.findByLabelText('Ver como membro de um grupo (opcional)')
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/class-groups?courseId=redes&studentClass=1DES')
    expect([...select.options].map((option) => option.textContent)).toEqual(['Nenhum grupo: só a turma', 'Laboratório · Laboratório A'])
    fireEvent.change(select, { target: { value: 'grp_1' } })
    fireEvent.click(screen.getByRole('button', { name: /Abrir pré-visualização/ }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/preview-sessions', { courseId: 'redes', studentClass: '1DES', groupId: 'grp_1' }))
    expect(mocks.startPreview).toHaveBeenCalledWith(RESPONSE, { origem: '/turmas?curso=redes' })
    expect(await screen.findByText('Portal do aluno')).toBeInTheDocument()
  })

  it('sem a tela de grupos, abre só pela turma (groupId null); a recusa do servidor aparece no diálogo', async () => {
    mocks.auth = { ...PROFESSOR, effectivePermissions: ['page.materials'] }
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('Turma não encontrada.'), { status: 404 }))
    renderButton()
    fireEvent.click(screen.getByRole('button', { name: /Ver como aluno/ }))
    expect(mocks.get).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Abrir pré-visualização/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Turma não encontrada.')
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/preview-sessions', { courseId: 'redes', studentClass: '1DES', groupId: null })
    expect(mocks.startPreview).not.toHaveBeenCalled()
    expect(screen.queryByText('Portal do aluno')).not.toBeInTheDocument()
  })
})
