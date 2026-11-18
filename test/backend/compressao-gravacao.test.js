// Junção J1 da fase 2: compressão (H2-A) e resposta depois do COMMIT (H1-a) no createApp
// de verdade. O teste do H2-A simulava o persistenceContext; aqui a rota é real
// (POST /api/admin/forum/all migra dúvidas antigas e grava sem esperar), a gravação é a do
// motor real e a trava é a de outro programa segurando o arquivo (BEGIN IMMEDIATE).
// A compressão fica antes do persistenceContext (passos 6 e 8 do contrato): o envio dele
// espera o COMMIT, decide entre 200 e 503 e só então a compressão vê o que sai. Se a ordem
// fosse a contrária, o 503 sairia com o Content-Encoding e o tamanho do 200 comprimido.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-compressao-gravacao-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';
// Trava longa vira 503 em cerca de 1 s (o padrão é 5 s).
process.env.ICLASS_DB_BUSY_TIMEOUT_MS = '1000';
process.env.ICLASS_VERIFY_SAVES = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession } = require('../../backend/utils/authSessions.js');

const databaseFile = path.join(tempRoot, 'database.db');
const WRITE_ERROR = 'Não foi possível gravar os dados agora. Tente de novo em alguns segundos.';
const courseId = 'curso-juncao';
const className = 'TURMA J1';
const COMMENTS = 30;

let server;
let baseUrl;
let adminToken;

function raw(method, urlPath, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request(`${baseUrl}${urlPath}`, {
            method,
            headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers },
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// Corpo como o navegador o lê: descomprime só se o Content-Encoding diz gzip (e falha se
// os bytes não forem gzip de verdade).
function decoded(res) {
    return res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(res.body).toString('utf8') : res.body.toString('utf8');
}

function openConnection() {
    return new sqlite3.Database(databaseFile);
}

function exec(connection, sql) {
    return new Promise((resolve, reject) => connection.exec(sql, err => (err ? reject(err) : resolve())));
}

async function holdWriteLock() {
    const connection = openConnection();
    await exec(connection, 'BEGIN IMMEDIATE');
    let released = false;
    return async () => {
        if (released) return;
        released = true;
        await exec(connection, 'COMMIT');
        await new Promise(resolve => connection.close(() => resolve()));
    };
}

async function forumRowOnDisk(id) {
    const reader = openConnection();
    try {
        const row = await new Promise((resolve, reject) => reader.get('SELECT value FROM forum WHERE key = ?', [id], (err, value) => (err ? reject(err) : resolve(value))));
        return row ? JSON.parse(row.value) : null;
    } finally {
        await new Promise(resolve => reader.close(() => resolve()));
    }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Dúvidas antigas (sem curso e turma): a listagem do professor as migra para a turma do
// aluno e grava sem esperar (db.save() sem await), então quem segura a resposta é o
// persistenceContext. Texto longo para a resposta passar de 1 KB e ser comprimida.
function legacyComments(prefix) {
    return Array.from({ length: COMMENTS }, (_, index) => ({
        id: `${prefix}-${index}`,
        key: 'geral',
        studentEmail: 'aluna@juncao.local',
        studentName: 'Aluna da Junção',
        text: `Dúvida ${index}: como a gravação e a compressão convivem na rede da sala? `.repeat(3),
        createdAt: new Date().toISOString(),
        replies: [],
    }));
}

function listForum() {
    return raw('POST', '/api/admin/forum/all', {
        headers: { 'x-admin-session': adminToken, 'Accept-Encoding': 'gzip, deflate, br' },
        body: { courseId, studentClass: className },
    });
}

test.before(async () => {
    await db.init();
    db.memory.admins = [{ email: 'admin@juncao.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') }];
    adminToken = createAdminSession(db.memory, 'admin@juncao.local');
    db.memory.courses = [{ id: courseId, name: 'Curso da junção', structure: [{ id: 'mod-1', title: 'Módulo 1', units: [] }] }];
    db.memory.classes = [{ name: className, courseId, period: 'Manhã', onlineExamConfigs: {} }];
    db.memory.students = [{ name: 'Aluna da Junção', email: 'aluna@juncao.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: className, courseId }] }];
    db.memory.forum = [];
    await db.save();
    server = await new Promise(resolve => { const listening = createApp().listen(0, '127.0.0.1', () => resolve(listening)); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.clearSaveVerifyFailures();
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-DESEMPENHO-001] [UC-GRAVACAO-001] resposta grande que espera o COMMIT sai em gzip e a gravação já está no arquivo', async () => {
    db.memory.forum = legacyComments('ok');
    const response = await listForum();
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.match(String(response.headers.vary || ''), /Accept-Encoding/i);
    assert.equal(Number(response.headers['content-length']), response.body.length);
    assert.equal(response.headers['cache-control'], 'no-store');
    const body = JSON.parse(decoded(response));
    assert.equal(body.comments.length, COMMENTS);
    assert.ok(response.body.length < Buffer.byteLength(decoded(response)) / 2, 'o JSON foi de fato comprimido');
    // A migração gravada sem await já está no disco quando o 200 chega (COMMIT antes).
    const onDisk = await forumRowOnDisk('ok-0');
    assert.equal(onDisk.courseId, courseId);
    assert.equal(onDisk.studentClass, className);
});

test('[UC-DESEMPENHO-001] [UC-GRAVACAO-001] gravação que falha depois de a rota responder: 503 retryable íntegro com gzip, servidor de pé e regravação depois', async () => {
    db.memory.forum = legacyComments('trava');
    const release = await holdWriteLock();
    let response;
    let elapsed;
    try {
        const started = performance.now();
        response = await listForum();
        elapsed = performance.now() - started;
    } finally {
        await release();
    }
    // O 503 é o do contrato, não o 200 comprimido com outro status: os cabeçalhos são os
    // do corpo que saiu (sem gzip, porque o 503 é pequeno), e nada da listagem vazou.
    assert.equal(response.status, 503);
    assert.ok(elapsed >= 900, `esperou a trava (${Math.round(elapsed)} ms)`);
    assert.equal(Number(response.headers['content-length']), response.body.length);
    const text = decoded(response);
    const body = JSON.parse(text);
    assert.deepEqual({ success: body.success, error: body.error, retryable: body.retryable }, { success: false, error: WRITE_ERROR, retryable: true });
    assert.doesNotMatch(text, /Dúvida 1/);
    assert.ok(response.headers['x-request-id']);
    assert.equal(response.headers['cache-control'], 'no-store');

    // O servidor continua respondendo e a sessão do professor continua valendo.
    const after = await raw('GET', '/api/admin/settings', { headers: { 'x-admin-session': adminToken, 'Accept-Encoding': 'gzip' } });
    assert.equal(after.status, 200);
    assert.equal(typeof JSON.parse(decoded(after)), 'object');

    // Sem novo pedido: a regravação em segundo plano leva a migração para o disco.
    const started = Date.now();
    while (Date.now() - started < 9000) {
        const row = await forumRowOnDisk('trava-0');
        if (row && row.courseId === courseId) break;
        await wait(100);
    }
    const row = await forumRowOnDisk('trava-0');
    assert.ok(row, 'a dúvida migrada foi gravada depois que a trava saiu');
    assert.equal(row.courseId, courseId);
    assert.equal(db.storageStatus().pendingRetry, false);
});
