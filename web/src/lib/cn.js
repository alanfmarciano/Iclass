// Junta classes condicionais (padrão simples, sem dependência externa).
export function cn(...parts) { return parts.filter(Boolean).join(' ') }
