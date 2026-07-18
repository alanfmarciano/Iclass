import { useMemo, useState } from 'react'
import { ArrowLeft, CheckCircle2, Play, Printer } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { snapshotsFromHistory } from './examTools'

function historyLabel(entry) {
  if (entry?.label) return entry.label
  return entry?.type === 'impressa' ? 'Prova impressa' : 'Aplicação online'
}

export function ExamApplicationDetail({ entry, title, subtitle, onBack, onReprint, onApplyOnline, applyBusy }) {
  const versions = useMemo(() => snapshotsFromHistory(entry), [entry])
  const [activeIndex, setActiveIndex] = useState(0)
  const active = versions[activeIndex] || null

  const questionNumbers = (entry?.questionNumbers || []).join(', ')
  const isPrint = entry?.type === 'impressa'

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-text"
      >
        <ArrowLeft size={16} />Voltar para provas
      </button>

      {/* Cabeçalho da aplicação */}
      <Card>
        <CardBody className="pt-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs uppercase font-semibold tracking-[0.05em] text-subtle">
                Aplicação · {historyLabel(entry)}
              </p>
              <h2 className="text-xl font-bold text-text mt-1">{title}</h2>
              {subtitle && <p className="text-sm text-muted mt-0.5">{subtitle}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge tone={isPrint ? 'info' : 'neutral'}>{entry?.type || 'online'}</Badge>
                <Badge tone="neutral">{entry?.questionCount || entry?.questionNumbers?.length || 0} questões</Badge>
                {entry?.durationMinutes ? <Badge tone="neutral">{entry.durationMinutes} min</Badge> : null}
                <Badge tone="success">{versions.length} {versions.length === 1 ? 'versão' : 'versões'}</Badge>
                {questionNumbers && <Badge tone="warning">Q: {questionNumbers}</Badge>}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {onReprint && (
                <Button size="sm" variant="secondary" icon={Printer} onClick={onReprint}>
                  {isPrint ? 'Reimprimir' : 'Imprimir'}
                </Button>
              )}
              {onApplyOnline && (
                <Button size="sm" icon={Play} loading={applyBusy} onClick={onApplyOnline}>Aplicar online</Button>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {versions.length === 0 ? (
        <Card>
          <CardBody className="pt-5">
            <p className="text-sm text-muted">
              Esta aplicação não tem um snapshot salvo das versões, então não é possível exibir as questões aqui.
            </p>
          </CardBody>
        </Card>
      ) : (
        <>
          {/* Seletor de versões */}
          <Card>
            <CardHeader
              title="Versões geradas"
              subtitle="Cada versão tem ordem própria de questões e alternativas. Selecione para visualizar."
              action={<Badge tone="neutral">{versions.length} {versions.length === 1 ? 'versão' : 'versões'}</Badge>}
            />
            <CardBody>
              <div className="flex flex-wrap gap-2.5">
                {versions.map((version, index) => {
                  const isActive = index === activeIndex
                  return (
                    <button
                      key={`${version.version}-${index}`}
                      type="button"
                      onClick={() => setActiveIndex(index)}
                      className={`flex flex-col gap-0.5 min-w-[118px] text-left rounded-xl border px-4 py-3 transition ${
                        isActive
                          ? 'border-primary bg-primary-soft shadow-[inset_0_0_0_1px_var(--primary)]'
                          : 'border-border bg-surface-2 hover:border-[var(--border-strong)]'
                      }`}
                    >
                      <span className="text-sm font-bold text-text">Versão {version.version}</span>
                      <span className="font-mono text-xs text-muted tracking-wide">#{version.examCode}</span>
                      <span className="text-[11px] text-subtle">{version.count} questões</span>
                    </button>
                  )
                })}
              </div>
            </CardBody>
          </Card>

          {/* Gabarito da versão */}
          {active && Object.keys(active.answerKey || {}).length > 0 && (
            <Card>
              <CardHeader title={`Gabarito — Versão ${active.version}`} subtitle="Respostas na ordem desta versão" />
              <CardBody>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(active.answerKey).map(([number, letter]) => (
                    <div
                      key={number}
                      className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm font-semibold"
                    >
                      <span className="font-mono text-subtle">{number}</span>
                      <span className="grid h-[22px] w-[22px] place-items-center rounded-md bg-primary text-primary-fg font-bold uppercase">
                        {letter}
                      </span>
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          )}

          {/* Questões da versão */}
          {active && (
            <Card>
              <CardHeader title={`Questões — Versão ${active.version}`} subtitle="Conteúdo exatamente como foi aplicado" />
              <CardBody className="space-y-3.5">
                {active.questions.map((question, index) => (
                  <div key={`${question.originalNumber}-${index}`} className="rounded-xl border border-border bg-surface-2 p-4">
                    <div className="flex items-start gap-3">
                      <div className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-surface text-sm font-bold text-text">
                        {index + 1}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[15px] font-medium leading-relaxed text-text">{question.text}</p>
                        {Number.isFinite(Number(question.originalNumber)) && (
                          <p className="mt-0.5 text-[11px] text-subtle">Questão original nº {question.originalNumber}</p>
                        )}
                      </div>
                    </div>
                    <ul className="mt-3.5 grid gap-2">
                      {(question.alternatives || []).map((alt, altIndex) => {
                        const letter = String(alt.displayLetter || alt.letter || '').toLowerCase()
                        return (
                          <li
                            key={altIndex}
                            className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm leading-snug ${
                              alt.isCorrect ? 'border-transparent bg-success-soft' : 'border-border bg-surface'
                            }`}
                          >
                            <span
                              className={`grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md text-xs font-bold uppercase ${
                                alt.isCorrect ? 'bg-success text-white' : 'bg-surface-2 text-text'
                              }`}
                            >
                              {letter}
                            </span>
                            <span className="text-text">{alt.text}</span>
                            {alt.isCorrect && (
                              <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-success">
                                <CheckCircle2 size={15} />correta
                              </span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

export default ExamApplicationDetail
