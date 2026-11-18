import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  noteServerBuild,
  onBeforeUpdateReload,
  resetUpdateReloadForTests,
  updateReloadPending,
  UPDATE_NOTICE_ID,
  UPDATE_RELOAD_MESSAGE,
} from './buildVersion'

// Autorrecuperação depois de uma atualização do IClass: o bundle que está rodando é
// "velho" e o servidor anuncia o "novo" no cabeçalho X-IClass-Build.
function options(extra = {}) {
  return { enabled: true, clientBuild: 'velho', reload: vi.fn(), storage: sessionStorage, delayMs: 1500, ...extra }
}

beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  resetUpdateReloadForTests()
})

afterEach(() => {
  resetUpdateReloadForTests()
  vi.useRealTimers()
  sessionStorage.clear()
})

describe('[UC-MANUT-001] versão do build: recarga automática depois de atualizar o IClass', () => {
  it('servidor com outra versão: avisa, deixa a tela salvar o que estiver pendente e recarrega sozinho', () => {
    const opts = options()
    const salvar = vi.fn()
    onBeforeUpdateReload(salvar)

    expect(noteServerBuild('novo', opts)).toBe(true)

    const aviso = document.getElementById(UPDATE_NOTICE_ID)
    expect(aviso).toBeTruthy()
    expect(aviso).toHaveTextContent(UPDATE_RELOAD_MESSAGE)
    expect(UPDATE_RELOAD_MESSAGE).toBe('O IClass foi atualizado. Recarregando...')
    expect(aviso).toHaveAttribute('role', 'status')
    expect(salvar).toHaveBeenCalledTimes(1)
    expect(updateReloadPending()).toBe(true)
    // O aviso aparece antes: a recarga espera as gravações pendentes saírem.
    expect(opts.reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1500)
    expect(opts.reload).toHaveBeenCalledTimes(1)
  })

  it('várias respostas com a versão nova agendam uma recarga só', () => {
    const opts = options()
    const salvar = vi.fn()
    onBeforeUpdateReload(salvar)
    noteServerBuild('novo', opts)
    expect(noteServerBuild('novo', opts)).toBe(false)
    expect(noteServerBuild('novo', opts)).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(opts.reload).toHaveBeenCalledTimes(1)
    expect(salvar).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll(`#${UPDATE_NOTICE_ID}`)).toHaveLength(1)
  })

  it('mesma versão, sem cabeçalho ou fora do build de produção: nada acontece', () => {
    const opts = options()
    expect(noteServerBuild('velho', opts)).toBe(false)
    expect(noteServerBuild('', opts)).toBe(false)
    expect(noteServerBuild(null, opts)).toBe(false)
    expect(noteServerBuild('novo', { ...opts, enabled: false })).toBe(false)
    expect(noteServerBuild('novo', { ...opts, clientBuild: '' })).toBe(false)
    // Nos testes (vite sem build) a autorrecuperação fica desligada por padrão.
    expect(noteServerBuild('novo', { reload: opts.reload })).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(opts.reload).not.toHaveBeenCalled()
    expect(document.getElementById(UPDATE_NOTICE_ID)).toBeNull()
    expect(updateReloadPending()).toBe(false)
  })

  it('já recarregou por esta versão e o bundle continua o antigo (cache): não entra em laço de recargas', () => {
    const opts = options()
    noteServerBuild('novo', opts)
    vi.advanceTimersByTime(1500)
    expect(opts.reload).toHaveBeenCalledTimes(1)

    // A página "recarregada" ainda roda o bundle velho.
    resetUpdateReloadForTests()
    expect(noteServerBuild('novo', opts)).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(opts.reload).toHaveBeenCalledTimes(1)

    // Uma atualização seguinte volta a valer.
    expect(noteServerBuild('mais-novo', opts)).toBe(true)
    vi.advanceTimersByTime(1500)
    expect(opts.reload).toHaveBeenCalledTimes(2)
  })

  it('bundle em dia libera a trava para a próxima atualização com a mesma versão', () => {
    const opts = options()
    noteServerBuild('novo', opts)
    vi.advanceTimersByTime(1500)
    resetUpdateReloadForTests()
    // Recarregou com o bundle novo: a versão confere e a trava é liberada.
    noteServerBuild('novo', { ...opts, clientBuild: 'novo' })
    expect(sessionStorage.getItem('iclass-update-reload')).toBeNull()
  })

  it('tela que já saiu (registro desfeito) não é chamada, e um erro numa tela não impede a recarga', () => {
    const opts = options()
    const saiu = vi.fn()
    const off = onBeforeUpdateReload(saiu)
    off()
    onBeforeUpdateReload(() => { throw new Error('falhou') })
    const outra = vi.fn()
    onBeforeUpdateReload(outra)
    noteServerBuild('novo', opts)
    vi.advanceTimersByTime(1500)
    expect(saiu).not.toHaveBeenCalled()
    expect(outra).toHaveBeenCalledTimes(1)
    expect(opts.reload).toHaveBeenCalledTimes(1)
  })

  it('sem sessionStorage (navegador restrito) ainda recarrega', () => {
    const opts = options({ storage: null })
    expect(noteServerBuild('novo', opts)).toBe(true)
    vi.advanceTimersByTime(1500)
    expect(opts.reload).toHaveBeenCalledTimes(1)
  })
})
