import { useId } from 'react'
import { Input } from './Input'

// Confirmação digitada das ações que não têm volta (LIMPAR, RESETAR, RESTAURAR e, nas
// próximas telas, REINICIAR, COMPACTAR, ANONIMIZAR e APAGAR): o botão da ação só
// funciona com a palavra certa, e o servidor confere de novo. A comparação ignora
// espaços nas pontas e maiúsculas/minúsculas, como o servidor.
export function typedConfirmMatches(value, word) {
  const expected = String(word ?? '').trim().toUpperCase()
  return !!expected && String(value ?? '').trim().toUpperCase() === expected
}

// - word: a palavra pedida; value/onChange: o texto digitado (controlado por quem usa);
// - description: o que acontece, numa linha acima do campo (opcional);
// - onConfirm: chamado com Enter quando a palavra está certa (o mesmo que o botão faz).
export function TypedConfirm({ id, word, value, onChange, description, onConfirm, disabled = false, autoFocus = false }) {
  const generatedId = useId()
  const fieldId = id || generatedId
  const descriptionId = `${fieldId}-descricao`
  return (
    <div className="space-y-2">
      {description && <p id={descriptionId} className="text-sm text-text">{description}</p>}
      <p className="text-sm text-muted">Digite <b className="text-text font-mono">{word}</b> para confirmar.</p>
      <Input
        id={fieldId}
        aria-label={`Digite ${word} para confirmar`}
        aria-describedby={description ? descriptionId : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || typeof onConfirm !== 'function') return
          event.preventDefault()
          if (!disabled && typedConfirmMatches(value, word)) onConfirm()
        }}
        placeholder={word}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        disabled={disabled}
        autoFocus={autoFocus}
      />
    </div>
  )
}
