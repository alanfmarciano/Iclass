// Chave da cópia local cifrada das respostas da prova (AVA-11).
// Cada tentativa tem uma chave aleatória de 32 bytes, gerada e guardada só no servidor
// junto da tentativa. Ela é entregue apenas ao dono da sessão enquanto a tentativa
// está aberta (start-attempt e sync); o navegador cifra a cópia das respostas com ela
// (AES-GCM) e nunca a grava: ao recarregar a página, pede de novo. Quando a tentativa
// vira entrega, o estado (e a chave) some do servidor e a cópia deixa de ser legível.
const crypto = require('crypto');
const { CLOSED_ATTEMPT_STATUSES } = require('./examApplications.js');

const LOCAL_COPY_KEY_BYTES = 32;
const LOCAL_COPY_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

function isValidLocalCopyKey(value) {
    return typeof value === 'string' && LOCAL_COPY_KEY_PATTERN.test(value);
}

// Tentativa que pode receber a chave: vinculada a uma aplicação, iniciada e ainda sem entrega.
function attemptAcceptsLocalCopy(state) {
    return !!(state
        && typeof state === 'object'
        && state.applicationId
        && state.startedAt
        && !CLOSED_ATTEMPT_STATUSES.has(state.status));
}

// Gera a chave da tentativa (uma vez). Devolve true quando gravou uma chave nova
// (tentativas iniciadas antes desta versão ganham a chave no primeiro sync).
function ensureLocalCopyKey(state) {
    if (!attemptAcceptsLocalCopy(state)) return false;
    if (isValidLocalCopyKey(state.localCopyKey)) return false;
    state.localCopyKey = crypto.randomBytes(LOCAL_COPY_KEY_BYTES).toString('base64');
    return true;
}

function localCopyKeyFor(state) {
    return attemptAcceptsLocalCopy(state) && isValidLocalCopyKey(state.localCopyKey) ? state.localCopyKey : null;
}

// Estado da tentativa sem a chave (e sem a flag interna do token) para respostas da API:
// a chave só sai no campo próprio, para o dono da tentativa. De uma tentativa reaberta
// pelo "+N min" da turma o aluno só vê quando foi reaberta (reopenedAt): a entrega
// guardada (com a nota ainda não publicada) e o histórico são do professor.
function stateWithoutSecrets(state) {
    if (!state || typeof state !== 'object') return state;
    const { localCopyKey, tokenValidated, reopenedBy, reopenedFrom, reopenedDelivery, pageExit, ...safeState } = state;
    return safeState;
}

module.exports = {
    LOCAL_COPY_KEY_BYTES,
    attemptAcceptsLocalCopy,
    ensureLocalCopyKey,
    isValidLocalCopyKey,
    localCopyKeyFor,
    stateWithoutSecrets,
};
