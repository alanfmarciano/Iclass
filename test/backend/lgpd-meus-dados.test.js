// "Meus dados" e a exportação do administrador (H8c reduzido; SEG-14, art. 18 da LGPD).
// Antes: GET /api/student/my-data respondia 404 e a única cópia de dados pessoais era o
// backup inteiro, com todos os alunos. Agora:
// 1) o aluno baixa a cópia dos próprios dados (meus-dados-AAAA-MM-DD.json): o que é dele
//    e o que ele já pode ver no portal, sem senha, sessão, nota não publicada, gabarito
//    não liberado, conteúdo da prova, observação que não é 'Compartilhada', texto
//    restrito de acessibilidade, quem da equipe fez cada coisa nem dado de outro aluno;
//    no máximo 5 cópias por hora; cada cópia vai para a auditoria (lgpd_export);
// 2) o administrador exporta tudo de um aluno pela ficha (GET
//    /api/admin/lgpd/students/export?email=), com lgpd_export na auditoria; o professor
//    recebe 403;
// 3) o dono de cada registro segue os e-mails que o aluno já usou (studentEmailOwnership),
//    como a anonimização: o login com o e-mail antigo é dele; o do novo dono daquele
//    e-mail, não.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-lgpd-meus-dados-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// Módulos antes do servidor (ver lgpd-documentos.test.js).
const exporter = require('../../backend/utils/studentDataExport.js');
const rateLimit = require('../../backend/utils/rateLimit.js');
const birth = require('../../backend/utils/birthDate.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');

const ADMIN = 'adm@meusdados.local';
const PROF = 'prof@meusdados.local';
const ANA = 'ana@meusdados.local';
const ANA_OLD = 'ana.antiga@meusdados.local';
const BIA = 'bia@meusdados.local';
const DAY = 86400000;
const NOW = Date.now();
let app;

const adminHeaders = (email = ADMIN) => ({ 'x-admin-session': createAdminSession(db.memory, email) });
const studentHeaders = email => ({ 'x-session-token': createStudentSession(db.memory, email) });
const auditOf = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);

function keyRow(email, serverTs, extra = {}) {
    return {
        id: `k_${email}_${serverTs}_${Math.random().toString(36).slice(2, 8)}`,
        studentEmail: email, studentClass: '1DES', courseId: 'DES', examKey: 'Prova_1', applicationId: 'app_1',
        attemptId: null, seq: 1, clientTs: serverTs, serverTs, key: 'c', code: 'KeyC', mods: 'Ctrl', kind: 'shortcut',
        question: null, blocked: false, suspicious: true, ...extra,
    };
}

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: ADMIN, name: 'Administração', role: 'admin', password: db.hashPassword('Painel-Seguro-2026') },
        { email: PROF, name: 'Professora Paula', role: 'professor', password: db.hashPassword('Painel-Seguro-2026'), assignedClasses: [{ courseId: 'DES', className: '1DES' }] },
    ];
    db.memory.schools = [{ id: 'escola_a', name: 'Escola Alfa', info: { dpoName: 'Encarregada Lia', dpoEmail: 'dpo@escola.local' }, branding: {} }];
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento', schoolId: 'escola_a' }];
    db.memory.classes = [{ name: '1DES', courseId: 'DES', status: 'active', releasedItems: {} }];
    db.memory.students = [
        {
            name: 'Ana Souza', email: ANA, status: 'Ativo', matricula: '2026-001', password: db.hashPassword('Caderno-Azul-7'),
            phone: '11 98888-0000', birthDate: '2001-04-10',
            classes: [{ name: '1DES', courseId: 'DES' }], studentClass: '1DES', period: 'Manhã',
            guardian: { name: 'Rita Souza', phone: '11 97777-0000', email: '', parentesco: 'Mãe', observacao: '' },
            accessibility: { fonteAmpliada: true, tempoAdicional: true, tempoAdicionalPercent: 50, observacao: 'Laudo de TDAH, CID F90.' },
            termsAcceptance: { documentId: 'modelo-2026.1:termos', version: null, at: NOW - 40 * DAY, ip: '10.0.0.5', device: 'Chrome' },
            legalAcceptances: [{ kind: 'termos', version: '1.0', at: NOW - 400 * DAY, replacedAt: NOW - 40 * DAY }],
            enrollmentRequests: [{ id: 'req_1', courseId: 'DES', className: '1DES', status: 'approved', reviewedBy: ADMIN, createdAt: NOW - 50 * DAY }],
            statusChangedBy: PROF,
            sessionsInvalidBefore: NOW - DAY,
        },
        // Bia ganhou o e-mail que a Ana largou: o que ela fez com ele não é da Ana.
        { name: 'Bia Lima', email: ANA_OLD, status: 'Ativo', password: db.hashPassword('Caderno-Verde-8'), classes: [{ name: '1DES', courseId: 'DES' }], createdAt: NOW - 10 * DAY },
        { name: 'Bruno Outro', email: BIA, status: 'Ativo', password: db.hashPassword('Caderno-Roxo-9'), classes: [{ name: '1DES', courseId: 'DES' }] },
    ];
    db.memory.submissions = [
        { id: 'sub_pub', student: { name: 'Ana Souza', email: ANA, studentClass: '1DES', courseId: 'DES' }, examKey: 'Prova_1', score: 80, correctCount: 4, totalCount: 5,
            gradedAnswers: [{ questionNumber: 1, studentChoice: 'A', correctAnswer: 'B', isCorrect: false }], gradePublished: true, gradePublishedBy: PROF,
            examSnapshot: { questions: [{ number: 1, text: 'Enunciado secreto', alternatives: [] }] }, scoreHistory: [{ score: 70, by: PROF }], timestamp: new Date(NOW - 20 * DAY).toISOString() },
        { id: 'sub_rev', student: { name: 'Ana Souza', email: ANA, studentClass: '1DES', courseId: 'DES' }, examKey: 'Prova_2', score: 55, correctCount: 2, totalCount: 5,
            gradedAnswers: [{ questionNumber: 1, studentChoice: 'C', correctAnswer: 'C', isCorrect: true }], gradePublished: false, timestamp: new Date(NOW - 2 * DAY).toISOString() },
        { id: 'sub_bruno', student: { name: 'Bruno Outro', email: BIA, studentClass: '1DES', courseId: 'DES' }, examKey: 'Prova_1', score: 90, gradePublished: true },
    ];
    db.memory.attendance = [
        { id: 'att_1', studentEmail: ANA, studentClass: '1DES', courseId: 'DES', date: '2026-10-01', origin: 'chamada', aulas: [{ status: 'presente' }], markedBy: PROF, timestamp: NOW - 30 * DAY },
        { id: 'att_bruno', studentEmail: BIA, studentClass: '1DES', courseId: 'DES', date: '2026-10-01', origin: 'chamada', aulas: [{ status: 'falta' }], markedBy: PROF, timestamp: NOW - 30 * DAY },
    ];
    db.memory.certificates = [{ id: 'cert_1', studentEmail: ANA, courseId: 'DES', code: 'CERT-1', status: 'Emitido', issuedAt: NOW - 5 * DAY, issuedBy: PROF }];
    db.memory.pedagogicalObservations = [
        { id: 'obs_shared', studentEmail: ANA, author: PROF, category: 'Participação', visibility: 'Compartilhada', text: 'Participa bem das aulas.', timestamp: NOW - 9 * DAY },
        { id: 'obs_team', studentEmail: ANA, author: PROF, category: 'Participação', visibility: 'Equipe pedagógica', text: 'Conversar com a família.', timestamp: NOW - 8 * DAY },
        { id: 'obs_restricted', studentEmail: ANA, author: ADMIN, category: 'Observação geral', visibility: 'Restrita (coordenação)', text: 'Situação familiar delicada.', timestamp: NOW - 7 * DAY },
        { id: 'obs_health', studentEmail: ANA, author: PROF, category: 'Acessibilidade pedagógica', visibility: 'Compartilhada', text: 'Diagnóstico informado pela família.', timestamp: NOW - 6 * DAY },
        { id: 'obs_bruno', studentEmail: BIA, author: PROF, category: 'Participação', visibility: 'Compartilhada', text: 'Bruno muito bem.', timestamp: NOW - 6 * DAY },
    ];
    db.memory.progress = { [ANA]: { Apostila_1: true }, [BIA]: { Apostila_9: true } };
    db.memory.notes = { [ANA]: { FUTEC: 'Minhas anotações.' } };
    db.memory.annotations = { [ANA]: { Apostila_1: [{ text: 'grifo' }] } };
    db.memory.forum = [
        { id: 'f_ana', key: 'Apostila_1', studentName: 'Ana Souza', studentEmail: ANA, text: 'Minha dúvida', timestamp: new Date(NOW - 3 * DAY).toISOString(), status: 'respondida',
            replies: [
                { id: 'r_prof', authorName: 'Professora Paula', authorEmail: PROF, authorRole: 'Instrutor', text: 'Resposta da professora', timestamp: new Date(NOW - 2 * DAY).toISOString() },
                { id: 'r_bruno', authorName: 'Bruno Outro', authorEmail: BIA, authorRole: 'Aluno', text: 'Palpite do Bruno', timestamp: new Date(NOW - 2 * DAY).toISOString() },
            ],
            events: [{ at: NOW - 2 * DAY, by: PROF, byName: 'Professora Paula', type: 'answered' }] },
        { id: 'f_bruno', key: 'Apostila_2', studentName: 'Bruno Outro', studentEmail: BIA, text: 'Dúvida do Bruno', timestamp: new Date(NOW - 3 * DAY).toISOString(),
            replies: [{ id: 'r_ana', authorName: 'Ana Souza', authorEmail: ANA, authorRole: 'Aluno', text: 'Minha resposta ao Bruno', timestamp: new Date(NOW - DAY).toISOString() }] },
    ];
    db.memory.moduleAccess = [{ id: 'acc_1', studentEmail: ANA, key: 'Apostila_1', courseId: 'DES', timestamp: NOW - DAY }];
    db.memory.loginLogs = [
        { id: 'login_new', email: ANA, role: 'student', status: 'success', timestamp: NOW - DAY, ip: '10.0.0.5', browser: 'Chrome' },
        // Login com o e-mail antigo, antes da troca (é da Ana) e depois, já da Bia (não é).
        { id: 'login_old_ana', email: ANA_OLD, role: 'student', status: 'success', timestamp: NOW - 100 * DAY, ip: '10.0.0.6' },
        { id: 'login_old_bia', email: ANA_OLD, role: 'student', status: 'success', timestamp: NOW - 2 * DAY, ip: '10.0.0.7' },
        { id: 'login_prof', email: PROF, role: 'professor', status: 'success', timestamp: NOW - DAY, ip: '10.0.0.1' },
    ];
    db.memory.proctoringLogs = [{ id: 'pl_1', studentEmail: ANA, examKey: 'Prova_1', type: 'tab_blur', timestamp: NOW - 20 * DAY, unlockedBy: PROF }];
    db.memory.broadcastMessages = [
        { id: 'msg_ana', studentClass: '1DES', courseId: 'DES', examKey: 'Prova_1', targetEmail: ANA, messageText: 'Ana, confira a questão 2.', senderEmail: PROF, acknowledgedBy: [ANA, BIA], deletedFor: [BIA], timestamp: NOW - 20 * DAY },
        { id: 'msg_all', studentClass: '1DES', courseId: 'DES', examKey: 'Prova_1', targetEmail: null, messageText: 'Para todos.', senderEmail: PROF, timestamp: NOW - 20 * DAY },
    ];
    db.memory.examApplications = [{
        id: 'app_1', examKey: 'Prova_1', studentClass: '1DES', courseId: 'DES', status: 'finished', keystrokeMode: 'eventos',
        questionReports: [
            { id: 'rep_ana', studentEmail: ANA, studentName: 'Ana Souza', questionNumber: 2, text: 'A questão 2 tem duas certas.', reviewedBy: PROF, createdAt: NOW - 20 * DAY },
            { id: 'rep_bruno', studentEmail: BIA, studentName: 'Bruno Outro', questionNumber: 3, text: 'Do Bruno', createdAt: NOW - 20 * DAY },
        ],
        studentAdjustments: { [ANA]: { extraMinutes: 10 }, [BIA]: { extraMinutes: 5 } },
        studentVersions: { [ANA]: 'B', [BIA]: 'A' },
    }];
    db.memory.studentExamState = {};
    db.memory.auditLogs = [
        // Troca de e-mail registrada (ana.antiga@ → ana@) há 50 dias.
        { id: 'aud_email', action: 'update', category: 'student', actor: ADMIN, ip: '10.0.0.1', device: 'Firefox', studentEmail: ANA, field: 'E-mail/login', oldValue: ANA_OLD, newValue: ANA, timestamp: NOW - 50 * DAY },
        { id: 'aud_phone', action: 'update', category: 'student', actor: PROF, ip: '10.0.0.2', device: 'Edge', studentEmail: ANA, field: 'Telefone', oldValue: '', newValue: '11 98888-0000', timestamp: NOW - 45 * DAY },
        { id: 'aud_bruno', action: 'update', category: 'student', actor: PROF, studentEmail: BIA, field: 'Telefone', oldValue: '', newValue: '1', timestamp: NOW - 45 * DAY },
        { id: 'aud_grade', action: 'grade_publish', category: 'grade', actor: PROF, studentEmail: ANA, examKey: 'Prova_1', timestamp: NOW - 19 * DAY },
    ];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    rateLimit.resetForTests();
}

async function seedKeystrokes() {
    await db.keystrokes.deleteWhere({ before: NOW + 365 * DAY });
    await db.keystrokes.append([keyRow(ANA, NOW - 20 * DAY), keyRow(BIA, NOW - 20 * DAY)]);
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(async () => { seed(); await seedKeystrokes(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-LGPD-010] aluno baixa os próprios dados como anexo, sem senha, sessão nem dado de outro aluno', async () => {
    const headers = studentHeaders(ANA);
    const res = await request(app).get('/api/student/my-data').set(headers);
    assert.equal(res.status, 200, res.body.error);
    assert.match(res.headers['content-disposition'], new RegExp(`attachment; filename="meus-dados-${birth.todayIso()}\\.json"`));
    const data = res.body;
    assert.equal(data.type, 'iclass-dados-pessoais');
    assert.equal(data.audience, 'aluno');
    assert.equal(data.formatVersion, 1);
    assert.equal(data.institution.name, 'Escola Alfa');
    assert.equal(data.institution.dpo.email, 'dpo@escola.local');
    const text = JSON.stringify(data);
    // Nada de senha, hash nem sessão.
    assert.equal(data.profile.password, undefined);
    assert.equal(data.profile.sessionsInvalidBefore, undefined);
    assert.equal(text.includes('scrypt'), false);
    assert.equal(text.includes(headers['x-session-token']), false);
    // Nada de outro aluno, nem de quem da equipe fez.
    for (const foreign of [BIA, 'Bruno Outro', 'Palpite do Bruno', 'Do Bruno', 'Bruno muito bem', ADMIN, PROF, 'Professora Paula', '10.0.0.7', '10.0.0.1', '10.0.0.2']) {
        assert.equal(text.includes(foreign), false, `a cópia do aluno não pode trazer "${foreign}"`);
    }
    // Perfil: acomodação sim, laudo não.
    assert.equal(data.profile.name, 'Ana Souza');
    assert.equal(data.profile.birthDate, '2001-04-10');
    assert.equal(data.profile.accessibility.tempoAdicionalPercent, 50);
    assert.equal(data.profile.accessibility.observacao, undefined);
    assert.equal(data.profile.accessibilityNoteRestricted, true);
    assert.equal(text.includes('CID F90'), false);
    assert.equal(data.profile.guardian.name, 'Rita Souza');
    // Matrículas e aceites em seção própria.
    assert.deepEqual(data.enrollments.classes, [{ className: '1DES', courseId: 'DES', courseName: 'Desenvolvimento' }]);
    assert.equal(data.enrollments.requests[0].reviewedBy, undefined);
    assert.equal(data.acceptances.terms.documentId, 'modelo-2026.1:termos');
    assert.equal(data.acceptances.terms.ip, '10.0.0.5', 'o IP do próprio aceite é dado dele');
    assert.equal(data.acceptances.previous[0].version, '1.0');
});

test('[UC-LGPD-010] na cópia do aluno: nota só publicada, sem gabarito nem prova, observação só compartilhada', async () => {
    const res = await request(app).get('/api/student/my-data').set(studentHeaders(ANA));
    assert.equal(res.status, 200, res.body.error);
    const data = res.body;
    const byId = Object.fromEntries(data.submissions.map(item => [item.id, item]));
    assert.deepEqual(Object.keys(byId).sort(), ['sub_pub', 'sub_rev']);
    assert.equal(byId.sub_pub.score, 80);
    assert.equal(byId.sub_pub.answerKeyReleased, false);
    assert.equal(byId.sub_pub.gradedAnswers[0].correctAnswer, undefined, 'gabarito não liberado');
    assert.equal(byId.sub_pub.scoreHistory, undefined);
    assert.equal(byId.sub_pub.examSnapshot, undefined);
    assert.equal(byId.sub_rev.score, undefined, 'nota não publicada fica de fora');
    assert.equal(byId.sub_rev.resultStatus, 'em_revisao');
    assert.equal(JSON.stringify(data).includes('Enunciado secreto'), false);
    assert.deepEqual(data.observations.map(item => item.id), ['obs_shared']);
    assert.equal(data.observations[0].author, undefined);
    // Presença, certificados, caderno, progresso e acessos dele.
    assert.deepEqual(data.attendance.map(item => item.id), ['att_1']);
    assert.equal(data.attendance[0].markedBy, undefined);
    assert.deepEqual(data.certificates.map(item => item.code), ['CERT-1']);
    assert.deepEqual(data.progress, { [ANA]: { Apostila_1: true } });
    assert.equal(data.notes[ANA].FUTEC, 'Minhas anotações.');
    assert.equal(data.moduleAccess.length, 1);
    // Fórum: a dúvida dele com a resposta da equipe (sem nome), a de outro aluno sem texto,
    // e a resposta dele na dúvida do outro.
    assert.equal(data.forum.questions.length, 1);
    assert.deepEqual(data.forum.questions[0].replies.map(reply => reply.from || 'eu'), ['Equipe', 'Outro aluno']);
    assert.equal(data.forum.questions[0].replies[0].text, 'Resposta da professora');
    assert.equal(data.forum.questions[0].events, undefined);
    assert.deepEqual(data.forum.replies.map(reply => reply.text), ['Minha resposta ao Bruno']);
    // Prova: foco, teclas, mensagem só para ele, contestação, tempo extra e versão.
    assert.equal(data.proctoring.focusEvents.length, 1);
    assert.equal(data.proctoring.focusEvents[0].unlockedBy, undefined);
    assert.deepEqual(data.proctoring.keystrokes.map(row => row.studentEmail), [ANA]);
    assert.deepEqual(data.examMessages.map(item => item.id), ['msg_ana']);
    assert.equal(data.examMessages[0].acknowledgedBy, undefined);
    assert.equal(data.examMessages[0].acknowledged, true);
    assert.equal(data.examMessages[0].deletedByStudent, false);
    assert.equal(data.examRecords.length, 1);
    assert.deepEqual(data.examRecords[0].questionReports.map(item => item.id), ['rep_ana']);
    assert.deepEqual(data.examRecords[0].adjustment, { extraMinutes: 10 });
    assert.equal(data.examRecords[0].assignedVersion, 'B');
    assert.equal(data.examRecords[0].keystrokeModeLabel, 'Só atalhos suspeitos');
    // Histórico do cadastro: o quê e quando, sem quem, IP nem aparelho.
    assert.deepEqual(data.profileHistory.map(item => item.field), ['E-mail/login', 'Telefone']);
    assert.deepEqual(Object.keys(data.profileHistory[1]).sort(), ['field', 'label', 'newValue', 'oldValue', 'timestamp']);
    assert.equal(data.audit, undefined);
    assert.equal(data.openAttempts, undefined);
    assert.equal(data.counts.submissions, 2);
    assert.equal(data.counts.keystrokes, 1);
});

test('[UC-LGPD-010] o login com o e-mail antigo é do aluno; o do novo dono daquele e-mail, não', async () => {
    const res = await request(app).get('/api/student/my-data').set(studentHeaders(ANA));
    assert.equal(res.status, 200, res.body.error);
    assert.deepEqual(res.body.loginLogs.map(item => item.id).sort(), ['login_new', 'login_old_ana']);
    // E a Bia, dona do e-mail agora, não leva o login de quando ele era da Ana.
    const bia = await request(app).get('/api/student/my-data').set(studentHeaders(ANA_OLD));
    assert.equal(bia.status, 200, bia.body.error);
    assert.deepEqual(bia.body.loginLogs.map(item => item.id), ['login_old_bia']);
    assert.equal(JSON.stringify(bia.body).includes('Ana Souza'), false);
});

test('[UC-LGPD-010] cada cópia vai para a auditoria, e são no máximo 5 por hora', async () => {
    const headers = studentHeaders(ANA);
    for (let i = 0; i < 5; i += 1) {
        const res = await request(app).get(`/api/student/my-data${i === 4 ? '?finalidade=imprimir' : ''}`).set(headers);
        assert.equal(res.status, 200, res.body.error);
    }
    const entries = auditOf('lgpd_export');
    assert.equal(entries.length, 5);
    assert.equal(entries[0].category, 'privacy');
    assert.equal(entries[0].actor, ANA);
    assert.equal(entries[0].actorRole, 'aluno');
    assert.equal(entries[0].studentEmail, ANA);
    assert.equal(entries[0].details.audience, 'aluno');
    assert.equal(entries[0].details.purpose, 'baixar');
    assert.equal(entries[4].details.purpose, 'imprimir');
    assert.equal(entries[0].details.counts.submissions, 2);
    const blocked = await request(app).get('/api/student/my-data').set(headers);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'my_data_rate_limited');
    assert.match(blocked.body.error, /^Você já baixou seus dados 5 vezes na última hora\. Tente de novo em \d+ minutos?\.$/);
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    assert.ok(blocked.body.retryAfterSeconds > 0);
    assert.equal(auditOf('lgpd_export').length, 5, 'a recusa não grava auditoria');
    // O limite é por aluno.
    const other = await request(app).get('/api/student/my-data').set(studentHeaders(BIA));
    assert.equal(other.status, 200);
});

test('[UC-LGPD-010] sem sessão de aluno nada sai (a recusa de sempre do validateStudentSession)', async () => {
    for (const headers of [{}, adminHeaders(), { 'x-session-token': 'token-inventado' }]) {
        const res = await request(app).get('/api/student/my-data').set(headers);
        assert.ok([400, 401, 403].includes(res.status), `status ${res.status}`);
        assert.equal(res.body.type, undefined);
    }
    // Com o e-mail na query de outro aluno e o token da Ana: 403, nunca os dados do outro.
    const other = await request(app).get(`/api/student/my-data?email=${BIA}`).set(studentHeaders(ANA));
    assert.equal(other.status, 403);
    assert.equal(auditOf('lgpd_export').length, 0);
});

test('[UC-LGPD-010] cadastro antigo (turma em texto, aceite 1.0, sem data de nascimento) também exporta', async () => {
    db.memory.students.push({ name: 'Caio Antigo', email: 'caio@meusdados.local', status: 'Ativo', password: db.hashPassword('Caderno-Azul-7'), studentClass: '1DES', termsAcceptance: { version: '1.0', at: NOW - 900 * DAY } });
    const res = await request(app).get('/api/student/my-data').set(studentHeaders('caio@meusdados.local'));
    assert.equal(res.status, 200, res.body.error);
    // A turma guardada só pelo nome acha o curso pela turma cadastrada com esse nome.
    assert.deepEqual(res.body.enrollments.classes, [{ className: '1DES', courseId: 'DES', courseName: 'Desenvolvimento' }]);
    assert.equal(res.body.acceptances.terms.version, '1.0');
    assert.equal(res.body.acceptances.privacy, null);
    assert.deepEqual(res.body.submissions, []);
    assert.deepEqual(res.body.forum, { questions: [], replies: [] });
});

test('[UC-LGPD-010] turma só pelo nome: sem curso quando o nome existe em mais de um curso', async () => {
    db.memory.courses.push({ id: 'ADM', name: 'Administração', schoolId: 'escola_a' });
    db.memory.classes.push({ name: '1DES', courseId: 'ADM', status: 'active', releasedItems: {} });
    db.memory.students.push({ name: 'Caio Antigo', email: 'caio@meusdados.local', status: 'Ativo', password: db.hashPassword('Caderno-Azul-7'), classes: ['1DES'] });
    const res = await request(app).get('/api/student/my-data').set(studentHeaders('caio@meusdados.local'));
    assert.equal(res.status, 200, res.body.error);
    assert.deepEqual(res.body.enrollments.classes, [{ className: '1DES', courseId: null, courseName: '' }]);
});

// Antes: o histórico do cadastro do aluno levava toda entrada da categoria 'student' com
// campo, inclusive "Observação pedagógica registrada" com a categoria da observação: a
// observação restrita sumia de observations, mas a data e a categoria apareciam ali.
test('[UC-LGPD-010] observação que não é Compartilhada não aparece nem pelo histórico do cadastro', async () => {
    const admin = adminHeaders();
    const restricted = await request(app).post('/api/admin/student/observations/create').set(admin)
        .send({ email: ANA, category: 'Acessibilidade pedagógica', text: 'Laudo novo entregue.' });
    assert.equal(restricted.status, 200, restricted.body.error);
    assert.equal(restricted.body.observation.visibility, 'Restrita (coordenação)');
    const team = await request(app).post('/api/admin/student/observations/create').set(admin)
        .send({ email: ANA, category: 'Frequência', visibility: 'Equipe pedagógica', text: 'Faltas seguidas.' });
    assert.equal(team.status, 200, team.body.error);
    const edited = await request(app).post('/api/admin/student/observations/update').set(admin)
        .send({ id: team.body.observation.id, text: 'Faltas seguidas na segunda.' });
    assert.equal(edited.status, 200, edited.body.error);
    const removed = await request(app).post('/api/admin/student/observations/delete').set(admin)
        .send({ id: 'obs_restricted' });
    assert.equal(removed.status, 200, removed.body.error);
    // Mudança do cadastro de verdade, para conferir que o histórico continua.
    db.memory.auditLogs.push({ id: 'aud_turma', action: 'update', category: 'student', actor: ADMIN, studentEmail: ANA, field: 'Turmas', oldValue: '', newValue: '1DES', timestamp: Date.now() });
    assert.ok(auditOf('observation_create').length >= 2 && auditOf('observation_update').length && auditOf('observation_delete').length);

    const res = await request(app).get('/api/student/my-data').set(studentHeaders(ANA));
    assert.equal(res.status, 200, res.body.error);
    const data = res.body;
    assert.deepEqual(data.observations.map(item => item.id), ['obs_shared']);
    assert.deepEqual(data.profileHistory.map(item => item.field), ['E-mail/login', 'Telefone', 'Turmas']);
    const text = JSON.stringify(data);
    for (const leak of ['Observação pedagógica', 'Acessibilidade pedagógica', 'Frequência', 'Observação geral', 'Laudo novo', 'Faltas seguidas']) {
        assert.equal(text.includes(leak), false, `a cópia do aluno não pode trazer "${leak}"`);
    }
    assert.equal(data.counts.profileHistory, 3);

    // O administrador continua vendo tudo (histórico e auditoria).
    const full = await request(app).get(`/api/admin/lgpd/students/export?email=${ANA}`).set(admin);
    assert.equal(full.status, 200, full.body.error);
    const fields = full.body.profileHistory.map(item => `${item.field}:${item.newValue}`);
    assert.ok(fields.includes('Observação pedagógica:Acessibilidade pedagógica'));
    assert.ok(fields.includes('Observação pedagógica:Frequência'));
    assert.ok(full.body.audit.some(entry => entry.action === 'observation_delete'));
});

test('[UC-LGPD-010] pedidos ao mesmo tempo não passam de 5 cópias por hora', async () => {
    const headers = studentHeaders(ANA);
    const results = await Promise.all(Array.from({ length: 10 }, () => request(app).get('/api/student/my-data').set(headers)));
    const statuses = results.map(res => res.status);
    assert.equal(statuses.filter(status => status === 200).length, 5, `status: ${statuses.join(', ')}`);
    assert.equal(statuses.filter(status => status === 429).length, 5);
    assert.equal(auditOf('lgpd_export').length, 5);
});

test('[UC-LGPD-010] cópia que não sai (falha ao montar) devolve a vez', async () => {
    const headers = studentHeaders(ANA);
    const saved = db.memory.examApplications;
    // Falha inesperada ao montar a cópia (depois da conferência do limite): 500, e a vez
    // volta para o aluno.
    Object.defineProperty(db.memory, 'examApplications', { configurable: true, enumerable: true, get() { throw new Error('falha simulada'); } });
    let failed;
    try {
        failed = await request(app).get('/api/student/my-data').set(headers);
    } finally {
        Object.defineProperty(db.memory, 'examApplications', { configurable: true, enumerable: true, writable: true, value: saved });
    }
    assert.equal(failed.status, 500);
    assert.equal(rateLimit.peek(`student-my-data:${ANA}`, { max: 5 }).count, 0);
    assert.equal(auditOf('lgpd_export').length, 0);
    const ok = await request(app).get('/api/student/my-data').set(headers);
    assert.equal(ok.status, 200, ok.body.error);
    assert.equal(rateLimit.peek(`student-my-data:${ANA}`, { max: 5 }).count, 1);
});

test('[UC-LGPD-011] administrador exporta tudo do aluno pela ficha, com lgpd_export na auditoria', async () => {
    db.memory.studentExamState = { 'app_1::ana@meusdados.local::Prova_1': { studentEmail: ANA, applicationId: 'app_1', status: 'active', answers: { 1: 'A' }, localCopyKey: 'segredo-da-copia' } };
    const res = await request(app).get(`/api/admin/lgpd/students/export?email=${encodeURIComponent(ANA.toUpperCase())}`).set(adminHeaders());
    assert.equal(res.status, 200, res.body.error);
    assert.match(res.headers['content-disposition'], new RegExp(`attachment; filename="dados-ana_meusdados\\.local-${birth.todayIso()}\\.json"`));
    const data = res.body;
    assert.equal(data.audience, 'admin');
    assert.equal(data.generatedBy, ADMIN);
    assert.deepEqual(data.knownEmails.sort(), [ANA, ANA_OLD].sort());
    assert.equal(data.profile.password, undefined);
    assert.equal(data.profile.accessibility.observacao, 'Laudo de TDAH, CID F90.');
    assert.equal(data.profile.statusChangedBy, PROF);
    assert.deepEqual(data.observations.map(item => item.id).sort(), ['obs_health', 'obs_restricted', 'obs_shared', 'obs_team']);
    assert.equal(data.submissions.find(item => item.id === 'sub_rev').score, 55, 'o administrador vê a nota em revisão');
    assert.equal(data.submissions.find(item => item.id === 'sub_pub').examSnapshot, undefined, 'o conteúdo da prova não é dado pessoal');
    assert.deepEqual(data.audit.map(item => item.id), ['aud_email', 'aud_phone', 'aud_grade']);
    assert.equal(data.audit[1].actor, PROF);
    assert.equal(data.openAttempts.length, 1);
    assert.equal(data.openAttempts[0].localCopyKey, undefined, 'segredo da tentativa fica de fora');
    // Nem a cópia completa traz dado de outro aluno (o arquivo pode ir para o titular).
    for (const foreign of [BIA, 'Bruno Outro', 'Palpite do Bruno', 'Do Bruno']) {
        assert.equal(JSON.stringify(data).includes(foreign), false, `a cópia do administrador não pode trazer "${foreign}"`);
    }
    const thread = data.forum.questions[0];
    assert.equal(thread.replies[0].authorEmail, PROF, 'quem da equipe respondeu fica na cópia completa');
    assert.deepEqual(thread.replies[1], { from: 'Outro aluno', text: '', timestamp: thread.replies[1].timestamp });
    assert.equal(thread.events.length, 1);
    assert.equal(thread.events[0].by, PROF, 'quem da equipe mexeu na dúvida fica na cópia completa');
    assert.equal(data.examMessages[0].senderEmail, PROF);
    assert.equal(data.counts.audit, 3);
    const entries = auditOf('lgpd_export');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].actor, ADMIN);
    assert.equal(entries[0].actorRole, 'admin');
    assert.equal(entries[0].studentEmail, ANA);
    assert.deepEqual({ audience: entries[0].details.audience, purpose: entries[0].details.purpose }, { audience: 'admin', purpose: 'baixar' });
    const print = await request(app).get(`/api/admin/lgpd/students/export?email=${ANA}&finalidade=imprimir`).set(adminHeaders());
    assert.equal(print.status, 200);
    assert.equal(auditOf('lgpd_export')[1].details.purpose, 'imprimir');
});

// Antes: o histórico da dúvida (events) ia sem filtro na cópia completa, com o e-mail e
// o nome do outro aluno que respondeu e o trecho da resposta apagada.
test('[UC-LGPD-011] na cópia completa, o histórico do fórum não traz e-mail, nome nem texto de outro aluno', async () => {
    const thread = db.memory.forum.find(item => item.id === 'f_ana');
    thread.events.push(
        { type: 'reply', by: BIA, byName: 'Bruno Outro', role: 'Aluno', at: new Date(NOW - 2 * DAY).toISOString(), detail: null },
        { type: 'delete_reply', by: PROF, byName: 'Professora Paula', role: 'Instrutor', at: new Date(NOW - DAY).toISOString(), detail: 'Palpite do Bruno' },
        { type: 'edit_comment', by: ANA, byName: 'Ana Souza', role: 'Aluno', at: new Date(NOW - DAY).toISOString(), detail: null },
    );
    const res = await request(app).get(`/api/admin/lgpd/students/export?email=${ANA}`).set(adminHeaders());
    assert.equal(res.status, 200, res.body.error);
    const events = res.body.forum.questions[0].events;
    assert.deepEqual(events.map(event => [event.type, event.by, event.byName]), [
        ['answered', PROF, 'Professora Paula'],
        ['reply', null, 'Outro aluno'],
        ['delete_reply', PROF, 'Professora Paula'],
        ['edit_comment', ANA, 'Ana Souza'],
    ]);
    assert.equal(events[2].detail, null, 'o trecho da resposta apagada pode ser de outro aluno');
    const text = JSON.stringify(res.body);
    for (const foreign of [BIA, 'Bruno Outro', 'Palpite do Bruno']) {
        assert.equal(text.includes(foreign), false, `a cópia do administrador não pode trazer "${foreign}"`);
    }
    // A memória não muda.
    assert.equal(thread.events[1].by, BIA);
});

test('[UC-LGPD-011] exportação do administrador: professor 403, sem sessão 401, pedido errado 400 e aluno desconhecido 404', async () => {
    const prof = await request(app).get(`/api/admin/lgpd/students/export?email=${ANA}`).set(adminHeaders(PROF));
    assert.equal(prof.status, 403);
    const none = await request(app).get(`/api/admin/lgpd/students/export?email=${ANA}`);
    assert.equal(none.status, 401);
    const missing = await request(app).get('/api/admin/lgpd/students/export').set(adminHeaders());
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { success: false, error: 'Informe o e-mail do aluno.', field: 'email' });
    const purpose = await request(app).get(`/api/admin/lgpd/students/export?email=${ANA}&finalidade=enviar`).set(adminHeaders());
    assert.equal(purpose.status, 400);
    assert.equal(purpose.body.field, 'finalidade');
    const unknown = await request(app).get('/api/admin/lgpd/students/export?email=ninguem@meusdados.local').set(adminHeaders());
    assert.equal(unknown.status, 404);
    assert.equal(auditOf('lgpd_export').length, 0);
});

test('[UC-LGPD-011] unidade: audiência desconhecida é erro de programação e aluno inexistente dá null', () => {
    assert.throws(() => exporter.buildStudentDataExport(db.memory, ANA, { audience: 'todos' }), TypeError);
    assert.equal(exporter.buildStudentDataExport(db.memory, 'ninguem@x.local'), null);
    assert.equal(exporter.exportFileName('admin', 'Zé Ninguém@x.local', '2026-11-11'), 'dados-z_ningu_m_x.local-2026-11-11.json');
    assert.equal(exporter.exportFileName('aluno', ANA, '2026-11-11'), 'meus-dados-2026-11-11.json');
    // A cópia não muda nada na memória.
    const before = JSON.stringify(db.memory.students);
    exporter.buildStudentDataExport(db.memory, ANA, { audience: 'admin' });
    exporter.buildStudentDataExport(db.memory, ANA, { audience: 'aluno' });
    assert.equal(JSON.stringify(db.memory.students), before);
});

// Rodada de ajuste 2: o desbloqueio da tela pelo Monitor grava em proctoringLogs.details o
// texto "Tela desbloqueada pelo instrutor (e-mail do professor)". withoutActors tira só
// campos (actor, author, *By), e o e-mail do professor ia para a cópia do aluno dentro
// desse texto. Agora o evento sai com o texto fixo, e qualquer outro e-mail que não seja
// dele some do texto do evento. O administrador continua vendo o texto inteiro.
test('[UC-LGPD-010] desbloqueio da tela pelo professor não leva o e-mail da equipe para a cópia do aluno', async () => {
    const { examStateKey } = require('../../backend/utils/examApplications.js');
    const key = examStateKey({ studentEmail: ANA, examKey: 'Prova_9' });
    db.memory.studentExamState = { [key]: { studentEmail: ANA, examKey: 'Prova_9', answers: {}, focusLocked: true, focusLockedAt: NOW - 60000 } };
    const unlock = await request(app).post('/api/admin/unlock-student-focus').set(adminHeaders(PROF))
        .send({ studentEmail: ANA, studentClass: '1DES', courseId: 'DES', examKey: 'Prova_9' });
    assert.equal(unlock.status, 200, unlock.body.error);
    const stored = db.memory.proctoringLogs.find(log => log.eventType === 'focus_unlocked');
    assert.ok(stored && stored.details.includes(PROF), 'o registro guardado continua com o e-mail (o Monitor e o administrador veem)');
    // Evento escrito por outro caminho com e-mail de outra pessoa no texto, e um com o dele.
    db.memory.proctoringLogs.push(
        { id: 'pl_txt', studentEmail: ANA, examKey: 'Prova_9', eventType: 'tab_blur', details: `Aviso de ${ADMIN} lido`, timestamp: NOW - 1000 },
        { id: 'pl_own', studentEmail: ANA, examKey: 'Prova_9', eventType: 'tab_blur', details: `Conta ${ANA}`, timestamp: NOW - 500 },
    );

    const res = await request(app).get('/api/student/my-data').set(studentHeaders(ANA));
    assert.equal(res.status, 200, res.body.error);
    const text = JSON.stringify(res.body);
    for (const staff of [PROF, ADMIN, 'meusdados.local)']) {
        assert.equal(text.includes(staff), false, `a cópia do aluno não pode trazer "${staff}"`);
    }
    const byType = Object.fromEntries(res.body.proctoring.focusEvents.map(item => [item.id || item.eventType, item]));
    assert.equal(byType[stored.id].details, 'Tela desbloqueada pelo instrutor');
    assert.equal(byType.pl_txt.details, 'Aviso de [e-mail omitido] lido');
    assert.equal(byType.pl_own.details, `Conta ${ANA}`);
    // A memória não muda, e o administrador vê o texto inteiro.
    assert.ok(db.memory.proctoringLogs.find(log => log.id === stored.id).details.includes(PROF));
    const full = await request(app).get(`/api/admin/lgpd/students/export?email=${ANA}`).set(adminHeaders());
    assert.equal(full.status, 200, full.body.error);
    assert.ok(full.body.proctoring.focusEvents.find(item => item.id === stored.id).details.includes(PROF));
});

test('[UC-LGPD-010] unidade: e-mail dentro de texto livre do evento sai, o do próprio aluno fica', () => {
    db.memory.proctoringLogs = [
        { id: 'p1', studentEmail: ANA, eventType: 'focus_unlocked', details: `Tela desbloqueada pelo instrutor (${PROF})`, timestamp: NOW },
        { id: 'p2', studentEmail: ANA, eventType: 'exam_left', details: `Saiu (${PROF}) e voltou; ver ${ADMIN}.`, timestamp: NOW },
        { id: 'p3', studentEmail: ANA, eventType: 'exam_left', details: `Antigo ${ANA_OLD}`, timestamp: NOW - 100 * DAY },
        { id: 'p4', studentEmail: ANA, eventType: 'tab_blur', timestamp: NOW },
    ];
    const events = exporter.buildStudentDataExport(db.memory, ANA, { audience: 'aluno' }).proctoring.focusEvents;
    assert.deepEqual(events.map(item => item.details), [
        'Tela desbloqueada pelo instrutor',
        'Saiu e voltou; ver [e-mail omitido].',
        `Antigo ${ANA_OLD}`,
        undefined,
    ]);
    const admin = exporter.buildStudentDataExport(db.memory, ANA, { audience: 'admin' }).proctoring.focusEvents;
    assert.equal(admin[0].details, `Tela desbloqueada pelo instrutor (${PROF})`);
});

// Rodada de ajuste 2: a migração do boot (server.js) preenche a resposta antiga de aluno
// sem e-mail com o e-mail do dono da dúvida. Sem a marca, a resposta de outro aluno na
// dúvida da Ana virava "minha" na cópia dela, com o texto do outro.
test('[UC-LGPD-010] resposta antiga de aluno sem e-mail (preenchida no boot) não vira do dono da dúvida', () => {
    const thread = db.memory.forum.find(item => item.id === 'f_ana');
    thread.replies.push({ id: 'r_legacy', authorName: 'Carla Antiga', authorEmail: ANA, authorEmailInferred: true, authorRole: 'Aluno', text: 'Texto antigo da Carla', timestamp: new Date(NOW - 300 * DAY).toISOString() });
    for (const audience of ['aluno', 'admin']) {
        const data = exporter.buildStudentDataExport(db.memory, ANA, { audience });
        const replies = data.forum.questions[0].replies;
        assert.deepEqual(replies.map(reply => (reply.mine ? 'eu' : reply.from)), ['Equipe', 'Outro aluno', 'Outro aluno'], audience);
        const text = JSON.stringify(data);
        assert.equal(text.includes('Texto antigo da Carla'), false, audience);
        assert.equal(text.includes('Carla Antiga'), false, audience);
    }
});

test('[UC-LGPD-010] a migração do boot marca a resposta de aluno cujo e-mail ela deduziu', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../backend/server.js'), 'utf8');
    const block = source.slice(source.indexOf('if (!reply.authorEmail) {'), source.indexOf('if (migrated) {'));
    assert.match(block, /reply\.authorEmail = reply\.authorRole === 'Instrutor' \? db\.defaultAdminEmail\(\) : \(comment\.studentEmail \|\| ''\);/);
    assert.match(block, /if \(reply\.authorRole !== 'Instrutor' && reply\.authorEmail\) reply\.authorEmailInferred = true;/);
});

// Rodada de ajuste 2: a versão para imprimir mostrava o código interno da prova
// (Avaliacao_FUTEC_2). O arquivo traz examTitles com o nome que o portal mostra.
test('[UC-LGPD-010] o arquivo traz o nome de cada prova citada (examTitles), como no portal', () => {
    db.memory.evaluations = { Prova_1: { title: 'Avaliação 1 — Lógica' } };
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento', schoolId: 'escola_a', structure: [{ id: 'm1', name: 'Módulo 1', units: [{ name: 'Prova da unidade 2', avaliacaoKey: 'Prova_2' }] }] }];
    db.memory.classes = [{ name: '1DES', courseId: 'DES', status: 'active', releasedItems: {}, contentOverrides: { unitNames: { Prova_3: 'Recuperação da turma' } } }];
    db.memory.proctoringLogs.push(
        { id: 'pl_3', studentEmail: ANA, examKey: 'Prova_3', eventType: 'tab_blur', timestamp: NOW },
        { id: 'pl_4', studentEmail: ANA, examKey: 'Avaliacao_FUTEC_4', eventType: 'tab_blur', timestamp: NOW },
    );
    const data = exporter.buildStudentDataExport(db.memory, ANA, { audience: 'aluno', keystrokes: [keyRow(ANA, NOW)] });
    assert.deepEqual(data.examTitles, {
        Avaliacao_FUTEC_4: 'Avaliacao FUTEC 4',
        Prova_1: 'Avaliação 1 — Lógica',
        Prova_2: 'Prova da unidade 2',
        Prova_3: 'Recuperação da turma',
    });
});
