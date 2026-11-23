import { useEffect, useId, useState } from 'react'
import { Badge } from '../../components/ui/Badge'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { Input } from '../../components/ui/Input'
import { api } from '../../lib/api'
import { situacaoTone } from '../../lib/grades'
import { useToast } from '../../context/ToastProvider'

// Encerrar e reabrir turma (fase 3, B10 / P2-S9, FUN-05). As regras são do servidor
// (GET /api/admin/class/close-summary, POST /api/admin/class/close e /reopen): o resumo de
// situações com os critérios que vão ser copiados, o que segura o encerramento (prova
// aberta ou agendada, correção pendente) e a recusa de cada turma. A tela só mostra o
// resumo, pede a palavra ENCERRAR e o motivo, e manda um pedido por turma.
//
// - mode 'close': targets é a lista de turmas ({ courseId, courseName, name }); uma (botão
//   da turma) ou várias (assistente do período letivo encerrado);
// - mode 'reopen': targets tem uma turma; o motivo é obrigatório.
// onDone(resultado): depois do pedido (a tela recarrega a lista de turmas).

export const CLOSE_WORD = 'ENCERRAR'

const keyOf = target => `${target.courseId}\u0000${target.name}`

function situationLine(summary) {
  if (!summary || !Array.isArray(summary.situacoes) || summary.situacoes.length === 0) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`Situações da turma ${summary.turma?.name || ''}`}>
      {summary.situacoes.map(item => (
        <li key={item.situacao}><Badge tone={situacaoTone(item.situacao)}>{item.rotulo}: {item.total}</Badge></li>
      ))}
    </ul>
  )
}

function TargetSummary({ target, entry }) {
  const summary = entry && entry.summary
  return (
    <li className="rounded-lg border border-border p-3">
      <p className="font-medium text-text">{target.courseName ? `${target.courseName} · ` : ''}{target.name}</p>
      {!entry || entry.loading ? <p className="mt-1 text-xs text-subtle">Carregando o resumo...</p> : null}
      {entry && entry.error ? <p className="mt-1 text-sm text-danger">{entry.error}</p> : null}
      {summary && summary.encerramento && summary.encerramento.encerrada
        ? <p className="mt-1 text-sm text-muted">Já está encerrada.</p>
        : null}
      {summary && !(summary.encerramento && summary.encerramento.encerrada) ? (
        <>
          <p className="mt-1 text-sm text-muted">{summary.alunos === 1 ? '1 aluno' : `${summary.alunos} alunos`}{summary.turma?.periodoLetivo ? ` · ${summary.turma.periodoLetivo}` : ''}</p>
          {situationLine(summary)}
          {(summary.pendencias || []).length > 0 && (
            <ul className="mt-2 space-y-1" aria-label={`O que impede encerrar a turma ${target.name}`}>
              {summary.pendencias.map((item, index) => <li key={`${item.code}-${index}`} className="text-sm text-danger">{item.texto}</li>)}
            </ul>
          )}
          {(summary.avisos || []).length > 0 && (
            <ul className="mt-2 space-y-1">
              {summary.avisos.map((text, index) => <li key={index} className="text-xs text-warning">{text}</li>)}
            </ul>
          )}
        </>
      ) : null}
    </li>
  )
}

export function ClassClosureDialog({ open, mode = 'close', targets = [], onClose, onDone }) {
  const toast = useToast()
  const [entries, setEntries] = useState({})
  const [word, setWord] = useState('')
  const wordId = useId()
  const list = Array.isArray(targets) ? targets : []
  const listKey = list.map(keyOf).join('|')

  useEffect(() => {
    if (!open) return undefined
    setWord('')
    setEntries({})
    if (mode !== 'close') return undefined
    let alive = true
    list.forEach(target => {
      const key = keyOf(target)
      setEntries(current => ({ ...current, [key]: { loading: true } }))
      api.get(`/api/admin/class/close-summary?courseId=${encodeURIComponent(target.courseId)}&name=${encodeURIComponent(target.name)}`)
        .then(summary => { if (alive) setEntries(current => ({ ...current, [key]: { summary } })) })
        .catch(error => { if (alive) setEntries(current => ({ ...current, [key]: { error: error.message || 'Não foi possível carregar o resumo.' } })) })
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, listKey])

  // O campo do motivo do ConfirmDialog pega o foco ao abrir; aqui o primeiro passo é
  // digitar ENCERRAR, então o foco vai para ele depois que o diálogo monta.
  useEffect(() => {
    if (!open || mode !== 'close') return undefined
    const timer = setTimeout(() => { document.getElementById(wordId)?.focus() }, 0)
    return () => clearTimeout(timer)
  }, [open, mode, wordId])

  const closable = list.filter(target => entries[keyOf(target)]?.summary?.podeEncerrar === true)
  const loading = list.some(target => !entries[keyOf(target)] || entries[keyOf(target)].loading)
  const wordOk = word.trim().toUpperCase() === CLOSE_WORD

  async function confirmClose(reason) {
    const done = []
    const failed = []
    for (const target of closable) {
      try {
        const result = await api.post('/api/admin/class/close', { courseId: target.courseId, name: target.name, confirm: CLOSE_WORD, ...(reason ? { reason } : {}) })
        done.push({ target, result })
      } catch (error) {
        failed.push({ target, error })
      }
    }
    if (!done.length && failed.length) throw failed[0].error
    if (failed.length) toast.error(`${done.length === 1 ? '1 turma encerrada' : `${done.length} turmas encerradas`}; não deu para encerrar ${failed.map(item => item.target.name).join(', ')}: ${failed[0].error.message}`)
    else toast.success(done.length === 1 ? `Turma ${done[0].target.name} encerrada. Notas e presença ficam travadas até reabrir.` : `${done.length} turmas encerradas. Notas e presença ficam travadas até reabrir.`)
    onClose?.()
    await onDone?.({ done, failed })
  }

  async function confirmReopen(reason) {
    const target = list[0]
    await api.post('/api/admin/class/reopen', { courseId: target.courseId, name: target.name, reason })
    toast.success(`Turma ${target.name} reaberta. Notas e presença voltam a ser lançadas.`)
    onClose?.()
    await onDone?.({ done: [{ target }], failed: [] })
  }

  if (mode === 'reopen') {
    const target = list[0]
    return (
      <ConfirmDialog open={open && !!target} onClose={onClose} onConfirm={confirmReopen}
        title={target ? `Reabrir a turma ${target.name}?` : ''}
        message="A turma volta a receber nota, chamada e prova, e a conta volta a usar os critérios de avaliação de agora do curso. O motivo fica na Auditoria."
        requireReason reasonLabel="Motivo para reabrir" reasonPlaceholder="Ex.: nota lançada errada" confirmLabel="Reabrir turma" />
    )
  }

  const single = list.length === 1
  return (
    <ConfirmDialog open={open && list.length > 0} onClose={onClose} onConfirm={confirmClose} tone="danger"
      title={single ? `Encerrar a turma ${list[0].name}?` : `Encerrar ${list.length} turmas?`}
      message="Encerrada, a turma não recebe nota, chamada, prova nem matrícula nova, e os critérios de avaliação de agora ficam copiados nela: mudar os critérios do curso depois não muda a média dela. Nada é apagado, e dá para reabrir com o motivo."
      askReason reasonLabel="Motivo" reasonPlaceholder="Ex.: fim do 1º semestre"
      confirmLabel={single ? 'Encerrar turma' : `Encerrar ${closable.length === 1 ? '1 turma' : `${closable.length} turmas`}`}
      confirmDisabled={loading || !closable.length || !wordOk}>
      <ul className="space-y-2" aria-label="Turmas para encerrar">
        {list.map(target => <TargetSummary key={keyOf(target)} target={target} entry={entries[keyOf(target)]} />)}
      </ul>
      {!loading && !closable.length && <p className="text-sm text-muted">Nenhuma turma pode ser encerrada agora: resolva o que está acima e abra de novo.</p>}
      {!loading && closable.length > 0 && closable.length < list.length && <p className="text-sm text-muted">Só {closable.length === 1 ? 'a turma sem pendência é encerrada' : `as ${closable.length} turmas sem pendência são encerradas`}.</p>}
      <Input id={wordId} label={`Digite ${CLOSE_WORD} para confirmar`} value={word} onChange={event => setWord(event.target.value)} autoComplete="off" />
    </ConfirmDialog>
  )
}
