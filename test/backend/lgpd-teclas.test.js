// Registro do teclado na prova, por aplicação (H8b, CRIT-04; decisões P2).
// 1) Preparar sem escolher grava keystrokeMode 'eventos' na aplicação e na configuração
//    da turma; valor fora da lista responde 400 com field 'keystrokeMode' e nada é criado.
// 2) log-keystrokes filtra pelo modo da aplicação, mesmo com o código antigo da prova
//    mandando tudo: 'eventos' guarda só atalhos, cópia e menu do botão direito; 'tudo'
//    guarda tudo; 'nada' não guarda nada e nem pede a gravação.
// 3) Aplicação de antes desta versão (sem o campo) e tecla sem aplicação valem 'eventos'.
// 4) O aluno recebe o modo (sync e lista de aplicações) e o prazo de guarda.
// 5) Caractere digitado com AltGr (Ctrl e Alt juntos no Windows) é digitação, não atalho.
// 6) O painel marca a aplicação de antes desta versão (keystrokeModeLegacy).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-lgpd-teclas-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const policy = require('../../backend/utils/keystrokePolicy.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

let app;
const adminToken = 'admin-token-teclas';
const adminEmail = 'admin@teclas-modo.local';
const studentClass = 'Turma Teclado';
const courseId = 'curso-teclado';
const examKey = 'Avaliacao_Teclado';
const student = { email: 'lia@teclas-modo.local', token: 'token-lia-teclado' };

// Um lote como o ExamRunner antigo mandava (tudo o que a pessoa digitou).
const EVENTS = [
    { seq: 1, key: 'a', code: 'KeyA', kind: 'char' },
    { seq: 2, key: 'Backspace', code: 'Backspace', kind: 'key' },
    { seq: 3, key: 'c', code: 'KeyC', mods: 'Ctrl', kind: 'shortcut', suspicious: true },
    { seq: 4, key: 'v', code: 'KeyV', mods: 'Ctrl', kind: 'clipboard', suspicious: true },
    { seq: 5, key: 'ContextMenu', code: '', kind: 'contextmenu', suspicious: true },
    { seq: 6, key: 'Tab', code: 'Tab', mods: 'Alt', kind: 'shortcut', suspicious: true },
    { seq: 7, key: 'b', code: 'KeyB' },
];

function admin(method, url) {
    return request(app)[method](url).set('x-admin-session', adminToken);
}

test.before(async () => {
    await db.init();
    app = createApp();
    db.memory.admins = [{ email: adminEmail, name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') }];
    db.memory.adminSessions = { [adminToken]: { email: adminEmail, createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.students = [{ name: 'Lia', email: student.email, status: 'Ativo', classes: [{ name: studentClass, courseId }] }];
    db.memory.sessions = { [student.email]: { token: student.token, lastSeen: Date.now(), ip: '127.0.0.1' } };
    db.memory.courses = [{ id: courseId, structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }] }];
    db.memory.classes = [{ name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }];
    db.memory.evaluations = {
        [examKey]: {
            key: examKey,
            title: 'Prova do teclado',
            questions: [1, 2].map(number => ({
                number,
                text: `Questão ${number}`,
                correctAnswer: 'A',
                alternatives: ['A', 'B'].map(letter => ({ letter, text: `Alternativa ${letter}`, isCorrect: letter === 'A' })),
            })),
        },
    };
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function historyEntry() {
    const history = await admin('post', '/api/admin/exam-history/add')
        .send({
            studentClass,
            courseId,
            examKey,
            type: 'online',
            questionNumbers: [1, 2],
            printSnapshot: [{
                version: 'A',
                questions: [1, 2].map(number => ({
                    originalNumber: number,
                    text: `Questão ${number}`,
                    alternatives: ['A', 'B'].map(letter => ({ letter, text: `Alternativa ${letter}` })),
                })),
            }],
            durationMinutes: 30,
            waitingRoomMinutes: 0,
            maxAttempts: 1,
        })
        .expect(200);
    return history.body.entry.id;
}

function prepare(historyId, applicationOptions) {
    return admin('post', '/api/admin/exam-applications').send({
        studentClass,
        courseId,
        examKey,
        historyId,
        applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, durationMinutes: 30, ...applicationOptions },
    });
}

async function prepareAndStart(options) {
    const created = await prepare(await historyEntry(), options).expect(201);
    await admin('post', `/api/admin/exam-applications/${created.body.application.id}/control`).send({ action: 'start' }).expect(200);
    return created.body.application;
}

async function finish(application) {
    await admin('post', `/api/admin/exam-applications/${application.id}/control`).send({ action: 'finish', inProgressPolicy: 'discard' }).expect(200);
}

function sendKeys(body) {
    return request(app).post('/api/student/log-keystrokes').set('x-session-token', student.token)
        .send({ email: student.email, studentClass, courseId, examKey, events: EVENTS, ...body });
}

function storedKinds(applicationId) {
    return db.keystrokes.query({ email: student.email, examKey, applicationId, limit: 100 })
        .then(result => result.events.map(event => event.kind));
}

test('[UC-LGPD-009] regra do modo: eventos guarda só atalhos, cópia e menu; tudo guarda tudo; nada não guarda', () => {
    assert.deepEqual(policy.KEYSTROKE_MODES, ['eventos', 'tudo', 'nada']);
    assert.equal(policy.DEFAULT_KEYSTROKE_MODE, 'eventos');
    assert.deepEqual(policy.filterKeystrokeEvents('eventos', EVENTS).map(event => event.seq), [3, 4, 5, 6]);
    assert.deepEqual(policy.filterKeystrokeEvents('tudo', EVENTS).map(event => event.seq), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(policy.filterKeystrokeEvents('nada', EVENTS), []);
    // Sem o campo, nulo ou desconhecido: 'eventos'.
    assert.equal(policy.keystrokeModeOf({}), 'eventos');
    assert.equal(policy.keystrokeModeOf(null), 'eventos');
    assert.equal(policy.keystrokeModeOf({ keystrokeMode: 'TUDO' }), 'eventos');
    assert.deepEqual(policy.parseKeystrokeModeOption({}), { valid: true, value: 'eventos' });
    assert.deepEqual(policy.parseKeystrokeModeOption({ keystrokeMode: ' nada ' }), { valid: true, value: 'nada' });
    assert.equal(policy.parseKeystrokeModeOption({ keystrokeMode: 'gravar' }).valid, false);
    assert.equal(policy.parseKeystrokeModeOption({ keystrokeMode: ['tudo'] }).valid, false);
});

test('[UC-LGPD-009] AltGr (ABNT2 no Windows: Ctrl e Alt juntos) é digitação: eventos não guarda', async () => {
    // Como o código antigo da prova mandava: 'shortcut' com mods 'Ctrl+Alt' e o caractere.
    const altGr = [
        { seq: 1, key: '/', code: 'KeyQ', mods: 'Ctrl+Alt', kind: 'shortcut', suspicious: true },
        { seq: 2, key: '°', code: 'KeyE', mods: 'Ctrl+Alt', kind: 'shortcut', suspicious: true },
        { seq: 3, key: '?', code: 'KeyW', mods: 'Ctrl+Alt+Shift', kind: 'shortcut', suspicious: true },
        { seq: 4, key: '€', code: 'KeyE', mods: 'AltGr', kind: 'char' },
        // Atalhos de verdade continuam: Ctrl+Alt com letra, Ctrl+C, Alt+Tab, Win.
        { seq: 5, key: 'v', code: 'KeyV', mods: 'Ctrl+Alt', kind: 'shortcut', suspicious: true },
        { seq: 6, key: 'c', code: 'KeyC', mods: 'Ctrl', kind: 'shortcut', suspicious: true },
        { seq: 7, key: 'Tab', code: 'Tab', mods: 'Alt', kind: 'shortcut', suspicious: true },
        { seq: 8, key: 'Meta', code: 'MetaLeft', mods: 'Meta', kind: 'shortcut', suspicious: true },
        { seq: 9, key: '/', code: 'KeyQ', mods: 'Ctrl+Alt+Meta', kind: 'shortcut', suspicious: true },
    ];
    assert.equal(policy.isAltGrTyping(altGr[0]), true);
    assert.equal(policy.isAltGrTyping(altGr[4]), false);
    assert.deepEqual(policy.filterKeystrokeEvents('eventos', altGr).map(event => event.seq), [5, 6, 7, 8, 9]);
    assert.equal(policy.filterKeystrokeEvents('tudo', altGr).length, altGr.length);

    const application = await prepareAndStart({});
    const sent = await sendKeys({ applicationId: application.id, events: altGr }).expect(200);
    assert.equal(sent.body.inserted, 5);
    const stored = await db.keystrokes.query({ email: student.email, examKey, applicationId: application.id, limit: 100 });
    assert.deepEqual(stored.events.map(event => event.key), ['v', 'c', 'Tab', 'Meta', '/']);
    await finish(application);
});

test('[UC-LGPD-009] eventos: o servidor classifica o atalho e não confia no kind do navegador (decisões §12)', async () => {
    const forged = [
        // Alt sozinho com uma letra é digitação, mesmo com kind 'SHORTCUT '.
        { seq: 1, key: 'ç', code: 'Semicolon', mods: 'Alt', kind: 'SHORTCUT ', suspicious: true },
        { seq: 2, key: 'g', code: 'KeyG', mods: 'Alt', kind: 'shortcut', suspicious: true },
        // Tecla digitada sem modificador marcada como atalho, cópia ou menu: não guarda.
        { seq: 3, key: 'a', code: 'KeyA', mods: '', kind: 'shortcut' },
        { seq: 4, key: 's', code: 'KeyS', mods: '', kind: 'Clipboard' },
        { seq: 5, key: 'x', code: 'KeyX', mods: 'Shift', kind: 'contextmenu' },
        { seq: 6, key: 'z', code: 'KeyZ', mods: 'Ctrl', kind: 'shortcut' },
        // Atalhos de verdade, com o kind normalizado (ou trocado pelo do servidor).
        { seq: 7, key: 'c', code: 'KeyC', mods: 'Ctrl', kind: ' SHORTCUT ', suspicious: true },
        { seq: 8, key: 'V', code: 'KeyV', mods: 'Meta', kind: 'char' },
        { seq: 9, key: 'copy', code: 'copy', mods: '', kind: 'CLIPBOARD' },
        { seq: 10, key: 'contextmenu', code: 'contextmenu', mods: '', kind: 'ContextMenu ' },
        { seq: 11, key: 'Tab', code: 'Tab', mods: 'Alt', kind: 'qualquer' },
        { seq: 12, key: 'p', code: 'KeyP', mods: 'Ctrl', kind: 'shortcut' },
    ];
    assert.equal(policy.normalizeEventKind('SHORTCUT '), 'shortcut');
    assert.equal(policy.normalizeEventKind('teclado'), 'key');
    assert.equal(policy.normalizeEventKind(undefined), 'key');
    assert.equal(policy.isServerShortcut(forged[0]), false);
    const kept = policy.filterKeystrokeEvents('eventos', forged);
    assert.deepEqual(kept.map(event => event.seq), [7, 8, 9, 10, 11, 12]);
    assert.deepEqual(kept.map(event => event.kind), ['shortcut', 'shortcut', 'clipboard', 'contextmenu', 'shortcut', 'shortcut']);
    // 'tudo' guarda tudo, com o kind na lista fechada.
    const all = policy.filterKeystrokeEvents('tudo', forged);
    assert.equal(all.length, forged.length);
    assert.equal(all[0].kind, 'shortcut');
    assert.equal(all[10].kind, 'key');

    const application = await prepareAndStart({});
    const sent = await sendKeys({ applicationId: application.id, events: forged }).expect(200);
    assert.equal(sent.body.inserted, 6);
    const stored = await db.keystrokes.query({ email: student.email, examKey, applicationId: application.id, limit: 100 });
    assert.deepEqual(stored.events.map(event => event.key), ['c', 'V', 'copy', 'contextmenu', 'Tab', 'p']);
    assert.ok(!stored.events.some(event => event.key === 'ç'), 'a tecla digitada não é guardada');
    assert.deepEqual(stored.events.map(event => event.kind), ['shortcut', 'shortcut', 'clipboard', 'contextmenu', 'shortcut', 'shortcut']);
    await finish(application);
});

test('[UC-LGPD-009] preparar sem escolher vale eventos; escolha inválida é recusada com o campo', async () => {
    const historyId = await historyEntry();
    const before = db.memory.examApplications.length;
    for (const keystrokeMode of ['gravar-tudo', 7, { modo: 'tudo' }]) {
        const refused = await prepare(historyId, { keystrokeMode }).expect(400);
        assert.equal(refused.body.field, 'keystrokeMode');
        assert.equal(refused.body.error, 'Modo de registro de teclado inválido.');
    }
    assert.equal(db.memory.examApplications.length, before, 'nada foi criado');

    const created = await prepare(historyId, {}).expect(201);
    assert.equal(created.body.application.keystrokeMode, 'eventos');
    const stored = db.memory.examApplications.find(item => item.id === created.body.application.id);
    assert.equal(stored.keystrokeMode, 'eventos');
    assert.equal(db.memory.classes[0].onlineExamConfigs[examKey].keystrokeMode, 'eventos');
    await admin('post', `/api/admin/exam-applications/${created.body.application.id}/control`).send({ action: 'cancel' });
});

test('[UC-LGPD-009] log-keystrokes grava conforme o modo da aplicação, mesmo com a prova antiga mandando tudo', async () => {
    // 'eventos' (padrão)
    const eventos = await prepareAndStart({});
    const first = await sendKeys({ applicationId: eventos.id }).expect(200);
    assert.deepEqual(first.body, { success: true, inserted: 4, dropped: 0 });
    assert.deepEqual(await storedKinds(eventos.id), ['shortcut', 'clipboard', 'contextmenu', 'shortcut']);

    // O aluno recebe o modo e o prazo de guarda (0 = sem prazo automático).
    const synced = await request(app).get('/api/student/sync').set('x-session-token', student.token)
        .query({ email: student.email, studentClass, courseId, examKey, applicationId: eventos.id }).expect(200);
    assert.equal(synced.body.onlineExamConfigs[examKey].keystrokeMode, 'eventos');
    assert.equal(synced.body.proctoringRetentionDays, 0);
    const listed = await request(app).get('/api/student/exam-applications').set('x-session-token', student.token)
        .query({ studentClass, courseId }).expect(200);
    assert.equal(listed.body.applications.find(item => item.id === eventos.id).keystrokeMode, 'eventos');
    await finish(eventos);

    // 'tudo'
    const tudo = await prepareAndStart({ keystrokeMode: 'tudo' });
    assert.equal(tudo.keystrokeMode, 'tudo');
    const all = await sendKeys({ applicationId: tudo.id }).expect(200);
    assert.equal(all.body.inserted, 7);
    await finish(tudo);

    // 'nada': nada gravado, sem pedir gravação ao store.
    const nada = await prepareAndStart({ keystrokeMode: 'nada' });
    const append = db.keystrokes.append;
    let appended = 0;
    db.keystrokes.append = (...args) => { appended += 1; return append(...args); };
    try {
        const none = await sendKeys({ applicationId: nada.id }).expect(200);
        assert.deepEqual(none.body, { success: true, inserted: 0, dropped: 0 });
    } finally {
        db.keystrokes.append = append;
    }
    assert.equal(appended, 0);
    assert.deepEqual(await storedKinds(nada.id), []);
    // O bloqueio dos atalhos e o foco não dependem do modo: a saída da tela continua.
    await request(app).post('/api/student/log-activity').set('x-session-token', student.token)
        .send({ email: student.email, studentClass, courseId, examKey, applicationId: nada.id, eventType: 'tab_blur', details: 'saiu da aba' })
        .expect(200);
    assert.ok(db.memory.proctoringLogs.some(log => log.applicationId === nada.id && log.eventType === 'tab_blur'));
    await finish(nada);
});

test('[UC-LGPD-009] aplicação de antes desta versão (sem o campo) e tecla sem aplicação valem eventos', async () => {
    const application = await prepareAndStart({ keystrokeMode: 'tudo' });
    // Como no banco da versão anterior: sem o campo na aplicação nem na configuração.
    const stored = db.memory.examApplications.find(item => item.id === application.id);
    delete stored.keystrokeMode;
    delete db.memory.classes[0].onlineExamConfigs[examKey].keystrokeMode;
    const old = await sendKeys({ applicationId: application.id }).expect(200);
    assert.equal(old.body.inserted, 4);
    const synced = await request(app).get('/api/student/sync').set('x-session-token', student.token)
        .query({ email: student.email, studentClass, courseId, examKey, applicationId: application.id }).expect(200);
    assert.equal(synced.body.onlineExamConfigs[examKey].keystrokeMode, 'eventos');
    // O painel também vê 'eventos', sem gravar o campo na aplicação antiga.
    const listed = await admin('get', '/api/admin/exam-applications').query({ studentClass, courseId, examKey }).expect(200);
    assert.equal(listed.body.applications.find(item => item.id === application.id).keystrokeMode, 'eventos');
    const single = await admin('get', `/api/admin/exam-applications/${application.id}`).expect(200);
    assert.equal(single.body.application.keystrokeMode, 'eventos');
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'keystrokeMode'), false);
    // ...e sabe que ela é de antes desta versão: o que já guardou é a digitação completa.
    assert.equal(listed.body.applications.find(item => item.id === application.id).keystrokeModeLegacy, true);
    assert.equal(single.body.application.keystrokeModeLegacy, true);
    await finish(application);
    // Aplicação nova (com o campo) não tem a marca.
    const fresh = await prepareAndStart({ keystrokeMode: 'tudo' });
    const freshListed = await admin('get', '/api/admin/exam-applications').query({ studentClass, courseId, examKey }).expect(200);
    assert.equal(freshListed.body.applications.find(item => item.id === fresh.id).keystrokeModeLegacy, undefined);
    const freshSingle = await admin('get', `/api/admin/exam-applications/${fresh.id}`).expect(200);
    assert.equal(freshSingle.body.application.keystrokeModeLegacy, undefined);
    await finish(fresh);

    // Sem aplicação (prova de antes das aplicações): 'eventos'.
    const loose = await sendKeys({ examKey: 'Prova_Sem_Aplicacao' }).expect(200);
    assert.equal(loose.body.inserted, 4);
});
