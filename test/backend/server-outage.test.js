// Servidor fora do ar durante a prova (fase 2, H3b: CONF-03, OPS-06, CONF-12).
// O tempo em que o servidor ficou parado (reinício, queda, computador suspenso) volta
// para as provas em andamento como pausa 'server_outage' (até 15 min), fica registrado
// na aplicação (outages, aviso do Monitor) e na auditoria da prova; o boot devolve o
// tempo antes da varredura do fim do tempo (antes, quem teve o prazo vencido com o
// servidor fora era entregue logo no boot); o envio automático antecipado depois da
// devolução recebe 409 com reason 'server_outage'; a janela de 60 s da volta à página
// não conta o tempo fora do ar. Também: prova só em .md (sem entrada em evaluations)
// voltou a ser entregue (antes o leitor do .md não estava importado e dava 500), e
// db.health()/db.ping() para a saúde do servidor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-server-outage-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const serverLifecycle = require('../../backend/utils/serverLifecycle.js');
const { computeAttemptDeadline, extendedByServerOutage } = require('../../backend/utils/examDeadline.js');
const { createExamApplication } = require('../../backend/utils/examApplications.js');
const { PAGE_EXIT_RETURN_WINDOW_MS, outageOverlapMs, pageExitReturnDecision, sessionFingerprint } = require('../../backend/utils/examFocusRules.js');
const { describeExamAudit } = require('../../backend/utils/gradebook.js');
const { actionLabel } = require('../../backend/utils/audit.js');

const MIN = 60000;
const DURATION_MIN = 30;
const childScript = path.join(__dirname, 'fixtures', 'server-boot-child.js');
const adminToken = 'admin-token-outage';
const adminEmail = 'admin@outage.local';
const studentClass = 'Turma Queda';
const courseId = 'curso-queda';
const examKey = 'Avaliacao_Queda';
const mdExamKey = 'Avaliacao_So_Md';
const students = {
    ana: { email: 'ana@outage.local', token: 'token-ana-queda' },
    bruno: { email: 'bruno@outage.local', token: 'token-bruno-queda' },
};

let app;

test.before(async () => {
    await db.init();
    app = createApp();
    db.memory.admins = [{ email: adminEmail, name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') }];
    db.memory.adminSessions = { [adminToken]: { email: adminEmail, createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.students = Object.values(students).map((student, index) => ({
        name: `Aluno ${index + 1}`,
        email: student.email,
        status: 'Ativo',
        classes: [{ name: studentClass, courseId }],
    }));
    db.memory.sessions = Object.fromEntries(Object.values(students).map(student => [
        student.email,
        { token: student.token, lastSeen: Date.now(), ip: '127.0.0.1' },
    ]));
    db.memory.courses = [{ id: courseId, structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }, { avaliacaoKey: mdExamKey }] }] }];
    db.memory.classes = [{ name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }];
    db.memory.evaluations = {
        [examKey]: {
            key: examKey,
            title: 'Prova da queda',
            questions: ['A', 'B', 'C'].map((correct, index) => ({
                number: index + 1,
                text: `Questão ${index + 1}`,
                correctAnswer: correct,
                alternatives: ['A', 'B', 'C'].map(letter => ({ letter, text: `Alternativa ${letter}`, isCorrect: letter === correct })),
            })),
        },
    };
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
    db.memory.broadcastMessages = [];
    db.memory.auditLogs = [];
});

test.after(async () => {
    serverLifecycle.stopHeartbeat();
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function control(applicationId, action, extra = {}) {
    return request(app)
        .post(`/api/admin/exam-applications/${applicationId}/control`)
        .set('x-admin-session', adminToken)
        .send({ action, ...extra })
        .expect(200);
}

async function createApplication({ key = examKey, timerMode = 'per_attempt', printQuestions } = {}) {
    const history = await request(app)
        .post('/api/admin/exam-history/add')
        .set('x-admin-session', adminToken)
        .send({
            studentClass,
            courseId,
            examKey: key,
            type: 'online',
            questionNumbers: [1, 2, 3],
            printSnapshot: [{
                version: 'A',
                questions: printQuestions || [1, 2, 3].map(number => ({
                    originalNumber: number,
                    text: `Questão ${number}`,
                    alternatives: ['A', 'B', 'C'].map(letter => ({ letter, text: `Alternativa ${letter}` })),
                })),
            }],
            durationMinutes: DURATION_MIN,
            waitingRoomMinutes: 0,
            maxAttempts: 1,
        })
        .expect(200);
    const created = await request(app)
        .post('/api/admin/exam-applications')
        .set('x-admin-session', adminToken)
        .send({
            studentClass,
            courseId,
            examKey: key,
            historyId: history.body.entry.id,
            applicationOptions: { timerMode, waitingRoomMinutes: 0, maxAttempts: 1 },
        })
        .expect(201);
    const started = await control(created.body.application.id, 'start');
    return started.body.application;
}

async function startAttempt(student, applicationId, key = examKey) {
    await request(app)
        .get('/api/student/sync')
        .set('x-session-token', student.token)
        .query({ email: student.email, studentClass, courseId, examKey: key, applicationId })
        .expect(200);
    const started = await request(app)
        .post(`/api/student/exam-applications/${applicationId}/start-attempt`)
        .set('x-session-token', student.token)
        .send({})
        .expect(200);
    return started.body;
}

function submit(student, applicationId, started, answers, { auto = true, key = examKey } = {}) {
    return request(app)
        .post('/api/student/submit')
        .set('x-session-token', student.token)
        .send({
            studentClass,
            courseId,
            examKey: key,
            applicationId,
            attemptId: started.attemptId,
            answers,
            examConfigVersion: started.examConfigVersion,
            auto,
        });
}

function stateOf(attemptId) {
    return Object.values(db.memory.studentExamState).find(state => state?.attemptId === attemptId) || null;
}

function applicationOf(applicationId) {
    return db.memory.examApplications.find(item => item.id === applicationId);
}

// Memória mínima para as contas de compensação (sem banco).
function outageMemory() {
    const now = Date.now();
    const make = (status, extra = {}) => ({
        ...createExamApplication({ examKey: 'Avaliacao_Unidade', courseId: 'c', studentClass: `T-${status}`, config: { durationMinutes: DURATION_MIN, timerMode: 'collective' }, status: 'running', now: now - 10 * MIN }),
        status,
        ...extra,
    });
    return {
        now,
        memory: {
            examApplications: [
                make('running'),
                make('paused', { pauses: [{ pausedAt: now - 2 * MIN, resumedAt: null }] }),
                make('finished'),
                make('waiting', { startsAt: now + 5 * MIN }),
                make('running', { timerEnabled: false }),
            ],
            studentExamState: {},
            auditLogs: [],
        },
    };
}

test('[UC-TENTATIVA-001] queda curta vira pausa server_outage só da prova em andamento com cronômetro (CONF-03)', () => {
    const { now, memory } = outageMemory();
    const [running, paused, finished, waiting, untimed] = memory.examApplications;
    const snapshot = JSON.stringify([paused, finished, waiting, untimed]);
    const state = { startedAt: running.startsAt };
    const before = computeAttemptDeadline({ application: running, state, now });

    const outcome = serverLifecycle.compensateServerOutage(memory, { from: now - 60000, to: now, reason: 'crash' });

    assert.equal(outcome.changed, true);
    assert.deepEqual(outcome.applications.map(item => item.applicationId), [running.id]);
    assert.deepEqual(running.pauses, [{ pausedAt: now - 60000, resumedAt: now, reason: 'server_outage' }]);
    assert.deepEqual(running.outages, [{ from: now - 60000, to: now, durationMs: 60000, reason: 'crash', compensated: true }]);
    assert.equal(computeAttemptDeadline({ application: running, state, now }) - before, 60000, 'o prazo cresce o tempo fora do ar');
    assert.equal(JSON.stringify([paused, finished, waiting, untimed]), snapshot, 'pausada, encerrada, na sala de espera e sem cronômetro não mudam');

    // Registro da prova (auditoria lida pelo registro da aplicação) com rótulo pt-BR.
    assert.equal(memory.auditLogs.length, 1);
    const [entry] = memory.auditLogs;
    assert.equal(entry.type, 'exam_application_server_outage');
    assert.equal(entry.applicationId, running.id);
    assert.deepEqual(describeExamAudit(entry), {
        title: 'Servidor fora do ar durante a prova',
        detail: 'Fora do ar por 1 min (queda do servidor). Tempo devolvido a todos.',
    });
    assert.equal(actionLabel('exam_application_server_outage'), 'Servidor fora do ar durante a prova');
});

test('[UC-TENTATIVA-001] acima de 15 min só registra (compensated: false), sem pausa (CONF-03)', () => {
    const { now, memory } = outageMemory();
    const running = memory.examApplications[0];
    running.startsAt = now - 40 * MIN;
    const outcome = serverLifecycle.compensateServerOutage(memory, { from: now - 22 * MIN, to: now, reason: 'restart' });
    assert.equal(outcome.changed, true);
    assert.deepEqual(running.pauses || [], []);
    assert.deepEqual(running.outages, [{ from: now - 22 * MIN, to: now, durationMs: 22 * MIN, reason: 'restart', compensated: false }]);
    assert.equal(describeExamAudit(memory.auditLogs[0]).detail, 'Fora do ar por 22 min (reinício). Tempo não devolvido (mais de 15 min).');
});

test('[UC-TENTATIVA-001] o início da queda respeita o fim da última pausa e o último salvamento (CONF-03)', () => {
    const { now, memory } = outageMemory();
    const running = memory.examApplications[0];
    running.pauses = [{ pausedAt: now - 5 * MIN, resumedAt: now - 50000 }];
    memory.studentExamState.a = { applicationId: running.id, status: 'active', savedAt: new Date(now - 20000).toISOString() };
    memory.studentExamState.b = { applicationId: running.id, status: 'active', savedAt: new Date(now - 40000).toISOString() };
    // Entregue: o salvamento dela não conta.
    memory.studentExamState.c = { applicationId: running.id, status: 'submitted', savedAt: new Date(now - 1000).toISOString() };
    serverLifecycle.compensateServerOutage(memory, { from: now - 90000, to: now });
    assert.deepEqual(running.pauses.at(-1), { pausedAt: now - 20000, resumedAt: now, reason: 'server_outage' });
    assert.equal(running.outages[0].durationMs, 20000);

    // Menos de 1 s não é queda; heartbeat com o relógio de trás para a frente não devolve nada.
    const again = serverLifecycle.compensateServerOutage(memory, { from: now - 500, to: now });
    assert.equal(again.changed, false);
    assert.equal(serverLifecycle.compensateServerOutage(memory, { from: now, to: now - 60000 }).changed, false);
});

test('[UC-TENTATIVA-001] heartbeat ilegível, ausente ou no futuro: tempo fora do ar desconhecido ou zero', () => {
    const file = path.join(tempRoot, 'heartbeat-teste.json');
    const now = Date.now();
    assert.equal(serverLifecycle.readHeartbeat({ now, file }).found, false);
    fs.writeFileSync(file, 'nao-e-json');
    assert.equal(serverLifecycle.readHeartbeat({ now, file }).found, false);
    fs.writeFileSync(file, JSON.stringify({ at: now + 5000, clean: true }));
    const ahead = serverLifecycle.readHeartbeat({ now, file });
    assert.equal(ahead.downtimeMs, 0);
    assert.equal(ahead.clockWentBack, true);
    fs.writeFileSync(file, JSON.stringify({ at: now - 7000, clean: false, reason: null }));
    assert.deepEqual(
        (({ found, clean, downtimeMs }) => ({ found, clean, downtimeMs }))(serverLifecycle.readHeartbeat({ now, file })),
        { found: true, clean: false, downtimeMs: 7000 });
    // Sem heartbeat não há devolução (só o aviso no console).
    const { memory } = outageMemory();
    assert.equal(serverLifecycle.compensateBootOutage(memory, { found: false }).changed, false);
});

// Boot (prepareServer) num processo próprio, com o banco e o heartbeat que a execução
// anterior deixou.
function runChild(dataDir, scenario, argument) {
    const env = {
        ...process.env,
        ICLASS_DATA_DIR: dataDir,
        ICLASS_CONTENT_DIR: path.join(dataDir, 'content'),
        ICLASS_ARCHIVE_DIR: path.join(dataDir, 'archives'),
        TEST_MODE: '1',
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.ICLASS_VERIFY_SAVES;
    const args = [childScript, scenario];
    if (argument !== undefined) args.push(String(argument));
    return new Promise((resolve, reject) => {
        execFile(process.execPath, args, { env, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            const marker = String(stdout || '').lastIndexOf('@@');
            if (marker < 0) {
                reject(new Error(`processo filho (${scenario}) sem resultado: ${(err && err.message) || ''}\n${stderr}`));
                return;
            }
            const result = JSON.parse(stdout.slice(marker + 2));
            if (result.fatal) {
                reject(new Error(`processo filho (${scenario}) falhou: ${result.fatal}\n${(result.logs || []).join('\n')}\n${stderr}`));
                return;
            }
            resolve(result);
        });
    });
}

test('[UC-TENTATIVA-001] boot depois de 90 s fora do ar devolve o tempo antes da varredura: a tentativa vencida nesse tempo continua (CONF-03)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-server-outage-boot-'));
    try {
        // Prazo base venceu há 45 s (além dos 30 s da finalização do servidor); o servidor
        // parou há 90 s sem desligamento limpo.
        const seeded = await runChild(dataDir, 'outageSeed', '90,45,0');
        const booted = await runChild(dataDir, 'outageBoot');
        assert.deepEqual(booted.uncaught, []);
        assert.equal(booted.previousRun.found, true);
        assert.equal(booted.previousRun.clean, false);
        assert.deepEqual(booted.attempt, { status: 'active', attemptId: seeded.attemptId }, 'a tentativa foi entregue no boot pelo tempo em que o servidor esteve fora');
        assert.equal(booted.submissions, 0);

        assert.equal(booted.outages.length, 1);
        const [outage] = booted.outages;
        assert.equal(outage.reason, 'crash');
        assert.equal(outage.compensated, true);
        assert.equal(outage.from, seeded.downSince);
        assert.ok(outage.to >= booted.bootAt && outage.durationMs >= 90000, JSON.stringify(outage));
        assert.deepEqual(booted.pauses.at(-1), { pausedAt: outage.from, resumedAt: outage.to, reason: 'server_outage' });
        assert.equal(booted.audit.length, 1);
        assert.equal(booted.auditView[0].title, 'Servidor fora do ar durante a prova');
        assert.match(booted.auditView[0].detail, /^Fora do ar por 1 min 3\d s \(queda do servidor\)\. Tempo devolvido a todos\.$/);
        assert.ok(booted.logs.some(line => line.includes('Servidor fora do ar (queda do servidor)')), booted.logs.join('\n'));
        // O novo heartbeat é desta execução; o desligamento limpo grava clean: true.
        assert.equal(booted.heartbeat.clean, false);
        assert.notEqual(booted.heartbeat.instanceId, 'anterior');
        assert.equal(booted.heartbeatAfterStop.clean, true);
        assert.equal(booted.heartbeatAfterStop.reason, 'stop');

        // Boot seguinte: a pausa e o registro da queda continuam no banco, sem repetir; a
        // parada limpa conta como reinício.
        const rebooted = await runChild(dataDir, 'outageReboot');
        assert.equal(rebooted.previousRun.clean, true);
        assert.deepEqual(rebooted.outages[0], outage);
        assert.equal(rebooted.pauses.filter(pause => pause.pausedAt === outage.from).length, 1);
        rebooted.outages.slice(1).forEach(item => assert.equal(item.reason, 'restart'));
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('[UC-TENTATIVA-001] computador suspenso por 40 s: o tempo volta antes do envio e o automático antecipado recebe 409 server_outage (CONF-03)', async () => {
    const { ana } = students;
    const application = await createApplication();
    const started = await startAttempt(ana, application.id);
    const now = Date.now();
    // O prazo base venceu há 5 s (dentro da folga: o envio automático seria aceito) e o
    // último salvamento foi antes da suspensão.
    const live = applicationOf(application.id);
    live.startsAt = now - 40 * MIN;
    const state = stateOf(started.attemptId);
    state.startedAt = now - DURATION_MIN * MIN - 5000;
    state.savedAt = new Date(now - 45000).toISOString();
    try {
        // Última verificação há 40 s (o processo ficou parado desde então).
        serverLifecycle.startHeartbeat({ getMemory: () => db.memory, save: () => db.save({ detached: true }), now: now - 40000 });
        const response = await submit(ana, application.id, started, { 1: 'A' }).expect(409);
        assert.equal(response.body.deadlineExtended, true);
        assert.equal(response.body.reason, 'server_outage');
        assert.equal(response.body.error, 'O servidor ficou fora do ar e o tempo foi devolvido. A prova continua.');
        assert.ok(response.body.timerRemaining >= 30 && response.body.timerRemaining <= 36, `timerRemaining ${response.body.timerRemaining}`);
        assert.equal(stateOf(started.attemptId).status, 'active');

        const outages = applicationOf(application.id).outages;
        assert.equal(outages.length, 1);
        assert.equal(outages[0].reason, 'suspended');
        assert.equal(outages[0].compensated, true);
        assert.ok(db.memory.auditLogs.some(entry => entry.type === 'exam_application_server_outage' && entry.applicationId === application.id));

        // Outro pedido logo depois não devolve o tempo de novo.
        await submit(ana, application.id, started, { 1: 'A' }).expect(409);
        assert.equal(applicationOf(application.id).outages.length, 1);

        // O Monitor recebe as quedas na lista da turma.
        const list = await request(app)
            .get('/api/admin/exam-applications')
            .set('x-admin-session', adminToken)
            .query({ courseId, studentClass })
            .expect(200);
        const listed = list.body.applications.find(item => item.id === application.id);
        assert.equal(listed.outages.length, 1);
        assert.equal(listed.pauses.filter(pause => pause.reason === 'server_outage').length, 1);
    } finally {
        serverLifecycle.stopHeartbeat();
        await control(application.id, 'finish', { inProgressPolicy: 'discard' });
    }
});

test('[UC-TENTATIVA-001] reason server_outage só quando o prazo está à frente pelo tempo devolvido da queda', () => {
    const now = Date.now();
    const application = { timerEnabled: true, durationMinutes: DURATION_MIN, globalTimeAdjustment: 0, pauses: [] };
    const state = { startedAt: now - DURATION_MIN * MIN - 5000 };
    assert.equal(extendedByServerOutage(state, application, now), false, 'sem queda não há reason');
    application.pauses = [{ pausedAt: now - 40000, resumedAt: now, reason: 'server_outage' }];
    assert.equal(extendedByServerOutage(state, application, now), true);
    // O professor deu +5 min: o prazo estaria à frente mesmo sem a queda.
    assert.equal(extendedByServerOutage(state, { ...application, globalTimeAdjustment: 5 }, now), false);
    // Pausa do professor (sem reason) não é queda.
    assert.equal(extendedByServerOutage(state, { ...application, pauses: [{ pausedAt: now - 40000, resumedAt: now }] }, now), false);
});

test('[UC-PROVA-003] recarregar a página logo antes da queda: o tempo fora do ar não conta nos 60 s da volta (decisão §3)', () => {
    const now = Date.now();
    const token = 'sessao-da-pagina';
    const state = { focusLocked: true, pageExit: { at: now - 100000, session: sessionFingerprint(token) } };
    assert.equal(PAGE_EXIT_RETURN_WINDOW_MS, 60000);
    assert.deepEqual(pageExitReturnDecision(state, { sessionToken: token, now }), { unlock: false, expired: true });
    // 70 s fora do ar dentro dos 100 s: contam 30 s.
    const outages = [{ from: now - 90000, to: now - 20000, durationMs: 70000, reason: 'crash', compensated: true }];
    assert.deepEqual(pageExitReturnDecision(state, { sessionToken: token, now, outages }), { unlock: true, seconds: 30 });
    // Outra sessão continua sem destravar.
    assert.deepEqual(pageExitReturnDecision(state, { sessionToken: 'outra', now, outages }), { unlock: false });
    // Quedas sobrepostas contam uma vez; fora do intervalo não contam.
    assert.equal(outageOverlapMs([{ from: 0, to: 50 }, { from: 30, to: 80 }, { from: 200, to: 300 }], 10, 100), 70);
});

test('[UC-PROVA-003] prova só em .md (sem entrada em evaluations) é entregue e corrigida pelo gabarito do arquivo', async () => {
    const { bruno } = students;
    fs.mkdirSync(process.env.ICLASS_CONTENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.ICLASS_CONTENT_DIR, `${mdExamKey}.md`), [
        '# Prova antiga em Markdown',
        '',
        '**1. Questão um**',
        'a) Alternativa A',
        'b) Alternativa B',
        'c) Alternativa C',
        '',
        '**2. Questão dois**',
        'a) Alternativa A',
        'b) Alternativa B',
        'c) Alternativa C',
        '',
        '**3. Questão três**',
        'a) Alternativa A',
        'b) Alternativa B',
        'c) Alternativa C',
        '',
        '<details>',
        '1. **B**',
        '2. **C**',
        '3. **A**',
        '</details>',
        '',
    ].join('\n'));
    assert.equal(db.memory.evaluations[mdExamKey], undefined);
    const application = await createApplication({ key: mdExamKey });
    const started = await startAttempt(bruno, application.id, mdExamKey);
    const response = await submit(bruno, application.id, started, { 1: 'B', 2: 'C', 3: 'C' }, { auto: false, key: mdExamKey });
    assert.equal(response.status, 200, `antes: 500 "Falha ao processar avaliação no servidor." — ${JSON.stringify(response.body)}`);
    const delivered = db.memory.submissions.find(item => item.id === response.body.submissionId);
    assert.equal(delivered.correctCount, 2, 'correção pelo gabarito do .md');
    await control(application.id, 'finish');
});

test('[UC-GRAVACAO-001] db.health resume a gravação e db.ping confere o banco com cache curto (CONF-12)', async () => {
    db.memory.notes['saude@outage.local'] = { modulo: 'gravada' };
    await db.save();
    const health = db.health();
    assert.ok(health.lastOkAt, 'último ciclo que gravou');
    assert.equal(health.consecutiveFailures, 0);
    assert.equal(health.lastErrorCode, null);
    assert.equal(health.saving, false);
    assert.ok(health.savesSinceBoot >= 1);
    assert.ok(health.dbFileBytes > 0);
    assert.ok(Number.isFinite(health.lastDurationMs));

    const first = await db.ping();
    assert.equal(first.ok, true);
    assert.equal(first.consecutiveFailures, 0);
    const second = await db.ping();
    assert.equal(second.cached, true, 'a segunda consulta em menos de 5 s usa o resultado guardado');
    assert.equal(second.at, first.at);
    const later = await db.ping({ now: Date.now() + 6000 });
    assert.equal(later.ok, true);
    assert.equal(later.cached, false);
});
