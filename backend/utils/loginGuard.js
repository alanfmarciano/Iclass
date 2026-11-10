// ---------------------------------------------------------------------------
// Atraso progressivo por conta no login (H5b; SEG-06, decisão 6 do Alan): sem trava
// definitiva, e o professor libera na hora.
//
// Chave: '<student|admin>:<e-mail em minúsculas>' (accountKey). Cada senha errada da
// conta conta uma falha (também a senha atual errada na troca de senha e o e-mail que
// não existe, para a resposta não revelar quais contas existem). Da 5.ª falha seguida em
// diante, a conta espera antes de tentar de novo: 30 s, 1, 2, 4 e 8 min, e depois 15 min
// a cada falha (30 s × 2^(n−5), no máximo 15 min). Durante a espera o login responde 429
// sem conferir a senha e sem contar outra falha. A senha certa zera a conta, e o
// "Liberar login" do professor (clear) também.
//
// Só na memória (Map): reiniciar o servidor zera tudo, e nada vai para o banco nem para
// o backup. Uma conta some 24 h depois da última falha; acima de 10.000 contas, sai a
// que errou há mais tempo (o Map guarda a ordem da última falha). Todas as funções
// aceitam `now`, para os testes.
// ---------------------------------------------------------------------------

const FAILURES_BEFORE_DELAY = 5;
const BASE_DELAY_MS = 30 * 1000;
const MAX_DELAY_MS = 15 * 60 * 1000;
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10000;

const entries = new Map();

function accountKey(kind, email) {
    const prefix = kind === 'admin' ? 'admin' : 'student';
    return `${prefix}:${String(email || '').trim().toLowerCase()}`;
}

// Espera depois da n-ésima falha seguida (0 antes da 5.ª).
function delayAfterFailures(failures) {
    const n = Number(failures) || 0;
    if (n < FAILURES_BEFORE_DELAY) return 0;
    return Math.min(BASE_DELAY_MS * (2 ** (n - FAILURES_BEFORE_DELAY)), MAX_DELAY_MS);
}

// Entrada viva da chave (a vencida sai na hora).
function liveEntry(key, now) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (now - entry.lastFailureAt > ENTRY_TTL_MS) {
        entries.delete(key);
        return null;
    }
    return entry;
}

// { delayed, retryAfterSeconds, retryAt, failures }: a conta está esperando agora?
function check(key, now = Date.now()) {
    const entry = liveEntry(key, now);
    if (!entry || !entry.retryAt || entry.retryAt <= now) {
        return { delayed: false, retryAfterSeconds: 0, retryAt: entry && entry.retryAt ? entry.retryAt : null, failures: entry ? entry.failures : 0 };
    }
    return {
        delayed: true,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.retryAt - now) / 1000)),
        retryAt: entry.retryAt,
        failures: entry.failures,
    };
}

function evictOldest() {
    while (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
    }
}

// Mais uma senha errada. Devolve o estado depois dela (como check).
function recordFailure(key, now = Date.now()) {
    const previous = liveEntry(key, now);
    const failures = (previous ? previous.failures : 0) + 1;
    const delay = delayAfterFailures(failures);
    const entry = { failures, lastFailureAt: now, retryAt: delay ? now + delay : null };
    // Apaga e grava de novo: a chave vai para o fim da ordem (a mais recente).
    entries.delete(key);
    entries.set(key, entry);
    evictOldest();
    return check(key, now);
}

function recordSuccess(key) {
    entries.delete(key);
}

// "Liberar login" do professor: a conta volta a entrar na hora. Devolve se havia algo.
function clear(key) {
    return entries.delete(key);
}

// Situação da conta para as telas (selo em Alunos e Contas, fila "Precisa de você"):
// { failures, retryAt } quando ela já chegou ao atraso (5 falhas ou mais) e ainda está
// na memória, ou null. retryAt pode já ter passado (a conta não espera mais, mas a
// próxima senha errada volta a atrasar).
function protectionFor(key, now = Date.now()) {
    const entry = liveEntry(key, now);
    if (!entry || entry.failures < FAILURES_BEFORE_DELAY) return null;
    return { failures: entry.failures, retryAt: entry.retryAt };
}

// E-mails (em minúsculas) das contas do tipo com atraso ativo ou já atingido.
function protectedEmails(kind, now = Date.now()) {
    const prefix = `${kind === 'admin' ? 'admin' : 'student'}:`;
    const emails = [];
    for (const key of [...entries.keys()]) {
        if (!key.startsWith(prefix)) continue;
        if (protectionFor(key, now)) emails.push(key.slice(prefix.length));
    }
    return emails;
}

function size() {
    return entries.size;
}

function resetForTests() {
    entries.clear();
}

module.exports = {
    FAILURES_BEFORE_DELAY,
    BASE_DELAY_MS,
    MAX_DELAY_MS,
    ENTRY_TTL_MS,
    MAX_ENTRIES,
    accountKey,
    delayAfterFailures,
    check,
    recordFailure,
    recordSuccess,
    clear,
    protectionFor,
    protectedEmails,
    size,
    resetForTests,
};
