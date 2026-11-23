import { Link } from 'react-router-dom'
import { ArrowLeft, Eye } from 'lucide-react'
import { PREVIEW_EXAM_TEXT } from '../../../lib/previewSession'

// /aluno/prova/:examKey na pré-visualização como aluno (C15 / P5-S6b, D21 do P5): a prova
// não começa (nem estado, nem tentativa, nem registro no Monitor). As questões o
// professor vê em Provas > Visualizar, no painel.
export function PreviewExamNotice() {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div role="status" className="rounded-xl border border-border bg-surface p-6 text-center shadow-sm">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-warning-soft text-warning"><Eye size={20} aria-hidden="true" /></span>
        <h1 className="mt-3 text-lg font-semibold text-text">Prova na pré-visualização</h1>
        <p className="mt-2 text-sm text-muted">{PREVIEW_EXAM_TEXT}</p>
        <Link to="/aluno/provas" className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-border bg-surface-2 px-4 text-sm font-semibold text-text hover:bg-surface">
          <ArrowLeft size={16} aria-hidden="true" /> Voltar para Provas
        </Link>
      </div>
    </div>
  )
}
