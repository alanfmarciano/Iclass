// Encerrar e reabrir a turma (fase 3, B10 / P2-S9; FUN-05): GET /api/admin/class/close-summary,
// POST /api/admin/class/close e /reopen (permissão classes.manage, escopo, ENCERRAR digitado,
// recusa com prova aberta, agendada ou aguardando correção, cópia dos critérios, auditoria e
// gravação parcial), a conta congelada da turma encerrada (os critérios do curso mudam e a
// média dela não), a turma encerrada fora da presença do login, da cobrança de chamada e da
// agenda de prova, e a recusa de matrícula nova. Cada teste falha no código de antes (não
// havia as rotas e assertClassOpen não tinha efeito).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-class-closure-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const academicCalendar = require('../../backend/utils/academicCalendar.js');
const examSchedule = require('../../backend/utils/examSchedule.js');
const dashboardAggregates = require('../../backend/utils/dashboardAggregates.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const COURSE = 'TI';
const tokens = { admin: 'tok-close-admin', prof: 'tok-close-prof', sec: 'tok-close-sec', coord: 'tok-close-coord' };
let app;
const as = (who, method, url) => request(app)[method](url).set('x-admin-session', tokens[who]);
const audits = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);
const cls1 = () => db.memory.classes.find(item => item.name === '1DES');

const CRITERIA = {
    courseId: COURSE,
    ativo: true,
    mediaMinima: 6,
    frequenciaMinima: 0,
    etapas: [{ ordem: 1, nome: '1º bimestre', peso: 1 }],
    recuperacao: { etapa: 'nenhuma', final: 'nenhuma' },
    mencoes: [],
    unidadeSituacao: 'turma',
};

let subSeq = 0;
function sub(email, examKey, score, extra = {}) {
    subSeq += 1;
    return {
        id: `sub_close_${subSeq}`,
        student: { name: email.split('@')[0], email, studentClass: '1DES', courseId: COURSE },
        examKey,
        score,
        type: 'impressa',
        entryMode: 'quick',
        attemptNumber: 1,
        resultStatus: 'considered',
        aggregationPolicy: 'highest',
        gradePublished: true,
        timestamp: '2026-03-10T12:00:00.000Z',
        ...extra,
    };
}

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: { timezone: 'America/Sao_Paulo' } };
    db.memory.courses = [{
        id: COURSE,
        name: 'Informática',
        structure: [{ id: 'M1', name: 'Redes', units: [{ key: 'u1', name: 'Prova 1', avaliacaoKey: 'Av_P1' }] }],
        disciplinas: [],
        avaliacao: { ...CRITERIA },
    }];
    db.memory.classes = [
        { name: '1DES', courseId: COURSE, period: 'Manhã', avaliacao: { schemaVersion: 1, itens: { Av_P1: { etapa: 1, peso: 1 } }, manuais: [] } },
        { name: '2DES', courseId: COURSE, period: 'Noite' },
    ];
    db.memory.evaluations = { Av_P1: { title: 'Prova 1', questions: [] } };
    db.memory.examApplications = [];
    db.memory.attendance = [];
    db.memory.academicTerms = [];
    db.memory.auditLogs = [];
    db.memory.admins = [
        { email: 'admin@close.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-admin-ok') },
        { email: 'prof@close.local', name: 'Prof', role: 'professor', password: db.hashPassword('senha-prof-ok'), assignedClasses: [{ courseId: COURSE, className: '1DES' }] },
        { email: 'sec@close.local', name: 'Secretaria', role: 'professor', password: db.hashPassword('senha-sec-ok'), additionalPermissions: ['classes.manage'], assignedClasses: [{ courseId: COURSE, className: '2DES' }] },
    ];
    const now = Date.now();
    db.memory.adminSessions = Object.fromEntries(Object.entries({ admin: 'admin', prof: 'prof', sec: 'sec' })
        .map(([who, user]) => [tokens[who], { email: `${user}@close.local`, createdAt: now, lastSeen: now }]));
    db.memory.students = [
        { name: 'Ana', email: 'ana@close.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE }], studentClass: '1DES' },
        { name: 'Bia', email: 'bia@close.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE }], studentClass: '1DES' },
    ];
    // Ana 7,0 (aprovada) e Bia 5,0 (reprovada por nota) com mínima 6.
    db.memory.submissions = [sub('ana@close.local', 'Av_P1', 70), sub('bia@close.local', 'Av_P1', 50)];
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

test('[UC-CURSO-003] resumo do encerramento: situações com os critérios de agora e nada segurando', async () => {
    const res = await as('admin', 'get', `/api/admin/class/close-summary?courseId=${COURSE}&name=1DES`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.alunos, 2);
    assert.deepEqual(res.body.situacoes.map(item => [item.situacao, item.total]), [['reprovado_nota', 1], ['aprovado', 1]]);
    assert.equal(res.body.situacoes.find(item => item.situacao === 'aprovado').rotulo, 'Aprovado');
    assert.deepEqual(res.body.pendencias, []);
    assert.equal(res.body.podeEncerrar, true);
    assert.equal(res.body.encerramento, null);
    assert.equal(res.body.turma.courseName, 'Informática');
    // Turma que não existe e turma fora do escopo.
    assert.equal((await as('admin', 'get', `/api/admin/class/close-summary?courseId=${COURSE}&name=9X`)).status, 404);
    assert.equal((await as('sec', 'get', `/api/admin/class/close-summary?courseId=${COURSE}&name=1DES`)).status, 403);
    // Sem "Gerenciar turmas" (o professor da turma) não lê nem encerra.
    assert.equal((await as('prof', 'get', `/api/admin/class/close-summary?courseId=${COURSE}&name=1DES`)).status, 403);
    assert.equal((await as('prof', 'post', '/api/admin/class/close').send({ courseId: COURSE, name: '1DES', confirm: 'ENCERRAR' })).status, 403);
    assert.equal(cls1().encerramento, undefined);
});

test('[UC-CURSO-003] encerrar pede ENCERRAR digitado, copia os critérios, audita e grava só turmas e auditoria', async () => {
    const noWord = await as('admin', 'post', '/api/admin/class/close').send({ courseId: COURSE, name: '1DES' });
    assert.equal(noWord.status, 400);
    assert.equal(noWord.body.field, 'confirm');
    assert.equal(cls1().encerramento, undefined);

    const saves = [];
    const originalSave = db.save;
    db.save = options => { saves.push(options); return originalSave.call(db, options); };
    let res;
    try {
        res = await as('admin', 'post', '/api/admin/class/close').send({ courseId: COURSE, name: '1DES', confirm: 'encerrar', reason: 'fim do semestre' });
    } finally {
        db.save = originalSave;
    }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.encerramento.encerrada, true);
    assert.equal(res.body.encerramento.por, 'admin@close.local');
    assert.equal(res.body.encerramento.motivo, 'fim do semestre');
    assert.equal('criterios' in res.body.encerramento, false, 'a resposta não leva a cópia dos critérios');
    assert.deepEqual(saves, [{ only: ['classes', 'auditLogs'] }]);
    const record = cls1().encerramento;
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.situacao, 'encerrada');
    assert.deepEqual(record.criterios.curso, CRITERIA);
    assert.deepEqual(record.criterios.turma, { schemaVersion: 1, itens: { Av_P1: { etapa: 1, peso: 1 } }, manuais: [] });
    assert.deepEqual(record.historico.map(item => item.acao), ['encerrada']);
    const [audit] = audits('class_closed');
    assert.ok(audit, 'encerramento auditado');
    assert.equal(audit.reason, 'fim do semestre');
    assert.equal(audit.details.alunos, 2);
    assert.deepEqual(audit.details.situacoes, { reprovado_nota: 1, aprovado: 1 });

    // Encerrar de novo não muda nada.
    const again = await as('admin', 'post', '/api/admin/class/close').send({ courseId: COURSE, name: '1DES', confirm: 'ENCERRAR' });
    assert.equal(again.body.semMudanca, true);
    assert.equal(audits('class_closed').length, 1);

    // A lista de turmas e o quadro mostram o encerramento, sem a cópia.
    const list = await as('admin', 'get', `/api/admin/classes?courseId=${COURSE}`);
    const row = list.body.find(item => item.name === '1DES');
    assert.equal(row.encerrada, true);
    assert.equal(row.encerramento.situacao, 'encerrada');
    assert.equal('criterios' in row.encerramento, false);
    assert.equal(list.body.find(item => item.name === '2DES').encerramento, null);
    const quadro = await as('admin', 'get', `/api/admin/gradebook?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(quadro.body.encerramento.encerrada, true);
});

test('[UC-CURSO-003] critérios mudados depois do encerramento não mudam a média nem a situação da turma encerrada', async () => {
    assert.equal((await as('admin', 'post', '/api/admin/class/close').send({ courseId: COURSE, name: '1DES', confirm: 'ENCERRAR' })).status, 200);
    // O curso sobe a média mínima para 8: Ana (7,0) passaria a reprovada.
    db.memory.courses[0].avaliacao = { ...CRITERIA, mediaMinima: 8 };
    const closed = await as('admin', 'get', `/api/admin/gradebook?courseId=${COURSE}&studentClass=1DES`);
    const ana = closed.body.rows.find(row => row.email === 'ana@close.local');
    assert.equal(ana.situacao, 'aprovado', JSON.stringify(ana));
    assert.equal(closed.body.criterio.mediaMinima, 6, 'o quadro pinta pela mínima congelada');
    // A outra turma do curso (aberta) usa a regra nova.
    db.memory.students.push({ name: 'Caio', email: 'caio@close.local', status: 'Ativo', classes: [{ name: '2DES', courseId: COURSE }], studentClass: '2DES' });
    db.memory.submissions.push({ ...sub('caio@close.local', 'Av_P1', 70), student: { name: 'caio', email: 'caio@close.local', studentClass: '2DES', courseId: COURSE } });
    const open = await as('admin', 'get', `/api/admin/gradebook?courseId=${COURSE}&studentClass=2DES`);
    assert.equal(open.body.rows.find(row => row.email === 'caio@close.local').situacao, 'reprovado_nota');
    // Reaberta, a turma volta a usar os critérios de agora.
    assert.equal((await as('admin', 'post', '/api/admin/class/reopen').send({ courseId: COURSE, name: '1DES', reason: 'revisão de nota' })).status, 200);
    const reopened = await as('admin', 'get', `/api/admin/gradebook?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(reopened.body.rows.find(row => row.email === 'ana@close.local').situacao, 'reprovado_nota');
    assert.deepEqual(cls1().encerramento.historico.map(item => item.acao), ['encerrada', 'reaberta']);
    assert.equal(cls1().encerramento.motivoReabertura, 'revisão de nota');
});

test('[UC-CURSO-003] encerrar recusa com prova aberta, prova agendada e entrega aguardando correção', async () => {
    const base = { examKey: 'Av_P1', studentClass: '1DES', courseId: COURSE, createdAt: '2026-03-01T10:00:00.000Z' };
    db.memory.examApplications = [{ ...base, id: 'app_open', status: 'running' }];
    let res = await as('admin', 'post', '/api/admin/class/close').send({ courseId: COURSE, name: '1DES', confirm: 'ENCERRAR' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'exam_in_progress');
    assert.match(res.body.error, /"Prova 1" está aberta no Monitor/);

    const abreEm = Date.now() + 86400000;
    db.memory.examApplications = [{ ...base, id: 'app_sched', status: 'prepared', agenda: { abreEm, fechaEm: abreEm + 3600000 } }];
    res = await as('admin', 'post', '/api/admin/class/close').send({ courseId: COURSE, name: '1DES', confirm: 'ENCERRAR' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'schedule_pending');
    // Agenda perdida (o computador estava desligado) não segura.
    db.memory.examApplications[0].agenda.perdida = true;

    db.memory.submissions.push(sub('ana@close.local', 'Av_P1', 0, { correcao: { situacao: 'pendente', versao: 0 } }));
    const summary = await as('admin', 'get', `/api/admin/class/close-summary?courseId=${COURSE}&name=1DES`);
    assert.deepEqual(summary.body.pendencias.map(item => item.code), ['correction_pending']);
    assert.equal(summary.body.podeEncerrar, false);
    res = await as('admin', 'post', '/api/admin/class/close').send({ courseId: COURSE, name: '1DES', confirm: 'ENCERRAR' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'correction_pending');
    assert.equal(cls1().encerramento, undefined);
    assert.equal(audits('class_closed').length, 0);
});

test('[UC-CURSO-003] turma encerrada: não prepara nem agenda prova, a agenda vencida vira perdida e a matrícula nova é recusada', async () => {
    cls1().encerramento = { schemaVersion: 1, situacao: 'encerrada', em: Date.now(), por: 'admin@close.local', criterios: {} };
    const prepare = await as('admin', 'post', '/api/admin/exam-applications').send({ studentClass: '1DES', courseId: COURSE, examKey: 'Av_P1', historyId: 'h1' });
    assert.equal(prepare.status, 409, JSON.stringify(prepare.body));
    assert.equal(prepare.body.code, 'class_closed');
    assert.match(prepare.body.error, /não aplica mais prova/);

    // Banco que chegou com a prova agendada numa turma encerrada: a varredura não abre.
    const abreEm = Date.now() - 1000;
    db.memory.examApplications = [{ id: 'app_due', examKey: 'Av_P1', studentClass: '1DES', courseId: COURSE, status: 'prepared', agenda: { abreEm, fechaEm: abreEm + 3600000 } }];
    const sweep = examSchedule.sweepSchedules(db.memory, { now: Date.now() });
    assert.equal(sweep.opened.length, 0);
    assert.equal(sweep.missed.length, 1);
    assert.equal(db.memory.examApplications[0].status, 'prepared');
    assert.equal(db.memory.examApplications[0].agenda.perdida, true);

    // Matrícula nova em turma encerrada: em lote, pela ficha e no cadastro.
    db.memory.students.push({ name: 'Duda', email: 'duda@close.local', status: 'Ativo', classes: [{ name: '2DES', courseId: COURSE }], studentClass: '2DES' });
    const bulk = await as('admin', 'post', '/api/admin/student/bulk-enroll').send({ emails: ['duda@close.local'], className: '1DES', courseId: COURSE });
    assert.equal(bulk.status, 409, JSON.stringify(bulk.body));
    assert.equal(bulk.body.code, 'class_closed');
    assert.match(bulk.body.error, /não recebe matrícula nova/);
    const update = await as('admin', 'post', '/api/admin/student/update').send({
        originalEmail: 'duda@close.local', name: 'Duda', email: 'duda@close.local', status: 'Ativo',
        classes: [{ name: '2DES', courseId: COURSE }, { name: '1DES', courseId: COURSE }],
    });
    assert.equal(update.status, 409, JSON.stringify(update.body));
    const create = await as('admin', 'post', '/api/admin/student/create').send({ name: 'Eva', email: 'eva@close.local', courseId: COURSE, classes: [{ name: '1DES', courseId: COURSE }] });
    assert.equal(create.status, 409, JSON.stringify(create.body));
    assert.equal(db.memory.students.find(item => item.email === 'duda@close.local').classes.length, 1);
    assert.equal(db.memory.students.some(item => item.email === 'eva@close.local'), false);
    // Sair da turma encerrada pode (a matrícula vai para o histórico).
    const leave = await as('admin', 'post', '/api/admin/student/update').send({
        originalEmail: 'ana@close.local', name: 'Ana', email: 'ana@close.local', status: 'Ativo', classes: [{ name: '2DES', courseId: COURSE }],
    });
    assert.equal(leave.status, 200, JSON.stringify(leave.body));
    const ana = db.memory.students.find(item => item.email === 'ana@close.local');
    assert.equal(ana.historicoMatriculas[0].motivo, 'turma_encerrada');
});

test('[UC-CURSO-003] turma encerrada não ganha presença do login nem cobrança de chamada no painel', async () => {
    const settingsUtil = require('../../backend/utils/settings.js');
    const attendanceUtil = require('../../backend/utils/attendance.js');
    db.memory.config = { ...(db.memory.config || {}), settings: { timezone: 'America/Sao_Paulo', attendance: { autoOnLogin: true, windowStart: '', windowEnd: '' } } };
    const today = settingsUtil.today();
    const now = attendanceUtil.hhmmToMin(settingsUtil.nowHHMM(settingsUtil.getSettings().timezone));
    const start = Math.max(0, now - 5);
    const hhmm = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    cls1().attendanceConfig = { toleranciaMin: 10, grade: { [String(weekday)]: [{ ordem: 1, inicio: hhmm }] } };
    cls1().encerramento = { schemaVersion: 1, situacao: 'encerrada', em: Date.now(), por: 'admin@close.local', criterios: {} };

    const queue = cls => dashboardAggregates.computeQueue({ memory: db.memory, cls, course: db.memory.courses[0], students: db.memory.students, today, now: Date.now(), canSeeMatriculas: false, pendingEnrollments: [] });
    assert.equal(queue(cls1()).some(item => item.id === 'chamada_pendente'), false, 'turma encerrada: o painel não cobra a chamada');

    const login = await request(app).post('/api/student/login').send({ email: 'ana@close.local', password: '123' });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    await request(app).get('/api/ping?email=ana@close.local').set('x-session-token', login.body.sessionToken).expect(200);
    assert.deepEqual(db.memory.attendance, [], 'login na turma encerrada não cria presença');

    // Reaberta, o mesmo acesso cria a presença e o painel volta a cobrar.
    cls1().encerramento = { ...cls1().encerramento, situacao: 'reaberta', reabertaEm: Date.now() };
    assert.equal(queue(cls1()).some(item => item.id === 'chamada_pendente'), true);
    await request(app).get('/api/ping?email=ana@close.local').set('x-session-token', login.body.sessionToken).expect(200);
    assert.equal(db.memory.attendance.length, 1);
    assert.equal(db.memory.attendance[0].origin, 'login');
});
