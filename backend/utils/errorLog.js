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

// logError(kind, err, ctx): ctx = { req, requestId, method, path, role, email, details,
// printStack }. `details` (objeto simples) vira linhas "chave: valor" depois do stack.
// O console recebe uma linha-resumo; o bloco inteiro (com o stack) vai também para o
// console quando o arquivo não pôde ser gravado (disco cheio, arquivo preso) ou quando
// printStack é true (exceção não tratada, como fazia o logCrash). Devolve true se o
// bloco foi gravado no arquivo. Nunca lança.
function logError(kind, err, ctx = {}) {
    let written = false;
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
        const detail = `${errorDetail(err)}${extra ? `\n${extra}` : ''}`;
        const block = `\n${header}\n${detail}\n`;

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
                written = true;
            }
        } catch (error) { /* disco cheio ou sem permissão: o stack vai para o console abaixo */ }
        const summary = `🛑 ${header.slice(header.indexOf(']') + 2)}: ${errorSummary(err)}`;
        if (written && context.printStack !== true) console.error(`${summary} (detalhes em crash.log)`);
        else console.error(`${summary}${written ? ' (também em crash.log)' : ' (crash.log indisponível)'}\n${detail}`);
    } catch (error) {
        // O registro nunca derruba quem chamou (nem o tratador de erros).
    }
    return written;
}

// Última falha registrada (cartão Saúde do servidor, H3c): lê só o fim do arquivo (64 KB)
// e devolve { at, kind, summary } do último bloco, ou null. O cabeçalho do bloco é
// "[ISO] <tipo> ..." (logError acima); summary é a primeira linha do detalhe (a mensagem
// do erro), sem o e-mail de quem fez o pedido. Nunca lança.
const LAST_CRASH_READ_BYTES = 64 * 1024;

function readLastCrash({ file = crashLogPath() } = {}) {
    let text = '';
    try {
        const size = fs.statSync(file).size;
        if (!size) return null;
        const length = Math.min(size, LAST_CRASH_READ_BYTES);
        const buffer = Buffer.alloc(length);
        const descriptor = fs.openSync(file, 'r');
        try { fs.readSync(descriptor, buffer, 0, length, size - length); } finally { fs.closeSync(descriptor); }
        text = buffer.toString('utf8');
    } catch (error) {
        return null;
    }
    const lines = text.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const match = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\] (\S+)/.exec(lines[index]);
        if (!match) continue;
        const detail = lines.slice(index + 1).find(line => line.trim()) || '';
        return {
            at: match[1],
            kind: match[2],
            summary: oneLine(detail).slice(0, 300),
        };
    }
    return null;
}

module.exports = {
    CRASH_LOG_MAX_BYTES,
    crashLogPath,
    logError,
    readLastCrash,
    requestActor,
};
