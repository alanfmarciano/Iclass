// Rate limiter em memória (sem dependências), por chave. Janela fixa simples.
// Uso local-first: protege login e validação de token de prova contra força
// bruta na rede da sala, sem afetar o uso legítimo (limites generosos).
//
// - rateLimit(key, opts) / hit(key, opts): conta esta chamada e diz se ela cabe no teto;
// - peek(key, opts): só consulta, sem contar (o token da prova confere antes e conta
//   depois, só quando o código está errado: H5b, DES-X2);
// - reset(key): zera a chave (o token certo zera os erros do aluno).
// Tudo zera quando o servidor reinicia; nada vai para o banco nem para o backup.
const buckets = new Map();

function currentEntry(key, now) {
    const entry = buckets.get(key);
    if (!entry || now > entry.resetAt) return null;
    return entry;
}

// Retorna { allowed, remaining, retryAfterMs, count }. Conta a tentativa atual.
function hit(key, { max = 30, windowMs = 60000, now = Date.now() } = {}) {
    const entry = currentEntry(key, now);
    if (!entry) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: max - 1, retryAfterMs: 0, count: 1 };
    }
    if (entry.count >= max) {
        return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now, count: entry.count };
    }
    entry.count += 1;
    return { allowed: true, remaining: max - entry.count, retryAfterMs: 0, count: entry.count };
}

// Como hit, mas sem contar: { allowed, remaining, retryAfterMs, count }. allowed false
// quando a chave já chegou ao teto nesta janela.
function peek(key, { max = 30, now = Date.now() } = {}) {
    const entry = currentEntry(key, now);
    if (!entry) return { allowed: true, remaining: max, retryAfterMs: 0, count: 0 };
    if (entry.count >= max) return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now, count: entry.count };
    return { allowed: true, remaining: max - entry.count, retryAfterMs: 0, count: entry.count };
}

function reset(key) {
    return buckets.delete(key);
}

// Só nos testes: zera todos os contadores.
function resetForTests() {
    buckets.clear();
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

module.exports = { rateLimit: hit, hit, peek, reset, resetForTests };
