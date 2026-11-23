// Agendamento de prova e de material (fase 3, P3-S12: AVA-20 e UXI-17; D25, D26 e D27 do
// desenho do P3, contratos C5, C6 e C10). A varredura (utils/examSchedule.js
// sweepSchedules) recebe o relógio de quem chama: aqui o teste injeta a hora.
//
// - A aplicação preparada com agenda abre sozinha em abreEm e fecha em fechaEm entregando
//   o que cada aluno salvou; o aluno vê "Abre em ..." antes, sem questões nem token.
// - Servidor desligado em abreEm (D26): ligou dentro da janela, abre na hora e avisa o
//   professor; ligou depois do fim, fica preparada como "perdida" e nunca abre sozinha.
// - O tempo fora do ar devolvido (pausa) e o "+N min" da turma empurram o fechamento.
// - Agenda no passado, janela de 3 min ou de 13 h e mais de 60 dias à frente dão 400; a
//   data digitada é a do relógio da escola (America/Sao_Paulo).
// - Material (D27): apostila e gabarito liberados sozinhos; o gabarito espera a aplicação
//   aberta da prova; a prova online nunca entra na agenda.
// - Aplicação e turma de antes desta versão (sem agenda) não mudam.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-exam-schedule-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const schoolTime = require('../../backend/utils/schoolTime.js');
const examSchedule = require('../../backend/utils/examSchedule.js');
const studentFeeds = require('../../backend/utils/studentFeeds.js');
const { encodeAnswersForStudent } = require('../../backend/utils/examAnswerIds.js');

let app;
const adminToken = 'admin-token-schedule';
const otherProfessorToken = 'professor-token-schedule';
const studentClass = '2AGD';
const otherClass = '3AGD';
const courseId = 'curso-agenda';
const examKey = 'Avaliacao_Agenda';
const apostilaKey = 'Apostila_Agenda';
const answerKey = `Gabarito_${examKey}`;
const ALICE = { email: 'alice@agenda.local', token: 'token-alice-agenda' };
const BRUNO = { email: 'bruno@agenda.local', token: 'token-bruno-agenda' };
const MINUTE = 60 * 1000;

const admin = req => req.set('x-admin-session', adminToken);
const asStudent = (req, student) => req.set('x-session-token', student.token);
const local = ms => examSchedule.localDateTimeOf(ms);
const audits = type => (db.memory.auditLogs || []).filter(entry => entry.type === type || entry.action === type);
const classOf = name => db.memory.classes.find(cls => cls.name === name);

function seed() {
    db.memory.admins = [
        { email: 'admin@agenda.local', name: 'Admin Agenda', role: 'admin', password: db.hashPassword('senha-administrativa') },
        { email: 'prof@outra.local', name: 'Prof Outra', role: 'professor', password: db.hashPassword('senha-professor-x'), assignedClasses: [{ courseId, className: otherClass }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@agenda.local', createdAt: Date.now(), lastSeen: Date.now() },
        [otherProfessorToken]: { email: 'prof@outra.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    const student = (name, email) => ({ name, email, status: 'Ativo', classes: [{ name: studentClass, courseId }] });
    db.memory.students = [student('Alice Souza', ALICE.email), student('Bruno Lima', BRUNO.email)];
    db.memory.sessions = Object.fromEntries([ALICE, BRUNO].map(item => [item.email, { token: item.token, lastSeen: Date.now(), ip: '127.0.0.1' }]));
    db.memory.courses = [{ id: courseId, name: 'Curso da agenda', structure: [{ name: 'Módulo', units: [{ name: 'Unidade 3', apostilaKey, avaliacaoKey: examKey }] }] }];
    db.memory.classes = [
        { name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
        { name: otherClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
    ];
    db.memory.evaluations = {
        [examKey]: {
            key: examKey,
            title: 'Prova agendada',
            questions: [{
                number: 1,
                text: 'Questão única',
                correctAnswer: 'A',
                alternatives: [{ letter: 'A', text: 'Certa', isCorrect: true }, { letter: 'B', text: 'Errada', isCorrect: false }],
            }],
        },
    };
    db.memory.nonSchoolDays = [];
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
    db.memory.broadcastMessages = [];
    db.memory.auditLogs = [];
}

test.before(async () => {
    await db.init();
    app = createApp();
});
test.beforeEach(() => seed());
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function createHistory(durationMinutes = 120) {
    const response = await admin(request(app).post('/api/admin/exam-history/add')).send({
        studentClass, courseId, examKey, type: 'online', questionNumbers: [1],
        printSnapshot: [{ version: 'A', questions: [{ originalNumber: 1, text: 'Questão única', alternatives: [{ letter: 'A', text: 'Certa' }, { letter: 'B', text: 'Errada' }] }] }],
        durationMinutes, waitingRoomMinutes: 0, maxAttempts: 1,
    }).expect(200);
    return response.body.entry.id;
}

function prepare(historyId, options = {}, expected = 201) {
    return admin(request(app).post('/api/admin/exam-applications')).send({
        studentClass, courseId, examKey, historyId,
        applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1, durationMinutes: 120, ...options },
    }).expect(expected);
}

// Aplicação preparada com agenda de [abreEm, fechaEm] (gravada direto: o servidor estava
// desligado quando a hora chegou, coisa que a rota não deixa marcar no passado).
async function preparedWithAgenda(abreEm, fechaEm, options = {}) {
    const historyId = await createHistory(options.durationMinutes || 120);
    const prepared = await prepare(historyId, options);
    const application = db.memory.examApplications.find(item => item.id === prepared.body.application.id);
    application.agenda = examSchedule.createAgenda({ abreEm, fechaEm }, { actor: 'admin@agenda.local', now: abreEm - 60 * MINUTE });
    return application;
}

function sync(student, applicationId) {
    return asStudent(request(app).get('/api/student/sync'), student)
        .query({ email: student.email, studentClass, courseId, examKey, applicationId })
        .expect(200);
}

test('[UC-PROVA-008] data e hora digitadas no relógio da escola viram o instante certo', () => {
    assert.equal(examSchedule.parseLocalDateTime('2026-11-20T08:00', 'America/Sao_Paulo'), Date.UTC(2026, 10, 20, 11, 0));
    assert.equal(schoolTime.deadlineFromLocal('2026-11-20', '08:00', 'America/Sao_Paulo'), Date.UTC(2026, 10, 20, 11, 0));
    assert.equal(examSchedule.parseLocalDateTime('2026-11-20 08:00', 'America/Sao_Paulo'), Date.UTC(2026, 10, 20, 11, 0));
    assert.equal(examSchedule.localDateTimeOf(Date.UTC(2026, 10, 20, 11, 0), 'America/Sao_Paulo'), '2026-11-20T08:00');
    for (const bad of ['', '2026-11-31T08:00', '2026-11-20T24:00', '20/11/2026 08:00', null, 123]) {
        assert.equal(examSchedule.parseLocalDateTime(bad, 'America/Sao_Paulo'), null, String(bad));
    }
    const open = Date.UTC(2026, 10, 20, 11, 0);
    assert.equal(examSchedule.describeWindow(open, open + 90 * MINUTE, 'America/Sao_Paulo'), 'abre em 20/11 às 08:00 e fecha às 09:30');
    assert.equal(examSchedule.describeWindow(open + 15 * 60 * MINUTE, open + 17 * 60 * MINUTE, 'America/Sao_Paulo'), 'abre em 20/11 às 23:00 e fecha em 21/11 às 01:00');
});

test('[UC-PROVA-008] agenda no passado, janela de 3 min ou de 13 h e mais de 60 dias à frente dão 400', async () => {
    const historyId = await createHistory();
    const base = Date.now() + 30 * MINUTE;
    const cases = [
        [{ abreEmLocal: local(Date.now() - 10 * MINUTE), fechaEmLocal: local(Date.now() + 60 * MINUTE) }, 'applicationOptions.agenda.abreEmLocal', /já passou/],
        [{ abreEmLocal: local(base), fechaEmLocal: local(base + 3 * MINUTE) }, 'applicationOptions.agenda.fechaEmLocal', /pelo menos 5 minutos/],
        [{ abreEmLocal: local(base), fechaEmLocal: local(base + 13 * 60 * MINUTE) }, 'applicationOptions.agenda.fechaEmLocal', /no máximo 12 horas/],
        [{ abreEmLocal: local(base), fechaEmLocal: local(base - 10 * MINUTE) }, 'applicationOptions.agenda.fechaEmLocal', /depois do de abrir/],
        [{ abreEmLocal: local(Date.now() + 61 * 24 * 60 * MINUTE), fechaEmLocal: local(Date.now() + 61 * 24 * 60 * MINUTE + 60 * MINUTE) }, 'applicationOptions.agenda.abreEmLocal', /60 dias/],
        [{ abreEmLocal: '2026-02-30T08:00', fechaEmLocal: '2026-02-30T09:00' }, 'applicationOptions.agenda.abreEmLocal', /data e a hora/],
    ];
    for (const [agenda, field, message] of cases) {
        const response = await prepare(historyId, { agenda }, 400);
        assert.equal(response.body.field, field, JSON.stringify(agenda));
        assert.match(response.body.error, message);
    }
    assert.equal(db.memory.examApplications.length, 0, 'agenda inválida não prepara nada');
    // Tipo errado no campo: 400 do schema.
    const typed = await prepare(historyId, { agenda: { abreEmLocal: 123 } }, 400);
    assert.equal(typed.body.field, 'applicationOptions.agenda.abreEmLocal');
});

test('[UC-PROVA-008] agendada: o aluno vê "Abre em..." sem questões nem token; abre e fecha sozinha entregando o que foi salvo', async () => {
    const historyId = await createHistory(120);
    const abreEm = Math.ceil((Date.now() + 3 * MINUTE) / MINUTE) * MINUTE;
    const fechaEm = abreEm + 60 * MINUTE;
    const prepared = await prepare(historyId, { tokenEnabled: true, accessToken: 'AGEND', agenda: { abreEmLocal: local(abreEm), fechaEmLocal: local(fechaEm) } });
    const view = prepared.body.application.agendaView;
    assert.equal(view.estado, 'agendada');
    assert.equal(view.abreEm, abreEm);
    assert.equal(view.fechaEm, fechaEm);
    assert.equal(prepared.body.application.status, 'prepared');
    const application = db.memory.examApplications.find(item => item.id === prepared.body.application.id);
    assert.equal(application.agenda.criadoPor, 'admin@agenda.local');
    assert.equal(audits('exam_application_scheduled').length, 1);
    assert.deepEqual(audits('exam_application_scheduled')[0].details, { abreEm, fechaEm });

    // Aluno: a lista de sempre não traz a agendada; agendadas traz o horário, nada mais.
    const before = await asStudent(request(app).get('/api/student/exam-applications'), ALICE).query({ studentClass, courseId }).expect(200);
    assert.deepEqual(before.body.applications, []);
    assert.equal(before.body.agendadas.length, 1);
    const scheduled = before.body.agendadas[0];
    assert.equal(scheduled.id, application.id);
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(scheduled.janela, examSchedule.describeWindow(abreEm, fechaEm));
    assert.equal(scheduled.tokenEnabled, true);
    for (const secret of ['versionSnapshots', 'accessTokenHash', 'accessTokenSealed', 'config', 'questions', 'participants', 'studentOverrides', 'agenda']) {
        assert.equal(Object.prototype.hasOwnProperty.call(scheduled, secret), false, secret);
    }
    // Antes da hora: começar a tentativa é recusado, e a mensagem fala do horário marcado
    // (antes dizia "ainda não foi iniciada pelo professor", J2).
    const early = await asStudent(request(app).post(`/api/student/exam-applications/${application.id}/start-attempt`), ALICE).send({}).expect(409);
    assert.equal(early.body.error, `A prova abre em ${examSchedule.formatWhen(abreEm)}.`);
    assert.doesNotMatch(early.body.error, /professor/);

    // A varredura antes da hora não muda nada.
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: abreEm - 1000 }).changed, false);
    assert.equal(application.status, 'prepared');

    // Na hora: abre (sem sala de espera, direto em andamento) e a turma passa a ter a prova.
    const opened = examSchedule.sweepSchedules(db.memory, { now: abreEm + 2000 });
    assert.equal(opened.opened.length, 1);
    assert.equal(application.status, 'running');
    assert.equal(application.agenda.abertaEm, abreEm + 2000);
    assert.equal(application.agenda.atrasoSegundos, 2);
    const cls = classOf(studentClass);
    assert.equal(cls.releasedItems[examKey], true);
    assert.equal(cls.activeApplicationId, application.id);
    assert.equal(cls.onlineExamConfigs[examKey].status, 'running');
    const auto = audits('exam_application_auto_opened');
    assert.equal(auto.length, 1);
    assert.equal(auto[0].actor, 'sistema');
    assert.equal(auto[0].details.atrasoSegundos, 2);
    // Repetir a volta não abre de novo.
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: abreEm + 12000 }).changed, false);
    // O token continua exigido.
    const afterOpen = await asStudent(request(app).get('/api/student/exam-applications'), ALICE).query({ studentClass, courseId }).expect(200);
    assert.equal(afterOpen.body.agendadas.length, 0);
    assert.equal(afterOpen.body.applications.length, 1);
    assert.equal(afterOpen.body.applications[0].tokenEnabled, true);

    // Alice começa e salva uma resposta (com o relógio de verdade).
    application.tokenEnabled = false;
    await sync(ALICE, application.id);
    const started = await asStudent(request(app).post(`/api/student/exam-applications/${application.id}/start-attempt`), ALICE).send({}).expect(200);
    await asStudent(request(app).post('/api/student/autosave-progress'), ALICE)
        .send({ studentClass, courseId, examKey, applicationId: application.id, attemptId: started.attemptId, answers: encodeAnswersForStudent({ 1: 'A' }, application.id) })
        .expect(200);

    // Um pouco antes do fechamento: nada muda. No fechamento: encerra com "entregar o que foi salvo".
    assert.equal(examSchedule.effectiveCloseAt(application, fechaEm - 1000), fechaEm);
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: fechaEm - 1000 }).finished.length, 0);
    const closed = examSchedule.sweepSchedules(db.memory, { now: fechaEm });
    assert.equal(closed.finished.length, 1);
    assert.equal(closed.finished[0].entregues, 1);
    assert.equal(application.status, 'finished');
    assert.equal(application.agenda.encerradaEm, fechaEm);
    assert.equal(application.finishResolution.policy, 'submit');
    assert.equal(application.finishResolution.reason, 'agendamento');
    const submission = db.memory.submissions.find(item => item.applicationId === application.id);
    assert.ok(submission, 'a tentativa em andamento virou entrega');
    assert.equal(submission.finishPolicy, 'submit');
    // Entregue pelo horário de fechar, não pelo professor: o Monitor e Resultados não
    // dizem "Salva pelo professor ao encerrar".
    assert.equal(submission.finishedBySchedule, true);
    assert.equal(submission.autoSubmittedByInstructor, undefined);
    const monitor = await admin(request(app).get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${examKey}`))
        .query({ courseId, applicationId: application.id }).expect(200);
    const aliceRow = monitor.body.find(row => row.email === ALICE.email);
    assert.equal(aliceRow.submissionSource, 'instructor_finish');
    assert.equal(aliceRow.finishedBySchedule, true);
    assert.equal(submission.gradedAnswers[0].studentChoice, 'A', 'com a resposta salva');
    assert.equal(submission.score, 100);
    assert.equal(cls.releasedItems[examKey], false);
    assert.equal(cls.activeApplicationId, null);
    assert.equal(audits('exam_application_auto_finished').length, 1);
    assert.equal(audits('exam_application_auto_finished')[0].details.entregues, 1);
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: fechaEm + 10000 }).changed, false);

    // O registro da aplicação descreve o agendamento.
    const trail = await admin(request(app).get(`/api/admin/exam-applications/${application.id}/audit`)).expect(200);
    const titles = trail.body.entries.map(entry => entry.title);
    assert.ok(titles.includes('Prova agendada'), titles.join(' | '));
    assert.ok(titles.includes('Prova aberta pelo agendamento'));
    assert.ok(titles.includes('Prova encerrada pelo agendamento'));
});

test('[UC-PROVA-008] com sala de espera a prova agendada abre na sala de espera', async () => {
    const now = Date.now();
    const application = await preparedWithAgenda(now + 10 * MINUTE, now + 70 * MINUTE, { waitingRoomMinutes: 5 });
    examSchedule.sweepSchedules(db.memory, { now: now + 10 * MINUTE });
    assert.equal(application.status, 'waiting');
    assert.equal(application.startsAt, now + 15 * MINUTE);
});

test('[UC-PROVA-008] servidor ligado no meio da janela: abre na hora do boot e avisa o professor', async () => {
    const now = Date.now();
    const application = await preparedWithAgenda(now - 20 * MINUTE, now + 40 * MINUTE);
    const result = examSchedule.sweepSchedules(db.memory, { now });
    assert.equal(result.opened.length, 1);
    assert.equal(application.status, 'running');
    assert.equal(application.agenda.atrasoSegundos, 20 * 60);
    const view = examSchedule.scheduleView(application, { now });
    assert.equal(view.estado, 'aberta');
    assert.equal(view.abertaAtrasada, true);
    const cls = classOf(studentClass);
    const queue = studentFeeds.collectInstructorQueue({ memory: db.memory, cls, now }).filter(item => item.id.startsWith('agendamento'));
    assert.equal(queue.length, 1);
    assert.equal(queue[0].id, 'agendamento_atrasado');
    assert.match(queue[0].detalhe, /20 min depois/);
    // Pela rota da fila do Dashboard também.
    const dashboard = await admin(request(app).get('/api/admin/dashboard/queue')).query({ courseId, studentClass }).expect(200);
    const late = dashboard.body.find(item => item.id === 'agendamento_atrasado');
    assert.ok(late, JSON.stringify(dashboard.body));
    assert.equal(late.tone, 'warning');
});

test('[UC-PROVA-008] servidor ligado depois do fim: a prova fica perdida, nunca abre sozinha e o professor é avisado', async () => {
    const now = Date.now();
    const application = await preparedWithAgenda(now - 90 * MINUTE, now - 30 * MINUTE);
    const result = examSchedule.sweepSchedules(db.memory, { now });
    assert.equal(result.missed.length, 1);
    assert.equal(result.opened.length, 0);
    assert.equal(application.status, 'prepared');
    assert.equal(application.agenda.perdida, true);
    assert.equal(audits('exam_application_schedule_missed').length, 1);
    // Idempotente: outra volta não repete nada.
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: now + 10000 }).changed, false);
    assert.equal(audits('exam_application_schedule_missed').length, 1);
    // O aluno não vê nada; o professor vê o aviso.
    const list = await asStudent(request(app).get('/api/student/exam-applications'), ALICE).query({ studentClass, courseId }).expect(200);
    assert.deepEqual(list.body.applications, []);
    assert.deepEqual(list.body.agendadas, []);
    const queue = examSchedule.queueItems({ memory: db.memory, cls: classOf(studentClass), now });
    assert.equal(queue[0].id, 'agendamento_perdido');
    assert.equal(queue[0].tone, 'danger');
    assert.match(queue[0].href, /applicationId=/);
    const adminView = await admin(request(app).get('/api/admin/exam-applications')).query({ studentClass, courseId, view: 'summary' }).expect(200);
    assert.equal(adminView.body.applications[0].agendaView.estado, 'perdida');

    // "Abrir agora" à mão: a prova perdida abre e nunca fecha sozinha.
    await admin(request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'start' }).expect(200);
    assert.equal(application.status, 'running');
    assert.equal(examSchedule.effectiveCloseAt(application, Date.now()), null);
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: Date.now() }).finished.length, 0);
    assert.equal(application.status, 'running');
});

test('[UC-PROVA-008] agenda perdida agendada de novo volta a valer com o horário novo', async () => {
    const now = Date.now();
    const application = await preparedWithAgenda(now - 90 * MINUTE, now - 30 * MINUTE);
    examSchedule.sweepSchedules(db.memory, { now });
    assert.equal(application.agenda.perdida, true);
    const abreEm = Math.ceil((now + 5 * MINUTE) / MINUTE) * MINUTE;
    const response = await admin(request(app).post(`/api/admin/exam-applications/${application.id}/schedule`))
        .send({ abreEmLocal: local(abreEm), fechaEmLocal: local(abreEm + 30 * MINUTE) }).expect(200);
    assert.equal(response.body.application.agendaView.estado, 'agendada');
    assert.equal(application.agenda.perdida, undefined);
    const changed = audits('exam_application_schedule_changed');
    assert.equal(changed.length, 1);
    assert.equal(changed[0].details.antes.perdida, true);
    examSchedule.sweepSchedules(db.memory, { now: abreEm });
    assert.equal(application.status, 'running');
});

test('[UC-PROVA-008] tempo fora do ar devolvido e "+N min" da turma empurram o fechamento; a pausa congela', async () => {
    const now = Date.now();
    const application = await preparedWithAgenda(now, now + 60 * MINUTE);
    examSchedule.sweepSchedules(db.memory, { now });
    assert.equal(application.status, 'running');
    const fechaEm = application.agenda.fechaEm;
    // 5 min fora do ar no meio da janela, devolvidos como pausa (H3b).
    application.pauses = [{ pausedAt: now + 20 * MINUTE, resumedAt: now + 25 * MINUTE, reason: 'server_outage' }];
    assert.equal(examSchedule.effectiveCloseAt(application, fechaEm), fechaEm + 5 * MINUTE);
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: fechaEm + MINUTE }).finished.length, 0);
    assert.equal(application.status, 'running');
    // +10 min para a turma.
    application.globalTimeAdjustment = 10;
    assert.equal(examSchedule.effectiveCloseAt(application, fechaEm), fechaEm + 15 * MINUTE);
    // Pausada pelo professor no fechamento: o relógio para e a prova não fecha.
    application.status = 'paused';
    application.pauses.push({ pausedAt: fechaEm + 2 * MINUTE, resumedAt: null });
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: fechaEm + 60 * MINUTE }).finished.length, 0);
    application.pauses[1].resumedAt = fechaEm + 62 * MINUTE;
    application.status = 'running';
    const closeAt = examSchedule.effectiveCloseAt(application, fechaEm + 62 * MINUTE);
    assert.equal(closeAt, fechaEm + 15 * MINUTE + 60 * MINUTE);
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: closeAt }).finished.length, 1);
    assert.equal(application.status, 'finished');
});

test('[UC-PROVA-008] aberta à mão antes da hora fecha sozinha; "Não encerrar sozinha" tira o fechamento', async () => {
    const now = Date.now();
    const abreEm = Math.ceil((now + 10 * MINUTE) / MINUTE) * MINUTE;
    const historyId = await createHistory();
    const prepared = await prepare(historyId, { agenda: { abreEmLocal: local(abreEm), fechaEmLocal: local(abreEm + 30 * MINUTE) } });
    const application = db.memory.examApplications.find(item => item.id === prepared.body.application.id);
    // Mudar o horário só na preparada; em andamento, 409.
    await admin(request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'start' }).expect(200);
    assert.equal(examSchedule.effectiveCloseAt(application, Date.now()), abreEm + 30 * MINUTE);
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: abreEm }).opened.length, 0, 'já aberta não abre de novo');
    const refused = await admin(request(app).post(`/api/admin/exam-applications/${application.id}/schedule`))
        .send({ abreEmLocal: local(abreEm + 60 * MINUTE), fechaEmLocal: local(abreEm + 90 * MINUTE) }).expect(409);
    assert.equal(refused.body.code, 'schedule_started');
    const cancelled = await admin(request(app).post(`/api/admin/exam-applications/${application.id}/schedule`)).send({ cancelar: true }).expect(200);
    assert.equal(cancelled.body.application.agendaView.estado, 'fechamento_cancelado');
    assert.equal(examSchedule.effectiveCloseAt(application, abreEm + 31 * MINUTE), null);
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: abreEm + 31 * MINUTE }).finished.length, 0);
    assert.equal(application.status, 'running');
    const changed = audits('exam_application_schedule_changed');
    assert.equal(changed.length, 1);
    assert.equal(changed[0].details.fechamentoCancelado, true);
    // Repetir não grava outra auditoria.
    const again = await admin(request(app).post(`/api/admin/exam-applications/${application.id}/schedule`)).send({ cancelar: true }).expect(200);
    assert.equal(again.body.unchanged, true);
    assert.equal(audits('exam_application_schedule_changed').length, 1);
});

test('[UC-PROVA-008] rota de agendamento: muda, cancela, escopo do professor e aplicação encerrada', async () => {
    const now = Date.now();
    const historyId = await createHistory();
    const prepared = await prepare(historyId);
    const id = prepared.body.application.id;
    assert.equal(prepared.body.application.agendaView, undefined, 'sem agenda, como sempre');
    const abreEm = Math.ceil((now + 30 * MINUTE) / MINUTE) * MINUTE;
    const body = { abreEmLocal: local(abreEm), fechaEmLocal: local(abreEm + 45 * MINUTE) };
    await request(app).post(`/api/admin/exam-applications/${id}/schedule`).set('x-admin-session', otherProfessorToken).send(body).expect(403);
    const first = await admin(request(app).post(`/api/admin/exam-applications/${id}/schedule`)).send(body).expect(200);
    assert.equal(first.body.application.agendaView.estado, 'agendada');
    assert.equal(audits('exam_application_scheduled').length, 1);
    const same = await admin(request(app).post(`/api/admin/exam-applications/${id}/schedule`)).send(body).expect(200);
    assert.equal(same.body.unchanged, true);
    const moved = await admin(request(app).post(`/api/admin/exam-applications/${id}/schedule`))
        .send({ abreEmLocal: local(abreEm + 60 * MINUTE), fechaEmLocal: local(abreEm + 120 * MINUTE) }).expect(200);
    assert.equal(moved.body.application.agendaView.abreEm, abreEm + 60 * MINUTE);
    const bad = await admin(request(app).post(`/api/admin/exam-applications/${id}/schedule`)).send({ abreEmLocal: local(abreEm), fechaEmLocal: local(abreEm + 2 * MINUTE) }).expect(400);
    assert.equal(bad.body.field, 'fechaEmLocal');
    const cancelled = await admin(request(app).post(`/api/admin/exam-applications/${id}/schedule`)).send({ cancelar: true }).expect(200);
    assert.equal(cancelled.body.application.agendaView, undefined);
    assert.equal(cancelled.body.application.status, 'prepared');
    const changes = audits('exam_application_schedule_changed');
    assert.equal(changes.length, 2);
    assert.equal(changes[1].details.depois, null);
    await admin(request(app).post(`/api/admin/exam-applications/${id}/control`)).send({ action: 'cancel' }).expect(200);
    const closed = await admin(request(app).post(`/api/admin/exam-applications/${id}/schedule`)).send(body).expect(409);
    assert.equal(closed.body.code, 'application_closed');
    await admin(request(app).post('/api/admin/exam-applications/nao-existe/schedule')).send(body).expect(404);
});

test('[UC-PROVA-008] dia não letivo e janela menor que a prova só avisam, nunca bloqueiam', async () => {
    const abreEm = Math.ceil((Date.now() + 2 * 24 * 60 * MINUTE) / MINUTE) * MINUTE;
    const date = schoolTime.schoolDateOf(abreEm);
    db.memory.nonSchoolDays = [{ id: 'nl_1', inicio: date, fim: date, tipo: 'feriado', nome: 'Feriado municipal', escopo: 'instituicao' }];
    const check = await admin(request(app).get('/api/admin/exam-applications/schedule-check'))
        .query({ studentClass, courseId, abreEmLocal: local(abreEm), fechaEmLocal: local(abreEm + 30 * MINUTE), durationMinutes: 60 }).expect(200);
    const codes = check.body.avisos.map(aviso => aviso.code);
    assert.deepEqual(codes, ['nao_letivo', 'janela_curta']);
    assert.match(check.body.avisos[0].texto, /Feriado municipal/);
    assert.match(check.body.avisos[1].texto, /30 min e dura 60 min/);
    const historyId = await createHistory(60);
    const prepared = await prepare(historyId, { durationMinutes: 60, agenda: { abreEmLocal: local(abreEm), fechaEmLocal: local(abreEm + 30 * MINUTE) } });
    assert.equal(prepared.body.application.agendaView.estado, 'agendada');
    assert.deepEqual(prepared.body.avisos.map(aviso => aviso.code), ['nao_letivo', 'janela_curta']);
    await request(app).get('/api/admin/exam-applications/schedule-check').set('x-admin-session', otherProfessorToken)
        .query({ studentClass, courseId, abreEmLocal: local(abreEm) }).expect(403);
});

test('[UC-PROVA-008] calendário e sino do aluno mostram a prova e a liberação agendadas', async () => {
    const now = Date.now();
    const abreEm = Math.ceil((now + 24 * 60 * MINUTE) / MINUTE) * MINUTE;
    await preparedWithAgenda(abreEm, abreEm + 90 * MINUTE);
    await admin(request(app).post('/api/admin/release-item')).send({ studentClass, courseId, itemKey: apostilaKey, releaseAtLocal: local(abreEm - 60 * MINUTE) }).expect(200);
    const calendar = await asStudent(request(app).get('/api/student/calendar-events'), ALICE).query({ studentClass, courseId }).expect(200);
    const exam = calendar.body.find(event => String(event.id).startsWith('prova-agendada:'));
    assert.ok(exam, JSON.stringify(calendar.body));
    const openParts = schoolTime.localParts(abreEm);
    assert.equal(exam.eventDate, openParts.date);
    assert.equal(exam.startTime, openParts.time);
    assert.equal(exam.eventType, 'prova');
    assert.equal(exam.title, 'Prova agendada');
    const release = calendar.body.find(event => String(event.id).startsWith('liberacao:'));
    assert.ok(release);
    assert.equal(release.title, 'Apostila · Unidade 3');
    const notifications = await asStudent(request(app).get('/api/student/notifications'), ALICE).query({ studentClass, courseId }).expect(200);
    const items = notifications.body.items || notifications.body.notifications || notifications.body;
    assert.ok(JSON.stringify(items).includes('prova-agendada:'), JSON.stringify(items));
});

test('[UC-PROVA-008] material: agendar libera sozinho na hora, com releaseMeta e content_release_auto', async () => {
    const now = Date.now();
    const at = Math.ceil((now + 10 * MINUTE) / MINUTE) * MINUTE;
    const response = await admin(request(app).post('/api/admin/release-item')).send({ studentClass, courseId, itemKey: apostilaKey, releaseAtLocal: local(at) }).expect(200);
    assert.equal(response.body.releaseSchedule[apostilaKey].at, at);
    const cls = classOf(studentClass);
    assert.equal(cls.releaseSchedule[apostilaKey].released, true);
    assert.equal(cls.releasedItems[apostilaKey], undefined, 'agendar não libera agora');
    const scheduledAudit = audits('content_release_scheduled');
    assert.equal(scheduledAudit.length, 1);
    assert.equal(scheduledAudit[0].category, 'content');
    // Materiais lê a agenda pelo /api/status do painel (o aluno não a recebe).
    const status = await admin(request(app).get('/api/status')).query({ studentClass, courseId }).expect(200);
    assert.equal(status.body.releaseSchedule[apostilaKey].atLabel, examSchedule.formatWhen(at));
    const studentStatus = await asStudent(request(app).get('/api/status'), ALICE).query({ studentClass, courseId }).expect(200);
    assert.equal(studentStatus.body.releaseSchedule, undefined);

    assert.equal(examSchedule.sweepSchedules(db.memory, { now: at - 1000 }).released.length, 0);
    const result = examSchedule.sweepSchedules(db.memory, { now: at });
    assert.equal(result.released.length, 1);
    assert.equal(cls.releasedItems[apostilaKey], true);
    assert.equal(cls.releaseMeta[apostilaKey].released, true);
    assert.equal(cls.releaseMeta[apostilaKey].agendado, true);
    assert.match(cls.releaseMeta[apostilaKey].by, /^Agendamento de Admin Agenda/);
    assert.equal(cls.releaseSchedule[apostilaKey], undefined);
    const auto = audits('content_release_auto');
    assert.equal(auto.length, 1);
    assert.equal(auto[0].studentClass, studentClass);
    assert.equal(auto[0].details.adiado, false);
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: at + 10000 }).changed, false);
});

test('[UC-PROVA-008] material: gabarito agendado espera a aplicação aberta e sai depois do encerramento', async () => {
    const now = Date.now();
    const historyId = await createHistory();
    const prepared = await prepare(historyId);
    const application = db.memory.examApplications.find(item => item.id === prepared.body.application.id);
    const at = Math.ceil((now + 10 * MINUTE) / MINUTE) * MINUTE;
    const response = await admin(request(app).post('/api/admin/release-item')).send({ studentClass, courseId, itemKey: answerKey, releaseAtLocal: local(at) }).expect(200);
    assert.deepEqual(response.body.avisos.map(aviso => aviso.code), ['gabarito_espera']);
    const cls = classOf(studentClass);
    const postponed = examSchedule.sweepSchedules(db.memory, { now: at });
    assert.equal(postponed.postponed.length, 1);
    assert.equal(postponed.released.length, 0);
    assert.ok(cls.releaseSchedule[answerKey].adiadoEm > 0);
    assert.notEqual(cls.releasedItems[answerKey], true);
    const queue = examSchedule.queueItems({ memory: db.memory, cls, now: at });
    assert.ok(queue.some(item => item.id === 'liberacao_adiada'));
    const status = await admin(request(app).get('/api/status')).query({ studentClass, courseId }).expect(200);
    assert.equal(status.body.releaseSchedule[answerKey].adiado, true);
    // Outra volta com a aplicação aberta: não grava de novo.
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: at + 10000 }).changed, false);
    // Encerrada a aplicação, a próxima volta libera (marcada como adiada).
    await admin(request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'cancel' }).expect(200);
    const released = examSchedule.sweepSchedules(db.memory, { now: at + 20000 });
    assert.equal(released.released.length, 1);
    assert.equal(cls.releasedItems[answerKey], true);
    assert.equal(audits('content_release_auto')[0].details.adiado, true);
});

test('[UC-PROVA-008] material: cancelar, prova online, aluno só, item já liberado e liberar à mão', async () => {
    const at = Math.ceil((Date.now() + 10 * MINUTE) / MINUTE) * MINUTE;
    const post = (payload, expected) => admin(request(app).post('/api/admin/release-item')).send({ studentClass, courseId, ...payload }).expect(expected);
    const exam = await post({ itemKey: examKey, releaseAtLocal: local(at) }, 400);
    assert.equal(exam.body.code, 'schedule_not_allowed');
    await post({ itemKey: apostilaKey, studentEmail: ALICE.email, releaseAtLocal: local(at) }, 400);
    await post({ itemKey: apostilaKey, releaseAtLocal: local(Date.now() - 5 * MINUTE) }, 400);
    await post({ itemKey: apostilaKey, releaseAtLocal: 'amanhã' }, 400);
    await post({ itemKey: apostilaKey, releaseAtLocal: 123 }, 400);
    await post({ itemKey: apostilaKey, releaseAtLocal: local(at) }, 200);
    const cancelled = await post({ itemKey: apostilaKey, cancelSchedule: true }, 200);
    assert.deepEqual(cancelled.body.releaseSchedule, {});
    const cancelAudit = audits('content_release_scheduled');
    assert.equal(cancelAudit.length, 2);
    assert.equal(cancelAudit[1].newValue, 'cancelada');
    assert.equal((await post({ itemKey: apostilaKey, cancelSchedule: true }, 200)).body.unchanged, true);
    // Liberar à mão tira a agenda do item; agendar o que já está liberado: 409.
    await post({ itemKey: apostilaKey, releaseAtLocal: local(at) }, 200);
    const manual = await post({ itemKey: apostilaKey, released: true }, 200);
    assert.equal(manual.body.scheduleDropped, true);
    assert.equal(classOf(studentClass).releaseSchedule[apostilaKey], undefined);
    const already = await post({ itemKey: apostilaKey, releaseAtLocal: local(at) }, 409);
    assert.equal(already.body.code, 'already_released');
    // Bloquear não mexe na agenda de outro item.
    await post({ itemKey: answerKey, releaseAtLocal: local(at) }, 200);
    await post({ itemKey: answerKey, released: false }, 200);
    assert.ok(classOf(studentClass).releaseSchedule[answerKey]);
});

test('[UC-PROVA-008] aplicações e turmas de antes desta versão (sem agenda) não mudam', async () => {
    const historyId = await createHistory();
    const prepared = await prepare(historyId);
    const application = db.memory.examApplications.find(item => item.id === prepared.body.application.id);
    const now = Date.now();
    // Agenda malformada (de outra versão ou editada à mão) vale como sem agenda.
    const before = JSON.stringify(db.memory.examApplications);
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: now + 24 * 60 * MINUTE }).changed, false);
    application.agenda = { abreEm: 'x', fechaEm: null };
    assert.equal(examSchedule.sweepSchedules(db.memory, { now }).changed, false);
    assert.equal(examSchedule.scheduleView(application), null);
    delete application.agenda;
    assert.equal(JSON.stringify(db.memory.examApplications), before);
    await admin(request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'start' }).expect(200);
    assert.equal(examSchedule.sweepSchedules(db.memory, { now: now + 24 * 60 * MINUTE }).finished.length, 0, 'sem agenda não fecha sozinha');
    assert.equal(application.status, 'running');
    classOf(studentClass).releaseSchedule = { [apostilaKey]: { at: 'amanhã' }, __proto__x: null };
    assert.equal(examSchedule.sweepSchedules(db.memory, { now }).changed, false);
    await admin(request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'finish', inProgressPolicy: 'submit' }).expect(200);
});

// Rodada de ajuste 1 do A11: o registro da aplicação, a prova do aluno com o horário de
// fechar, o gabarito preso por uma preparada que não abre e o curso clonado.
test('[UC-PROVA-008] registro e prova do aluno: o encerramento da agenda não diz "pelo professor" e a prova mostra o horário de fechar', async () => {
    const historyId = await createHistory(120);
    const abreEm = Math.ceil((Date.now() + 3 * MINUTE) / MINUTE) * MINUTE;
    const fechaEm = abreEm + 30 * MINUTE;
    const prepared = await prepare(historyId, { agenda: { abreEmLocal: local(abreEm), fechaEmLocal: local(fechaEm) } });
    const application = db.memory.examApplications.find(item => item.id === prepared.body.application.id);
    examSchedule.sweepSchedules(db.memory, { now: abreEm });
    assert.equal(application.status, 'running');

    // A prova do aluno traz o horário em que a aplicação fecha (o cronômetro dele conta 120 min).
    const running = await sync(ALICE, application.id);
    assert.equal(running.body.scheduleCloseAt, fechaEm);
    assert.equal(running.body.scheduleCloseLabel, examSchedule.formatWhen(fechaEm));
    assert.equal(running.body.finishedBySchedule, undefined);
    await asStudent(request(app).post(`/api/student/exam-applications/${application.id}/start-attempt`), ALICE).send({}).expect(200);

    // "Não encerrar sozinha" tira o horário da prova do aluno; sem agenda, nunca vem.
    application.agenda.fechamentoCanceladoEm = Date.now();
    const noClose = await sync(ALICE, application.id);
    assert.equal(noClose.body.scheduleCloseAt, undefined);
    delete application.agenda.fechamentoCanceladoEm;

    examSchedule.sweepSchedules(db.memory, { now: fechaEm });
    assert.equal(application.status, 'finished');
    const finished = await sync(ALICE, application.id);
    assert.equal(finished.body.finishOutcome, 'submitted');
    assert.equal(finished.body.finishedBySchedule, true);
    assert.equal(finished.body.scheduleCloseAt, undefined);

    const trail = await admin(request(app).get(`/api/admin/exam-applications/${application.id}/audit`)).expect(200);
    const opened = trail.body.entries.find(entry => entry.title === 'Prova aberta pelo agendamento');
    assert.ok(opened);
    assert.doesNotMatch(opened.detail, /às .* às /, opened.detail);
    assert.match(opened.detail, /no horário marcado/);
    const closedRow = trail.body.entries.find(entry => entry.title === 'Aplicação encerrada no horário marcado');
    assert.ok(closedRow, trail.body.entries.map(entry => entry.title).join(' | '));
    assert.match(closedRow.detail, /1 prova em andamento enviada pelo agendamento/);
    for (const entry of trail.body.entries) assert.doesNotMatch(`${entry.title} ${entry.detail}`, /pelo professor/);
});

test('[UC-PROVA-008] encerramento pelo professor continua com o texto de sempre no registro', async () => {
    const historyId = await createHistory(120);
    const prepared = await prepare(historyId);
    const application = db.memory.examApplications.find(item => item.id === prepared.body.application.id);
    await admin(request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'start' }).expect(200);
    await sync(ALICE, application.id);
    await asStudent(request(app).post(`/api/student/exam-applications/${application.id}/start-attempt`), ALICE).send({}).expect(200);
    await admin(request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'finish', inProgressPolicy: 'submit' }).expect(200);
    assert.equal(application.status, 'finished');
    const trail = await admin(request(app).get(`/api/admin/exam-applications/${application.id}/audit`)).expect(200);
    const row = trail.body.entries.find(entry => entry.title === 'Aplicação encerrada');
    assert.ok(row, trail.body.entries.map(entry => entry.title).join(' | '));
    assert.match(row.detail, /pelo professor/);
    const finished = await sync(ALICE, application.id);
    assert.equal(finished.body.finishedBySchedule, undefined);
});

test('[UC-PROVA-008] gabarito agendado preso por preparada que não abriu: Materiais e o Precisa de você dizem como destravar', async () => {
    const now = Date.now();
    const application = await preparedWithAgenda(now - 90 * MINUTE, now - 30 * MINUTE);
    examSchedule.sweepSchedules(db.memory, { now });
    assert.equal(application.agenda.perdida, true);
    const at = Math.ceil((now + 10 * MINUTE) / MINUTE) * MINUTE;
    await admin(request(app).post('/api/admin/release-item')).send({ studentClass, courseId, itemKey: answerKey, releaseAtLocal: local(at) }).expect(200);
    const cls = classOf(studentClass);
    examSchedule.sweepSchedules(db.memory, { now: at });
    assert.ok(cls.releaseSchedule[answerKey].adiadoEm > 0);
    const status = await admin(request(app).get('/api/status')).query({ studentClass, courseId }).expect(200);
    assert.equal(status.body.releaseSchedule[answerKey].adiado, true);
    assert.equal(status.body.releaseSchedule[answerKey].espera, 'perdida');
    const queue = examSchedule.queueItems({ memory: db.memory, cls, now: at });
    const item = queue.find(entry => entry.id === 'liberacao_adiada');
    assert.match(item.detalhe, /preparada que não abriu/);
    assert.match(item.detalhe, /bloqueada em Materiais/);

    // Bloquear a prova em Materiais cancela a preparação, e a próxima volta libera o gabarito.
    await admin(request(app).post('/api/admin/release-item')).send({ studentClass, courseId, itemKey: examKey, released: false }).expect(200);
    assert.equal(application.status, 'cancelled');
    const released = examSchedule.sweepSchedules(db.memory, { now: at + 10000 });
    assert.equal(released.released.length, 1);
    assert.equal(cls.releasedItems[answerKey], true);

    // Aplicação em andamento: espera 'andamento' e o texto de sempre.
    seed();
    const historyId = await createHistory();
    const running = await prepare(historyId);
    await admin(request(app).post(`/api/admin/exam-applications/${running.body.application.id}/control`)).send({ action: 'start' }).expect(200);
    await admin(request(app).post('/api/admin/release-item')).send({ studentClass, courseId, itemKey: answerKey, releaseAtLocal: local(at) }).expect(200);
    examSchedule.sweepSchedules(db.memory, { now: at });
    const view = examSchedule.releaseScheduleView(classOf(studentClass), { memory: db.memory });
    assert.equal(view[answerKey].espera, 'andamento');
    assert.match(examSchedule.queueItems({ memory: db.memory, cls: classOf(studentClass), now: at }).find(entry => entry.id === 'liberacao_adiada').detalhe, /ainda está aberta/);
});

test('[UC-PROVA-008] clonar o curso leva a liberação agendada com as chaves do curso novo', async () => {
    const at = Math.ceil((Date.now() + 30 * MINUTE) / MINUTE) * MINUTE;
    await admin(request(app).post('/api/admin/release-item')).send({ studentClass, courseId, itemKey: apostilaKey, releaseAtLocal: local(at) }).expect(200);
    await admin(request(app).post('/api/admin/release-item')).send({ studentClass, courseId, itemKey: answerKey, releaseAtLocal: local(at) }).expect(200);
    classOf(studentClass).releaseSchedule[answerKey].adiadoEm = Date.now();
    const cloned = await admin(request(app).post(`/api/admin/courses/${courseId}/clone`)).send({ newId: 'CLONE1', newName: 'Curso clonado' }).expect(200);
    const clonedCourseId = cloned.body.course.id;
    const clonedClass = db.memory.classes.find(cls => cls.name === studentClass && cls.courseId === clonedCourseId);
    assert.ok(clonedClass);
    assert.deepEqual(Object.keys(clonedClass.releaseSchedule).sort(), [`${apostilaKey}_CLONE1`, `Gabarito_${examKey}_CLONE1`].sort());
    assert.equal(clonedClass.releaseSchedule[`${apostilaKey}_CLONE1`].at, at);
    assert.equal(clonedClass.releaseSchedule[`Gabarito_${examKey}_CLONE1`].adiadoEm, undefined, 'o adiamento era da aplicação do curso de origem');
    // A turma de origem continua com as chaves dela; a varredura liga o item do curso novo.
    assert.deepEqual(Object.keys(classOf(studentClass).releaseSchedule).sort(), [apostilaKey, answerKey].sort());
    examSchedule.sweepSchedules(db.memory, { now: at });
    assert.equal(clonedClass.releasedItems[`${apostilaKey}_CLONE1`], true);
    assert.equal(clonedClass.releasedItems[apostilaKey], undefined);
});

// ------------------------------------------------------------ pendências do A11 (A18)
// (1) Começar antes da hora fala do horário marcado em todos os casos da agenda e da sala
// de espera; (2) o log e o registro da volta do boot dizem a hora real do que saiu
// atrasado; (3) o calendário do aluno nunca diz "Gabarito liberado" antes da liberação e
// acha a unidade do gabarito da prova editada só para a turma.

test('[UC-PROVA-008] A18: start-attempt sem a prova aberta fala do horário marcado, não do professor', async () => {
    const now = Date.now();
    // Agenda perdida: a prova não abriu e não vai abrir sozinha.
    const missed = await preparedWithAgenda(now - 90 * MINUTE, now - 30 * MINUTE);
    examSchedule.sweepSchedules(db.memory, { now });
    const refused = await asStudent(request(app).post(`/api/student/exam-applications/${missed.id}/start-attempt`), ALICE).send({}).expect(409);
    assert.equal(refused.body.scheduleMissed, true);
    assert.match(refused.body.error, /horário marcado para esta prova .* passou sem ela abrir/);
    assert.doesNotMatch(refused.body.error, /ainda não foi iniciada/);
    // No horário, antes da volta de 10 s abrir a prova: "está abrindo", para tentar de novo.
    const opening = { status: 'prepared', agenda: { abreEm: now - 5000, fechaEm: now + 60 * MINUTE } };
    const soon = examSchedule.notStartedResponse(opening, { now });
    assert.equal(soon.retryable, true);
    assert.match(soon.error, /abrindo agora, no horário marcado/);
    // Antes da hora (o texto do ce30b59 continua).
    const early = examSchedule.notStartedResponse({ status: 'prepared', agenda: { abreEm: now + 30 * MINUTE, fechaEm: now + 90 * MINUTE } }, { now });
    assert.equal(early.error, `A prova abre em ${examSchedule.formatWhen(now + 30 * MINUTE)}.`);
    // Horário de fechar passou sem a volta marcar perdida (servidor acabou de ligar).
    const passed = examSchedule.notStartedResponse({ status: 'prepared', agenda: { abreEm: now - 60 * MINUTE, fechaEm: now - MINUTE } }, { now });
    assert.equal(passed.scheduleMissed, true);
    // Sala de espera: diz a hora de começar.
    const startsAt = now + 5 * MINUTE;
    const waiting = examSchedule.notStartedResponse({ status: 'waiting', startsAt }, { now });
    assert.equal(waiting.waitingRoom, true);
    assert.match(waiting.error, new RegExp(`A prova começa (às|em .* às) ${schoolTime.localParts(startsAt).time}\\. Aguarde na sala de espera\\.`));
    // Sem agenda, o texto de sempre.
    assert.equal(examSchedule.notStartedResponse({ status: 'prepared' }, { now }).error, 'A prova ainda não foi iniciada pelo professor.');
    // Pela rota, com a sala de espera da agenda.
    const withRoom = await preparedWithAgenda(now - MINUTE, now + 60 * MINUTE, { waitingRoomMinutes: 5 });
    examSchedule.sweepSchedules(db.memory, { now });
    assert.equal(withRoom.status, 'waiting');
    const room = await asStudent(request(app).post(`/api/student/exam-applications/${withRoom.id}/start-attempt`), ALICE).send({}).expect(409);
    assert.equal(room.body.waitingRoom, true, JSON.stringify(room.body));
    assert.doesNotMatch(room.body.error, /professor/);
});

test('[UC-PROVA-008] A18: start-attempt na prova encerrada pela agenda fala do horário, não do professor', async () => {
    const now = Date.now();
    const application = await preparedWithAgenda(now - 30 * MINUTE, now + 30 * MINUTE);
    examSchedule.sweepSchedules(db.memory, { now: now - 29 * MINUTE });
    assert.equal(application.status, 'running');
    // Fechou no horário (a volta de 10 s logo depois do fechaEm).
    examSchedule.sweepSchedules(db.memory, { now: now + 30 * MINUTE + 5000 });
    assert.equal(application.status, 'finished');
    const refused = await asStudent(request(app).post(`/api/student/exam-applications/${application.id}/start-attempt`), ALICE).send({}).expect(409);
    assert.equal(refused.body.applicationClosed, true);
    assert.equal(refused.body.closedBySchedule, true);
    assert.equal(refused.body.error, `Esta prova já foi encerrada no horário marcado (${examSchedule.formatWhen(now + 30 * MINUTE)}).`);
    assert.doesNotMatch(refused.body.error, /professor/);
    // Fechou atrasada (servidor desligado no horário): diz as duas horas.
    const late = examSchedule.closedResponse({ status: 'finished', agenda: { abreEm: now - 90 * MINUTE, fechaEm: now - 60 * MINUTE, encerradaEm: now } });
    assert.equal(late.closedBySchedule, true);
    assert.equal(late.error, `Esta prova já foi encerrada pela agenda: o horário de fechar (${examSchedule.formatWhen(now - 60 * MINUTE)}) passou e ela fechou em ${examSchedule.formatWhen(now)}.`);
    // Encerrada pelo professor (com ou sem agenda) e cancelada: o texto de sempre.
    for (const closed of [
        { status: 'finished' },
        { status: 'finished', agenda: { abreEm: now - 90 * MINUTE, fechaEm: now + 60 * MINUTE, abertaEm: now - 90 * MINUTE } },
        { status: 'cancelled', agenda: { abreEm: now - 90 * MINUTE, fechaEm: now - 60 * MINUTE, encerradaEm: now } },
    ]) {
        const body = examSchedule.closedResponse(closed);
        assert.equal(body.error, 'Esta aplicação já foi encerrada pelo professor.');
        assert.equal(body.closedBySchedule, undefined);
    }
});

test('[UC-PROVA-008] A18: horário de fechar adiado (tempo extra ou tempo devolvido): aluno, log e registro falam da mesma hora', async () => {
    // Antes (ajuste 2): a varredura fechava no horário efetivo e o log dizia "no horário
    // marcado", mas o aluno lia que o horário de fechar "passou e ela fechou" 6 min depois.
    const now = Date.now();
    const application = await preparedWithAgenda(now - 30 * MINUTE, now + 30 * MINUTE);
    examSchedule.sweepSchedules(db.memory, { now: now - 29 * MINUTE });
    assert.equal(application.status, 'running');
    // 6 min a mais para a turma (o mesmo efeito do tempo devolvido de uma queda).
    application.globalTimeAdjustment = 6;
    const notYet = examSchedule.sweepSchedules(db.memory, { now: now + 31 * MINUTE });
    assert.equal(notYet.finished.length, 0);
    assert.equal(application.status, 'running');
    const closeAt = now + 36 * MINUTE + 5000;
    const closed = examSchedule.sweepSchedules(db.memory, { now: closeAt });
    assert.equal(closed.finished.length, 1);
    assert.equal(application.status, 'finished');
    assert.equal(application.agenda.fechaEfetivaEm, now + 36 * MINUTE);
    assert.equal(closed.finished[0].adiadoSegundos, 6 * 60);
    assert.ok(closed.finished[0].atrasoSegundos <= 60);
    // Log: fechou no horário adiado, com as duas horas; não diz "no horário marcado" nem "desligado".
    const lines = examSchedule.sweepLogLines(closed);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /encerrada\(s\) no horário de fechar adiado pelo tempo extra ou pelo tempo em que a prova ficou parada/);
    assert.ok(lines[0].includes(`marcado para ${examSchedule.formatWhen(now + 30 * MINUTE)}, fechou às ${schoolTime.localParts(closeAt).time}`), lines[0]);
    assert.doesNotMatch(lines[0], /no horário marcado|desligado/);
    // Aluno: a mesma referência (não "o horário de fechar passou").
    const refused = await asStudent(request(app).post(`/api/student/exam-applications/${application.id}/start-attempt`), ALICE).send({}).expect(409);
    assert.equal(refused.body.closedBySchedule, true);
    assert.equal(refused.body.error, `Esta prova já foi encerrada pela agenda em ${examSchedule.formatWhen(closeAt)}. O horário marcado para fechar era ${examSchedule.formatWhen(now + 30 * MINUTE)}; ela ficou aberta 6 min a mais pelo tempo extra ou pelo tempo em que a prova ficou parada.`);
    assert.doesNotMatch(refused.body.error, /passou|professor/);
    // Registro da aplicação: a hora em que fechou e a marcada.
    const trail = await admin(request(app).get(`/api/admin/exam-applications/${application.id}/audit`)).expect(200);
    const row = (trail.body.entries || []).find(item => item.title === 'Prova encerrada pelo agendamento');
    assert.ok(row, JSON.stringify(trail.body).slice(0, 2000));
    assert.match(row.detail, /^em .*, 6 min depois de .* pelo tempo extra ou pelo tempo em que a prova ficou parada · /);
    // Adiada e ainda atrasada (servidor desligado no horário adiado): a referência é o adiado.
    const late = examSchedule.closedResponse({ status: 'finished', agenda: { abreEm: now - 90 * MINUTE, fechaEm: now - 60 * MINUTE, fechaEfetivaEm: now - 50 * MINUTE, encerradaEm: now } });
    assert.equal(late.error, `Esta prova já foi encerrada pela agenda: o horário de fechar (${examSchedule.formatWhen(now - 50 * MINUTE)}) passou e ela fechou em ${examSchedule.formatWhen(now)}.`);
});

test('[UC-PROVA-008] A18: liberação e encerramento atrasados no boot ficam com a hora real no log e no registro', async () => {
    const now = Date.now();
    const at = Math.ceil((now + 10 * MINUTE) / MINUTE) * MINUTE;
    await admin(request(app).post('/api/admin/release-item')).send({ studentClass, courseId, itemKey: apostilaKey, releaseAtLocal: local(at) }).expect(200);
    // Servidor desligado na hora: a primeira volta (a do boot) é 25 min depois.
    const bootAt = at + 25 * MINUTE;
    const result = examSchedule.sweepSchedules(db.memory, { now: bootAt });
    assert.equal(result.released.length, 1);
    assert.equal(result.released[0].atrasoSegundos, 25 * 60);
    assert.equal(result.released[0].liberadoEm, bootAt);
    const auto = audits('content_release_auto');
    assert.equal(auto[0].details.atrasoSegundos, 25 * 60);
    assert.equal(auto[0].details.liberadoEm, bootAt);
    assert.equal(classOf(studentClass).releaseMeta[apostilaKey].at, new Date(bootAt).toISOString());
    const lines = examSchedule.sweepLogLines(result);
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /no horário marcado/);
    assert.match(lines[0], /depois do horário marcado, porque o servidor estava desligado/);
    assert.ok(lines[0].includes(`marcado para ${examSchedule.formatWhen(at)}, saiu às ${schoolTime.localParts(bootAt).time}`), lines[0]);
    // No horário (dentro de 1 min), a linha de sempre.
    const onTime = examSchedule.sweepLogLines({ released: [{ itemKey: 'x', at, liberadoEm: at + 10000, atrasoSegundos: 10 }] });
    assert.deepEqual(onTime, ['🗓️  Agendamento: 1 material(is) liberado(s) no horário marcado.']);

    // Encerramento: o servidor ligou 15 min depois do horário de fechar.
    const application = await preparedWithAgenda(now - 30 * MINUTE, now + 30 * MINUTE);
    examSchedule.sweepSchedules(db.memory, { now: now - 29 * MINUTE });
    assert.equal(application.status, 'running');
    const closeBoot = now + 45 * MINUTE;
    const closed = examSchedule.sweepSchedules(db.memory, { now: closeBoot });
    assert.equal(closed.finished.length, 1);
    assert.equal(closed.finished[0].atrasoSegundos, 15 * 60);
    const closeLines = examSchedule.sweepLogLines(closed);
    assert.equal(closeLines.length, 1);
    assert.match(closeLines[0], /encerrada\(s\) agora, depois do horário de fechar/);
    assert.doesNotMatch(closeLines[0], /no horário marcado/);
    const finishedAudit = (db.memory.auditLogs || []).find(entry => entry.type === 'exam_application_auto_finished' && entry.applicationId === application.id)
        || (db.memory.auditLogs || []).find(entry => entry.type === 'exam_application_auto_finished');
    assert.ok(finishedAudit, 'auditoria do encerramento');
    assert.equal(finishedAudit.details.atrasoSegundos, 15 * 60);
    // O registro da aplicação diz quanto atrasou.
    const trail = await admin(request(app).get(`/api/admin/exam-applications/${application.id}/audit`)).expect(200);
    const row = (trail.body.entries || trail.body.events || trail.body.items || []).find(item => /encerrada pelo agendamento/i.test(item.title || ''));
    assert.ok(row, JSON.stringify(trail.body).slice(0, 2000));
    assert.match(row.detail, /15 min depois de .* \(o computador estava desligado\)/);
});

test('[UC-PROVA-008] A18: calendário do aluno com o gabarito agendado da prova editada só para a turma', async () => {
    const now = Date.now();
    const at = Math.ceil((now + 24 * 60 * MINUTE) / MINUTE) * MINUTE;
    // Variante "só desta turma" da prova (forkEvaluation): Avaliacao_X__turma_<hash>.
    const variantKey = `${examKey}__turma_0123456789`;
    db.memory.evaluations[variantKey] = { ...db.memory.evaluations[examKey], key: variantKey, sourceEvaluationKey: examKey };
    const cls = classOf(studentClass);
    cls.contentOverrides = { materials: {}, evaluations: { [examKey]: { key: variantKey, createdAt: now } }, unitNames: {}, extraUnits: [], structure: null };
    cls.releaseSchedule = { [`Gabarito_${variantKey}`]: { at, released: true, por: 'admin@agenda.local', criadoEm: now } };
    const calendar = await asStudent(request(app).get('/api/student/calendar-events'), ALICE).query({ studentClass, courseId }).expect(200);
    const release = calendar.body.find(event => String(event.id).startsWith('liberacao:'));
    assert.ok(release, JSON.stringify(calendar.body));
    assert.equal(release.title, 'Gabarito · Unidade 3');
    // Nome da unidade trocado na turma vale.
    cls.contentOverrides.unitNames = { [examKey]: 'Unidade 3 (turma)' };
    assert.equal(examSchedule.releaseItemTitle(db.memory, cls, `Gabarito_${variantKey}`), 'Gabarito · Unidade 3 (turma)');
    // Sem unidade, o título diz o que vai sair e nunca "liberado".
    db.memory.courses[0].structure = [];
    cls.contentOverrides.unitNames = {};
    const orphan = examSchedule.releaseItemTitle(db.memory, cls, `Gabarito_${variantKey}`);
    assert.equal(orphan, 'Gabarito da prova Prova agendada');
    assert.doesNotMatch(orphan, /liberad/);
    assert.doesNotMatch(examSchedule.releaseItemTitle(db.memory, cls, 'Apostila_Sem_Unidade'), /liberad/);
    // Unidade extra da turma.
    cls.contentOverrides.extraUnits = [{ moduleId: '0', unit: { name: 'Unidade extra', apostilaKey: 'Apostila_Extra' } }];
    assert.equal(examSchedule.releaseItemTitle(db.memory, cls, 'Apostila_Extra'), 'Apostila · Unidade extra');
});
