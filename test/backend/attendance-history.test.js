// Presença com versões (H7b; CONF-09, FUN-04).
// A chamada do dia continua sendo regravada inteira a cada salvamento (o registro sai e
// volta com id novo). O que se perdia agora fica:
// 1) na auditoria: attendance_changed com antes e depois quando a situação muda depois da
//    conclusão, sobre a presença automática do login ou a marcação individual, por outra
//    pessoa ou mais de 15 min depois da versão de referência; o rascunho do mesmo
//    professor (autosave) e a primeira chamada do dia não geram entrada. Vale também
//    depois do 1º autosave: a tela manda a turma inteira a cada 2 s, e regravar o aluno
//    sem mudar nada não apaga de onde, de quem e de quando é a situação (baseVersion).
//    A marcação individual sempre grava attendance_marked. Nada do texto da
//    justificativa, da observação nem do IP do aluno vai para a auditoria;
// 2) no próprio registro: concludedAt (hora da primeira conclusão), loginAccess (o
//    acesso do login que a chamada substituiu) e baseVersion passam de versão em versão;
// 3) na chamada: aluno com cadastro encerrado não aparece nas datas novas, só numa data
//    em que já tem registro ou anterior ao desligamento (statusChangedAt).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-attendance-history-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// Módulos antes do servidor: server.js registra o process.on('uncaughtException'), que
// engoliria a falha destes require e o arquivo passaria sem rodar nenhum teste.
const attendanceUtil = require('../../backend/utils/attendance.js');
const { isClosedStudentStatus } = require('../../backend/utils/students.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const COURSE = 'curso-presenca';
const CLASS = '1DES';
const DATE = '2026-03-02';
const OTHER_DATE = '2026-03-09';
const tokens = { admin: 'admin-token-presenca', prof: 'prof-token-presenca', prof2: 'prof2-token-presenca' };
const emails = { admin: 'admin@presenca.local', prof: 'prof@presenca.local', prof2: 'prof2@presenca.local' };
let app;

// Relógio do servidor: adiantar simula o tempo passando entre um autosave e outro.
const realDateNow = Date.now;
let clockOffset = 0;
const advance = ms => { clockOffset += ms; };

const as = who => req => req.set('x-admin-session', tokens[who]);
const auditOf = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);
const dayRecords = (email, date = DATE) => (db.memory.attendance || []).filter(a => a.studentEmail === email && a.date === date);
const aulas = (...statuses) => statuses.map((status, i) => ({ ordem: i + 1, disciplinaId: '', inicio: i ? '08:50' : '08:00', status, hora: '' }));

function seed() {
    db.memory.admins = [
        { email: emails.admin, name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        { email: emails.prof, name: 'Professora', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId: COURSE, className: CLASS }] },
        { email: emails.prof2, name: 'Professor 2', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId: COURSE, className: CLASS }] },
    ];
    db.memory.adminSessions = Object.fromEntries(Object.keys(tokens).map(who => [tokens[who], { email: emails[who], createdAt: Date.now(), lastSeen: Date.now() }]));
    db.memory.courses = [{ id: COURSE, name: 'Desenvolvimento', schoolId: '', structure: [] }];
    // Duas aulas em todos os dias da semana: as datas do teste não dependem do calendário.
    const grade = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map(wd => [wd, [
        { ordem: 1, inicio: '08:00', disciplinaId: '' },
        { ordem: 2, inicio: '08:50', disciplinaId: '' },
    ]]));
    db.memory.classes = [{ name: CLASS, courseId: COURSE, period: 'Manhã', attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade } }];
    const student = (name, status = 'Ativo', extra = {}) => ({
        name, email: `${name.toLowerCase()}@presenca.local`, status, password: db.hashPassword('123'),
        classes: [{ name: CLASS, courseId: COURSE }], ...extra,
    });
    db.memory.students = [
        student('Ana'),
        student('Bruno'),
        student('Carla', 'Inativo'),
        student('Davi', 'Transferido', { statusChangedAt: Date.parse('2026-03-05T15:00:00Z') }),
        student('Elisa', 'Bloqueado'),
    ];
    db.memory.attendance = [];
    db.memory.auditLogs = [];
    db.memory.sessions = {};
    if (db.memory.config) delete db.memory.config.settings;
}

async function chamada(who, entries, { concluida = false, date = DATE } = {}) {
    const res = await as(who)(request(app).post('/api/admin/attendance/bulk')).send({ studentClass: CLASS, courseId: COURSE, date, concluida, entries });
    assert.equal(res.status, 200, res.body && res.body.error);
    return res.body;
}
const entry = (name, ...statuses) => ({ email: `${name}@presenca.local`, aulas: aulas(...statuses) });

async function roster(who = 'prof', date = DATE) {
    const res = await as(who)(request(app).get(`/api/admin/attendance/roster?studentClass=${CLASS}&courseId=${COURSE}&date=${date}`));
    assert.equal(res.status, 200, res.body && res.body.error);
    return res.body.roster;
}

test.before(async () => {
    await db.init();
    app = createApp();
    Date.now = () => realDateNow() + clockOffset;
});
test.beforeEach(() => { clockOffset = 0; seed(); });
test.after(async () => {
    Date.now = realDateNow;
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-PRESENCA-004] primeira chamada do dia e rascunho do mesmo professor não viram entrada', async () => {
    await chamada('prof', [entry('ana', 'presente', 'presente')]);
    await chamada('prof', [entry('ana', 'falta', 'falta')]);
    await chamada('prof', [entry('ana', 'presente', 'falta')]);
    assert.equal(auditOf('attendance_changed').length, 0);
    const [rec] = dayRecords('ana@presenca.local');
    assert.deepEqual(rec.aulas.map(a => a.status), ['presente', 'falta']);
    assert.equal(rec.concludedAt, undefined, 'rascunho não tem hora de conclusão');
    assert.equal(dayRecords('ana@presenca.local').length, 1, 'continua um registro por dia');
});

test('[UC-PRESENCA-004] concluir grava concludedAt, que fica nas versões seguintes; mudar depois de concluir vira attendance_changed', async () => {
    await chamada('prof', [entry('ana', 'presente', 'presente')]);
    const before = Date.now();
    await chamada('prof', [entry('ana', 'presente', 'presente')], { concluida: true });
    const concluded = dayRecords('ana@presenca.local')[0];
    assert.ok(concluded.concludedAt >= before, 'antes: a chamada não guardava quando foi concluída');
    assert.equal(auditOf('attendance_changed').length, 0, 'concluir sem mudar a situação não grava');

    // O autosave da tela grava como rascunho (concluida: false) mesmo depois de concluir.
    await chamada('prof', [entry('ana', 'falta', 'presente')]);
    const changed = auditOf('attendance_changed');
    assert.equal(changed.length, 1, 'antes: a mudança depois de concluir não deixava rastro');
    const [audit] = changed;
    assert.equal(audit.category, 'attendance');
    assert.equal(audit.actor, emails.prof);
    assert.equal(audit.actorRole, 'professor');
    assert.equal(audit.studentEmail, 'ana@presenca.local');
    assert.equal(audit.courseId, COURSE);
    assert.equal(audit.studentClass, CLASS);
    assert.equal(audit.field, 'Presença em 02/03/2026');
    assert.equal(audit.oldValue, 'Presente (2 aulas)');
    assert.equal(audit.newValue, '1 presença e 1 falta (2 aulas)');
    assert.equal(audit.details.date, DATE);
    assert.equal(audit.details.before.length, 1);
    assert.equal(audit.details.before[0].id, concluded.id, 'a fotografia é do registro que saiu');
    assert.equal(audit.details.before[0].concluida, true);
    assert.deepEqual(audit.details.before[0].aulas, [{ ordem: 1, status: 'presente' }, { ordem: 2, status: 'presente' }]);
    const current = dayRecords('ana@presenca.local')[0];
    assert.notEqual(current.id, concluded.id, 'o registro continua sendo regravado com id novo');
    assert.equal(audit.details.after.id, current.id);
    assert.deepEqual(audit.details.after.aulas, [{ ordem: 1, status: 'falta' }, { ordem: 2, status: 'presente' }]);
    assert.equal(current.concluida, false);
    assert.equal(current.concludedAt, concluded.concludedAt, 'a primeira conclusão passa para a versão seguinte');

    // Concluir de novo não muda a hora da primeira conclusão; mexer de novo também audita.
    await chamada('prof', [entry('ana', 'falta', 'presente')], { concluida: true });
    assert.equal(dayRecords('ana@presenca.local')[0].concludedAt, concluded.concludedAt);
    await chamada('prof', [entry('ana', 'falta', 'falta')]);
    assert.equal(auditOf('attendance_changed').length, 2);
});

test('[UC-PRESENCA-004] outro professor mudando o rascunho grava attendance_changed; o mesmo professor depois de 15 min também', async () => {
    await chamada('prof', [entry('ana', 'presente', 'presente'), entry('bruno', 'presente', 'presente')]);
    await chamada('prof2', [entry('ana', 'falta', 'falta'), entry('bruno', 'presente', 'presente')]);
    let changed = auditOf('attendance_changed');
    assert.equal(changed.length, 1, 'só quem mudou de situação (Bruno ficou igual)');
    assert.equal(changed[0].studentEmail, 'ana@presenca.local');
    assert.equal(changed[0].actor, emails.prof2);
    assert.equal(changed[0].details.before[0].markedBy, emails.prof);

    // prof2 continua mexendo logo em seguida: é o rascunho dele.
    await chamada('prof2', [entry('ana', 'presente', 'falta'), entry('bruno', 'presente', 'presente')]);
    assert.equal(auditOf('attendance_changed').length, 1);

    // Mais de 15 min depois da versão de referência (a mudança que virou entrada): volta
    // a auditar. O rascunho do meio não renova a janela.
    advance(attendanceUtil.ATTENDANCE_EDIT_SESSION_MS + 60 * 1000);
    await chamada('prof2', [entry('ana', 'presente', 'presente'), entry('bruno', 'presente', 'presente')]);
    changed = auditOf('attendance_changed');
    assert.equal(changed.length, 2);
    assert.equal(changed[1].oldValue, '1 presença e 1 falta (2 aulas)');
    assert.equal(changed[1].newValue, 'Presente (2 aulas)');
});

test('[UC-PRESENCA-004] presença automática do login substituída: mudança vira entrada e o acesso fica guardado no registro', async () => {
    const loginRecord = (name, statuses) => ({
        id: `att_login_${name}`, studentEmail: `${name}@presenca.local`, studentClass: CLASS, courseId: COURSE, date: DATE,
        origin: 'login', source: 'heartbeat', horaAcesso: '07:58', ip: '10.0.0.7', userAgent: 'Navegador do aluno',
        aulas: aulas(...statuses), justificativa: null, markedBy: null, timestamp: Date.now() - 60 * 1000,
    });
    db.memory.attendance.push(loginRecord('ana', ['presente', 'presente']), loginRecord('bruno', ['presente', 'presente']));

    const before = await roster();
    assert.deepEqual(before.find(r => r.email === 'ana@presenca.local').acessoAutomatico, { hora: '07:58', ip: '10.0.0.7', via: 'sessão aberta' });

    await chamada('prof', [entry('ana', 'falta', 'falta'), entry('bruno', 'presente', 'presente')]);
    const changed = auditOf('attendance_changed');
    assert.equal(changed.length, 1, 'antes: a falta por cima da presença automática apagava o registro do acesso sem rastro');
    assert.equal(changed[0].studentEmail, 'ana@presenca.local');
    assert.equal(changed[0].details.before[0].origin, 'login');
    assert.equal(changed[0].oldValue, 'Presente (2 aulas)');
    assert.equal(changed[0].newValue, 'Falta (2 aulas)');
    const text = JSON.stringify(changed[0]);
    assert.ok(!text.includes('10.0.0.7'), 'o IP do aluno não vai para a auditoria');
    assert.ok(!text.includes('Navegador do aluno'));

    const ana = dayRecords('ana@presenca.local');
    assert.equal(ana.length, 1);
    assert.equal(ana[0].origin, 'chamada');
    assert.deepEqual(ana[0].loginAccess, { horaAcesso: '07:58', ip: '10.0.0.7', source: 'heartbeat' });
    const bruno = dayRecords('bruno@presenca.local');
    assert.deepEqual(bruno[0].loginAccess, { horaAcesso: '07:58', ip: '10.0.0.7', source: 'heartbeat' }, 'presente → presente não grava entrada e guarda o acesso');

    // A versão seguinte mantém o acesso, e a chamada continua mostrando a hora.
    await chamada('prof', [entry('ana', 'falta', 'presente'), entry('bruno', 'presente', 'presente')]);
    assert.deepEqual(dayRecords('ana@presenca.local')[0].loginAccess, { horaAcesso: '07:58', ip: '10.0.0.7', source: 'heartbeat' });
    const after = await roster();
    const anaRow = after.find(r => r.email === 'ana@presenca.local');
    assert.equal(anaRow.origin, 'chamada');
    assert.deepEqual(anaRow.acessoAutomatico, { hora: '07:58', ip: '10.0.0.7', via: 'sessão aberta' });
});

// A tela da Chamada (ChamadaPage.buildEntries) manda a turma inteira a cada autosave:
// quem não mudou volta com o markedBy e a hora de quem salvou. As regras de quando
// auditar não podem valer só para o 1º autosave de quem abre a tela.
const TURMA = ['ana', 'bruno', 'elisa'];
const turma = (changes = {}) => TURMA.map(name => entry(name, ...(changes[name] || ['presente', 'presente'])));
const loginRecord = (name, statuses = ['presente', 'presente'], extra = {}) => ({
    id: `att_login_${name}`, studentEmail: `${name}@presenca.local`, studentClass: CLASS, courseId: COURSE, date: DATE,
    origin: 'login', source: 'login', horaAcesso: '07:58', ip: '10.0.0.9', userAgent: 'Navegador do aluno',
    aulas: aulas(...statuses), justificativa: null, markedBy: null, timestamp: Date.now() - 60 * 1000, ...extra,
});

test('[UC-PRESENCA-004] turma inteira no autosave: falta sobre a presença do login no 2º autosave vira entrada', async () => {
    const anaLogin = loginRecord('ana');
    db.memory.attendance.push(anaLogin, loginRecord('bruno'));
    // 1º autosave: a professora mexe só na Elisa (sem registro: não grava entrada).
    await chamada('prof', turma({ elisa: ['falta', 'falta'] }));
    assert.equal(auditOf('attendance_changed').length, 0);
    const anaAfterFirst = dayRecords('ana@presenca.local')[0];
    assert.equal(anaAfterFirst.origin, 'chamada');
    assert.deepEqual(anaAfterFirst.baseVersion, { origin: 'login', markedBy: null, timestamp: anaLogin.timestamp },
        'a situação regravada sem mudar continua sendo a da presença automática');

    // 2º autosave, 2 s depois: agora a Ana leva falta.
    advance(2000);
    await chamada('prof', turma({ elisa: ['falta', 'falta'], ana: ['falta', 'falta'] }));
    const changed = auditOf('attendance_changed');
    assert.equal(changed.length, 1, 'antes: a falta sobre a presença automática no 2º autosave não deixava rastro');
    assert.equal(changed[0].studentEmail, 'ana@presenca.local');
    assert.equal(changed[0].oldValue, 'Presente (2 aulas)');
    assert.equal(changed[0].newValue, 'Falta (2 aulas)');
    assert.equal(changed[0].details.before[0].baseVersion.origin, 'login', 'a fotografia diz de onde vinha a situação');
    assert.ok(!JSON.stringify(changed[0]).includes('10.0.0.9'), 'o IP do aluno não vai para a auditoria');
    const ana = dayRecords('ana@presenca.local')[0];
    assert.equal(ana.baseVersion, undefined, 'a mudança registrada vira a nova referência');
    assert.deepEqual(ana.loginAccess, { horaAcesso: '07:58', ip: '10.0.0.9', source: 'login' });

    // Rascunho dela logo em seguida: não grava. O Bruno, regravado três vezes sem mudar,
    // continua com a referência do login e com o acesso guardado.
    advance(2000);
    await chamada('prof', turma({ elisa: ['falta', 'falta'], ana: ['falta', 'presente'] }));
    assert.equal(auditOf('attendance_changed').length, 1);
    const bruno = dayRecords('bruno@presenca.local')[0];
    assert.equal(bruno.baseVersion.origin, 'login');
    assert.deepEqual(bruno.loginAccess, { horaAcesso: '07:58', ip: '10.0.0.9', source: 'login' });
    advance(2000);
    await chamada('prof', turma({ elisa: ['falta', 'falta'], ana: ['falta', 'presente'], bruno: ['falta', 'presente'] }));
    assert.equal(auditOf('attendance_changed').length, 2, 'o Bruno também, no 4º autosave');
    assert.equal(auditOf('attendance_changed')[1].studentEmail, 'bruno@presenca.local');
});

test('[UC-PRESENCA-004] turma inteira no autosave: outra pessoa mudando o aluno no 2º autosave dela vira entrada', async () => {
    await chamada('prof', turma());
    advance(60 * 1000);
    await chamada('prof2', turma({ bruno: ['falta', 'falta'] }));
    assert.deepEqual(auditOf('attendance_changed').map(e => e.studentEmail), ['bruno@presenca.local']);
    advance(2000);
    await chamada('prof2', turma({ bruno: ['falta', 'falta'], ana: ['falta', 'falta'] }));
    const changed = auditOf('attendance_changed');
    assert.deepEqual(changed.map(e => e.studentEmail), ['bruno@presenca.local', 'ana@presenca.local'],
        'antes: a Ana, marcada pela professora, mudou no 2º autosave do colega sem rastro');
    assert.equal(changed[1].actor, emails.prof2);
    assert.equal(changed[1].details.before[0].markedBy, emails.prof2, 'o registro que saiu foi regravado pelo colega');
    assert.equal(changed[1].details.before[0].baseVersion.markedBy, emails.prof, 'mas a situação era da professora');
    // A partir daí é o rascunho dele.
    advance(2000);
    await chamada('prof2', turma({ bruno: ['falta', 'falta'], ana: ['presente', 'falta'] }));
    assert.equal(auditOf('attendance_changed').length, 2);
    // A professora volta e mexe na Ana: a situação agora é do colega.
    advance(2000);
    await chamada('prof', turma({ bruno: ['falta', 'falta'], ana: ['presente', 'presente'] }));
    assert.equal(auditOf('attendance_changed').length, 3);
});

test('[UC-PRESENCA-004] turma inteira no autosave: versão de mais de 15 min mudada no 2º autosave vira entrada', async () => {
    await chamada('prof', turma());
    advance(40 * 60 * 1000);
    await chamada('prof', turma({ bruno: ['falta', 'falta'] }));
    assert.deepEqual(auditOf('attendance_changed').map(e => e.studentEmail), ['bruno@presenca.local']);
    advance(2000);
    await chamada('prof', turma({ bruno: ['falta', 'falta'], ana: ['falta', 'falta'] }));
    assert.deepEqual(auditOf('attendance_changed').map(e => e.studentEmail), ['bruno@presenca.local', 'ana@presenca.local'],
        'antes: a situação da Ana, de 40 min atrás, mudou no 2º autosave sem rastro');
    // Depois da entrada, a janela recomeça: o rascunho logo em seguida não grava.
    advance(2000);
    await chamada('prof', turma({ bruno: ['falta', 'falta'], ana: ['presente', 'falta'] }));
    assert.equal(auditOf('attendance_changed').length, 2);
});

test('[UC-PRESENCA-004] rascunho longo do mesmo professor: a janela de 15 min não anda com o autosave', async () => {
    await chamada('prof', turma());
    // Uma hora com a chamada aberta, mexendo na Ana a cada 10 min sem concluir.
    const times = [];
    for (let i = 1; i <= 6; i++) {
        advance(10 * 60 * 1000);
        await chamada('prof', turma({ ana: [i % 2 ? 'falta' : 'presente', 'presente'] }));
        times.push(auditOf('attendance_changed').length);
    }
    assert.deepEqual(times, [0, 1, 1, 2, 2, 3], 'antes: nenhuma entrada em uma hora de rascunho');
    // A mudança de 10 min depois da referência fica de fora (rascunho), a de 20 min entra,
    // e o Antes é a situação que estava valendo (a do rascunho).
    const [first] = auditOf('attendance_changed');
    assert.equal(first.oldValue, '1 presença e 1 falta (2 aulas)');
    assert.equal(first.newValue, 'Presente (2 aulas)');
});

test('[UC-PRESENCA-004] registro antigo sem curso que a chamada mostra é substituído, não fica ao lado do novo', async () => {
    // Registro de versão antiga, sem courseId, concluído no dia; e acesso do login de uma
    // turma que não tinha curso (courseId vazio).
    db.memory.attendance.push(
        { id: 'att_sem_curso', studentEmail: 'ana@presenca.local', studentClass: CLASS, date: DATE, origin: 'chamada', concluida: true,
            aulas: aulas('presente', 'presente'), markedBy: emails.prof, timestamp: Date.now() - 86400000 },
        loginRecord('bruno', ['presente', 'presente'], { courseId: '' }),
    );
    const before = await roster();
    assert.equal(before.find(r => r.email === 'ana@presenca.local').concluida, true, 'a chamada mostra o registro antigo');
    assert.deepEqual(before.find(r => r.email === 'bruno@presenca.local').acessoAutomatico, { hora: '07:58', ip: '10.0.0.9', via: 'login' });

    await chamada('prof2', [entry('ana', 'falta', 'falta'), entry('bruno', 'falta', 'presente')]);
    assert.equal(dayRecords('ana@presenca.local').length, 1, 'antes: o registro sem curso ficava ao lado do novo');
    assert.equal(dayRecords('bruno@presenca.local').length, 1);
    assert.deepEqual(auditOf('attendance_changed').map(e => e.studentEmail).sort(), ['ana@presenca.local', 'bruno@presenca.local'],
        'antes: nenhuma das duas mudanças era auditada');
    assert.equal(auditOf('attendance_changed').find(e => e.studentEmail === 'ana@presenca.local').details.before[0].id, 'att_sem_curso');
    assert.deepEqual(dayRecords('bruno@presenca.local')[0].loginAccess, { horaAcesso: '07:58', ip: '10.0.0.9', source: 'login' }, 'antes: o acesso do login se perdia');

    const after = await roster();
    const ana = after.find(r => r.email === 'ana@presenca.local');
    assert.deepEqual(ana.aulas.map(a => a.status), ['falta', 'falta'], 'antes: a chamada continuava mostrando o antigo');
    assert.equal(ana.frequencia, 0, 'antes: 50% (o antigo e o novo contavam juntos)');
    assert.equal(ana.faltasAcumuladas, 2);
    assert.deepEqual(after.find(r => r.email === 'bruno@presenca.local').acessoAutomatico, { hora: '07:58', ip: '10.0.0.9', via: 'login' });
});

test('[UC-PRESENCA-004] marcação individual: cadastro encerrado só numa data que a chamada ainda mostra; sobre a chamada, a entrada diz que ela continua valendo', async () => {
    const mark = (who, body) => as(who)(request(app).post('/api/admin/student/attendance/mark')).send({ studentClass: CLASS, courseId: COURSE, ...body });
    const closed = await mark('admin', { email: 'carla@presenca.local', date: OTHER_DATE });
    assert.equal(closed.status, 409, 'antes: criava o registro e o aluno inativo voltava para a chamada da data');
    assert.equal(closed.body.code, 'student_closed');
    assert.match(closed.body.error, /encerrado \(Inativo\)/);
    assert.equal(dayRecords('carla@presenca.local', OTHER_DATE).length, 0);
    assert.equal(auditOf('attendance_marked').length, 0);
    assert.ok(!(await roster('prof', OTHER_DATE)).some(r => r.email === 'carla@presenca.local'));
    // Antes do desligamento gravado (05/03), a data ainda aceita.
    assert.equal((await mark('admin', { email: 'davi@presenca.local', date: DATE })).status, 200);
    assert.equal((await mark('admin', { email: 'davi@presenca.local', date: OTHER_DATE })).status, 409);

    // Sobre a chamada concluída com falta: a marcação não muda o dia, e a entrada diz isso.
    await chamada('prof', [entry('ana', 'falta', 'falta')], { concluida: true });
    const over = await mark('admin', { email: 'ana@presenca.local', date: DATE });
    assert.equal(over.status, 200, over.body.error);
    const marked = auditOf('attendance_marked').find(e => e.studentEmail === 'ana@presenca.local');
    assert.equal(marked.oldValue, 'Falta (2 aulas)');
    assert.equal(marked.newValue, 'Presente (2 aulas), mas a chamada do dia continua valendo',
        'antes: "Falta → Presente", como se a presença tivesse mudado');
    assert.equal(marked.details.afterPrevails, false);
    assert.deepEqual((await roster()).find(r => r.email === 'ana@presenca.local').aulas.map(a => a.status), ['falta', 'falta']);
    // Sem chamada no dia, a marcação vale e o texto é só a presença.
    await mark('admin', { email: 'bruno@presenca.local', date: DATE });
    const plain = auditOf('attendance_marked').find(e => e.studentEmail === 'bruno@presenca.local');
    assert.equal(plain.newValue, 'Presente (2 aulas)');
    assert.equal(plain.details.afterPrevails, undefined);
});

test('[UC-PRESENCA-004] marcação individual sempre grava attendance_marked com antes e depois', async () => {
    const first = await as('prof')(request(app).post('/api/admin/student/attendance/mark')).send({ email: 'ana@presenca.local', date: DATE, studentClass: CLASS, courseId: COURSE });
    assert.equal(first.status, 200, first.body.error);
    let marked = auditOf('attendance_marked');
    assert.equal(marked.length, 1, 'antes: a marcação individual não deixava entrada na auditoria');
    assert.equal(marked[0].category, 'attendance');
    assert.equal(marked[0].actor, emails.prof);
    assert.equal(marked[0].studentEmail, 'ana@presenca.local');
    assert.equal(marked[0].field, 'Presença em 02/03/2026');
    assert.equal(marked[0].oldValue, 'Sem registro');
    assert.equal(marked[0].newValue, 'Presente (2 aulas)');
    assert.deepEqual(marked[0].details.before, []);
    assert.equal(marked[0].details.after.origin, 'manual');
    assert.equal(marked[0].details.after.id, dayRecords('ana@presenca.local')[0].id);

    // Sobre uma chamada com falta e justificativa: a fotografia não leva o texto.
    db.memory.attendance = [];
    await chamada('prof', [{
        email: 'bruno@presenca.local', aulas: aulas('justificada', 'justificada'),
        justificativa: { tipo: 'atestado', abonado: true, texto: 'Consulta no posto de saúde', arquivo: '/uploads/atestado-bruno.pdf', arquivoNome: 'atestado.pdf' },
        observacao: 'Chegou a avisar por mensagem',
    }], { concluida: true });
    const again = await as('admin')(request(app).post('/api/admin/student/attendance/mark')).send({ email: 'bruno@presenca.local', date: DATE, studentClass: CLASS, courseId: COURSE });
    assert.equal(again.status, 200, again.body.error);
    marked = auditOf('attendance_marked');
    assert.equal(marked.length, 2);
    const last = marked[1];
    assert.equal(last.actor, emails.admin);
    assert.equal(last.oldValue, 'Falta justificada (2 aulas, atestado, abonada)');
    assert.equal(last.details.before.length, 1);
    assert.deepEqual(last.details.before[0].justificativa, { tipo: 'atestado', abonado: true, temTexto: true, temArquivo: true });
    assert.equal(last.details.before[0].temObservacao, true);
    const text = JSON.stringify(db.memory.auditLogs);
    for (const secret of ['Consulta no posto', 'atestado-bruno.pdf', 'avisar por mensagem']) {
        assert.ok(!text.includes(secret), `a auditoria não guarda "${secret}"`);
    }
    assert.equal(dayRecords('bruno@presenca.local').length, 2, 'marcar não apaga a chamada do dia');
});

test('[UC-PRESENCA-004] registro antigo (sem aulas, concluída sem concludedAt) conta como concluído', async () => {
    const legacyTime = Date.parse('2026-03-02T11:00:00Z');
    db.memory.attendance.push({
        id: 'att_legado', studentEmail: 'ana@presenca.local', studentClass: CLASS, courseId: COURSE, date: DATE,
        origin: 'chamada', status: 'ausente', concluida: true, markedBy: emails.prof, timestamp: legacyTime,
    });
    await chamada('prof', [entry('ana', 'presente', 'presente')]);
    const changed = auditOf('attendance_changed');
    assert.equal(changed.length, 1);
    assert.equal(changed[0].oldValue, 'Falta');
    assert.deepEqual(changed[0].details.before[0].aulas, [{ ordem: 1, status: 'falta' }]);
    assert.equal(dayRecords('ana@presenca.local')[0].concludedAt, legacyTime, 'a conclusão antiga conta pela hora em que foi gravada');
});

test('[UC-PRESENCA-004] chamada de data nova sem aluno encerrado; com registro na data, ele aparece com a situação', async () => {
    const first = await roster('prof', OTHER_DATE);
    const listed = first.map(r => r.email).sort();
    assert.deepEqual(listed, ['ana@presenca.local', 'bruno@presenca.local', 'elisa@presenca.local'],
        'antes: Inativo e Transferido apareciam na chamada de qualquer data (Bloqueado continua)');
    assert.equal(first.find(r => r.email === 'elisa@presenca.local').encerrado, false);

    // Registro já existente na data: o encerrado aparece, marcado como tal.
    db.memory.attendance.push({
        id: 'att_carla', studentEmail: 'carla@presenca.local', studentClass: CLASS, courseId: COURSE, date: OTHER_DATE,
        origin: 'chamada', concluida: true, aulas: aulas('presente', 'presente'), justificativa: null, markedBy: emails.prof, timestamp: Date.now(),
    });
    const second = await roster('prof', OTHER_DATE);
    const carla = second.find(r => r.email === 'carla@presenca.local');
    assert.ok(carla, 'com registro na data, o aluno encerrado aparece');
    assert.equal(carla.encerrado, true);
    assert.equal(carla.situacao, 'Inativo');
    assert.equal(carla.salvo, true);

    // Desligado com hora gravada (05/03): aparece na chamada atrasada de 02/03, não na de 09/03.
    assert.ok((await roster('prof', DATE)).some(r => r.email === 'davi@presenca.local'));
    assert.ok(!(await roster('prof', OTHER_DATE)).some(r => r.email === 'davi@presenca.local'));
    assert.ok(!(await roster('prof', '2026-03-05')).some(r => r.email === 'davi@presenca.local'), 'no dia do desligamento, só com registro');
});

test('[UC-PRESENCA-004] salvar a chamada não cria registro para aluno encerrado que a data não mostra', async () => {
    const body = await chamada('prof', [entry('ana', 'presente', 'presente'), entry('carla', 'presente', 'presente'), entry('davi', 'falta', 'falta')], { date: OTHER_DATE });
    assert.equal(body.saved, 1);
    assert.equal(body.skipped, 2);
    assert.equal(dayRecords('carla@presenca.local', OTHER_DATE).length, 0);
    assert.equal(dayRecords('davi@presenca.local', OTHER_DATE).length, 0);

    // Na data com registro (ou anterior ao desligamento), a chamada do encerrado continua.
    db.memory.attendance.push({
        id: 'att_carla_old', studentEmail: 'carla@presenca.local', studentClass: CLASS, courseId: COURSE, date: OTHER_DATE,
        origin: 'chamada', concluida: true, aulas: aulas('presente', 'presente'), justificativa: null, markedBy: emails.prof, timestamp: Date.now(),
    });
    const later = await chamada('prof2', [entry('carla', 'falta', 'falta'), entry('davi', 'falta', 'falta')], { date: OTHER_DATE });
    assert.equal(later.saved, 1);
    assert.equal(dayRecords('carla@presenca.local', OTHER_DATE).length, 1);
    assert.equal(dayRecords('carla@presenca.local', OTHER_DATE)[0].aulas[0].status, 'falta');
    assert.equal(auditOf('attendance_changed').length, 1, 'a mudança no registro concluído do encerrado é auditada');
    const retro = await chamada('prof', [entry('davi', 'presente', 'falta')], { date: DATE });
    assert.equal(retro.saved, 1, 'data anterior ao desligamento aceita a chamada atrasada');
});

test('[UC-PRESENCA-004] entradas de presença aparecem na tela Auditoria (categoria Presença) e na ficha do aluno', async () => {
    await chamada('prof', [entry('ana', 'presente', 'presente')], { concluida: true });
    await chamada('prof2', [entry('ana', 'falta', 'presente')]);
    const res = await as('admin')(request(app).get('/api/admin/audit?category=attendance'));
    assert.equal(res.status, 200, res.body.error);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].label, 'Presença alterada');
    assert.equal(res.body.items[0].category, 'attendance');
    const ficha = await as('admin')(request(app).get('/api/admin/student/audit?email=ana@presenca.local'));
    assert.equal(ficha.status, 200);
    assert.ok(ficha.body.some(item => item.action === 'attendance_changed' && item.field === 'Presença em 02/03/2026'));
});

test('[UC-PRESENCA-004] situações que encerram o cadastro, sem acento e sem maiúscula', () => {
    for (const status of ['Inativo', 'concluido', 'CONCLUÍDO', 'Transferido', 'evadido', 'Anonimizado']) assert.equal(isClosedStudentStatus(status), true, status);
    for (const status of ['Ativo', 'Bloqueado', '', undefined, null]) assert.equal(isClosedStudentStatus(status), false, String(status));
});
