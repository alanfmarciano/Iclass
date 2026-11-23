import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BuscaPage, { SEARCH_DEBOUNCE_MS } from './BuscaPage'
import { clearCourseContentCache } from './useCourseContent'
import { SEARCH_RESULT_LIMIT, apostilaEntries, runSearch } from './busca/searchIndex'

// Fase 3, C16 (P5-S2; CRIT-07, D24 do P5): busca do aluno no aparelho, nas apostilas
// liberadas (por seção), na Biblioteca e nos avisos da turma.
const mocks = vi.hoisted(() => ({ get: vi.fn(), released: {}, library: [], announcements: [], urls: [] }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: vi.fn() } }))
vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', name: 'Ana', studentClass: '1DES', courseId: 'DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (url) => {
    mocks.urls.push(url)
    const text = String(url || '')
    const data = text.startsWith('/api/status') ? { releasedItems: mocks.released }
      : text.startsWith('/api/student/library') ? mocks.library
        : text.startsWith('/api/student/announcements') ? mocks.announcements
          : null
    return { data, loading: false, error: null, refetch: vi.fn() }
  },
}))

const APOSTILA_1 = [
  '# Introdução às redes',
  '',
  'Uma rede liga computadores.',
  '',
  '## Protocolos',
  '',
  'O protocolo TCP garante a entrega. A configuração do roteador vem depois.',
  '',
  '## Segurança',
  '',
  'Texto com <img src=x onerror="window.__xss=1"> e a palavra firewall.',
].join('\n')

function courseData(extra = {}) {
  return {
    Apostila_DES_1: APOSTILA_1,
    // No data.js por engano (ou guardado antes do bloqueio): a liberação de agora manda.
    Apostila_DES_3: '# Bloqueada\n\nConteúdo secreto sobre TCP.',
    courses: [{ id: 'DES', structure: [{ id: 'M1', name: 'Módulo 1', units: [
      { id: '1', name: 'Redes de computadores', apostilaKey: 'Apostila_DES_1' },
      { id: '2', name: 'Sistemas operacionais', apostilaKey: 'Apostila_DES_2' },
      { id: '3', name: 'Unidade bloqueada', apostilaKey: 'Apostila_DES_3' },
    ] }] }],
    ...extra,
  }
}

function LocationProbe() {
  const location = useLocation()
  return <p data-testid="local">{`${location.pathname}${location.search}`}</p>
}

function renderSearch(initial = '/aluno/busca') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/aluno/busca" element={<><BuscaPage /><LocationProbe /></>} />
        <Route path="/aluno/modulos" element={<LocationProbe />} />
        <Route path="/aluno/biblioteca" element={<LocationProbe />} />
        <Route path="/aluno/avisos" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

async function typeTerm(value) {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value } })
  await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10) })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  clearCourseContentCache()
  mocks.urls = []
  mocks.released = { Apostila_DES_1: true, Apostila_DES_2: true, Apostila_DES_3: false }
  mocks.library = [{ id: 'lib1', name: 'Guia do roteador', description: 'Passo a passo da configuração.', tags: ['rede'], materia: 'Módulo 1' }]
  mocks.announcements = [{ id: 'av1', title: 'Prova de redes', message: 'A prova sobre TCP será na sexta.', authorName: 'Prof. Rui' }]
  mocks.get.mockImplementation(async (url) => {
    if (url.startsWith('/api/data.js')) return `const courseData = ${JSON.stringify(courseData())};`
    return {}
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
  delete window.__xss
})

describe('[UC-BUSCA-003] Busca do aluno', () => {
  it('acha a palavra sem acento nas apostilas (com a seção), na Biblioteca e nos avisos, com o termo marcado', async () => {
    renderSearch()
    await act(async () => {})
    await typeTerm('tcp')
    const apostilas = screen.getByRole('region', { name: 'Apostilas' })
    const result = within(apostilas).getByRole('link', { name: /Redes de computadores/ })
    expect(result).toHaveTextContent('Módulo 1 · Protocolos')
    expect(within(result).getByText('TCP', { selector: 'mark' })).toBeInTheDocument()
    const avisos = screen.getByRole('region', { name: 'Avisos' })
    expect(within(avisos).getByRole('link', { name: /Prova de redes/ })).toHaveAttribute('href', '/aluno/avisos?aviso=av1')
    expect(screen.queryByRole('region', { name: 'Biblioteca' })).not.toBeInTheDocument()

    await typeTerm('configuracao')
    const biblioteca = screen.getByRole('region', { name: 'Biblioteca' })
    const material = within(biblioteca).getByRole('link', { name: /Guia do roteador/ })
    expect(material).toHaveAttribute('href', '/aluno/biblioteca?material=lib1')
    expect(within(material).getByText('configuração', { selector: 'mark' })).toBeInTheDocument()
    // O termo fica no endereço (voltar do leitor devolve a mesma busca).
    expect(screen.getByTestId('local')).toHaveTextContent('/aluno/busca?q=configuracao')
  })

  it('apostila bloqueada ou fora do data.js nunca aparece, mesmo com a palavra', async () => {
    renderSearch()
    await act(async () => {})
    await typeTerm('secreto')
    expect(screen.getByText('Nenhum resultado para “secreto”.')).toBeInTheDocument()
    expect(screen.getByText('Tente outra palavra.')).toBeInTheDocument()
    await typeTerm('sistemas operacionais')
    // A unidade 2 está liberada, mas o texto dela não veio no data.js: não há o que achar.
    expect(screen.queryByRole('region', { name: 'Apostilas' })).not.toBeInTheDocument()
  })

  it('o HTML digitado na apostila aparece como texto no trecho (nada roda)', async () => {
    renderSearch()
    await act(async () => {})
    await typeTerm('firewall')
    const result = within(screen.getByRole('region', { name: 'Apostilas' })).getByRole('link')
    expect(result.querySelector('img')).toBeNull()
    expect(window.__xss).toBeUndefined()
    expect(result).toHaveTextContent('Segurança')
    expect(within(result).getByText('firewall', { selector: 'mark' })).toBeInTheDocument()
  })

  it('o clique leva ao leitor na unidade, com o termo e a seção (/aluno/modulos?unidade=&busca=&secao=)', async () => {
    renderSearch()
    await act(async () => {})
    await typeTerm('roteador')
    const result = within(screen.getByRole('region', { name: 'Apostilas' })).getByRole('link')
    expect(result).toHaveAttribute('href', '/aluno/modulos?unidade=Apostila_DES_1&busca=roteador&secao=2')
    fireEvent.click(result)
    expect(screen.getByTestId('local')).toHaveTextContent('/aluno/modulos?unidade=Apostila_DES_1&busca=roteador&secao=2')
  })

  it('abre com o termo do endereço e pede pelo menos 2 letras', async () => {
    renderSearch('/aluno/busca?q=protocolo')
    await act(async () => {})
    expect(screen.getByRole('searchbox', { name: 'Buscar' })).toHaveValue('protocolo')
    expect(within(screen.getByRole('region', { name: 'Apostilas' })).getByRole('link')).toHaveTextContent('Protocolos')
    await typeTerm('a')
    expect(screen.getByText('Digite pelo menos 2 letras.')).toBeInTheDocument()
  })

  it('o data.js é baixado uma vez por turma: voltar à busca não baixa as apostilas de novo', async () => {
    // data.js que bate com a liberação (o da turma de verdade).
    mocks.released = { Apostila_DES_1: true, Apostila_DES_2: false, Apostila_DES_3: false }
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/data.js')) return `const courseData = ${JSON.stringify(courseData({ Apostila_DES_3: undefined }))};`
      return {}
    })
    const view = renderSearch('/aluno/busca?q=tcp')
    await act(async () => {})
    view.unmount()
    renderSearch('/aluno/busca?q=rede')
    await act(async () => {})
    expect(screen.getByRole('region', { name: 'Apostilas' })).toBeInTheDocument()
    expect(mocks.get.mock.calls.filter(([url]) => url.startsWith('/api/data.js'))).toHaveLength(1)
  })

  it('a liberação mudou (o professor liberou ou bloqueou): o data.js vem de novo, uma vez', async () => {
    mocks.released = { Apostila_DES_1: true, Apostila_DES_2: false, Apostila_DES_3: false }
    let served = courseData({ Apostila_DES_3: undefined })
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/data.js')) return `const courseData = ${JSON.stringify(served)};`
      return {}
    })
    const view = renderSearch('/aluno/busca?q=kernel')
    await act(async () => {})
    expect(screen.getByText('Nenhum resultado para “kernel”.')).toBeInTheDocument()
    view.unmount()
    // O professor liberou a unidade 2.
    mocks.released = { Apostila_DES_1: true, Apostila_DES_2: true, Apostila_DES_3: false }
    served = { ...served, Apostila_DES_2: '# Processos\n\nO kernel escalona os processos.' }
    renderSearch('/aluno/busca?q=kernel')
    await act(async () => {})
    await act(async () => {})
    expect(within(screen.getByRole('region', { name: 'Apostilas' })).getByRole('link')).toHaveTextContent('Sistemas operacionais')
    expect(mocks.get.mock.calls.filter(([url]) => url.startsWith('/api/data.js'))).toHaveLength(2)
  })
})

describe('[UC-BUSCA-003] índice da busca', () => {
  it('no máximo 50 resultados, com lugar para a Biblioteca e os avisos', () => {
    const units = Array.from({ length: 30 }, (_, index) => ({ id: String(index), name: `Unidade ${index}`, apostilaKey: `Apostila_X_${index}` }))
    const data = { courses: [{ id: 'X', structure: [{ id: 'M', name: 'M', units }] }] }
    units.forEach((unit) => { data[unit.apostilaKey] = '# A\n\nrede\n\n# B\n\nrede\n\n# C\n\nrede' })
    const index = {
      apostilas: apostilaEntries(data),
      biblioteca: Array.from({ length: 20 }, (_, i) => ({ kind: 'biblioteca', id: `b${i}`, title: 'rede', materia: '', tags: [], text: '' })),
      avisos: Array.from({ length: 3 }, (_, i) => ({ kind: 'aviso', id: `a${i}`, title: 'rede', text: '' })),
    }
    const result = runSearch(index, 'rede')
    expect(result.total).toBe(90 + 20 + 3)
    expect(result.shown).toBe(SEARCH_RESULT_LIMIT)
    expect(result.avisos).toHaveLength(3)
    expect(result.biblioteca.length).toBeGreaterThanOrEqual(10)
    expect(result.apostilas.length + result.biblioteca.length + result.avisos.length).toBe(SEARCH_RESULT_LIMIT)
  })
})
