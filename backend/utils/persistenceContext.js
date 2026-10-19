// Resposta só depois do COMMIT (fase 2, H1-a: CONF-04).
//
// Middleware montado no createApp logo depois do leitor de corpo (posição 8 do contrato),
// antes de qualquer rota ou guarda. Cada pedido roda dentro de um AsyncLocalStorage com
// { pending: [] }: todo db.save() chamado durante o pedido (com ou sem await, na rota,
// numa função de utils ou num callback) registra a promessa ali, a não ser que venha
// { detached: true }. res.send é envolvido: com gravações pendentes, a resposta espera
// todas; se alguma falhou (DbWriteError, code 'ICLASS_DB_WRITE'), sai o 503 retryable em
// vez do corpo original. res.json, res.sendStatus e res.jsonp passam por res.send.
// Antes, cerca de 105 gravações não eram aguardadas: o aluno recebia "salvo" com o dado
// ainda na fila e um kill -9 ou o Reiniciar o perdiam.
//
// O mesmo módulo guarda a foto da memória para o verificador de gravação parcial
// (ICLASS_VERIFY_SAVES, database.js).
const { AsyncLocalStorage, AsyncResource } = require('node:async_hooks');

const storage = new AsyncLocalStorage();
let apiRequestsInFlight = 0;
// Pedidos /api que já começaram (só cresce): o verificador sabe se outro pedido começou
// depois da foto deste.
let apiRequestStarts = 0;

// Verificador de gravação parcial: ligado no node --test (NODE_TEST_CONTEXT, que o
// executor define nos processos filhos) e com ICLASS_VERIFY_SAVES=1 (e2e);
// ICLASS_VERIFY_SAVES=0 desliga.
function verifySavesEnabled() {
    const flag = String(process.env.ICLASS_VERIFY_SAVES || '').trim();
    if (flag === '0') return false;
    return flag === '1' || !!process.env.NODE_TEST_CONTEXT;
}

// Contexto do pedido em andamento (null fora de pedido ou depois de a resposta sair).
function currentRequestContext() {
    const store = storage.getStore();
    return store && !store.finished ? store : null;
}

function apiRequestCount() {
    return apiRequestsInFlight;
}

// O pedido do contexto é o único /api desde a foto dele: nenhum outro estava em andamento
// quando ela foi tirada (sem isso não há foto), nenhum começou depois e só ele está em
// andamento. Com outro pedido no meio, a memória pode ter mudado por ele, e o verificador
// acusaria a alteração alheia.
function isSoleApiRequest(context) {
    return !!context && context.startSeq === apiRequestStarts && apiRequestsInFlight === 1;
}

// Callback entregue a terceiros (multer) que precisa continuar no contexto do pedido.
function bindToRequestContext(fn) {
    return AsyncResource.bind(fn);
}

function isApiPath(pathName) {
    return pathName === '/api' || String(pathName || '').startsWith('/api/');
}

// Envolve res.send: a resposta só sai depois das gravações do pedido.
function deferSendUntilCommitted(req, res, store, onWriteFailure) {
    const originalSend = res.send;
    let deferred = false;
    res.send = function sendAfterCommit(body) {
        // Uma resposta já espera o COMMIT: um segundo envio (rota que respondeu e depois
        // lançou) é ignorado, como seria com a primeira já enviada.
        if (deferred) return this;
        const pending = store.pending.splice(0);
        if (!pending.length || this.headersSent) return originalSend.call(this, body);
        deferred = true;
        const statusCode = this.statusCode;
        const contentType = this.get('Content-Type');
        Promise.allSettled(pending).then(results => {
            res.send = originalSend;
            if (res.headersSent || res.writableEnded) return;
            const failure = results.find(result => result.status === 'rejected'
                && result.reason && result.reason.code === 'ICLASS_DB_WRITE');
            // Falha de gravação: o "salvo" não pode sair. Recusa já prevista (4xx/5xx)
            // continua com a resposta dela.
            if (failure && statusCode < 400) {
                onWriteFailure(failure.reason, req, res);
                return;
            }
            res.statusCode = statusCode;
            if (contentType) res.set('Content-Type', contentType);
            originalSend.call(res, body);
        }).catch(err => {
            console.error(`⚠️ [GRAVAÇÃO] resposta de ${req.method} ${String(req.originalUrl || '').split('?')[0]} não pôde ser enviada: ${(err && err.message) || err}`);
        });
        return this;
    };
}

// createPersistenceContext({ snapshot, onWriteFailure })
// - snapshot(): foto da memória para o verificador (só chamada com ele ligado);
// - onWriteFailure(err, req, res): responde a falha de gravação (errorHandler: 503).
function createPersistenceContext({ snapshot, onWriteFailure }) {
    return function persistenceContext(req, res, next) {
        const pathName = String(req.originalUrl || req.url || '').split('?')[0];
        const isApi = isApiPath(pathName);
        const store = {
            pending: [],
            finished: false,
            method: req.method,
            path: pathName,
            snapshot: null,
            reported: new Set(),
            startSeq: 0,
        };
        if (isApi) {
            apiRequestsInFlight += 1;
            apiRequestStarts += 1;
            store.startSeq = apiRequestStarts;
        }
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            store.finished = true;
            store.snapshot = null;
            if (isApi) apiRequestsInFlight -= 1;
        };
        res.once('finish', finish);
        res.once('close', finish);
        // A foto só vale com este pedido sozinho: com outro /api em andamento a
        // verificação é pulada (o outro pedido pode mudar a memória ao mesmo tempo).
        if (isApi && apiRequestsInFlight === 1 && typeof snapshot === 'function' && verifySavesEnabled()) {
            try { store.snapshot = snapshot(); } catch (e) { store.snapshot = null; }
        }
        deferSendUntilCommitted(req, res, store, onWriteFailure);
        storage.run(store, next);
    };
}

module.exports = {
    apiRequestCount,
    bindToRequestContext,
    isSoleApiRequest,
    createPersistenceContext,
    currentRequestContext,
    verifySavesEnabled,
};
