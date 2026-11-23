import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ModulosPage from './ModulosPage'
import { clearCourseContentCache } from './useCourseContent'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), released: {} }))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', name: 'Ana', studentClass: '1DES', courseId: 'DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: () => ({ data: { releasedItems: mocks.released, completedUnits: {} }, loading: false, error: null, refetch: vi.fn() }),
}))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

const courseData = {
  Apostila_DES_1: '# Unidade 1\n\nTexto da apostila.',
  Apostila_DES_2: '# Começo\n\nA rede local liga os computadores.\n\n## Endereços\n\nCada máquina da Rede tem um endereço IP. A **re**de da escola usa DHCP.',
  courses: [{ id: 'DES', structure: [{ id: 'M1', name: 'Módulo 1', units: [
    { id: '1', name: 'Introdução', apostilaKey: 'Apostila_DES_1' },
    { id: '2', name: 'Redes locais', apostilaKey: 'Apostila_DES_2' },
    { id: '3', name: 'Bloqueada', apostilaKey: 'Apostila_DES_3' },
  ] }] }],
}

function LocationProbe() {
  const location = useLocation()
  return <p data-testid="local">{`${location.pathname}${location.search}`}</p>
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/aluno/modulos" element={<><ModulosPage /><LocationProbe /></>} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  clearCourseContentCache()
  mocks.released = { Apostila_DES_1: true, Apostila_DES_2: true, Apostila_DES_3: false }
  Element.prototype.scrollIntoView = vi.fn()
  mocks.get.mockImplementation(async (url) => {
    if (url.startsWith('/api/data.js')) return `const courseData = ${JSON.stringify(courseData)};`
    if (url.startsWith('/api/student/annotations')) return { annotations: {} }
    if (url.startsWith('/api/forum')) return { comments: [] }
    return {}
  })
  mocks.post.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Módulos do aluno · sessão nas chamadas da apostila', () => {
  it('[UC-SIGILO-001] anotações e comentários da unidade vão com a sessão do aluno (sem auth: false, que dava 401)', async () => {
    renderAt('/aluno/modulos')
    fireEvent.click(await screen.findByTitle('Introdução'))
    await waitFor(() => {
      expect(mocks.get.mock.calls.some(([url]) => url.startsWith('/api/student/annotations'))).toBe(true)
      expect(mocks.get.mock.calls.some(([url]) => url.startsWith('/api/forum'))).toBe(true)
    })
    const unitCalls = mocks.get.mock.calls.filter(([url]) => url.startsWith('/api/student/annotations') || url.startsWith('/api/forum'))
    unitCalls.forEach(([url, options]) => {
      expect(options?.auth, url).not.toBe(false)
    })
  })
})

// Fase 3, C16 (P5-S2; contrato C8 do P5): a unidade tem endereço próprio. O sino, a
// Início e a Busca levam direto à apostila; ?busca= marca o termo e rola até ele.
describe('[UC-BUSCA-003] Módulos do aluno · abrir a unidade pelo endereço', () => {
  it('?unidade= abre a apostila (também com outra caixa) e conta o acesso', async () => {
    renderAt('/aluno/modulos?unidade=apostila_des_1')
    expect(await screen.findByText('Texto da apostila.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Voltar aos módulos' })).toBeInTheDocument()
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/student/track-access', expect.objectContaining({ key: 'Apostila_DES_1' })))
  })

  it('clicar na unidade muda o endereço; "Voltar aos módulos" volta à lista sem o parâmetro', async () => {
    renderAt('/aluno/modulos')
    fireEvent.click(await screen.findByTitle('Redes locais'))
    expect(await screen.findByText('A rede local liga os computadores.')).toBeInTheDocument()
    expect(screen.getByTestId('local')).toHaveTextContent('/aluno/modulos?unidade=Apostila_DES_2')
    fireEvent.click(screen.getByRole('button', { name: 'Voltar aos módulos' }))
    expect(await screen.findByTitle('Introdução')).toBeInTheDocument()
    expect(screen.getByTestId('local').textContent).toBe('/aluno/modulos')
  })

  it('unidade bloqueada ou que não existe: aviso e a lista, sem abrir nada', async () => {
    renderAt('/aluno/modulos?unidade=Apostila_DES_3')
    expect(await screen.findByRole('alert')).toHaveTextContent('A unidade do link não está liberada para a sua turma')
    expect(screen.getByTitle('Introdução')).toBeInTheDocument()
    expect(mocks.get.mock.calls.some(([url]) => url.includes('Apostila_DES_3'))).toBe(false)
    cleanup()
    renderAt('/aluno/modulos?unidade=Apostila_NAO_EXISTE')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('?busca= marca o termo sem acento no texto (palavra quebrada pelo negrito também) e rola até o primeiro trecho da seção', async () => {
    renderAt('/aluno/modulos?unidade=Apostila_DES_2&busca=rede&secao=2')
    expect(await screen.findByText(/Destacando “rede” nesta unidade/)).toBeInTheDocument()
    const article = document.querySelector('article')
    const marks = [...article.querySelectorAll('mark.busca-marca')]
    expect(marks.map((mark) => mark.textContent)).toEqual(['rede', 'Rede', 're', 'de'])
    // Seção 2 (Endereços): o primeiro trecho dela é "Rede", não o "rede" da seção 1.
    const current = article.querySelector('mark.busca-marca-atual')
    expect(current.textContent).toBe('Rede')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    expect(Element.prototype.scrollIntoView.mock.contexts[0]).toBe(current)
    // As anotações continuam contando os mesmos parágrafos.
    expect(article.textContent).toContain('A rede da escola usa DHCP.')

    fireEvent.click(screen.getByRole('button', { name: 'Tirar destaque' }))
    await waitFor(() => expect(article.querySelectorAll('mark').length).toBe(0))
    expect(screen.getByTestId('local')).toHaveTextContent('/aluno/modulos?unidade=Apostila_DES_2')
    expect(screen.getByTestId('local').textContent).not.toContain('busca=')
    expect(article.textContent).toContain('A rede da escola usa DHCP.')
  })

  it('termo que não está no texto: avisa e não marca nada', async () => {
    renderAt('/aluno/modulos?unidade=Apostila_DES_1&busca=roteador')
    expect(await screen.findByText('“roteador” não aparece no texto desta unidade.')).toBeInTheDocument()
    expect(document.querySelectorAll('article mark').length).toBe(0)
  })

  it('o leitor usa o data.js guardado: abrir de novo pelo endereço não baixa as apostilas outra vez', async () => {
    const view = renderAt('/aluno/modulos?unidade=Apostila_DES_1')
    expect(await screen.findByText('Texto da apostila.')).toBeInTheDocument()
    view.unmount()
    renderAt('/aluno/modulos?unidade=Apostila_DES_2')
    expect(await screen.findByText('A rede local liga os computadores.')).toBeInTheDocument()
    await act(async () => {})
    expect(mocks.get.mock.calls.filter(([url]) => url.startsWith('/api/data.js'))).toHaveLength(1)
  })
})
