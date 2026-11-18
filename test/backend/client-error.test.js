// Erro de tela registrado no servidor (fase 2, H9c: ENG-05). A área de erro dos layouts
// e a tela de erro da raiz (web/src/lib/clientErrors.js) avisam POST /api/client-error,
// que grava a linha "erro de tela" no crash.log da pasta de dados. Pede sessão, confere
// os campos e aceita até 10 avisos por minuto por e-mail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-client-error-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { DEMO_ACCOUNTS } = require('../../backend/utils/demoAccounts.js');

const ADMIN_TOKEN = 'h9c-admin-token';
const PROFESSOR_TOKEN = 'h9c-professor-token';
const STUDENT_TOKEN = 'h9c-student-token';
const crashLog = () => {
    try { return fs.readFileSync(path.join(tempRoot, 'crash.log'), 'utf8'); } catch { return ''; }
};

let app;

function openSessions() {
    const now = Date.now();
    db.memory.adminSessions = {
        [ADMIN_TOKEN]: { email: DEMO_ACCOUNTS.admin.email, createdAt: now, lastSeen: now },
        [PROFESSOR_TOKEN]: { email: DEMO_ACCOUNTS.professor.email, createdAt: now, lastSeen: now },
    };
    db.memory.sessions = {
        [DEMO_ACCOUNTS.student.email]: { token: STUDENT_TOKEN, createdAt: now, lastSeen: now, ip: '127.0.0.1' },
    };
}

test.before(async () => {
    await db.init();
    app = createApp();
    const seeded = await request(app).post('/api/test/seed');
    assert.equal(seeded.status, 200);
    openSessions();
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-ERRO-002] sem sessão o aviso de erro de tela responde 401 e não grava nada', async () => {
    const before = crashLog();
    const res = await request(app).post('/api/client-error').send({ area: 'aluno', message: 'Falhou', path: '/aluno' });
    assert.equal(res.status, 401);
    assert.equal(crashLog(), before);
});

test('[UC-ERRO-002] com sessão de aluno responde 204 e grava a linha "erro de tela" com área, caminho, build e quem estava na tela', async () => {
    openSessions();
    const res = await request(app).post('/api/client-error').set('x-session-token', STUDENT_TOKEN)
        .send({ area: 'aluno', message: "Cannot read properties of undefined (reading 'nome')", path: '/aluno/caderno', build: 'build-de-teste-1' });
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal(res.text, '');
    const log = crashLog();
    const block = log.split(/\n(?=\[\d{4}-)/).find(entry => entry.includes('erro de tela') && entry.includes('build-de-teste-1')) || '';
    assert.match(block, /^\n?\[\d{4}-[^\]]+\] erro de tela [0-9a-f]{8} POST \/api\/client-error \(aluno [^)]+\)/);
    assert.ok(block.includes(`(aluno ${DEMO_ACCOUNTS.student.email})`), block);
    assert.ok(block.includes("Cannot read properties of undefined (reading 'nome')"), block);
    assert.ok(block.includes('  área: aluno'), block);
    assert.ok(block.includes('  caminho: /aluno/caderno'), block);
    assert.ok(block.includes('  build: build-de-teste-1'), block);
    // O stack do servidor não diz nada sobre o erro do navegador e não vai junto.
    assert.doesNotMatch(block, /\n\s+at /);
});

test('[UC-ERRO-002] o instrutor também avisa (painel), e o aviso não precisa de build', async () => {
    openSessions();
    const res = await request(app).post('/api/client-error').set('x-admin-session', ADMIN_TOKEN)
        .send({ area: 'admin', message: 'Erro interno da tela', path: '/monitor' });
    assert.equal(res.status, 204);
    const log = crashLog();
    assert.ok(log.includes(`(instrutor ${DEMO_ACCOUNTS.admin.email})`), log);
    assert.ok(log.includes('  caminho: /monitor'), log);
});

test('[UC-ERRO-002] campos conferidos: área fora da lista, tipo errado, tamanho e corpo que não é objeto respondem 400 com o campo', async () => {
    openSessions();
    const send = (body) => request(app).post('/api/client-error').set('x-admin-session', ADMIN_TOKEN).send(body);
    const before = crashLog();

    let res = await send({ area: 'painel', message: 'x' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, field: 'area', error: 'O campo "área" tem um valor não permitido.' });

    res = await send({ message: 'x' });
    assert.deepEqual(res.body, { success: false, field: 'area', error: 'O campo "área" é obrigatório.' });

    res = await send({ area: 'admin' });
    assert.deepEqual(res.body, { success: false, field: 'message', error: 'O campo "mensagem" é obrigatório.' });

    res = await send({ area: 'admin', message: { texto: 'x' } });
    assert.deepEqual(res.body, { success: false, field: 'message', error: 'O campo "mensagem" está em formato inválido.' });

    res = await send({ area: 'admin', message: 'x'.repeat(301) });
    assert.deepEqual(res.body, { success: false, field: 'message', error: 'O campo "mensagem" aceita no máximo 300 caracteres.' });

    res = await send({ area: 'admin', message: 'x', path: `/${'p'.repeat(200)}` });
    assert.deepEqual(res.body, { success: false, field: 'path', error: 'O campo "caminho" aceita no máximo 200 caracteres.' });

    res = await send({ area: 'admin', message: 'x', build: 'b'.repeat(65) });
    assert.deepEqual(res.body, { success: false, field: 'build', error: 'O campo "versão" aceita no máximo 64 caracteres.' });

    res = await send([{ area: 'admin', message: 'x' }]);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, error: 'Dados enviados em formato inválido.' });

    assert.equal(crashLog(), before, 'aviso recusado não vai para o crash.log');
});

test('[UC-ERRO-002] texto do navegador não forja bloco no crash.log: quebras de linha e caracteres de controle viram uma linha só', async () => {
    openSessions();
    const forged = `[${new Date().toISOString()}] unhandledRejection deadbeef GET /api/admin/backup (instrutor ${DEMO_ACCOUNTS.admin.email})`;
    const res = await request(app).post('/api/client-error').set('x-session-token', STUDENT_TOKEN)
        .send({
            area: 'aluno',
            message: `Falha comum\n\n${forged}\nError: senha do admin vazou`,
            path: `/aluno\r\n${forged}`,
            build: 'injecao\u2028[2026-01-01T00:00:00.000Z] x\u001b[31m',
        });
    assert.equal(res.status, 204, JSON.stringify(res.body));
    const log = crashLog();
    // Antes, a mensagem ia crua para o arquivo e a linha forjada virava um bloco à parte,
    // com o cabeçalho do instrutor. Agora só os cabeçalhos de verdade começam com "[".
    const headerLines = log.split('\n').filter(line => line.startsWith('['));
    assert.ok(headerLines.length > 0);
    for (const line of headerLines) {
        assert.match(line, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] erro de tela [0-9a-f]{8} POST \/api\/client-error \((aluno|instrutor) [^)]+\)$/, line);
    }
    const block = log.split(/\n(?=\[\d{4}-)/).find(entry => entry.includes('Falha comum')) || '';
    assert.ok(block.includes(`(aluno ${DEMO_ACCOUNTS.student.email})`), block);
    assert.ok(block.includes(`Falha comum ${forged} Error: senha do admin vazou`), block);
    assert.ok(block.includes(`  caminho: /aluno ${forged}`), block);
    assert.ok(block.includes('  build: injecao [2026-01-01T00:00:00.000Z] x[31m'), block);
    assert.doesNotMatch(log, /\r|\u2028|\u001b/);
    assert.ok(!log.split(/\n(?=\[\d{4}-)/).some(entry => /^\n?\[[^\]]+\] unhandledRejection/.test(entry)), 'nenhum bloco forjado');
});

test('[UC-ERRO-002] aviso recusado (400) não conta no limite de 10 por minuto', async () => {
    openSessions();
    const send = (body) => request(app).post('/api/client-error').set('x-admin-session', ADMIN_TOKEN).send(body);
    for (let index = 0; index < 12; index += 1) {
        const res = await send({ area: 'painel', message: 'x' });
        assert.equal(res.status, 400, `recusado ${index + 1}`);
    }
    // Antes, os recusados contavam e o aviso de verdade levava 429.
    const ok = await send({ area: 'admin', message: 'Erro de verdade depois dos recusados', path: '/turmas' });
    assert.equal(ok.status, 204, JSON.stringify(ok.body));
});

test('[UC-ERRO-002] no máximo 10 avisos por minuto por e-mail: o 11º responde 429', async () => {
    openSessions();
    const send = (token) => request(app).post('/api/client-error').set('x-admin-session', token)
        .send({ area: 'admin', message: 'Erro em laço', path: '/alunos' });
    for (let index = 0; index < 10; index += 1) {
        const res = await send(PROFESSOR_TOKEN);
        assert.equal(res.status, 204, `aviso ${index + 1}`);
    }
    const blocked = await send(PROFESSOR_TOKEN);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.success, false);
    assert.equal(blocked.body.error, 'Muitos avisos de erro seguidos. Aguarde um instante.');
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
    // O limite é por e-mail: o aluno continua avisando.
    const other = await request(app).post('/api/client-error').set('x-session-token', STUDENT_TOKEN)
        .send({ area: 'aluno', message: 'Outro erro', path: '/aluno' });
    assert.equal(other.status, 204);
});
