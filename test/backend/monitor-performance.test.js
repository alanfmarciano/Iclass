// Monitor leve com um ano de dados (fase 2, H2-D: DES-04, DES-13).
// O monitor-status é consultado a cada 3 s durante a prova. Antes, para cada aluno da
// turma, ele percorria todas as entregas, logs de foco e estados de prova da escola e
// devolvia o histórico de foco inteiro de cada aluno. Agora cada coleção é lida uma vez
// (utils/monitorActivity.js), as teclas vêm dos contadores do store (statsEntries) e a
// linha leva só os 10 últimos eventos de foco, com logCount.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const request = require('supertest');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-monitor-perf-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { findOpenAttemptState, openAttemptFromEntries } = require('../../backend/utils/examApplications.js');
const { collectMonitorActivity } = require('../../backend/utils/monitorActivity.js');
const { KEYSTROKE_SCHEMA, KEYSTROKE_TABLE } = require('../../backend/utils/keystrokeStore.js');

let app;
const adminToken = 'admin-token-monitor-perf';
const adminEmail = 'admin@monitor.local';
const courseId = 'curso-monitor';
const CLASSES = 10;
const PER_CLASS = 44;
const OLD_APPLICATIONS = 200;
const OLD_KEYSTROKES = 150000;
const examKey = 'Prova_Atual';
const currentApplication = 'app-atual';
const watched = 'aluno0_1@monitor.local';
const focusEvents = 30;

const emailOf = (c, s) => `aluno${c}_${s}@monitor.local`;
// Um terço das aplicações antigas é da mesma prova (outras turmas e anos anteriores).
const oldExamOf = a => (a % 3 === 0 ? examKey : `Prova_${a % 7}`);

// 150 mil teclas de outras aplicações gravadas direto no arquivo, num comando só,
// antes do boot (o boot monta os contadores com um GROUP BY, como no computador da escola
// depois de um ano). Pelo append, uma linha por vez, levariam meio minuto.
async function seedOldKeystrokes(now) {
    const connection = new sqlite3.Database(path.join(tempRoot, 'database.db'));
    const run = (sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, err => (err ? reject(err) : resolve())));
    try {
        for (const sql of KEYSTROKE_SCHEMA) await run(sql);
        // Gerado pelo próprio SQLite (WITH RECURSIVE), com as mesmas regras de emailOf e
        // oldExamOf: a = i % OLD_APPLICATIONS, turma = a % CLASSES, aluno = i % PER_CLASS.
        await run(`INSERT INTO ${KEYSTROKE_TABLE} (id, student_email, student_class, course_id, exam_key, application_id, seq, server_ts, key, kind)
            WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
            SELECT 'tecla-antiga-' || i,
                'aluno' || ((i % ?) % ?) || '_' || (i % ?) || '@monitor.local',
                'T' || ((i % ?) % ?),
                ?,
                CASE WHEN (i % ?) % 3 = 0 THEN ? ELSE 'Prova_' || ((i % ?) % 7) END,
                'app-antiga-' || (i % ?),
                i, ?, 'a', 'key'
            FROM n`, [OLD_KEYSTROKES, OLD_APPLICATIONS, CLASSES, PER_CLASS, OLD_APPLICATIONS, CLASSES, courseId,
            OLD_APPLICATIONS, examKey, OLD_APPLICATIONS, OLD_APPLICATIONS, now - 86400000]);
    } finally {
        await new Promise(resolve => connection.close(() => resolve()));
    }
}

test.before(async () => {
    await seedOldKeystrokes(Date.now());
    await db.init();
    app = createApp();
    const m = db.memory;
    m.admins = [{ email: adminEmail, name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') }];
    m.adminSessions = { [adminToken]: { email: adminEmail, createdAt: Date.now(), lastSeen: Date.now() } };
    m.courses = [{ id: courseId, structure: [] }];
    m.evaluations = {
        [examKey]: { key: examKey, title: 'Prova atual', questions: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, text: `Questão ${i + 1}`, correctAnswer: 'A' })) },
    };
    m.classes = Array.from({ length: CLASSES }, (_, c) => ({ name: `T${c}`, courseId, releasedItems: {}, examHistory: {}, onlineExamConfigs: {} }));
    m.students = [];
    for (let c = 0; c < CLASSES; c++) {
        for (let s = 0; s < PER_CLASS; s++) {
            m.students.push({ name: `Aluno ${c}-${s}`, email: emailOf(c, s), status: 'Ativo', password: 'x', classes: [{ name: `T${c}`, courseId }] });
        }
    }
    const now = Date.now();
    // Um ano de histórico: aplicações encerradas com entregas, tentativas e foco.
    m.examApplications = [];
    m.submissions = [];
    m.proctoringLogs = [];
    m.studentExamState = {};
    for (let a = 0; a < OLD_APPLICATIONS; a++) {
        const c = a % CLASSES;
        const id = `app-antiga-${a}`;
        const oldExam = oldExamOf(a);
        m.examApplications.push({ id, examKey: oldExam, studentClass: `T${c}`, courseId, status: 'finished', createdAt: new Date(now - 86400000 * (a + 1)).toISOString() });
        for (let s = 0; s < PER_CLASS; s++) {
            const email = emailOf(c, s);
            m.studentExamState[`${id}::${email}::1`] = { studentEmail: email, applicationId: id, examKey: oldExam, attemptId: `${id}-${s}`, attemptNumber: 1, status: 'submitted', startedAt: now - 86400000, answers: {} };
            m.submissions.push({ id: `sub-${a}-${s}`, studentEmail: email, student: { email }, studentClass: `T${c}`, courseId, examKey: oldExam, applicationId: id, attemptId: `${id}-${s}`, timestamp: new Date(now - 86400000 * (a + 1)).toISOString(), score: 70 });
            m.proctoringLogs.push({ id: `log-${a}-${s}-1`, studentEmail: email, studentClass: `T${c}`, courseId, examKey: oldExam, applicationId: id, timestamp: now - 86400000, eventType: 'tab_blur' });
            m.proctoringLogs.push({ id: `log-${a}-${s}-2`, studentEmail: email, studentClass: `T${c}`, courseId, examKey: oldExam, applicationId: id, timestamp: now - 86300000, eventType: 'tab_focus' });
        }
    }
    // A prova de agora na T0: 40 alunos com a tentativa aberta e online.
    m.examApplications.push({ id: currentApplication, examKey, studentClass: 'T0', courseId, status: 'running', startsAt: now - 600000, durationMinutes: 0, timerEnabled: false, createdAt: new Date(now).toISOString() });
    m.sessions = {};
    for (let s = 0; s < 40; s++) {
        const email = emailOf(0, s);
        m.studentExamState[`${currentApplication}::${email}::1`] = { studentEmail: email, applicationId: currentApplication, examKey, attemptId: `atual-${s}`, attemptNumber: 1, status: 'active', startedAt: now - 300000, answers: { 1: 'A' }, assignedVersion: 'A' };
        m.sessions[email] = { token: `token-${s}`, lastSeen: now, createdAt: now, ip: '127.0.0.1' };
    }
    // O aluno observado saiu da aba 30 vezes nesta aplicação; o último evento é uma saída.
    for (let i = 0; i < focusEvents; i++) {
        m.proctoringLogs.push({ id: `foco-${i}`, studentEmail: watched, studentClass: 'T0', courseId, examKey, applicationId: currentApplication, attemptId: 'atual-1', timestamp: now - 200000 + i * 1000, eventType: i % 2 === 0 ? 'tab_focus' : 'tab_blur' });
    }
    await db.save();

    // Teclas da aplicação atual pelo caminho normal (db.keystrokes.append). A prova com a
    // caixa trocada também conta: a comparação não diferencia maiúsculas.
    await db.keystrokes.append([
        ...Array.from({ length: 7 }, (_, i) => ({ studentEmail: watched, studentClass: 'T0', courseId, examKey, applicationId: currentApplication, seq: i, serverTs: now - 1000 + i, key: 'b', kind: 'key' })),
        { studentEmail: watched, studentClass: 'T0', courseId, examKey: 'PROVA_ATUAL', applicationId: currentApplication, seq: 8, serverTs: now, key: 'v', kind: 'shortcut', suspicious: true },
        { studentEmail: emailOf(0, 2), studentClass: 'T0', courseId, examKey, applicationId: currentApplication, seq: 1, serverTs: now, key: 'c', kind: 'key' },
    ]);
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function monitorStatus() {
    return request(app)
        .get(`/api/admin/monitor-status/T0/${examKey}`)
        .query({ courseId, applicationId: currentApplication })
        .set('x-admin-session', adminToken);
}

test('[UC-DESEMPENHO-003] monitor-status com um ano de dados e 150 mil teclas responde rápido e conta só as teclas da aplicação', async () => {
    assert.ok(db.keystrokes.total() >= OLD_KEYSTROKES);
    await monitorStatus().expect(200);
    const times = [];
    let body;
    for (let i = 0; i < 7; i++) {
        const started = performance.now();
        const response = await monitorStatus().expect(200);
        times.push(performance.now() - started);
        body = response.body;
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    assert.ok(median < 200, `mediana do monitor-status ${median.toFixed(1)} ms (limite 200 ms)`);

    assert.equal(body.length, PER_CLASS);
    const row = body.find(item => item.email === watched);
    assert.equal(row.keystrokeCount, 8, 'só as teclas da aplicação atual, inclusive com a prova em outra caixa');
    assert.equal(row.suspiciousCount, 1);
    assert.ok(row.lastKeystrokeAt > 0);
    assert.equal(body.find(item => item.email === emailOf(0, 2)).keystrokeCount, 1);
    const idle = body.find(item => item.email === emailOf(0, 3));
    assert.equal(idle.keystrokeCount, 0, 'as teclas das aplicações antigas não entram');
    assert.equal(idle.lastKeystrokeAt, null);
    // Ninguém da T0 aparece como "Finalizou" por causa das entregas das aplicações antigas.
    assert.equal(body.filter(item => item.status === 'finished').length, 0);
    assert.equal(body.filter(item => item.attemptInProgress).length, 40);
    assert.equal(body.find(item => item.email === emailOf(0, 41)).status, 'absent');
});

test('[UC-DESEMPENHO-003] linha do Monitor leva os 10 últimos eventos de foco e o total em logCount', async () => {
    const row = (await monitorStatus().expect(200)).body.find(item => item.email === watched);
    assert.equal(row.logCount, focusEvents);
    assert.equal(row.logs.length, 10);
    assert.deepEqual(row.logs.map(log => log.id), Array.from({ length: 10 }, (_, i) => `foco-${focusEvents - 10 + i}`), 'os 10 mais recentes, em ordem cronológica');
    // O status vem da lista completa: o último evento é uma saída da aba.
    assert.equal(row.status, 'blur');
    const quiet = (await monitorStatus().expect(200)).body.find(item => item.email === emailOf(0, 5));
    assert.equal(quiet.logCount, 0, 'os eventos das aplicações antigas não entram');
    assert.deepEqual(quiet.logs, []);
    assert.equal(quiet.status, 'online');
});

test('[UC-DESEMPENHO-003] monitor-status não segura a gravação da prova', async () => {
    // Rascunho da prova enquanto o Monitor consulta: o event loop fica livre.
    let maxGap = 0;
    let last = performance.now();
    const probe = setInterval(() => {
        const nowMs = performance.now();
        maxGap = Math.max(maxGap, nowMs - last - 5);
        last = nowMs;
    }, 5);
    try {
        await Promise.all(Array.from({ length: 5 }, () => monitorStatus().expect(200)));
    } finally {
        clearInterval(probe);
    }
    assert.ok(maxGap < 250, `maior bloqueio do event loop ${maxGap.toFixed(1)} ms com 5 consultas do Monitor`);
});

test('[UC-DESEMPENHO-003] openAttemptFromEntries e o agrupamento do Monitor escolhem a mesma tentativa que findOpenAttemptState', () => {
    let seed = 7;
    const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };
    const statuses = ['active', 'submitted', 'invalidated', 'expired', undefined, 'paused'];
    const emails = ['Ana@X.local', 'ana@x.local', 'BIA@x.local', 'caio@x.local'];
    for (let round = 0; round < 50; round++) {
        const states = {};
        const total = 1 + Math.floor(random() * 12);
        for (let i = 0; i < total; i++) {
            const email = emails[Math.floor(random() * emails.length)];
            const applicationId = random() < 0.8 ? 'app-1' : 'app-2';
            states[`k-${round}-${i}`] = {
                studentEmail: email,
                applicationId,
                examKey: 'Prova',
                attemptNumber: 1 + Math.floor(random() * 3),
                status: statuses[Math.floor(random() * statuses.length)],
            };
        }
        const activity = collectMonitorActivity({ studentExamState: states }, { application: { id: 'app-1' }, examKey: 'Prova' });
        for (const email of ['ana@x.local', 'bia@x.local', 'caio@x.local']) {
            const expected = findOpenAttemptState(states, { applicationId: 'app-1', studentEmail: email });
            assert.deepEqual(openAttemptFromEntries(activity.attemptsByEmail.get(email)), expected, `rodada ${round}, ${email}`);
        }
    }
    assert.equal(openAttemptFromEntries(undefined), null);
});
