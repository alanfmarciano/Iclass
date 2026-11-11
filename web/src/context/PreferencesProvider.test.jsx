import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H9b (ENG-03): o servidor recusa com 400 as preferências que passam de 100 chaves
// ou 64 KB. Antes o PreferencesProvider engolia a falha (.catch(() => {})): o modelo de
// resposta novo aparecia na tela e sumia ao recarregar, sem aviso. E só a última chave
// alterada dentro da espera de 400 ms chegava ao servidor.
const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('../lib/api', () => ({ api: apiMock }))
vi.mock('./AuthProvider', () => ({ useAuth: () => ({ auth: { role: 'admin', email: 'prof@escola.local' } }) }))
vi.mock('./ToastProvider', () => ({ useToast: () => toastMock }))

import { PREFERENCES_RETRY_MESSAGE, PREFERENCES_RETRY_MS, PREFERENCES_SAVE_DELAY_MS, PreferencesProvider, usePreferences } from './PreferencesProvider'

let api
function Probe() {
  api = usePreferences()
  return <output data-testid="templates">{JSON.stringify(api.pref('forum.templates', []))}</output>
}

const saved = [{ id: 'tpl_1', title: 'Obrigado', text: 'Obrigado pela pergunta!' }]

async function mount() {
  render(<PreferencesProvider><Probe /></PreferencesProvider>)
  await act(async () => {})
}

beforeEach(() => {
  vi.useFakeTimers()
  apiMock.get.mockReset().mockResolvedValue({ 'forum.templates': saved })
  apiMock.post.mockReset()
  Object.values(toastMock).forEach((fn) => fn.mockReset())
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const shown = () => JSON.parse(screen.getByTestId('templates').textContent)

describe('[UC-ERRO-003] Preferências do professor: gravação recusada não some em silêncio', () => {
  it('400 do servidor (passou de 64 KB): o modelo novo sai da tela e o motivo aparece', async () => {
    const refusal = Object.assign(new Error('As preferências desta conta passaram do limite de 64 KB. Limpe favoritos ou modelos de resposta antigos.'), { status: 400 })
    apiMock.post.mockRejectedValue(refusal)
    await mount()
    expect(shown()).toEqual(saved)
    const added = [...saved, { id: 'tpl_2', title: 'Longo', text: 'x'.repeat(5000) }]
    act(() => { api.setPref('forum.templates', added) })
    expect(shown()).toEqual(added)
    await act(async () => { vi.advanceTimersByTime(PREFERENCES_SAVE_DELAY_MS) })
    expect(apiMock.post).toHaveBeenCalledWith('/api/admin/preferences', { 'forum.templates': added })
    expect(shown()).toEqual(saved)
    expect(toastMock.error).toHaveBeenCalledWith('Preferência não salva: As preferências desta conta passaram do limite de 64 KB. Limpe favoritos ou modelos de resposta antigos.')
    // Recusa pelo conteúdo não é repetida.
    await act(async () => { vi.advanceTimersByTime(PREFERENCES_RETRY_MS * 2) })
    expect(apiMock.post).toHaveBeenCalledTimes(1)
  })

  it('a gravação aceita mantém o valor; duas chaves alteradas na mesma espera vão juntas', async () => {
    apiMock.post.mockImplementation((url, body) => Promise.resolve({ success: true, preferences: { 'forum.templates': saved, ...body } }))
    await mount()
    act(() => {
      // setPref devolve a promessa da gravação (decisões §12): fora do retorno do act.
      api.setPref('forum.lastSeen', '2026-11-11T10:00:00.000Z')
      api.setPref('dashboard.riskCount', 7)
    })
    await act(async () => { vi.advanceTimersByTime(PREFERENCES_SAVE_DELAY_MS) })
    expect(apiMock.post).toHaveBeenCalledTimes(1)
    expect(apiMock.post).toHaveBeenCalledWith('/api/admin/preferences', { 'forum.lastSeen': '2026-11-11T10:00:00.000Z', 'dashboard.riskCount': 7 })
    expect(api.pref('dashboard.riskCount', 5)).toBe(7)
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('sem conexão: o valor fica na tela, o professor é avisado uma vez e o IClass tenta de novo', async () => {
    const offline = Object.assign(new Error('Sem conexão com o servidor do IClass.'), { status: 0, network: true })
    apiMock.post.mockRejectedValueOnce(offline).mockRejectedValueOnce(offline).mockResolvedValue({ success: true })
    await mount()
    const added = [...saved, { id: 'tpl_2', title: 'Novo', text: 'Veja a apostila.' }]
    act(() => { api.setPref('forum.templates', added) })
    await act(async () => { vi.advanceTimersByTime(PREFERENCES_SAVE_DELAY_MS) })
    expect(shown()).toEqual(added)
    expect(toastMock.warning).toHaveBeenCalledWith(PREFERENCES_RETRY_MESSAGE)
    await act(async () => { vi.advanceTimersByTime(PREFERENCES_RETRY_MS) })
    await act(async () => { vi.advanceTimersByTime(PREFERENCES_RETRY_MS) })
    expect(apiMock.post).toHaveBeenCalledTimes(3)
    expect(apiMock.post).toHaveBeenLastCalledWith('/api/admin/preferences', { 'forum.templates': added })
    expect(toastMock.warning).toHaveBeenCalledTimes(1)
    expect(shown()).toEqual(added)
  })
})

// Decisões §12 (sobra do H9b): só rede, prazo e 5xx/503 tentam de novo; 401/403/404/409
// param e mostram a mensagem; 429 tenta de novo depois do retryAfter.
describe('[UC-ERRO-003] Preferências do professor: quando tentar de novo', () => {
  it.each([401, 403, 404, 409])('%i: para, volta o valor gravado e mostra a mensagem', async (status) => {
    apiMock.post.mockRejectedValue(Object.assign(new Error(`Recusado ${status}.`), { status }))
    await mount()
    const added = [...saved, { id: 'tpl_2', title: 'Novo', text: 'Oi' }]
    let result
    act(() => { result = api.setPref('forum.templates', added) })
    await act(async () => { vi.advanceTimersByTime(PREFERENCES_SAVE_DELAY_MS) })
    await expect(result).resolves.toBe(false)
    expect(shown()).toEqual(saved)
    expect(toastMock.error).toHaveBeenCalledWith(`Preferência não salva: Recusado ${status}.`)
    await act(async () => { vi.advanceTimersByTime(PREFERENCES_RETRY_MS * 3) })
    expect(apiMock.post).toHaveBeenCalledTimes(1)
  })

  it('500 e 503: tenta de novo e a promessa só resolve com a gravação', async () => {
    apiMock.post
      .mockRejectedValueOnce(Object.assign(new Error('Erro interno.'), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('Não foi possível gravar agora.'), { status: 503, retryable: true }))
      .mockResolvedValue({ success: true })
    await mount()
    let result
    act(() => { result = api.setPref('dashboard.riskCount', 3) })
    await act(async () => { vi.advanceTimersByTime(PREFERENCES_SAVE_DELAY_MS) })
    await act(async () => { vi.advanceTimersByTime(PREFERENCES_RETRY_MS) })
    await act(async () => { vi.advanceTimersByTime(PREFERENCES_RETRY_MS) })
    expect(apiMock.post).toHaveBeenCalledTimes(3)
    await expect(result).resolves.toBe(true)
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('429: espera o retryAfter do servidor antes de tentar de novo', async () => {
    apiMock.post
      .mockRejectedValueOnce(Object.assign(new Error('Muitos pedidos. Tente de novo em 12 segundos.'), { status: 429, data: { retryAfterSeconds: 12 } }))
      .mockResolvedValue({ success: true })
    await mount()
    act(() => { api.setPref('dashboard.riskCount', 4) })
    await act(async () => { vi.advanceTimersByTime(PREFERENCES_SAVE_DELAY_MS) })
    expect(toastMock.warning).toHaveBeenCalledWith('Muitos pedidos. Tente de novo em 12 segundos.')
    await act(async () => { vi.advanceTimersByTime(11000) })
    expect(apiMock.post).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(apiMock.post).toHaveBeenCalledTimes(2)
    expect(api.pref('dashboard.riskCount', 0)).toBe(4)
  })
})

