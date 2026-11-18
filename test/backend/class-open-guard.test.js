// Turma encerrada: o portão único das gravações de nota e presença (fundação C0b da
// fase 3; X4 do plano, contrato de backend/utils/academicCalendar.js).
//
// assertClassOpen nasce SEM EFEITO (toda turma está aberta) para as rotas de hoje que
// gravam nota ou presença já a chamarem antes de gravar; o B10 (P2-S9) liga o efeito
// (409 class_closed) e percorre estas mesmas rotas no teste de 409. Este teste:
// 1) 'rota que grava nota ou presença chama assertClassOpen': cada rota da lista chama a
//    função antes da primeira gravação; e nenhuma outra rota de backend/routes grava nota
//    (submissions) ou presença (attendance) sem chamar, a não ser as de FORA_DO_PORTAO,
//    cada uma com o motivo. Rota nova que grava nota, presença, diário, correção,
//    gabarito, anulação, importação de notas ou tarefa ganha linha em ROTAS_QUE_GRAVAM;
// 2) sem efeito: a função deixa gravar mesmo numa turma com encerramento, e as rotas
//    respondem como antes;
// 3) o formato da recusa que o B10 vai usar (409, code 'class_closed', em português).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-class-open-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const calendar = require('../../backend/utils/academicCalendar.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession } = require('../../backend/utils/authSessions.js');

const ROUTES_DIR = path.join(__dirname, '../../backend/routes');

// Rotas que gravam nota ou presença e chamam assertClassOpen antes de gravar.
// [arquivo, método, caminho]
const ROTAS_QUE_GRAVAM = [
    ['admin.js', 'POST', '/api/admin/submissions/result-control'],
    ['admin.js', 'POST', '/api/admin/submissions/publish'],
    ['admin.js', 'POST', '/api/admin/submissions/delete'],
    ['admin.js', 'POST', '/api/admin/submissions/restore'],
    ['admin.js', 'POST', '/api/admin/submissions/create'],
    ['admin.js', 'POST', '/api/admin/student/attendance/mark'],
    ['admin.js', 'POST', '/api/admin/attendance/bulk'],
];

// Rotas que gravam entregas ou presença e não passam pelo portão, com o motivo.
// [arquivo, método, caminho, motivo]
const FORA_DO_PORTAO = [
    ['student.js', 'POST', '/api/student/login', 'presença automática do login: é o aluno entrando, não lançamento do professor; turma encerrada deixa de ter alunos matriculados (histórico de matrícula do B10)'],
    ['student.js', 'GET', '/api/ping', 'mesma presença automática do login, para a sessão que já estava aberta'],
    ['student.js', 'POST', '/api/student/submit', 'entrega da prova pelo aluno: só existe com aplicação aberta, e o encerramento da turma não deixa aplicação aberta; recusar perderia as respostas'],
    ['adminExamConfig.js', 'POST', '/api/admin/exam-applications/:applicationId/control', 'encerrar a aplicação entrega o que os alunos já fizeram; recusar deixaria a prova aberta (as ações por aluno do Monitor que mexem em nota nascem chamando, A4)'],
    ['adminExamConfig.js', 'POST', '/api/admin/exam-applications/:applicationId/access-token', 'token novo da aplicação em andamento: a gravação parcial do Monitor leva as entregas na lista, mas a rota não mexe em nota'],
    ['adminExamConfig.js', 'POST', '/api/admin/exam-applications/:applicationId/time-adjustment', 'tempo a mais devolve a tentativa entregue pelo fim do tempo para o aluno continuar a prova em andamento'],
    ['adminArchive.js', 'POST', '/api/admin/courses/:id/purge', 'arquivar o curso inteiro leva as notas para o pacote do curso; não é mudança de nota'],
    ['adminArchive.js', 'POST', '/api/admin/archived-courses/restore', 'restaurar o curso arquivado devolve as notas como estavam'],
];

// Sinais de gravação de nota ou presença no corpo de uma rota.
const WRITE_MARKERS = [
    /writeJSON\(\s*DB_SUBMISSIONS_FILE/,
    /\.submissions\.push\(/,
    /\.submissions\s*=\s*(?!\s*\[\s*\])/,
    /\.attendance\.push\(/,
    /\.attendance\s*=\s*(?!\s*\[\s*\])/,
    /only:\s*\[[^\]]*['"](?:submissions|attendance)['"]/,
    /saveApplicationAction\(/,
];

const ROUTE_START = /^[ \t]*router\.(get|post|put|patch|delete)\(\s*(?:\[\s*)?['"]([^'"]+)['"]/gm;

// Corpo de cada rota: do router.<método>('<caminho>' até a próxima rota do arquivo.
function routeHandlers() {
    const out = [];
    fs.readdirSync(ROUTES_DIR).filter(name => name.endsWith('.js')).sort().forEach(file => {
        const text = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
        const starts = [...text.matchAll(ROUTE_START)];
        starts.forEach((match, index) => {
            const end = index + 1 < starts.length ? starts[index + 1].index : text.length;
            out.push({ file, method: match[1].toUpperCase(), path: match[2], body: text.slice(match.index, end) });
        });
    });
    return out;
}

const routeKey = (file, method, route) => `${file} ${method} ${route}`;

function firstWriteIndex(body) {
    const found = WRITE_MARKERS.map(marker => {
        const match = marker.exec(body);
        return match ? match.index : -1;
    }).filter(index => index >= 0);
    return found.length ? Math.min(...found) : -1;
}

test('[UC-FUNDACAO-004] rota que grava nota ou presença chama assertClassOpen', () => {
    const handlers = routeHandlers();
    const byKey = new Map(handlers.map(handler => [routeKey(handler.file, handler.method, handler.path), handler]));
    const required = new Set(ROTAS_QUE_GRAVAM.map(([file, method, route]) => routeKey(file, method, route)));
    const exempt = new Map(FORA_DO_PORTAO.map(([file, method, route, reason]) => [routeKey(file, method, route), reason]));

    ROTAS_QUE_GRAVAM.forEach(([file, method, route]) => {
        const handler = byKey.get(routeKey(file, method, route));
        assert.ok(handler, `rota da lista não encontrada: ${routeKey(file, method, route)}`);
        const call = handler.body.search(/assertClassOpen\(/);
        assert.ok(call >= 0, `${routeKey(file, method, route)} não chama assertClassOpen`);
        const write = firstWriteIndex(handler.body);
        assert.ok(write === -1 || call < write, `${routeKey(file, method, route)} grava antes de chamar assertClassOpen`);
    });

    FORA_DO_PORTAO.forEach(([file, method, route, reason]) => {
        assert.ok(byKey.has(routeKey(file, method, route)), `rota de FORA_DO_PORTAO não encontrada: ${routeKey(file, method, route)}`);
        assert.ok(String(reason || '').length >= 20, `rota de FORA_DO_PORTAO sem motivo: ${routeKey(file, method, route)}`);
        assert.ok(!required.has(routeKey(file, method, route)), `rota nas duas listas: ${routeKey(file, method, route)}`);
    });

    // Rota que grava e não está em nenhuma das listas: ou chama, ou entra com motivo.
    const missing = handlers
        .filter(handler => firstWriteIndex(handler.body) >= 0)
        .map(handler => routeKey(handler.file, handler.method, handler.path))
        .filter(key => !required.has(key) && !exempt.has(key));
    assert.deepEqual(missing, [], 'rotas que gravam nota ou presença sem assertClassOpen e fora das listas');
});

test('o teste de guarda enxerga as gravações (a lista de sinais não ficou cega)', () => {
    const handlers = routeHandlers();
    const writers = handlers.filter(handler => firstWriteIndex(handler.body) >= 0).map(handler => routeKey(handler.file, handler.method, handler.path));
    // As rotas das duas listas gravam de verdade (o sinal está no corpo de cada uma):
    // rota que deixou de gravar sai da lista.
    [...ROTAS_QUE_GRAVAM, ...FORA_DO_PORTAO].forEach(([file, method, route]) => assert.ok(writers.includes(routeKey(file, method, route)), `sem sinal de gravação: ${routeKey(file, method, route)}`));
});

test('[UC-FUNDACAO-004] assertClassOpen está sem efeito: toda turma passa, com ou sem res', () => {
    const closedClass = { name: '1DES', courseId: 'DES', encerramento: { em: Date.now(), por: 'adm@x.local' }, status: 'encerrada', closedAt: Date.now() };
    const sent = [];
    const res = { status(code) { sent.push(code); return this; }, json(body) { sent.push(body); return this; } };
    assert.equal(calendar.assertClassOpen(closedClass), true);
    assert.equal(calendar.assertClassOpen(closedClass, { res }), true);
    assert.equal(calendar.assertClassOpen([closedClass, { name: '2DES' }], { res }), true);
    assert.equal(calendar.assertClassOpen(null, { res }), true);
    assert.equal(calendar.assertClassOpen(undefined), true);
    assert.equal(calendar.assertClassOpen([]), true);
    assert.equal(calendar.isClassClosed(closedClass), false);
    assert.deepEqual(sent, [], 'nada foi respondido');
});

test('recusa que o B10 vai ligar: 409, code class_closed e mensagem em português', () => {
    const error = new calendar.ClassClosedError({ name: '1DES', courseId: 'DES' });
    assert.equal(error.status, 409);
    assert.equal(error.code, 'class_closed');
    assert.equal(error.studentClass, '1DES');
    assert.equal(error.courseId, 'DES');
    assert.match(error.message, /turma foi encerrada/);
    assert.deepEqual(calendar.classClosedBody(error), { success: false, error: calendar.CLASS_CLOSED_MESSAGE, code: 'class_closed' });
});

test('turma da entrega: pelo curso e turma da entrega, do cadastro copiado ou só pelo nome', () => {
    const memory = { classes: [{ name: '1DES', courseId: 'DES' }, { name: '1DES', courseId: 'ADM' }, { name: '2ADM', courseId: 'ADM' }] };
    assert.equal(calendar.classOfSubmission(memory, { student: { studentClass: '1DES', courseId: 'ADM' } }), memory.classes[1]);
    assert.equal(calendar.classOfSubmission(memory, { studentClass: '2ADM', courseId: 'ADM', student: {} }), memory.classes[2]);
    assert.equal(calendar.classOfSubmission(memory, { student: { studentClass: '1DES' } }), memory.classes[0]);
    assert.equal(calendar.classOfSubmission(memory, { student: { studentClass: '9X', courseId: 'DES' } }), null);
    assert.equal(calendar.classOfSubmission(memory, { student: {} }), null);
    assert.equal(calendar.classOfSubmission(memory, null), null);
    assert.deepEqual(calendar.classesOfSubmissions(memory, [
        { student: { studentClass: '1DES', courseId: 'DES' } },
        { student: { studentClass: '1DES', courseId: 'DES' } },
        { student: { studentClass: '2ADM', courseId: 'ADM' } },
        { student: {} },
    ]), [memory.classes[0], memory.classes[2]]);
});

test('[UC-FUNDACAO-004] sem efeito nas rotas: turma com encerramento continua recebendo chamada, presença e nota', async () => {
    await db.init();
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [{ email: 'adm@turma.local', name: 'Administração', role: 'admin', password: db.hashPassword('Painel-Seguro-2026') }];
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento', structure: [] }];
    db.memory.classes = [{ name: '1DES', courseId: 'DES', status: 'active', releasedItems: {}, encerramento: { em: Date.now() - 1000, por: 'adm@turma.local', criterios: {} } }];
    db.memory.students = [{ name: 'Ana Souza', email: 'ana@turma.local', status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }], studentClass: '1DES' }];
    db.memory.attendance = [];
    db.memory.evaluations = { Prova_1: { title: 'Prova 1', questions: [{ number: 1, questionText: 'Q1', alternatives: { A: 'a', B: 'b' }, correctAnswer: 'A' }] } };
    db.memory.submissions = [];
    const app = createApp();
    const headers = { 'x-admin-session': createAdminSession(db.memory, 'adm@turma.local') };

    const bulk = await request(app).post('/api/admin/attendance/bulk').set(headers).send({
        courseId: 'DES', studentClass: '1DES', date: '2026-11-10', concluida: true,
        entries: [{ email: 'ana@turma.local', aulas: [{ ordem: 1, status: 'presente' }] }],
    });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    const mark = await request(app).post('/api/admin/student/attendance/mark').set(headers).send({ email: 'ana@turma.local', date: '2026-11-11', studentClass: '1DES', courseId: 'DES' });
    assert.equal(mark.status, 200, JSON.stringify(mark.body));
    const created = await request(app).post('/api/admin/submissions/create').set(headers).send({ studentEmail: 'ana@turma.local', examKey: 'Prova_1', studentClass: '1DES', courseId: 'DES', grade: '8,5', type: 'manual' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = db.memory.submissions[0] && db.memory.submissions[0].id;
    assert.ok(id, 'nota lançada');
    const published = await request(app).post('/api/admin/submissions/publish').set(headers).send({ ids: [id], published: true });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.updated, 1);
    assert.equal(db.memory.attendance.length, 2);
});
