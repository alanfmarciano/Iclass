// Correção das tarefas pelo painel (fase 3, C6 / P1-d; FUN-01, D7, D9, D10 e D16 do P1).
// Antes deste caso, o professor via a lista da turma (C4) mas não tinha como abrir a
// entrega, baixar o arquivo, dar nota, devolver, pedir para refazer, prorrogar o prazo de
// um aluno, registrar a entrega em mãos nem baixar as entregas em ZIP: as rotas abaixo
// respondiam 404. Confere: a entrega com as versões (sem caminho), o download sempre como
// anexo (inline só imagem e PDF), salvar sem o aluno ver e devolver com o desconto de
// atraso, nota com vírgula, mudar nota devolvida só com motivo, zero explícito sem
// entrega, refazer reabrindo o envio só para aquele aluno, "devolver todas", prorrogação,
// entrega em mãos, o ZIP com lista.csv protegida contra fórmula e nomes que o Windows
// abre, a fila "Precisa de você" e os sinos (painel e aluno), o escopo e os papéis, a
// auditoria e a turma encerrada (409 class_closed pelo assertClassOpen).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-assignments-grading-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// Módulos antes do servidor: server.js registra o process.on('uncaughtException'), que
// engoliria a falha destes require.
const AdmZip = require('adm-zip');
const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const assignments = require('../../backend/utils/assignments.js');
const assignmentFiles = require('../../backend/utils/assignmentFiles.js');
const assignmentExport = require('../../backend/utils/assignmentExport.js');
const academicCalendar = require('../../backend/utils/academicCalendar.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');
const { createApp } = require('../../backend/server.js');

const COURSE = 'curso-correcao';
const SCHOOL = 'escola-correcao';
const CLASS = '1DES';
const OTHER = '2DES';
const ANA = 'ana@correcao.local';
const BIA = 'bia@correcao.local';
const CAIO = 'caio@correcao.local';
const DUDA = 'duda@correcao.local';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(512, 0x20), Buffer.from('\n%%EOF\n')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const ACCOUNTS = {
    admin: { email: 'adm@correcao.local', role: 'admin' },
    prof: { email: 'prof@correcao.local', role: 'professor', assignedClasses: [{ courseId: COURSE, className: CLASS }] },
    prof2: { email: 'prof2@correcao.local', role: 'professor', assignedClasses: [{ courseId: COURSE, className: OTHER }] },
    monitor: { email: 'monitor@correcao.local', role: 'monitor', assignedClasses: [{ courseId: COURSE, className: CLASS }] },
    coord: { email: 'coord@correcao.local', role: 'coordenacao', assignedSchoolIds: [SCHOOL] },
};
const tokens = {};
let app;

const as = (name, req) => req.set('x-admin-session', tokens[name]);
const get = (name, url) => as(name, request(app).get(url));
const post = (name, url, payload = {}) => as(name, request(app).post(url)).send(payload);
const asStudent = (email, req) => req.set('x-session-token', tokens[email]);
const audits = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);
const Q = `courseId=${COURSE}&studentClass=${CLASS}`;

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {
        timezone: 'America/Sao_Paulo',
        entregas: { maxMbPorArquivo: 5, maxMbPorEnvio: 10, discoLivreMinimoMb: 0 },
    } };
    db.memory.schools = [{ id: SCHOOL, name: 'Escola da Correção' }];
    db.memory.courses = [{ id: COURSE, name: 'Desenvolvimento', schoolId: SCHOOL, structure: [{ id: 'm1', name: 'Módulo 1', units: [] }] }];
    db.memory.classes = [{ name: CLASS, courseId: COURSE, period: 'Manhã' }, { name: OTHER, courseId: COURSE, period: 'Tarde' }];
    db.memory.students = [
        { id: 'alu_00000000000000a1', name: 'Ana Lima', email: ANA, matricula: '2026-001', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: CLASS, courseId: COURSE }] },
        { id: 'alu_00000000000000b2', name: '=HYPERLINK("x")', email: BIA, matricula: '2026-002', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: CLASS, courseId: COURSE }] },
        { id: 'alu_00000000000000c3', name: 'Caio: Dias?', email: CAIO, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: CLASS, courseId: COURSE }] },
        { id: 'alu_00000000000000d4', name: 'Duda Melo', email: DUDA, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: OTHER, courseId: COURSE }] },
    ];
    db.memory.admins = Object.entries(ACCOUNTS).map(([name, account]) => ({
        name: `Conta ${name}`, password: db.hashPassword('Senha-forte-2026'), assignedClasses: [], assignedSchoolIds: [], assignedCourseIds: [], additionalPermissions: [], ...account,
    }));
    db.memory.adminSessions = {};
    db.memory.sessions = {};
    db.memory.assignments = [];
    db.memory.assignmentSubmissions = [];
    db.memory.auditLogs = [];
    db.memory.announcements = [];
    db.memory.forum = [];
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.attendance = [];
    Object.entries(ACCOUNTS).forEach(([name, account]) => { tokens[name] = createAdminSession(db.memory, account.email); });
    [ANA, BIA, CAIO, DUDA].forEach(email => { tokens[email] = createStudentSession(db.memory, email); });
    fs.rmSync(runtimePaths.ASSIGNMENT_FILES_DIR, { recursive: true, force: true });
}

function addTask(fields = {}) {
    const now = Date.now();
    const record = assignments.newAssignmentRecord({
        courseId: COURSE,
        studentClass: CLASS,
        title: 'Relatório da prática',
        response: { files: true, text: true, link: true },
        files: { maxFiles: 3, maxSizeMb: 2, types: ['pdf', 'image', 'code'], extraExtensions: [] },
        dueAt: now + 3 * DAY,
        latePolicy: { mode: 'desconto', penaltyPerDayPct: 10, penaltyMaxPct: 30 },
        status: 'publicada',
        ...fields,
    }, { actor: ACCOUNTS.prof.email, now: now - DAY });
    db.memory.assignments.push(record);
    return record;
}

// Entrega gravada como o envio do aluno grava (arquivos de verdade em data/entregas).
function addSubmission(task, email, versions = [{}], extra = {}) {
    const student = db.memory.students.find(item => item.email === email);
    const sub = assignments.newSubmissionRecord(task, student, { now: Date.now() - 2 * HOUR });
    sub.versions = versions.map((spec, index) => {
        const files = (spec.files || [['relatorio.pdf', PDF]]).map(([name, content]) => {
            const ext = path.extname(name).toLowerCase();
            const id = assignmentFiles.newFileId();
            const storedRel = assignmentFiles.storedRelFor(task.id, sub.id, id, ext);
            const abs = assignmentFiles.absFromStoredRel(storedRel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content);
            return { id, originalName: name, storedRel, size: content.length, sha256: require('crypto').createHash('sha256').update(content).digest('hex'), mime: assignmentFiles.DOWNLOAD_MIME[ext] || 'application/octet-stream', ext, category: '' };
        });
        const requestAt = spec.requestAt || Date.now() - HOUR + index;
        return { n: index + 1, requestAt, receivedAt: requestAt + 100, late: !!spec.lateMs, lateMs: spec.lateMs || 0, text: spec.text || '', link: spec.link || '', files, ip: '10.0.0.5', device: 'Celular' };
    });
    sub.status = sub.versions.length ? 'enviada' : 'pendente';
    Object.assign(sub, extra);
    db.memory.assignmentSubmissions.push(sub);
    return sub;
}

const subOf = (task, email) => assignments.normalizeSubmission(assignments.findSubmission(db.memory, task.id, email));
const grade = (task, payload, name = 'prof') => post(name, `/api/admin/assignments/${task.id}/grade`, payload);

function patchClassClosed() {
    const original = academicCalendar.assertClassOpen;
    academicCalendar.assertClassOpen = (cls, options = {}) => {
        const error = new academicCalendar.ClassClosedError(cls);
        if (options && options.res) {
            options.res.status(409).json(academicCalendar.classClosedBody(error));
            return false;
        }
        throw error;
    };
    return () => { academicCalendar.assertClassOpen = original; };
}

function zipBuffer(req) {
    return req.buffer(true).parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => seed());
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('entrega no painel: todas as versões, desconto por versão, prévia possível e arquivo que sumiu, sem caminho', async () => {
    const task = addTask();
    const sub = addSubmission(task, ANA, [
        { files: [['relatório.pdf', PDF], ['foto.png', PNG]] },
        { files: [['main.py', Buffer.from('print("oi")\n')], ['site.html', Buffer.from('<script>alert(1)</script>')]], text: 'Segue a versão nova.', lateMs: 2 * DAY - 1000 },
    ]);
    fs.rmSync(assignmentFiles.absFromStoredRel(sub.versions[0].files[1].storedRel));

    const res = await get('prof', `/api/admin/assignments/${task.id}/submissions/${sub.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body.submission;
    assert.equal(body.name, 'Ana Lima');
    assert.equal(body.instructorStatus, 'para_corrigir');
    assert.equal(body.versions.length, 2);
    assert.deepEqual(body.versions.map(version => version.penaltyPct), [0, 20]);
    assert.deepEqual(body.versions[0].files.map(file => [file.name, file.preview, file.missing]), [['relatório.pdf', 'pdf', false], ['foto.png', 'image', true]]);
    assert.deepEqual(body.versions[1].files.map(file => file.preview), ['text', 'text']);
    assert.equal(body.versions[1].text, 'Segue a versão nova.');
    assert.equal(body.versions[1].ip, '10.0.0.5');
    assert.match(body.versions[0].comprovante, /^[0-9A-F]{8}$/);
    assert.equal(JSON.stringify(res.body).includes('storedRel'), false);
    assert.equal(JSON.stringify(res.body).includes('entregas/'), false);

    // Entrega de outra tarefa pelo caminho desta: 404; professor de outra turma: 403.
    const other = addTask({ title: 'Outra' });
    assert.equal((await get('prof', `/api/admin/assignments/${other.id}/submissions/${sub.id}`)).status, 404);
    assert.equal((await get('prof2', `/api/admin/assignments/${task.id}/submissions/${sub.id}`)).status, 403);
    // Coordenação vê; Professor auxiliar não tem a tela de tarefas.
    assert.equal((await get('coord', `/api/admin/assignments/${task.id}/submissions/${sub.id}`)).status, 200);
    assert.equal((await get('monitor', `/api/admin/assignments/${task.id}/submissions/${sub.id}`)).status, 403);
});

test('download pelo painel: anexo com nome acentuado, nosniff, CSP sandbox; inline só imagem e PDF; HTML nunca como text/html', async () => {
    const task = addTask();
    const sub = addSubmission(task, ANA, [{ files: [['Relatório final.pdf', PDF], ['foto.png', PNG], ['site.html', Buffer.from('<h1>x</h1>')]] }]);
    const [pdf, png, html] = sub.versions[0].files;
    const url = file => `/api/admin/assignments/${task.id}/files/${file.id}`;

    const download = await get('prof', url(pdf));
    assert.equal(download.status, 200);
    assert.equal(download.headers['content-type'], 'application/pdf');
    assert.match(download.headers['content-disposition'], /^attachment; filename="Relatorio final.pdf"; filename\*=UTF-8''Relat%C3%B3rio%20final.pdf$/);
    assert.equal(download.headers['x-content-type-options'], 'nosniff');
    assert.equal(download.headers['content-security-policy'], 'sandbox');
    assert.equal(Number(download.headers['content-length']), PDF.length);

    assert.match((await get('prof', `${url(png)}?inline=1`)).headers['content-disposition'], /^inline;/);
    const htmlInline = await get('prof', `${url(html)}?inline=1`);
    assert.match(htmlInline.headers['content-disposition'], /^attachment;/);
    assert.match(htmlInline.headers['content-type'], /^text\/plain/);

    // Arquivo de outra tarefa, id estranho, fora do escopo e arquivo que sumiu do disco.
    const other = addTask({ title: 'Outra' });
    assert.equal((await get('prof', `/api/admin/assignments/${other.id}/files/${pdf.id}`)).status, 404);
    assert.equal((await get('prof', `/api/admin/assignments/${task.id}/files/..%2F..%2Fdatabase.db`)).status, 404);
    assert.equal((await get('prof2', url(pdf))).status, 403);
    fs.rmSync(assignmentFiles.absFromStoredRel(pdf.storedRel));
    const missing = await get('prof', url(pdf));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'file_missing');
    assert.equal(missing.headers['content-disposition'], undefined);
    // Download individual não vai para a auditoria (volume); o ZIP vai.
    assert.equal((db.memory.auditLogs || []).length, 0);
});

test('salvar não aparece para o aluno; devolver publica com o desconto; "8,5" vira 85; mudar nota devolvida só com motivo', async () => {
    const task = addTask();
    addSubmission(task, ANA, [{ lateMs: DAY + 1000 }]);

    const saved = await grade(task, { studentEmail: ANA, grade: '8,5', comment: 'Bom trabalho, faltou a conclusão.', action: 'salvar' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    let sub = subOf(task, ANA);
    assert.equal(sub.status, 'corrigida');
    assert.deepEqual([sub.grade.score, sub.grade.penaltyPct, sub.grade.finalScore, sub.grade.versionGraded], [85, 20, 68, 1]);
    assert.equal(saved.body.row.status, 'corrigida');
    assert.equal(audits('assignment_grade_saved').length, 1);
    assert.equal(audits('assignment_grade_saved')[0].category, 'grade');
    assert.equal(audits('assignment_grade_saved')[0].newValue, '6,8');

    // O aluno não vê a correção salva (nem no detalhe nem no quadro de notas).
    let detail = await asStudent(ANA, request(app).get(`/api/student/assignments/${task.id}?${Q}`));
    assert.equal(detail.body.devolucao, null);
    assert.deepEqual(assignments.assignmentGradeEntries(db.memory, { courseId: COURSE, studentClass: CLASS }), []);

    // Repetir sem mudar nada não grava.
    const same = await grade(task, { studentEmail: ANA, grade: '8,5', action: 'salvar' });
    assert.equal(same.body.changed, false);
    assert.equal(audits('assignment_grade_saved').length, 1);

    // Devolver sem mandar a nota de novo devolve a salva.
    const returned = await grade(task, { studentEmail: ANA, action: 'devolver' });
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    sub = subOf(task, ANA);
    assert.equal(sub.status, 'devolvida');
    assert.ok(sub.returnedAt);
    assert.equal(audits('assignment_grade_returned').length, 1);
    detail = await asStudent(ANA, request(app).get(`/api/student/assignments/${task.id}?${Q}`));
    assert.deepEqual(detail.body.devolucao && [detail.body.devolucao.nota, detail.body.devolucao.desconto, detail.body.devolucao.notaFinal, detail.body.devolucao.comentario], [85, 20, 68, 'Bom trabalho, faltou a conclusão.']);
    assert.equal(assignments.assignmentGradeEntries(db.memory, { courseId: COURSE, studentClass: CLASS })[0].score, 68);
    let bell = await asStudent(ANA, request(app).get(`/api/student/notifications?${Q}`));
    assert.equal(bell.body.items.find(item => item.id === `tarefa:${task.id}:devolvida`).title, 'Tarefa devolvida');

    // Mudar depois de devolvida: sem motivo 400; com motivo, continua devolvida.
    const noReason = await grade(task, { studentEmail: ANA, grade: 9, waivePenalty: true, action: 'devolver' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'reason_required');
    assert.equal(subOf(task, ANA).grade.finalScore, 68);
    await new Promise(resolve => setTimeout(resolve, 5));
    const changed = await grade(task, { studentEmail: ANA, grade: 9, waivePenalty: true, action: 'salvar', reason: 'Atraso justificado com atestado.' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    sub = subOf(task, ANA);
    assert.equal(sub.status, 'devolvida');
    assert.deepEqual([sub.grade.score, sub.grade.penaltyPct, sub.grade.finalScore, sub.grade.penaltyWaived], [90, 0, 90, true]);
    const entry = audits('assignment_grade_changed')[0];
    assert.deepEqual([entry.oldValue, entry.newValue, entry.reason, entry.field], ['6,8', '9,0', 'Atraso justificado com atestado.', 'Nota da tarefa']);
    bell = await asStudent(ANA, request(app).get(`/api/student/notifications?${Q}`));
    const item = bell.body.items.find(row => row.id === `tarefa:${task.id}:devolvida`);
    assert.equal(item.title, 'Nota da tarefa alterada');

    // Nota fora da faixa e texto estranho: mensagem em português no campo.
    const bad = await grade(task, { studentEmail: ANA, grade: '11', action: 'salvar', reason: 'teste' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'grade');
    assert.match(bad.body.error, /de 0 a 10/);
});

test('sem entrega: só o zero explícito (ninguém ganha nota sem entregar); aluno fora da lista 404', async () => {
    const task = addTask();
    const refused = await grade(task, { studentEmail: BIA, grade: '5', action: 'devolver' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'no_delivery');
    assert.equal(db.memory.assignmentSubmissions.length, 0);
    const zero = await grade(task, { studentEmail: BIA, grade: '0', comment: 'Não entregou.', action: 'devolver' });
    assert.equal(zero.status, 200, JSON.stringify(zero.body));
    const sub = subOf(task, BIA);
    assert.deepEqual([sub.status, sub.grade.finalScore, sub.grade.versionGraded, sub.studentId], ['devolvida', 0, 0, 'alu_00000000000000b2']);
    assert.equal(audits('assignment_grade_returned')[0].details.semEntrega, true);
    // Aluno de outra turma: o escopo da conta barra antes (403); e-mail fora da lista: 404 no campo.
    const outside = await grade(task, { studentEmail: DUDA, grade: '0', action: 'salvar' });
    assert.equal(outside.status, 403);
    const unknown = await grade(task, { studentEmail: 'ninguem@correcao.local', grade: '0', action: 'salvar' });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.field, 'studentEmail');
    assert.equal(db.memory.assignmentSubmissions.length, 1);
    // Sem nota em salvar: pede a nota.
    addSubmission(task, ANA);
    const empty = await grade(task, { studentEmail: ANA, action: 'salvar' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.field, 'grade');
});

test('refazer: pede comentário e prazo novo, reabre o envio só para aquele aluno e volta para a fila com a versão nova', async () => {
    const task = addTask({ dueAt: Date.now() - HOUR, latePolicy: { mode: 'bloquear', penaltyPerDayPct: 0, penaltyMaxPct: 0 } });
    addSubmission(task, ANA, [{ requestAt: Date.now() - 2 * HOUR }]);
    addSubmission(task, BIA, [{ requestAt: Date.now() - 2 * HOUR }]);
    const tomorrow = new Date(Date.now() + DAY + 3 * HOUR).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

    assert.equal((await grade(task, { studentEmail: ANA, action: 'refazer', redoDueDate: tomorrow })).body.field, 'comment');
    const noDate = await grade(task, { studentEmail: ANA, action: 'refazer', comment: 'Refaça o diagrama.' });
    assert.equal(noDate.status, 400);
    assert.equal(noDate.body.field, 'redoDueDate');
    const past = await grade(task, { studentEmail: ANA, action: 'refazer', comment: 'Refaça o diagrama.', redoDueDate: '2020-01-01' });
    assert.equal(past.status, 400);
    assert.equal(past.body.field, 'redoDueDate');

    const redo = await grade(task, { studentEmail: ANA, action: 'refazer', comment: 'Refaça o diagrama.', redoDueDate: tomorrow, redoDueTime: '22:00' });
    assert.equal(redo.status, 200, JSON.stringify(redo.body));
    let sub = subOf(task, ANA);
    assert.equal(sub.status, 'refazer');
    assert.equal(sub.grade.comment, 'Refaça o diagrama.');
    assert.equal(redo.body.row.status, 'refazer');
    assert.equal(audits('assignment_redo_requested').length, 1);
    assert.match(audits('assignment_redo_requested')[0].newValue, /às 22:00$/);

    // O aluno vê o pedido e o sino avisa; ele pode mandar outra versão (a tarefa bloqueia
    // atraso e o prazo da turma já passou); a outra aluna continua sem poder.
    const detail = await asStudent(ANA, request(app).get(`/api/student/assignments/${task.id}?${Q}`));
    assert.equal(detail.body.aceitaEnvio, true);
    assert.equal(detail.body.refazer.comentario, 'Refaça o diagrama.');
    const bell = await asStudent(ANA, request(app).get(`/api/student/notifications?${Q}`));
    assert.ok(bell.body.items.some(item => item.id === `tarefa:${task.id}:refazer` && item.title === 'Refazer a tarefa' && item.unread));
    const again = await asStudent(ANA, request(app).post(`/api/student/assignments/${task.id}/submit`)).attach('files', PDF, 'v2.pdf');
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.version.n, 2);
    const blocked = await asStudent(BIA, request(app).post(`/api/student/assignments/${task.id}/submit`)).attach('files', PDF, 'v2.pdf');
    assert.equal(blocked.status, 409);
    sub = subOf(task, ANA);
    assert.equal(assignments.instructorStatus(sub), 'para_corrigir');
    const bellAfter = await asStudent(ANA, request(app).get(`/api/student/notifications?${Q}`));
    assert.equal(bellAfter.body.items.some(item => item.id === `tarefa:${task.id}:refazer`), false);

    // Refazer de uma entrega já devolvida esconde a nota publicada: pede motivo.
    await grade(task, { studentEmail: BIA, grade: '7', action: 'devolver' });
    const hidden = await grade(task, { studentEmail: BIA, action: 'refazer', comment: 'Faltou a parte 2.', redoDueDate: tomorrow });
    assert.equal(hidden.status, 400);
    assert.equal(hidden.body.code, 'reason_required');
    assert.match(hidden.body.error, /ficará escondida/);
    const withReason = await grade(task, { studentEmail: BIA, action: 'refazer', comment: 'Faltou a parte 2.', redoDueDate: tomorrow, reason: 'Combinado em sala.' });
    assert.equal(withReason.status, 200, JSON.stringify(withReason.body));
    assert.equal(subOf(task, BIA).returnedAt, null);
    assert.deepEqual(assignments.assignmentGradeEntries(db.memory, { courseId: COURSE, studentClass: CLASS }), []);
    assert.equal(audits('assignment_redo_requested')[1].details.notaEscondida, true);
});

test('devolver todas as corrigidas: só as que têm nota e nenhuma versão nova esperando', async () => {
    const task = addTask();
    addSubmission(task, ANA);
    addSubmission(task, BIA);
    addSubmission(task, CAIO);
    await grade(task, { studentEmail: ANA, grade: '8', action: 'salvar' });
    await grade(task, { studentEmail: BIA, grade: '6', action: 'salvar' });
    // Bia mandou outra versão depois da correção: fica fora (a nota é da versão velha).
    const bia = assignments.findSubmission(db.memory, task.id, BIA);
    bia.versions.push({ ...bia.versions[0], n: 2, requestAt: Date.now() });
    const res = await post('prof', `/api/admin/assignments/${task.id}/return-all`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.returned, res.body.newVersionPending], [1, 1]);
    assert.equal(subOf(task, ANA).status, 'devolvida');
    assert.equal(subOf(task, BIA).status, 'corrigida');
    assert.equal(subOf(task, CAIO).status, 'enviada');
    const entries = audits('assignment_grade_returned');
    assert.equal(entries.length, 1);
    assert.deepEqual([entries[0].studentEmail, entries[0].details.lote, entries[0].newValue], [ANA, true, '8,0']);
    const again = await post('prof', `/api/admin/assignments/${task.id}/return-all`, {});
    assert.deepEqual([again.body.changed, again.body.returned], [false, 0]);
});

test('prorrogação: motivo, depois de agora e do prazo da turma; o aluno envia depois do prazo da turma; devolvida não recebe', async () => {
    const task = addTask({ dueAt: Date.now() - HOUR, latePolicy: { mode: 'bloquear', penaltyPerDayPct: 0, penaltyMaxPct: 0 } });
    const tomorrow = new Date(Date.now() + DAY + 3 * HOUR).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const url = `/api/admin/assignments/${task.id}/extension`;
    const noReason = await post('prof', url, { studentEmail: ANA, dueDate: tomorrow });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.field, 'reason');
    const past = await post('prof', url, { studentEmail: ANA, dueDate: '2020-01-01', reason: 'Atestado médico' });
    assert.equal(past.status, 400);
    assert.equal(past.body.field, 'dueDate');
    // A tarefa não tem encerramento: o aluno também não ganha um.
    const close = await post('prof', url, { studentEmail: ANA, dueDate: tomorrow, closeDate: tomorrow, reason: 'Atestado médico' });
    assert.equal(close.status, 400);
    assert.equal(close.body.field, 'closeDate');

    const granted = await post('prof', url, { studentEmail: ANA, dueDate: tomorrow, dueTime: '18:00', reason: 'Atestado médico' });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    const sub = subOf(task, ANA);
    assert.equal(sub.status, 'pendente');
    assert.equal(sub.extension.reason, 'Atestado médico');
    assert.equal(granted.body.row.extension.dueAt, sub.extension.dueAt);
    const entry = audits('assignment_extension_granted')[0];
    assert.deepEqual([entry.category, entry.studentEmail, entry.reason, entry.field], ['assignment', ANA, 'Atestado médico', 'Prazo da tarefa']);
    assert.match(entry.newValue, /às 18:00$/);
    // O mesmo prazo de novo não grava.
    assert.equal((await post('prof', url, { studentEmail: ANA, dueDate: tomorrow, dueTime: '18:00', reason: 'Atestado médico' })).body.changed, false);
    assert.equal(audits('assignment_extension_granted').length, 1);

    const sent = await asStudent(ANA, request(app).post(`/api/student/assignments/${task.id}/submit`)).attach('files', PDF, 'relatorio.pdf');
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.version.late, false);
    assert.equal((await asStudent(BIA, request(app).post(`/api/student/assignments/${task.id}/submit`)).attach('files', PDF, 'relatorio.pdf')).status, 409);

    await grade(task, { studentEmail: ANA, grade: '9', action: 'devolver' });
    const returned = await post('prof', url, { studentEmail: ANA, dueDate: tomorrow, dueTime: '20:00', reason: 'Mais tempo' });
    assert.equal(returned.status, 409);
    assert.equal(returned.body.code, 'assignment_returned');
});

test('entrega em mãos: registro sem arquivo, entra na fila sem nota e sai com nota; devolver junto', async () => {
    const task = addTask();
    const url = `/api/admin/assignments/${task.id}/manual-entry`;
    const res = await post('prof', url, { studentEmail: CAIO, note: 'Entregou impresso na aula.' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let sub = subOf(task, CAIO);
    assert.deepEqual([sub.status, sub.manualEntry.note, sub.versions.length], ['entregue_em_maos', 'Entregou impresso na aula.', 0]);
    assert.equal(assignments.instructorStatus(sub), 'para_corrigir');
    assert.equal(audits('assignment_manual_entry').length, 1);
    assert.equal(audits('assignment_manual_entry')[0].category, 'assignment');
    // O aluno vê "Entregue em mãos".
    const list = await asStudent(CAIO, request(app).get(`/api/student/assignments?${Q}`));
    assert.equal(list.body.assignments[0].situacao, 'entregue_em_maos');
    // Com nota, sem desconto (não há hora de chegada), e devolvida de uma vez.
    const graded = await post('prof', url, { studentEmail: CAIO, note: 'Entregou impresso na aula.', grade: '7,5', comment: 'Ok.', returnNow: true });
    assert.equal(graded.status, 200, JSON.stringify(graded.body));
    sub = subOf(task, CAIO);
    assert.deepEqual([sub.status, sub.grade.score, sub.grade.penaltyPct, sub.grade.finalScore, sub.grade.comment], ['devolvida', 75, 0, 75, 'Ok.']);
    assert.equal(audits('assignment_manual_entry').length, 1, 'mesma observação não grava outra entrada');
    assert.equal(audits('assignment_grade_returned').length, 1);
    // Devolvida: a entrega em mãos não muda a nota (use a correção, com motivo).
    const locked = await post('prof', url, { studentEmail: CAIO, note: 'outra', grade: '10' });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.code, 'assignment_returned');
});

test('fila "Precisa de você" e sino do painel: entregas para corrigir por turma, só com page.assignments', async () => {
    const task = addTask();
    addSubmission(task, ANA, [{ requestAt: Date.now() - 3 * DAY }]);
    addSubmission(task, BIA);
    await grade(task, { studentEmail: BIA, grade: '8', action: 'devolver' });
    await post('prof', `/api/admin/assignments/${task.id}/manual-entry`, { studentEmail: CAIO, note: 'impresso' });
    addTask({ title: 'Rascunho', status: 'rascunho' });

    const queue = await get('prof', `/api/admin/dashboard/queue?${Q}`);
    assert.equal(queue.status, 200);
    const item = queue.body.find(row => row.id === 'entregas_para_corrigir');
    assert.ok(item, JSON.stringify(queue.body));
    assert.equal(item.count, 2);
    assert.equal(item.href, '/tarefas?filtro=para-corrigir');
    assert.match(item.detalhe, /Relatório da prática/);
    assert.ok(item.at <= Date.now() - 3 * DAY + 1000);

    const bell = await get('prof', `/api/admin/notifications?${Q}`);
    assert.ok(bell.body.items.some(row => row.type === 'entregas_para_corrigir' && row.count === 2));
    // Professor auxiliar (sem page.assignments) não vê o item.
    const monitorQueue = await get('monitor', `/api/admin/dashboard/queue?${Q}`);
    assert.equal(monitorQueue.body.some(row => row.id === 'entregas_para_corrigir'), false);
    // Coordenação vê as tarefas (page.assignments) mas não corrige: nem na fila nem no sino.
    const coordQueue = await get('coord', `/api/admin/dashboard/queue?${Q}`);
    assert.equal(coordQueue.status, 200);
    assert.equal(coordQueue.body.some(row => row.id === 'entregas_para_corrigir'), false);
    const coordBell = await get('coord', `/api/admin/notifications?${Q}`);
    assert.equal(coordBell.status, 200);
    assert.equal((coordBell.body.items || []).some(row => row.type === 'entregas_para_corrigir'), false);
    // Tudo corrigido: o item some.
    await grade(task, { studentEmail: ANA, grade: '6', action: 'salvar' });
    await grade(task, { studentEmail: CAIO, grade: '6', action: 'salvar' });
    const empty = await get('prof', `/api/admin/dashboard/queue?${Q}`);
    assert.equal(empty.body.some(row => row.id === 'entregas_para_corrigir'), false);
});

test('ZIP das entregas: pasta por aluno com nomes que o Windows abre, lista.csv contra fórmula, última ou todas as versões', async () => {
    const task = addTask({ title: 'Relatório: rede/LAN?' });
    const ana = addSubmission(task, ANA, [
        { files: [['relatório.pdf', PDF]] },
        { files: [['relatório.pdf', PDF], ['relatório.pdf', PNG.subarray(0, 8)]], text: 'Minha resposta\nem duas linhas', link: 'https://exemplo.org/projeto' },
    ]);
    addSubmission(task, BIA, [{ files: [['CON.txt', Buffer.from('texto\n')]] }]);
    const caio = addSubmission(task, CAIO, [{ files: [['foto.png', PNG]] }]);
    fs.rmSync(assignmentFiles.absFromStoredRel(caio.versions[0].files[0].storedRel));
    await grade(task, { studentEmail: ANA, grade: '8,5', action: 'salvar' });

    const res = await zipBuffer(get('prof', `/api/admin/assignments/${task.id}/export`));
    assert.equal(res.status, 200, String(res.body));
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.match(res.headers['content-disposition'], /^attachment; filename="Entregas - Relatorio rede LAN - 1DES.zip"; filename\*=UTF-8''Entregas%20-%20Relat%C3%B3rio%20rede%20LAN%20-%201DES.zip$/);
    const zip = new AdmZip(res.body);
    const names = zip.getEntries().map(entry => entry.entryName).sort();
    assert.deepEqual(names, [
        'Ana Lima - 2026-001/v2_link.txt',
        'Ana Lima - 2026-001/v2_relatório (2).pdf',
        'Ana Lima - 2026-001/v2_relatório.pdf',
        'Ana Lima - 2026-001/v2_resposta.txt',
        'Caio Dias',
        '=HYPERLINK( x ) - 2026-002/v1_CON.txt',
        'lista.csv',
    ].filter(name => name !== 'Caio Dias').sort());
    assert.equal(zip.readAsText('Ana Lima - 2026-001/v2_resposta.txt'), 'Minha resposta\r\nem duas linhas');
    const csv = zip.readFile('lista.csv').toString('utf8');
    assert.equal(csv.charCodeAt(0), 0xfeff, 'BOM para o Excel');
    const lines = csv.slice(1).split('\r\n');
    assert.match(lines[0], /^Aluno;Matrícula;E-mail;Situação;/);
    const anaLine = lines.find(line => line.startsWith('Ana Lima'));
    assert.match(anaLine, /;Corrigida \(não devolvida\);2;v2;/);
    assert.match(anaLine, /;8,5;0;8,5;/);
    assert.ok(lines.some(line => line.startsWith('"\'=HYPERLINK(""x"")"')), 'nome que começa com = sai neutralizado');
    const caioLine = lines.find(line => line.startsWith('Caio: Dias?'));
    assert.match(caioLine, /v1_foto\.png/, 'arquivo que sumiu aparece em "Arquivos que faltam"');
    // Todos os arquivos dele sumiram: a pasta não existe no ZIP, então a coluna fica vazia.
    assert.equal(caioLine.split(';')[lines[0].split(';').indexOf('Pasta no ZIP')], '');
    assert.ok(anaLine.includes(';Ana Lima - 2026-001;'));
    const entry = audits('assignment_files_exported')[0];
    assert.deepEqual([entry.category, entry.details.versoes, entry.details.arquivos, entry.details.faltando, entry.details.alunos], ['assignment', 'ultima', 3, 1, 3]);

    const all = await zipBuffer(get('prof', `/api/admin/assignments/${task.id}/export?versoes=todas`));
    const allNames = new AdmZip(all.body).getEntries().map(item => item.entryName);
    assert.ok(allNames.includes('Ana Lima - 2026-001/v1_relatório.pdf'));
    assert.equal((await get('prof', `/api/admin/assignments/${task.id}/export?versoes=algumas`)).status, 400);
    assert.equal((await get('prof2', `/api/admin/assignments/${task.id}/export`)).status, 403);
    assert.equal(ana.versions.length, 2, 'o ZIP não muda a entrega');
});

test('nomes do ZIP: reservados do Windows, caracteres proibidos, ponto no fim e repetidos', () => {
    assert.equal(assignmentExport.safeZipSegment('CON', 'x'), '_CON');
    assert.equal(assignmentExport.safeZipSegment('lpt1.txt', 'x', 120), '_lpt1.txt');
    assert.equal(assignmentExport.safeZipSegment('a<b>c:"d"/e\\f|g?h*', 'x'), 'a b c d e f g h');
    assert.equal(assignmentExport.safeZipSegment('fim. . ', 'x'), 'fim');
    assert.equal(assignmentExport.safeZipSegment('   ', 'Aluno'), 'Aluno');
    const used = new Set();
    assert.deepEqual(['Ana', 'ana', 'Ana'].map(name => assignmentExport.uniqueName(name, used)), ['Ana', 'ana (2)', 'Ana (3)']);
    const long = assignmentExport.safeZipSegment(`${'a'.repeat(200)}.pdf`, 'x', 120);
    assert.equal(long.length, 120);
    assert.ok(long.endsWith('.pdf'));
});

test('tarefa arquivada ou rascunho não recebe correção; coordenação não grava; turma encerrada 409 class_closed', async () => {
    const draft = addTask({ status: 'rascunho' });
    assert.equal((await grade(draft, { studentEmail: ANA, grade: '0', action: 'salvar' })).body.code, 'assignment_not_published');
    const task = addTask();
    addSubmission(task, ANA);
    const coord = await grade(task, { studentEmail: ANA, grade: '5', action: 'salvar' }, 'coord');
    assert.equal(coord.status, 403);
    assert.equal(coord.body.code, 'read_only_account');

    const restore = patchClassClosed();
    try {
        const tomorrow = new Date(Date.now() + DAY + 3 * HOUR).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
        const calls = [
            grade(task, { studentEmail: ANA, grade: '5', action: 'salvar' }),
            grade(task, { studentEmail: ANA, action: 'refazer', comment: 'x', redoDueDate: tomorrow }),
            post('prof', `/api/admin/assignments/${task.id}/return-all`, {}),
            post('prof', `/api/admin/assignments/${task.id}/manual-entry`, { studentEmail: BIA, note: 'impresso' }),
            post('prof', `/api/admin/assignments/${task.id}/extension`, { studentEmail: BIA, dueDate: tomorrow, reason: 'Atestado' }),
        ];
        for (const res of await Promise.all(calls)) {
            assert.equal(res.status, 409, JSON.stringify(res.body));
            assert.equal(res.body.code, 'class_closed');
            assert.match(res.body.error, /turma foi encerrada/);
        }
    } finally {
        restore();
    }
    assert.equal(subOf(task, ANA).grade, null);
    assert.equal(assignments.findSubmission(db.memory, task.id, BIA), null);
    assert.equal((db.memory.auditLogs || []).length, 0);

    db.memory.assignments.find(item => item.id === task.id).status = 'arquivada';
    const archived = await grade(task, { studentEmail: ANA, grade: '5', action: 'salvar' });
    assert.equal(archived.status, 409);
    assert.equal(archived.body.code, 'assignment_archived');
});

// ------------------------------------------------------------ C6, ajuste 1
// A trava por aluno e tarefa é a mesma do envio do aluno (utils/submissionLocks.js). Antes,
// o professor que devolvia enquanto a versão nova do aluno esperava o disco
// (commitReceivedFiles) trocava o objeto da linha; o envio, ao terminar, acrescentava a
// linha velha de novo: duas linhas com o mesmo id e, no disco, só a do aluno (a nota
// devolvida sumia). A prorrogação de quem ainda não tinha entrega criava uma segunda linha.
const submissionLocks = require('../../backend/utils/submissionLocks.js');

// Segura o envio do aluno no meio da gravação (depois do aceite, antes de mover os
// arquivos), roda a chamada do professor, que precisa esperar a vez, e solta o envio.
async function raceWithStudentCommit(task, email, teacherCall, { duringGate } = {}) {
    const original = assignmentFiles.commitReceivedFiles;
    let reached;
    const atGate = new Promise(resolve => { reached = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    assignmentFiles.commitReceivedFiles = async (...args) => { reached(); await gate; return original(...args); };
    let student = null;
    try {
        student = asStudent(email, request(app).post(`/api/student/assignments/${task.id}/submit?${Q}`)).attach('files', PDF, 'versao-nova.pdf').then(res => res);
        await atGate;
        if (duringGate) duringGate();
        const teacher = teacherCall ? teacherCall().then(res => res) : null;
        if (teacher) {
            // O pedido do professor chega à trava e espera (nada mudou ainda).
            const limit = Date.now() + 5000;
            while (submissionLocks.queuedLocks() < 1 && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 5));
            assert.ok(submissionLocks.queuedLocks() >= 1, 'o pedido do professor não chegou à trava');
        }
        release();
        return { student: await student, teacher: teacher ? await teacher : null };
    } finally {
        // Falhou no meio: solta o envio para o teste não ficar esperando.
        release();
        assignmentFiles.commitReceivedFiles = original;
        if (student) await student.catch(() => null);
    }
}

const rowsFor = (task, email) => db.memory.assignmentSubmissions.filter(row => row.assignmentId === task.id && row.studentEmail === email);

function diskSubmissions() {
    const sqlite3 = require('sqlite3');
    return new Promise((resolve, reject) => {
        const handle = new sqlite3.Database(path.join(tempRoot, 'database.db'), sqlite3.OPEN_READONLY);
        handle.all('SELECT value FROM assignment_submissions', (err, rows) => {
            handle.close();
            if (err) reject(err); else resolve(rows.map(row => JSON.parse(row.value)));
        });
    });
}

test('corrida: devolver enquanto a versão nova do aluno é gravada deixa uma linha só, com a versão e a nota (também no disco)', async () => {
    const task = addTask({ latePolicy: { mode: 'aceitar', penaltyPerDayPct: 0, penaltyMaxPct: 0 } });
    addSubmission(task, ANA);
    const out = await raceWithStudentCommit(task, ANA, () => grade(task, { studentEmail: ANA, grade: '8', action: 'devolver' }));
    assert.equal(out.student.status, 201, JSON.stringify(out.student.body));
    assert.equal(out.teacher.status, 200, JSON.stringify(out.teacher.body));
    const rows = rowsFor(task, ANA);
    assert.equal(rows.length, 1, 'uma linha só por aluno e tarefa');
    const sub = assignments.normalizeSubmission(rows[0]);
    // O professor corrigiu depois que a versão 2 entrou: a nota vale para ela.
    assert.deepEqual([sub.versions.length, sub.status, sub.grade.finalScore, sub.grade.versionGraded], [2, 'devolvida', 80, 2]);
    assert.equal(audits('assignment_grade_returned')[0].newValue, '8,0');
    await db.save();
    const disk = (await diskSubmissions()).filter(row => row.assignmentId === task.id);
    assert.equal(disk.length, 1);
    assert.deepEqual([disk[0].status, disk[0].versions.length, disk[0].grade && disk[0].grade.finalScore], ['devolvida', 2, 80]);
    assert.equal(submissionLocks.pendingLocks(), 0);
});

test('corrida: prorrogar o prazo de quem ainda está enviando a primeira versão não cria outra entrega', async () => {
    const task = addTask();
    const later = new Date(Date.now() + 5 * DAY).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const out = await raceWithStudentCommit(task, ANA, () => post('prof', `/api/admin/assignments/${task.id}/extension`, { studentEmail: ANA, dueDate: later, reason: 'Atestado médico' }));
    assert.equal(out.student.status, 201, JSON.stringify(out.student.body));
    assert.equal(out.teacher.status, 200, JSON.stringify(out.teacher.body));
    const rows = rowsFor(task, ANA);
    assert.equal(rows.length, 1, 'uma linha só por aluno e tarefa');
    const sub = assignments.normalizeSubmission(rows[0]);
    assert.equal(sub.versions.length, 1);
    assert.ok(sub.extension && sub.extension.reason === 'Atestado médico');
    assert.equal(audits('assignment_extension_granted')[0].submissionId, sub.id);
    assert.equal(audits('assignment_submitted')[0].submissionId, sub.id);
});

test('corrida: "devolver todas" enquanto chega a versão nova deixa essa entrega de fora, sem perder a versão nem a nota', async () => {
    const task = addTask({ latePolicy: { mode: 'aceitar', penaltyPerDayPct: 0, penaltyMaxPct: 0 } });
    addSubmission(task, ANA);
    addSubmission(task, BIA);
    await grade(task, { studentEmail: ANA, grade: '7', action: 'salvar' });
    await grade(task, { studentEmail: BIA, grade: '6', action: 'salvar' });
    const out = await raceWithStudentCommit(task, ANA, () => post('prof', `/api/admin/assignments/${task.id}/return-all`, {}));
    assert.equal(out.student.status, 201, JSON.stringify(out.student.body));
    assert.equal(out.teacher.status, 200, JSON.stringify(out.teacher.body));
    assert.deepEqual([out.teacher.body.returned, out.teacher.body.newVersionPending], [1, 1]);
    const ana = rowsFor(task, ANA);
    assert.equal(ana.length, 1);
    const sub = assignments.normalizeSubmission(ana[0]);
    assert.deepEqual([sub.versions.length, sub.status, sub.returnedAt, sub.grade.finalScore], [2, 'corrigida', null, 70]);
    assert.equal(assignments.needsGrading(sub), true);
    assert.equal(subOf(task, BIA).status, 'devolvida');
    assert.equal(audits('assignment_grade_returned').length, 1);
});

test('envio do aluno: entrega que mudou fora da trava durante a gravação não é sobrescrita (409 submission_changed) e o arquivo não fica em entregas', async () => {
    const task = addTask();
    const original = addSubmission(task, ANA);
    let replaced = null;
    const out = await raceWithStudentCommit(task, ANA, null, {
        // Como uma restauração de backup no meio do envio: a linha vira outro objeto.
        duringGate: () => {
            const rows = db.memory.assignmentSubmissions;
            replaced = { ...rows[rows.indexOf(original)], note: 'restaurada' };
            rows[rows.indexOf(original)] = replaced;
        },
    });
    assert.equal(out.student.status, 409, JSON.stringify(out.student.body));
    assert.deepEqual([out.student.body.code, out.student.body.retryable], ['submission_changed', true]);
    assert.match(out.student.body.error, /envie de novo/);
    const rows = rowsFor(task, ANA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0], replaced);
    assert.equal(assignments.normalizeSubmission(rows[0]).versions.length, 1);
    const folder = path.join(runtimePaths.ASSIGNMENT_FILES_DIR, task.id, original.id);
    assert.equal(fs.readdirSync(folder).length, 1, 'o arquivo da versão recusada foi para a lixeira');
    assert.equal(audits('assignment_submitted').length, 0);
});

test('entrega em mãos com nota numa entrega que tem versão atrasada: o desconto da versão vale, como na correção; dispensar fica gravado', async () => {
    const task = addTask();
    addSubmission(task, ANA, [{ lateMs: 3 * DAY - 1000 }]);
    const url = `/api/admin/assignments/${task.id}/manual-entry`;
    const res = await post('prof', url, { studentEmail: ANA, note: 'Trouxe impresso também.', grade: '8' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let sub = subOf(task, ANA);
    assert.deepEqual([sub.grade.score, sub.grade.penaltyPct, sub.grade.finalScore, sub.grade.versionGraded, sub.grade.penaltyWaived], [80, 30, 56, 1, false]);
    // A mesma nota pela correção dá o mesmo resultado.
    const viaGrade = assignments.gradeWithPenalty(assignments.normalizeAssignment(task), sub, { score: 80 });
    assert.equal(viaGrade.finalScore, sub.grade.finalScore);
    const waived = await post('prof', url, { studentEmail: ANA, grade: '8', waivePenalty: true });
    assert.equal(waived.status, 200, JSON.stringify(waived.body));
    sub = subOf(task, ANA);
    assert.deepEqual([sub.grade.penaltyPct, sub.grade.finalScore, sub.grade.penaltyWaived], [0, 80, true]);
    const entry = audits('assignment_grade_saved').pop();
    assert.deepEqual([entry.oldValue, entry.newValue, entry.details.penaltyWaived, entry.details.entregaEmMaos], ['5,6', '8,0', true, true]);
});

test('entrega devolvida em que só o comentário muda: a auditoria mostra o comentário e o sino diz "Comentário da tarefa alterado"', async () => {
    const task = addTask();
    addSubmission(task, ANA);
    assert.equal((await grade(task, { studentEmail: ANA, grade: '5', comment: 'Faltou a conclusão.', action: 'devolver' })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 5));
    // Mudar o que o aluno já viu (mesmo só o comentário) pede motivo.
    const noReason = await grade(task, { studentEmail: ANA, comment: 'Faltou a conclusão e as referências.', action: 'salvar' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'reason_required');
    const changed = await grade(task, { studentEmail: ANA, comment: 'Faltou a conclusão e as referências.', action: 'salvar', reason: 'Ajuste no comentário' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    let entry = audits('assignment_grade_changed').pop();
    assert.deepEqual([entry.field, entry.oldValue, entry.newValue, entry.details.somenteComentario], ['Comentário da tarefa', 'Faltou a conclusão.', 'Faltou a conclusão e as referências.', true]);
    assert.equal(subOf(task, ANA).grade.finalScore, 50);
    let bell = await asStudent(ANA, request(app).get(`/api/student/notifications?${Q}`));
    assert.equal(bell.body.items.find(item => item.id === `tarefa:${task.id}:devolvida`).title, 'Comentário da tarefa alterado');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await grade(task, { studentEmail: ANA, grade: '6', action: 'salvar', reason: 'Revisão em sala' })).status, 200);
    entry = audits('assignment_grade_changed').pop();
    assert.deepEqual([entry.field, entry.oldValue, entry.newValue, entry.details.somenteComentario], ['Nota da tarefa', '5,0', '6,0', false]);
    bell = await asStudent(ANA, request(app).get(`/api/student/notifications?${Q}`));
    assert.equal(bell.body.items.find(item => item.id === `tarefa:${task.id}:devolvida`).title, 'Nota da tarefa alterada');
});
