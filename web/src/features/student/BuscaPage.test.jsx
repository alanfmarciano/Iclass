import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BuscaPage, { SEARCH_DEBOUNCE_MS, STATUS_POLL_MS } from './BuscaPage'
import { CONTENT_MAX_AGE_MS, clearCourseContentCache } from './useCourseContent'
import { SEARCH_RESULT_LIMIT, apostilaEntries, buildApostilaIndex, peekApostilaIndex, runSearch } from './busca/searchIndex'

// Fase 3, C16 (P5-S2; CRIT-07, D24 do P5): busca do aluno no aparelho, nas apostilas
// liberadas (por seção), na Biblioteca e nos avisos da turma.
const mocks = vi.hoisted(() => ({ get: vi.fn(), released: {}, library: [], announcements: [], notebook: null, urls: [], options: {} }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: vi.fn() } }))
vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', name: 'Ana', studentClass: '1DES', courseId: 'DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (url, deps, options) => {
    mocks.urls.push(url)
    if (url) mocks.options[String(url).split('?')[0]] = options
    const text = String(url || '')
    const data = text.startsWith('/api/status') ? { releasedItems: mocks.released }
      : text.startsWith('/api/student/library') ? mocks.library
        : text.startsWith('/api/student/announcements') ? mocks.announcements
          : text.startsWith('/api/student/notebook') ? mocks.notebook
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
        <Route path="/aluno/caderno" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

// Espera o data.js, o índice (montado aos poucos, com setTimeout) e a espera entre teclas.
async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(20) })
}

async function typeTerm(value) {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value } })
  await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10) })
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  clearCourseContentCache()
  mocks.urls = []
  mocks.released = { Apostila_DES_1: true, Apostila_DES_2: true, Apostila_DES_3: false }
  mocks.library = [{ id: 'lib1', name: 'Guia do roteador', description: 'Passo a passo da configuração.', tags: ['rede'], materia: 'Módulo 1' }]
  mocks.announcements = [{ id: 'av1', title: 'Prova de redes', message: 'A prova sobre TCP será na sexta.', authorName: 'Prof. Rui' }]
  mocks.notebook = null
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
    await settle()
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
    await settle()
    await typeTerm('secreto')
    expect(screen.getByText('Nenhum resultado para “secreto”.')).toBeInTheDocument()
    expect(screen.getByText('Tente outra palavra.')).toBeInTheDocument()
    await typeTerm('sistemas operacionais')
    // A unidade 2 está liberada, mas o texto dela não veio no data.js: não há o que achar.
    expect(screen.queryByRole('region', { name: 'Apostilas' })).not.toBeInTheDocument()
  })

  it('o HTML digitado na apostila aparece como texto no trecho (nada roda)', async () => {
    renderSearch()
    await settle()
    await typeTerm('firewall')
    const result = within(screen.getByRole('region', { name: 'Apostilas' })).getByRole('link')
    expect(result.querySelector('img')).toBeNull()
    expect(window.__xss).toBeUndefined()
    expect(result).toHaveTextContent('Segurança')
    expect(within(result).getByText('firewall', { selector: 'mark' })).toBeInTheDocument()
  })

  it('o clique leva ao leitor na unidade, com o termo e a seção (/aluno/modulos?unidade=&busca=&secao=)', async () => {
    renderSearch()
    await settle()
    await typeTerm('roteador')
    const result = within(screen.getByRole('region', { name: 'Apostilas' })).getByRole('link')
    expect(result).toHaveAttribute('href', '/aluno/modulos?unidade=Apostila_DES_1&busca=roteador&secao=2')
    fireEvent.click(result)
    expect(screen.getByTestId('local')).toHaveTextContent('/aluno/modulos?unidade=Apostila_DES_1&busca=roteador&secao=2')
  })

  it('abre com o termo do endereço e pede pelo menos 2 letras', async () => {
    renderSearch('/aluno/busca?q=protocolo')
    await settle()
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
    await settle()
    view.unmount()
    renderSearch('/aluno/busca?q=rede')
    await settle()
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
    await settle()
    expect(screen.getByText('Nenhum resultado para “kernel”.')).toBeInTheDocument()
    view.unmount()
    // O professor liberou a unidade 2.
    mocks.released = { Apostila_DES_1: true, Apostila_DES_2: true, Apostila_DES_3: false }
    served = { ...served, Apostila_DES_2: '# Processos\n\nO kernel escalona os processos.' }
    renderSearch('/aluno/busca?q=kernel')
    await settle()
    await settle()
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

// Rodada de ajuste 1 do C16: palavra só no título, peso no celular, bloqueio com a Busca
// aberta e conteúdo guardado que envelhece.
function titledCourse() {
  const sections = (n) => Array.from({ length: n }, (_, i) => `## Seção ${i + 1}\n\nTexto qualquer número ${i + 1} sobre outro assunto.`).join('\n\n')
  return {
    courses: [{ id: 'X', structure: [{ id: 'm1', name: 'Módulo Redes', units: [
      { id: '1', name: 'Redes de computadores', apostilaKey: 'Apostila_A' },
      { id: '2', name: 'Outra', apostilaKey: 'Apostila_B' },
    ] }, { id: 'm2', name: 'Módulo 2', units: [
      { id: '3', name: 'Terceira', apostilaKey: 'Apostila_C' },
    ] }] }],
    Apostila_A: sections(30),
    Apostila_B: `${sections(30)}\n\nAqui fala de redes uma vez.`,
    Apostila_C: Array.from({ length: 60 }, (_, i) => `## Parte ${i + 1}\n\nAs redes sem fio, parte ${i + 1}.`).join('\n\n'),
  }
}

describe('[UC-BUSCA-003] palavra só no título da unidade ou do módulo', () => {
  it('vira um resultado por unidade, depois das seções que têm a palavra no texto', () => {
    const data = titledCourse()
    const result = runSearch({ apostilas: apostilaEntries(data), biblioteca: [], avisos: [] }, 'redes')
    // 60 seções da Terceira + 1 da Outra têm "redes" no texto; a unidade "Redes de
    // computadores" (só no título) conta uma vez; as outras seções do módulo, nenhuma.
    expect(result.total).toBe(60 + 1 + 1)
    expect(result.shown).toBe(SEARCH_RESULT_LIMIT)
    const ids = result.apostilas.map((item) => item.id)
    // A seção da Outra que fala de redes aparece (antes ficava fora dos 50).
    expect(ids).toContain('Apostila_B#30')
    expect(result.apostilas.every((item) => item.snippet.some((part) => part.mark))).toBe(true)
    expect(ids.filter((id) => id.startsWith('Apostila_A'))).toEqual([])
  })

  it('unidade achada só pelo título aparece uma vez, abre do começo e sem repetir seções', () => {
    const data = titledCourse()
    const result = runSearch({ apostilas: apostilaEntries(data), biblioteca: [], avisos: [] }, 'computadores')
    expect(result.total).toBe(1)
    const [unit] = result.apostilas
    expect(unit.title).toBe('Redes de computadores')
    expect(unit.context).toBe('Módulo Redes')
    expect(unit.href).toBe('/aluno/modulos?unidade=Apostila_A&busca=computadores')
    // A palavra fica marcada no nome da unidade (o trecho do texto não tem a palavra).
    expect(unit.titleParts.filter((part) => part.mark).map((part) => part.text)).toEqual(['computadores'])
  })

  it('achada no título da parte da apostila: a palavra aparece marcada na linha de contexto', async () => {
    renderSearch()
    await settle()
    await typeTerm('seguranca')
    const result = within(screen.getByRole('region', { name: 'Apostilas' })).getByRole('link')
    expect(result).toHaveTextContent('Módulo 1 · Segurança')
    expect(within(result).getByText('Segurança', { selector: 'mark' })).toBeInTheDocument()
  })

  it('palavras divididas entre o título e o texto: a seção com parte delas no texto vem antes da unidade só pelo título', () => {
    const data = titledCourse()
    const result = runSearch({ apostilas: apostilaEntries(data), biblioteca: [], avisos: [] }, 'redes fio parte 7')
    expect(result.apostilas[0].id).toBe('Apostila_C#7')
    const mixed = runSearch({ apostilas: apostilaEntries(data), biblioteca: [], avisos: [] }, 'redes qualquer')
    // A seção com as duas palavras no texto vem primeiro; depois, as que têm "qualquer" no
    // texto e "redes" só no título do módulo (na ordem do curso).
    expect(mixed.apostilas[0].id).toBe('Apostila_B#30')
    expect(mixed.apostilas[1].id).toBe('Apostila_A#1')
    expect(mixed.apostilas.every((item) => !item.titleOnly)).toBe(true)
  })
})

describe('[UC-BUSCA-003] índice montado uma vez, aos poucos', () => {
  it('monta em pedaços (a página responde no meio) e guarda: a segunda vez é a mesma', async () => {
    // Relógio parado (sem andar com o tempo real): só os pedaços que o teste deixa rodar.
    vi.useRealTimers()
    vi.useFakeTimers()
    const data = titledCourse()
    const promise = buildApostilaIndex(data, { sliceMs: 0 })
    expect(peekApostilaIndex(data)).toBeNull()
    await vi.advanceTimersToNextTimerAsync()
    // Um pedaço por unidade com sliceMs 0: depois do primeiro, ainda não acabou.
    expect(peekApostilaIndex(data)).toBeNull()
    await vi.runAllTimersAsync()
    const entries = await promise
    expect(entries.length).toBe(apostilaEntries(data).length)
    expect(peekApostilaIndex(data)).toBe(entries)
    expect(buildApostilaIndex(data)).toBe(promise)
  })

  it('a busca usa o texto já normalizado do índice (não normaliza a apostila a cada termo)', () => {
    const [entry] = apostilaEntries({ Apostila_Z: 'Configuração do roteador' })
    expect(entry.hay).toBe('configuracao do roteador')
    const fake = { ...entry, hay: 'palavra so do indice' }
    expect(runSearch({ apostilas: [fake] }, 'indice').total).toBe(1)
    expect(runSearch({ apostilas: [fake] }, 'roteador').total).toBe(0)
  })

  it('abrir a Busca de novo e apagar o termo não monta o índice outra vez', async () => {
    const view = renderSearch('/aluno/busca?q=tcp')
    await settle()
    expect(within(screen.getByRole('region', { name: 'Apostilas' })).getByRole('link')).toHaveTextContent('Protocolos')
    const firstData = [...mocks.get.mock.calls].length
    await typeTerm('')
    await typeTerm('firewall')
    // Sem "Preparando…": o índice já estava pronto.
    expect(screen.queryByText('Preparando a busca nas apostilas…')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Apostilas' })).toBeInTheDocument()
    view.unmount()
    renderSearch('/aluno/busca?q=roteador')
    // Logo na primeira pintura, sem esperar montagem.
    expect(screen.queryByText('Preparando a busca nas apostilas…')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Apostilas' })).toBeInTheDocument()
    expect(mocks.get.mock.calls.length).toBe(firstData)
  })
})

describe('[UC-BUSCA-003] liberação e conteúdo com a Busca aberta', () => {
  it('a Busca consulta a liberação de tempos em tempos e a unidade bloqueada sai dos resultados na hora', async () => {
    renderSearch('/aluno/busca?q=tcp')
    await settle()
    expect(mocks.options['/api/status']).toEqual({ pollMs: STATUS_POLL_MS })
    expect(screen.getByRole('region', { name: 'Apostilas' })).toBeInTheDocument()
    // O professor bloqueou a unidade 1 (a próxima consulta traz a liberação nova).
    mocks.released = { Apostila_DES_1: false, Apostila_DES_2: true, Apostila_DES_3: false }
    await typeTerm('tcp ')
    expect(screen.queryByRole('region', { name: 'Apostilas' })).not.toBeInTheDocument()
    // O aviso com TCP continua.
    expect(screen.getByRole('region', { name: 'Avisos' })).toBeInTheDocument()
  })

  it('o data.js guardado envelhece: voltar depois de um minuto baixa de novo e mostra o texto corrigido', async () => {
    mocks.released = { Apostila_DES_1: true, Apostila_DES_2: false, Apostila_DES_3: false }
    let served = courseData({ Apostila_DES_3: undefined })
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/data.js')) return `const courseData = ${JSON.stringify(served)};`
      return {}
    })
    const dataCalls = () => mocks.get.mock.calls.filter(([url]) => url.startsWith('/api/data.js')).length
    const view = renderSearch('/aluno/busca?q=switch')
    await settle()
    expect(screen.getByText('Nenhum resultado para “switch”.')).toBeInTheDocument()
    view.unmount()
    // O professor corrigiu o texto da apostila (a liberação é a mesma).
    served = { ...served, Apostila_DES_1: `${APOSTILA_1}\n\nO switch liga os computadores da sala.` }
    await act(async () => { await vi.advanceTimersByTimeAsync(CONTENT_MAX_AGE_MS + 1000) })
    renderSearch('/aluno/busca?q=switch')
    await settle()
    expect(dataCalls()).toBe(2)
    expect(within(screen.getByRole('region', { name: 'Apostilas' })).getByRole('link')).toHaveTextContent('switch')
  })

  it('data.js baixado de novo e igual: mantém o mesmo conteúdo (o índice não é refeito)', async () => {
    mocks.released = { Apostila_DES_1: true, Apostila_DES_2: false, Apostila_DES_3: false }
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/data.js')) return `const courseData = ${JSON.stringify(courseData({ Apostila_DES_3: undefined }))};`
      return {}
    })
    const view = renderSearch('/aluno/busca?q=tcp')
    await settle()
    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(CONTENT_MAX_AGE_MS + 1000) })
    renderSearch('/aluno/busca?q=tcp')
    // O guardado aparece logo (sem "Preparando…") enquanto o data.js vem de novo.
    expect(screen.queryByText('Preparando a busca nas apostilas…')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Apostilas' })).toBeInTheDocument()
    await settle()
    expect(mocks.get.mock.calls.filter(([url]) => url.startsWith('/api/data.js'))).toHaveLength(2)
    expect(screen.getByRole('region', { name: 'Apostilas' })).toBeInTheDocument()
  })
})

// Fase 3, C17 (P5-S3; D24 do P5): o caderno do aluno entra na busca, pela rota do caderno
// para levar. Só o que ele escreveu (a nota e as anotações), não o trecho da apostila.
describe('[UC-BUSCA-003] Busca do aluno · caderno', () => {
  it('acha a palavra na nota geral e nas notas das unidades; unidade liberada abre a apostila, as outras abrem o Caderno', async () => {
    mocks.notebook = {
      geral: 'Revisar a máscara de sub-rede antes da prova',
      unidades: [
        { chave: 'Apostila_DES_1', titulo: 'Redes de computadores', modulo: 'Módulo 1', nota: '', destaques: [{ paragrafo: 'p1', trecho: 'Uma rede liga computadores.', nota: 'Mascara cai na prova' }] },
        { chave: 'Apostila_DES_3', titulo: 'Unidade bloqueada', modulo: 'Módulo 1', nota: 'máscara /24 no laboratório', destaques: [] },
      ],
    }
    renderSearch()
    await settle()
    expect(mocks.urls.some((url) => String(url).startsWith('/api/student/notebook?courseId=DES&studentClass=1DES'))).toBe(true)
    await typeTerm('mascara')
    const caderno = screen.getByRole('region', { name: 'Caderno' })
    const links = within(caderno).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/aluno/caderno', '/aluno/modulos?unidade=Apostila_DES_1', '/aluno/caderno'])
    expect(links[1]).toHaveTextContent('Redes de computadores')
    expect(within(links[1]).getByText('Mascara', { selector: 'mark' })).toBeInTheDocument()

    // O trecho destacado é texto da apostila: não vira resultado do caderno.
    await typeTerm('liga computadores')
    expect(screen.queryByRole('region', { name: 'Caderno' })).not.toBeInTheDocument()
  })

  it('runSearch: o caderno tem a parte garantida dos 50 resultados, como Biblioteca e avisos', () => {
    const apostilas = Array.from({ length: 80 }, (_, i) => ({ kind: 'apostila', id: `a${i}#0`, unitKey: 'Apostila_DES_1', unitTitle: 'U', moduleTitle: 'M', secao: 0, sectionTitle: '', text: 'rede', hay: 'rede', titleHay: 'u m' }))
    const caderno = Array.from({ length: 3 }, (_, i) => ({ kind: 'caderno', id: `c${i}`, title: 'C', context: '', unitKey: '', text: 'rede', hay: 'rede' }))
    const result = runSearch({ apostilas, biblioteca: [], avisos: [], caderno }, 'rede')
    expect(result.caderno).toHaveLength(3)
    expect(result.shown).toBe(SEARCH_RESULT_LIMIT)
    expect(result.total).toBe(83)
    expect(runSearch({ apostilas, biblioteca: [], avisos: [] }, 'rede').caderno).toEqual([])
  })
})
