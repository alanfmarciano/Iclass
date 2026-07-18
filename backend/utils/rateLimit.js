// Rate limiter em memória (sem dependências), por chave. Janela fixa simples.
// Uso local-first: protege login e validação de token de prova contra força
// bruta na rede da sala, sem afetar o uso legítimo (limites generosos).
const buckets = new Map();

// Retorna { allowed, remaining, retryAfterMs }. Conta a tentativa atual.
function rateLimit(key, { max = 30, windowMs = 60000 } = {}) {
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry || now > entry.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: max - 1, retryAfterMs: 0 };
    }
    if (entry.count >= max) {
        return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
    }
    entry.count += 1;
    return { allowed: true, remaining: max - entry.count, retryAfterMs: 0 };
}

// Limpeza periódica para não acumular chaves expiradas. unref() para não
// impedir o processo de encerrar.
const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
        if (now > entry.resetAt) buckets.delete(key);
    }
}, 5 * 60 * 1000);
if (typeof cleanup.unref === 'function') cleanup.unref();

module.exports = { rateLimit };
