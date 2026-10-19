// Registro único de falhas do servidor em DATA_DIR/crash.log (ENG-04, CONF-13 parcial).
// Só logError escreve nesse arquivo: erro 500 de rota (com o código do erro que a tela
// mostra), exceção não tratada, falha de gravação e erro de tela. Cada registro é um
// bloco: a linha "[ISO] <tipo> <código> <MÉTODO> <caminho> (<papel> <e-mail>)" seguida
// do stack. Nunca grava corpo nem query string do pedido (podem trazer senha ou
// ?access=). Ao passar de 5 MB o arquivo vira crash.log.1 (substitui o anterior), para
// uma rajada de erros não encher o disco.
const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtimePaths.js');

const CRASH_LOG_MAX_BYTES = 5 * 1024 * 1024;
// Teto de um bloco: uma mensagem de erro com um texto enorme dentro não vira 5 MB.
const MAX_DETAIL_CHARS = 32 * 1024;

function crashLogPath() {
    return path.join(runtimePaths.DATA_DIR, 'crash.log');
}

function oneLine(value) {
    return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}

// Caminho do pedido sem a query string (req.path é relativo ao ponto de montagem do
// router; originalUrl traz o caminho inteiro).
function requestPath(req) {
    const raw = String((req && (req.originalUrl || req.url)) || '');
    return raw.split('?')[0];
}

// Quem fez o pedido, pelo que a validação de sessão já deixou no req.
function requestActor(req) {
    if (!req || typeof req !== 'object') return null;
    if (req.adminAccount && req.adminAccount.email) {
        return { role: req.adminAccount.role || 'instrutor', email: req.adminAccount.email };
    }
    if (req.studentEmail) return { role: 'aluno', email: req.studentEmail };
    if (req.auth && req.auth.email) return { role: req.auth.role === 'student' ? 'aluno' : (req.auth.role || 'instrutor'), email: req.auth.email };
    if (req.requester && req.requester.email) return { role: req.requester.role === 'student' ? 'aluno' : 'instrutor', email: req.requester.email };
    return null;
}

function errorDetail(err) {
    let detail;
    if (err && typeof err === 'object' && err.stack) detail = String(err.stack);
    else if (err && typeof err === 'object' && err.message) detail = String(err.message);
    else detail = String(err);
    return detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS)}\n[... cortado]` : detail;
}

function errorSummary(err) {
    if (err && typeof err === 'object' && err.message) return oneLine(err.message).slice(0, 300);
    return oneLine(err).slice(0, 300);
}

function detailsLines(details) {
    if (!details || typeof details !== 'object') return '';
    return Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `  ${oneLine(key)}: ${oneLine(typeof value === 'object' ? JSON.stringify(value) : value).slice(0, 500)}`)
        .join('\n');
}

// Gira o arquivo quando passa do limite. Devolve false quando não deve gravar: o
// arquivo está preso por outro programa (Windows) e já passou do dobro do limite.
function rotateIfNeeded(file) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch (error) { return true; }
    if (size <= CRASH_LOG_MAX_BYTES) return true;
    try { fs.renameSync(file, `${file}.1`); return true; } catch (error) { /* tenta apagar o .1 antes */ }
    try {
        fs.rmSync(`${file}.1`, { force: true });
        fs.renameSync(file, `${file}.1`);
        return true;
    } catch (error) { /* sem girar: cresce só até o dobro */ }
    return size < CRASH_LOG_MAX_BYTES * 2;
}

// logError(kind, err, ctx): ctx = { req, requestId, method, path, role, email, details }.
// `details` (objeto simples) vira linhas "chave: valor" depois do stack. Nunca lança.
function logError(kind, err, ctx = {}) {
    try {
        const context = ctx && typeof ctx === 'object' ? ctx : {};
        const req = context.req;
        const requestId = context.requestId || (req && req.id) || '';
        const method = context.method || (req && req.method) || '';
        const pathName = context.path || (req ? requestPath(req) : '');
        const actor = (context.role || context.email)
            ? { role: context.role || '', email: context.email || '' }
            : requestActor(req);
        const parts = [`[${new Date().toISOString()}]`, oneLine(kind) || 'erro'];
        if (requestId) parts.push(oneLine(requestId));
        if (method || pathName) parts.push(`${oneLine(method)} ${oneLine(pathName)}`.trim());
        if (actor && (actor.role || actor.email)) parts.push(`(${oneLine(`${actor.role || ''} ${actor.email || ''}`)})`);
        const header = parts.join(' ');
        const extra = detailsLines(context.details);
        const block = `\n${header}\n${errorDetail(err)}\n${extra ? `${extra}\n` : ''}`;

        const file = crashLogPath();
        try {
            if (rotateIfNeeded(file)) {
                try {
                    fs.appendFileSync(file, block);
                } catch (error) {
                    if (!error || error.code !== 'ENOENT') throw error;
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    fs.appendFileSync(file, block);
                }
            }
        } catch (error) { /* disco cheio ou sem permissão: fica só o console */ }
        console.error(`🛑 ${header.slice(header.indexOf(']') + 2)}: ${errorSummary(err)} (detalhes em crash.log)`);
    } catch (error) {
        // O registro nunca derruba quem chamou (nem o tratador de erros).
    }
}

module.exports = {
    CRASH_LOG_MAX_BYTES,
    crashLogPath,
    logError,
    requestActor,
};
