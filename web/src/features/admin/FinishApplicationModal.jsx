import { AlertTriangle, Save, Trash2 } from 'lucide-react'
import { Modal } from '../../components/ui/Modal'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'

export function FinishApplicationModal({ open, onClose, summary, onSubmit, onDiscard, busy }) {
  const inProgress = Number(summary?.inProgressAttempts || 0)
  const answered = Number(summary?.answeredQuestions || 0)
  const waiting = Number(summary?.waitingToStart || 0)
  const hasInProgress = inProgress > 0

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Finalizar esta aplicação?"
      description={hasInProgress
        ? 'Há alunos com respostas salvas automaticamente. Escolha o que fazer com essas tentativas.'
        : 'Nenhum aluno possui uma tentativa iniciada e ainda não enviada.'}
      footer={hasInProgress ? <>
        <Button variant="ghost" onClick={onClose} disabled={!!busy}>Cancelar</Button>
        <Button variant="destructive" icon={Trash2} onClick={onDiscard} loading={busy === 'discard'}>Desconsiderar e finalizar</Button>
        <Button icon={Save} onClick={onSubmit} loading={busy === 'submit'}>Salvar e entregar respostas</Button>
      </> : <>
        <Button variant="ghost" onClick={onClose} disabled={!!busy}>Cancelar</Button>
        <Button variant="destructive" onClick={onDiscard} loading={busy === 'discard'}>Finalizar aplicação</Button>
      </>}
    >
      {hasInProgress ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-warning/50 bg-warning-soft p-3 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <p>Esta decisão vale somente para tentativas em andamento. Entregas já concluídas permanecem preservadas.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card className="p-3"><p className="text-xs text-muted">Tentativas em andamento</p><p className="mt-1 text-2xl font-bold text-text">{inProgress}</p></Card>
            <Card className="p-3"><p className="text-xs text-muted">Respostas salvas</p><p className="mt-1 text-2xl font-bold text-text">{answered}</p></Card>
            <Card className="p-3"><p className="text-xs text-muted">Ainda não iniciaram</p><p className="mt-1 text-2xl font-bold text-text">{waiting}</p></Card>
          </div>
          <div className="space-y-2 text-sm text-muted">
            <p><strong className="text-text">Salvar e entregar:</strong> cria uma entrega com tudo que o autosave registrou e a tentativa passa a contar normalmente.</p>
            <p><strong className="text-text">Desconsiderar:</strong> não cria entrega e a tentativa não será consumida.</p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">Os alunos deixarão de ver a prova disponível. Esta ação não altera entregas já realizadas.</p>
      )}
    </Modal>
  )
}
