// ---------------------------------------------------------------------------
// Trava em memória por aluno e tarefa (fase 3, P1; regras_comuns das rotas do desenho):
// tudo o que muda a entrega de um aluno numa tarefa (assignmentSubmissions, uma linha por
// assignmentId + studentEmail) roda um de cada vez para aquela chave. Usam a mesma trava o
// envio do aluno (C5, que espera o disco no meio da gravação) e as rotas do professor que
// mudam a entrega (C6: nota, devolução, refazer, "devolver todas", prorrogação e entrega
// em mãos). Sem ela, o professor que devolve enquanto a versão nova do aluno ainda está
// sendo gravada perdia a nota (a linha voltava como o aluno a tinha lido) ou nasciam duas
// linhas para o mesmo aluno.
//
// - submissionLockKey(assignmentId, studentEmail): a chave (e-mail em minúsculas).
// - withSubmissionLock(key, fn): roda fn depois de quem já está na fila daquela chave e
//   devolve a promessa do resultado dela (o erro de fn chega a quem chamou e não trava
//   os próximos).
// - withSubmissionLocks(keys, fn): várias chaves de uma vez ("devolver todas"), sempre em
//   ordem alfabética, para dois lotes nunca esperarem um pelo outro.
// - pendingLocks(): quantas chaves estão ocupadas; queuedLocks(): quantos pedidos esperam
//   a vez (testes).
// ---------------------------------------------------------------------------
const chains = new Map();
let queued = 0;

function submissionLockKey(assignmentId, studentEmail) {
    return `${String(assignmentId === undefined || assignmentId === null ? '' : assignmentId)}\u0000${String(studentEmail || '').trim().toLowerCase()}`;
}

function withSubmissionLock(key, fn) {
    const previous = chains.get(key) || Promise.resolve();
    queued += 1;
    const run = previous.then(() => { queued -= 1; return fn(); });
    const tail = run.then(() => {}, () => {});
    chains.set(key, tail);
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return run;
}

function withSubmissionLocks(keys, fn) {
    const sorted = [...new Set((keys || []).map(String))].sort();
    const step = index => (index >= sorted.length ? Promise.resolve().then(() => fn()) : withSubmissionLock(sorted[index], () => step(index + 1)));
    return step(0);
}

function pendingLocks() {
    return chains.size;
}

function queuedLocks() {
    return queued;
}

module.exports = { submissionLockKey, withSubmissionLock, withSubmissionLocks, pendingLocks, queuedLocks };
