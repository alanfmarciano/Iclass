import { useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Modal } from '../../components/ui/Modal'
import { Select } from '../../components/ui/Select'
import { Switch } from '../../components/ui/Switch'
import { Textarea } from '../../components/ui/Textarea'
import { useToast } from '../../context/ToastProvider'
import { api, downloadFile } from '../../lib/api'
import { answerSummary, formatPointsLabel, questionTypeLabel } from './questionEditorModel'
import {
  BANK_CATEGORY_MAX,
  BANK_IMPORT_EXCEL_MESSAGE,
  BANK_IMPORT_FORMATS,
  BANK_IMPORT_MAX_BYTES,
  BANK_IMPORT_PREVIEW_MAX,
  bankExcerpt,
  bankExportPath,
  importConfirmLabel,
  importCount,
  importDuplicateText,
  importSummaryText,
  isExcelWorkbookName,
  questionsWithImages,
} from './questionBankModel'

// Importar e exportar o banco de questões (fase 3, P3-S9b: AVA-15; D22 do desenho P3,
// telas.professor "Provas > Banco de questões"):
// - Importar: GIFT (o formato de texto do Moodle, e o que outro IClass exporta) ou
//   planilha CSV (do Excel, com "Salvar como" > CSV; o .xlsx é recusado com essa dica),
//   escolhendo o arquivo ou colando o texto. "Ver
//   prévia" manda ao servidor, que lê tudo sem gravar e devolve as questões que entram,
//   os erros por linha e as repetidas; "Importar N questões" confirma com o sha256 da
//   prévia (o servidor recusa se o arquivo mudou). Trocar o arquivo, o texto, o formato
//   ou a categoria apaga a prévia.
// - Exportar: as questões da lista, com os filtros de agora, em GIFT ou planilha CSV
//   (abre no Excel com os acentos).
// No celular (375 px) cabe numa coluna: os erros ficam recolhidos e a prévia mostra as
// primeiras 50 questões.

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo. Escolha o arquivo de novo.'))
    reader.readAsDataURL(file)
  })
}

export default function QuestionImportDialog({ open, onClose, onImported }) {
  const toast = useToast()
  const [formato, setFormato] = useState('gift')
  const [source, setSource] = useState('arquivo')
  const [file, setFile] = useState(null)
  const [text, setText] = useState('')
  const [categoria, setCategoria] = useState('')
  const [preview, setPreview] = useState(null)
  const [includeDuplicates, setIncludeDuplicates] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef(null)
  const requestRef = useRef(0)

  useEffect(() => {
    if (open) return
    setFile(null)
    setText('')
    setPreview(null)
    setIncludeDuplicates(false)
    setError('')
    setBusy('')
    requestRef.current += 1
  }, [open])

  // Qualquer mudança no que vai ser importado invalida a prévia.
  const reset = () => {
    requestRef.current += 1
    setPreview(null)
    setIncludeDuplicates(false)
    setError('')
    setBusy('')
  }

  const format = BANK_IMPORT_FORMATS.find((item) => item.value === formato) || BANK_IMPORT_FORMATS[0]

  async function chooseFile(chosen) {
    reset()
    if (!chosen) { setFile(null); return }
    // Arquivo recusado aqui: o campo volta a "nenhum arquivo", para não parecer escolhido.
    const refuse = (message) => {
      setFile(null)
      setError(message)
      if (fileRef.current) fileRef.current.value = ''
    }
    if (chosen.size > BANK_IMPORT_MAX_BYTES) {
      refuse('O arquivo passa de 2 MB. Divida em arquivos menores.')
      return
    }
    if (isExcelWorkbookName(chosen.name)) {
      refuse(BANK_IMPORT_EXCEL_MESSAGE)
      return
    }
    try {
      const base64 = await readAsBase64(chosen)
      setFile({ name: chosen.name, size: chosen.size, base64 })
      if (/\.csv$/i.test(chosen.name)) setFormato('csv')
    } catch (readError) {
      setFile(null)
      setError(readError.message)
    }
  }

  function requestBody() {
    const body = { formato, categoriaPadrao: categoria.trim() || null }
    if (source === 'arquivo') {
      body.arquivo = file?.base64 || ''
      body.nomeArquivo = file?.name || null
    } else {
      body.conteudo = text
    }
    return body
  }

  const ready = source === 'arquivo' ? !!file : text.trim() !== ''

  async function loadPreview() {
    if (!ready) {
      setError(source === 'arquivo' ? 'Escolha o arquivo com as questões.' : 'Cole o texto das questões.')
      return
    }
    const id = requestRef.current + 1
    requestRef.current = id
    setBusy('preview')
    setError('')
    try {
      const response = await api.post('/api/admin/question-bank/import/preview', requestBody())
      if (requestRef.current !== id) return
      setPreview(response)
    } catch (previewError) {
      if (requestRef.current === id) setError(previewError.message)
    } finally {
      if (requestRef.current === id) setBusy('')
    }
  }

  async function confirmImport() {
    if (!preview) return
    const id = requestRef.current + 1
    requestRef.current = id
    setBusy('import')
    setError('')
    try {
      const response = await api.post('/api/admin/question-bank/import', { ...requestBody(), sha256: preview.sha256, ignorarDuplicadas: !includeDuplicates })
      if (requestRef.current !== id) return
      const imported = Number(response?.importadas) || 0
      toast.success(`${plural(imported, 'questão importada', 'questões importadas')} para o banco`)
      onImported?.(response)
      onClose?.()
    } catch (importError) {
      if (requestRef.current !== id) return
      // Arquivo diferente da prévia: a prévia sai e o professor vê de novo.
      if (importError?.data?.code === 'import_changed') setPreview(null)
      setError(importError.message)
    } finally {
      if (requestRef.current === id) setBusy('')
    }
  }

  const count = importCount(preview, includeDuplicates)
  const items = Array.isArray(preview?.itens) ? preview.itens : []
  const errors = Array.isArray(preview?.erros) ? preview.erros : []
  const warnings = Array.isArray(preview?.avisos) ? preview.avisos : []
  const shown = items.slice(0, BANK_IMPORT_PREVIEW_MAX)

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose?.() }}
      title="Importar questões"
      description="Traga questões de um arquivo GIFT (do Moodle ou de outro IClass) ou de uma planilha. Nada entra no banco antes da prévia."
      size="lg"
      fullScreenOnPhone
      footer={preview ? (
        <>
          <Button variant="ghost" onClick={reset} disabled={!!busy}>Voltar</Button>
          <Button onClick={confirmImport} loading={busy === 'import'} disabled={count === 0}>{importConfirmLabel(count)}</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={() => onClose?.()} disabled={!!busy}>Cancelar</Button>
          <Button onClick={loadPreview} loading={busy === 'preview'}>Ver prévia</Button>
        </>
      )}
    >
      <div className="min-w-0 space-y-3">
        {!preview && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select label="Formato" value={formato} onChange={(event) => { reset(); setFormato(event.target.value) }}>
                {BANK_IMPORT_FORMATS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
              <Input
                label="Categoria das questões sem categoria"
                value={categoria}
                maxLength={BANK_CATEGORY_MAX}
                placeholder="Geral"
                onChange={(event) => { reset(); setCategoria(event.target.value) }}
              />
            </div>
            <div className="flex flex-wrap gap-2" role="group" aria-label="De onde vêm as questões">
              <Button size="sm" variant={source === 'arquivo' ? 'secondary' : 'ghost'} aria-pressed={source === 'arquivo'} onClick={() => { reset(); setSource('arquivo') }}>Escolher arquivo</Button>
              <Button size="sm" variant={source === 'colar' ? 'secondary' : 'ghost'} aria-pressed={source === 'colar'} onClick={() => { reset(); setSource('colar') }}>Colar o texto</Button>
            </div>
            {source === 'arquivo' ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="banco-importar-arquivo" className="text-sm font-medium text-text">Arquivo ({format.value === 'gift' ? '.txt ou .gift' : '.csv'}, até 2 MB)</label>
                <input
                  id="banco-importar-arquivo"
                  ref={fileRef}
                  type="file"
                  accept={format.accept}
                  onChange={(event) => chooseFile(event.target.files?.[0] || null)}
                  className="min-w-0 max-w-full text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:font-medium file:text-primary-fg"
                />
                {file && <span className="break-words text-xs text-subtle [overflow-wrap:anywhere]">{file.name}</span>}
              </div>
            ) : (
              <Textarea
                label={formato === 'gift' ? 'Texto GIFT' : 'Texto da planilha (com o cabeçalho)'}
                value={text}
                rows={8}
                placeholder={formato === 'gift' ? 'Qual porta o HTTP usa? {=80 ~21 ~22}' : 'Categoria;Tipo;Enunciado;Alternativa A;Alternativa B;Correta'}
                onChange={(event) => { reset(); setText(event.target.value) }}
              />
            )}
            {formato === 'gift' ? (
              <p className="text-xs text-subtle">
                GIFT: uma questão por bloco, com uma linha em branco entre elas. {'{=certa ~errada}'} é uma correta, {'{~%50%A ~%50%B ~%-100%C}'} várias corretas, {'{T}'} ou {'{F}'} verdadeiro ou falso, {'{#3.5:0.1}'} numérica, {'{=resposta =outra}'} resposta curta e {'{}'} dissertativa. No Moodle, use Banco de questões &gt; Exportar &gt; Formato GIFT.
              </p>
            ) : (
              <p className="text-xs text-subtle">
                Planilha: a primeira linha é o cabeçalho, com Enunciado e, se quiser, Categoria, Tipo, Alternativa A a H, Correta (B, ou A, C), Pontos, Valor, Tolerância, Unidade, Respostas aceitas, Revisão, Resposta esperada, Rubrica, Explicação, Dificuldade, Habilidades, Etiquetas e Pontuação parcial. Listas separadas por “|” (para um “|” dentro do item, escreva “\|”). Para ter o modelo, exporte o banco em planilha.
              </p>
            )}
          </>
        )}

        {error && <p role="alert" className="break-words rounded-md border border-danger/50 bg-danger-soft px-3 py-2 text-sm text-danger [overflow-wrap:anywhere]">{error}</p>}

        {preview && (
          <div className="min-w-0 space-y-3">
            <p role="status" className="text-sm font-medium text-text">{importSummaryText(preview)}</p>
            {errors.length > 0 && (
              <details className="rounded-md border border-danger/40 px-3 py-2 text-sm" open={errors.length <= 5}>
                <summary className="cursor-pointer font-medium text-danger">{plural(errors.length, 'questão com erro fica', 'questões com erro ficam')} de fora</summary>
                <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto" aria-label="Erros da importação">
                  {errors.map((item, index) => <li key={`${item.linha}-${index}`} className="break-words text-xs text-text [overflow-wrap:anywhere]">Linha {item.linha}: {item.mensagem}</li>)}
                </ul>
              </details>
            )}
            {warnings.length > 0 && (
              <ul className="space-y-1" aria-label="Avisos do arquivo">
                {warnings.map((item, index) => <li key={`${item.linha}-${index}`} className="break-words text-xs text-warning [overflow-wrap:anywhere]">{item.mensagem}</li>)}
              </ul>
            )}
            {Number(preview.duplicadas) > 0 && (
              <Switch
                id="banco-importar-repetidas"
                checked={includeDuplicates}
                onChange={setIncludeDuplicates}
                label={`Importar também as repetidas (${preview.duplicadas})`}
              />
            )}
            <ul className="max-h-[50vh] space-y-2 overflow-y-auto overflow-x-hidden" aria-label="Questões do arquivo">
              {shown.map((item) => {
                const answer = answerSummary(item)
                const duplicate = importDuplicateText(item)
                return (
                  <li key={item.linha} className={`min-w-0 space-y-1 rounded-lg border p-3 ${item.duplicada ? 'border-dashed border-border bg-surface-2/50' : 'border-border'}`} aria-label={`Linha ${item.linha}`}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="info">{questionTypeLabel(item.type)}</Badge>
                      {duplicate && <Badge tone="warning">{duplicate}</Badge>}
                      <span className="text-xs text-muted">{formatPointsLabel(item.points ?? 1)}</span>
                      <span className="text-xs text-subtle">Linha {item.linha}</span>
                    </div>
                    <p className="break-words text-sm text-text [overflow-wrap:anywhere]">{bankExcerpt(item.questionText) || 'Questão sem enunciado'}</p>
                    <p className="break-words text-xs text-subtle [overflow-wrap:anywhere]">{item.category}{answer ? ` · resposta ${answer}` : ''}{item.tags?.length ? ` · ${item.tags.join(', ')}` : ''}</p>
                    {(item.avisos || []).map((warning) => <p key={warning} className="break-words text-xs text-warning [overflow-wrap:anywhere]">{warning}</p>)}
                  </li>
                )
              })}
            </ul>
            {items.length > shown.length && <p className="text-xs text-subtle">E mais {plural(items.length - shown.length, 'questão', 'questões')} no arquivo.</p>}
          </div>
        )}
      </div>
    </Modal>
  )
}

// Exportar as questões da lista (com os filtros de agora) em GIFT ou planilha CSV.
export function QuestionExportDialog({ open, onClose, filters, questions = [] }) {
  const toast = useToast()
  const [busy, setBusy] = useState('')
  const total = Array.isArray(questions) ? questions.length : 0
  const withImages = questionsWithImages(questions)

  async function download(formato) {
    setBusy(formato)
    try {
      const name = await downloadFile(bankExportPath(filters, formato), formato === 'gift' ? 'banco-de-questoes.gift.txt' : 'banco-de-questoes.csv')
      toast.success(`Arquivo ${name} baixado`)
      onClose?.()
    } catch (downloadError) {
      toast.error(downloadError.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose?.() }}
      title="Exportar questões"
      description={`Leva as ${plural(total, 'questão', 'questões')} da lista, com os filtros de agora.`}
      footer={<Button variant="ghost" onClick={() => onClose?.()} disabled={!!busy}>Fechar</Button>}
    >
      <div className="min-w-0 space-y-3 text-sm text-text">
        <p><strong>GIFT</strong>: para importar no Moodle (Banco de questões &gt; Importar &gt; GIFT) ou em outro IClass, sem perder pontos, dificuldade nem rubrica.</p>
        <p><strong>Planilha (CSV)</strong>: abre no Excel, com uma questão por linha; dá para editar e importar de volta.</p>
        {withImages > 0 && (
          <p className="rounded-md border border-warning/50 bg-warning-soft px-3 py-2 text-xs text-warning">
            {withImages === 1 ? '1 questão tem imagem' : `${withImages} questões têm imagem`}: o arquivo leva só o endereço da imagem, que não abre em outro computador. Em outro lugar, envie a imagem de novo pelo editor.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {BANK_IMPORT_FORMATS.map((option) => (
            <Button key={option.value} variant="secondary" icon={Download} loading={busy === option.value} disabled={!!busy || total === 0} onClick={() => download(option.value)}>
              {option.exportLabel}
            </Button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
