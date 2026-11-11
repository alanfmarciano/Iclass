// Contrato das telas (fase 2, H9b: ENG-03). Os schemas novos (utils/inputSchema.js) não
// podem recusar um pedido válido de uma tela: cada caso abaixo manda o corpo exatamente
// como a tela o monta em web/src (os mesmos campos, tipos e tamanhos máximos que o campo
// da tela deixa digitar) e exige 2xx. Para o caso não ficar velho quando a tela mudar, cada
// um confere antes que a chamada copiada ainda está no arquivo da tela (screen()); se a
// tela mudar o corpo, este teste falha e o caso é atualizado junto.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-contrato-telas-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { DEMO_ACCOUNTS } = require('../../backend/utils/demoAccounts.js');
const { NOTE_MAX_CHARS, ANNOTATION_NOTE_MAX_CHARS } = require('../../backend/utils/studentNotes.js');

const WEB_SRC = path.join(__dirname, '..', '..', 'web', 'src');
const COURSE_ID = 'curso_legacy_01';
const CLASS_NAME = '1DES';
const EXAM_KEY = 'Avaliacao_FUTEC_5';
const UNIT_KEY = 'Apostila_FUTEC_3';
const PASSWORD = 'teste';

let app;
const tokens = {};
const sourceCache = new Map();

// A chamada copiada continua na tela (sem espaços repetidos, para não depender da
// quebra de linha). Se falhar, a tela mudou o corpo: atualize o caso abaixo junto.
function screen(file, snippet) {
    if (!sourceCache.has(file)) {
        sourceCache.set(file, fs.readFileSync(path.join(WEB_SRC, file), 'utf8').replace(/\s+/g, ' '));
    }
    const wanted = snippet.replace(/\s+/g, ' ');
    assert.ok(sourceCache.get(file).includes(wanted), `a tela ${file} não monta mais: ${snippet}`);
}

function asStudent(route) {
    return request(app).post(route).set('x-session-token', tokens.student);
}

function asInstructor(route, who = 'admin') {
    return request(app).post(route).set('x-admin-session', tokens[who]);
}

function ok(res, label) {
    assert.ok(res.status >= 200 && res.status < 300, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
    return res;
}

test.before(async () => {
    await db.init();
    app = createApp();
    ok(await request(app).post('/api/test/seed'), 'seed');

    // LoginPage/AuthProvider: { email, password } (a senha nunca é aparada).
    screen('context/AuthProvider.jsx', "api.post('/api/student/login', { email, password }, { auth: false })");
    const student = ok(await request(app).post('/api/student/login').send({ email: DEMO_ACCOUNTS.student.email, password: PASSWORD }), 'student/login');
    tokens.student = student.body.sessionToken;
    screen('context/AuthProvider.jsx', "api.post('/api/session/admin-login', { email, password }, { auth: false })");
    for (const [who, account] of [['admin', DEMO_ACCOUNTS.admin], ['professor', DEMO_ACCOUNTS.professor]]) {
        const res = ok(await request(app).post('/api/session/admin-login').send({ email: account.email, password: PASSWORD }), `admin-login ${who}`);
        tokens[who] = res.body.sessionToken;
    }
    assert.ok(tokens.student && tokens.admin && tokens.professor);
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ------------------------------------------------------------------ aluno: estudo

test('[UC-ERRO-003] contrato das telas do aluno: Caderno, Módulos (caderno, anotação, progresso, acesso) e fórum passam pelos schemas', async () => {
    const email = DEMO_ACCOUNTS.student.email;
    const name = 'Aluno Teste';

    // CadernoPage: moduleKey fixo 'geral'; o Textarea deixa digitar até NOTE_MAX_CHARS.
    screen('features/student/CadernoPage.jsx', "api.post('/api/student/notes/get', { email, moduleKey })");
    screen('features/student/CadernoPage.jsx', "api.post('/api/student/notes/save', { email, moduleKey, note })");
    const notePrefix = 'Anotações da aula — revisão de hardware.\n\n';
    const fullNote = notePrefix + 'ç'.repeat(NOTE_MAX_CHARS - notePrefix.length);
    assert.equal(fullNote.length, NOTE_MAX_CHARS);
    ok(await asStudent('/api/student/notes/save').send({ email, moduleKey: 'geral', note: fullNote }), 'Caderno salvar 50.000');
    const read = ok(await asStudent('/api/student/notes/get').send({ email, moduleKey: 'geral' }), 'Caderno ler');
    assert.equal(read.body.note, fullNote, 'a nota volta como foi digitada (sem aparar)');
    // Apagar todo o texto e salvar (note: '').
    ok(await asStudent('/api/student/notes/save').send({ email, moduleKey: 'geral', note: '' }), 'Caderno salvar vazio');

    // ModulosPage: caderno da unidade, com a chave da apostila.
    screen('features/student/ModulosPage.jsx', "api.post('/api/student/notes/get', { email, moduleKey: key })");
    screen('features/student/ModulosPage.jsx', "api.post('/api/student/notes/save', { email, moduleKey: openUnit.key, note })");
    ok(await asStudent('/api/student/notes/save').send({ email, moduleKey: UNIT_KEY, note: '  Resumo com espaços nas pontas  \n' }), 'Módulos caderno');
    ok(await asStudent('/api/student/notes/get').send({ email, moduleKey: UNIT_KEY }), 'Módulos caderno ler');

    // ModulosPage: acesso à unidade (moduleKey vazio quando a unidade não tem).
    screen('features/student/ModulosPage.jsx', "api.post('/api/student/track-access', { email, key: unit.key, moduleKey: unit.moduleKey || '', courseId })");
    ok(await asStudent('/api/student/track-access').send({ email, key: UNIT_KEY, moduleKey: '', courseId: COURSE_ID }), 'track-access sem módulo');
    ok(await asStudent('/api/student/track-access').send({ email, key: UNIT_KEY, moduleKey: 'FUTEC', courseId: COURSE_ID }), 'track-access');

    // ModulosPage: concluir e desmarcar (mapa inteiro, com true e false).
    screen('features/student/ModulosPage.jsx', "const next = { ...completed, [openUnit.key]: done }");
    screen('features/student/ModulosPage.jsx', "api.post('/api/student/progress', { email, completedUnits: next })");
    ok(await asStudent('/api/student/progress').send({ email, completedUnits: { Apostila_FUTEC_1: true, [UNIT_KEY]: true } }), 'progress concluir');
    ok(await asStudent('/api/student/progress').send({ email, completedUnits: { Apostila_FUTEC_1: true, [UNIT_KEY]: false } }), 'progress desmarcar');

    // ModulosPage: anotação de parágrafo. Ao clicar, o trecho destacado é o texto inteiro do
    // parágrafo (pode passar de 1.000; o servidor guarda cortado) e a nota começa ''.
    screen('features/student/ModulosPage.jsx', "setAnnotation({ paragraphId: id, highlightedText: node.textContent.trim(), note: annotations[id]?.note || '' })");
    screen('features/student/ModulosPage.jsx', "api.post('/api/student/annotation', { email, key: openUnit.key, ...annotation })");
    const paragraph = 'Um parágrafo longo da apostila. '.repeat(120).trim();
    ok(await asStudent('/api/student/annotation').send({ email, key: UNIT_KEY, paragraphId: 'p3', highlightedText: paragraph, note: '' }), 'anotação nota vazia');
    ok(await asStudent('/api/student/annotation').send({ email, key: UNIT_KEY, paragraphId: 'p3', highlightedText: paragraph, note: 'n'.repeat(ANNOTATION_NOTE_MAX_CHARS) }), 'anotação 5.000');
    screen('features/student/ModulosPage.jsx', "api.post('/api/student/annotation', { email, key: openUnit.key, paragraphId: annotation.paragraphId, highlightedText: null, note: null })");
    ok(await asStudent('/api/student/annotation').send({ email, key: UNIT_KEY, paragraphId: 'p3', highlightedText: null, note: null }), 'anotação apagar');

    // ModulosPage e DuvidasPage: dúvida nova (até 5.000) e resposta do aluno.
    screen('features/student/ModulosPage.jsx', "api.post('/api/forum/comment', { key: openUnit.key, studentName: name, studentEmail: email, courseId, studentClass, text: commentText })");
    screen('features/student/DuvidasPage.jsx', "api.post('/api/forum/comment', { key: topic, studentName: name, studentEmail: email, courseId, studentClass, text })");
    const comment = ok(await asStudent('/api/forum/comment').send({ key: UNIT_KEY, studentName: name, studentEmail: email, courseId: COURSE_ID, studentClass: CLASS_NAME, text: 'd'.repeat(5000) }), 'dúvida 5.000');
    ok(await asStudent('/api/forum/comment').send({ key: 'geral', studentName: name, studentEmail: email, courseId: COURSE_ID, studentClass: CLASS_NAME, text: 'Dúvida geral sobre a prova?' }), 'Dúvidas tópico geral');
    const commentId = comment.body.comment?.id || comment.body.id || (db.memory.forum || []).find(item => item.text === 'd'.repeat(5000))?.id;
    assert.ok(commentId, JSON.stringify(comment.body));
    screen('features/student/ModulosPage.jsx', "api.post('/api/forum/reply', { commentId, courseId, studentClass, authorName: name, authorRole: 'Aluno', authorEmail: email, text })");
    ok(await asStudent('/api/forum/reply').send({ commentId, courseId: COURSE_ID, studentClass: CLASS_NAME, authorName: name, authorRole: 'Aluno', authorEmail: email, text: 'r'.repeat(5000) }), 'resposta do aluno');

    // ForumPage do professor: responder, editar e apagar, com o e-mail da conta.
    screen('features/admin/ForumPage.jsx', "api.post('/api/forum/reply', { commentId, courseId: activeCourseId, studentClass: activeClassName, authorName: auth.email || 'Instrutor', authorRole: 'Instrutor', authorEmail: auth.email, text })");
    const professor = DEMO_ACCOUNTS.professor.email;
    const reply = ok(await asInstructor('/api/forum/reply', 'professor').send({ commentId, courseId: COURSE_ID, studentClass: CLASS_NAME, authorName: professor, authorRole: 'Instrutor', authorEmail: professor, text: 'Modelo: veja a seção 2.\n\n' + 'x'.repeat(4900) }), 'resposta do professor');
    const thread = (db.memory.forum || []).find(item => item.id === commentId);
    const replyId = reply.body.reply?.id || thread?.replies?.[thread.replies.length - 1]?.id;
    assert.ok(replyId, JSON.stringify(reply.body));
    screen('features/admin/ForumPage.jsx', "api.post('/api/forum/reply/edit', { commentId: target.commentId, replyId: target.replyId, courseId: activeCourseId, studentClass: activeClassName, email: auth.email, text })");
    ok(await asInstructor('/api/forum/reply/edit', 'professor').send({ commentId, replyId, courseId: COURSE_ID, studentClass: CLASS_NAME, email: professor, text: 'Texto corrigido.' }), 'editar resposta');
    screen('features/admin/ForumPage.jsx', "api.post('/api/forum/comment/edit', { commentId: target.commentId, courseId: activeCourseId, studentClass: activeClassName, email: auth.email, text })");
    ok(await asInstructor('/api/forum/comment/edit', 'professor').send({ commentId, courseId: COURSE_ID, studentClass: CLASS_NAME, email: professor, text: 'Dúvida editada pelo professor.' }), 'editar dúvida');
    screen('features/admin/ForumPage.jsx', "api.post('/api/forum/reply/delete', { commentId: del.commentId, replyId: del.replyId, courseId: activeCourseId, studentClass: activeClassName, email: auth.email })");
    ok(await asInstructor('/api/forum/reply/delete', 'professor').send({ commentId, replyId, courseId: COURSE_ID, studentClass: CLASS_NAME, email: professor }), 'apagar resposta');
    screen('features/student/ModulosPage.jsx', "api.post('/api/forum/comment/delete', { commentId: deleteTarget.commentId, courseId, studentClass, email })");
    ok(await asStudent('/api/forum/comment/delete').send({ commentId, courseId: COURSE_ID, studentClass: CLASS_NAME, email }), 'apagar dúvida');
});

test('[UC-ERRO-003] contrato das telas do aluno: avisos, notificações, matrícula, entregas, senha e erro de tela', async () => {
    const email = DEMO_ACCOUNTS.student.email;
    screen('features/student/AvisosPage.jsx', "api.post('/api/student/announcements/read', { email, id: announcement.id })");
    screen('features/student/StudentShell.jsx', "api.post('/api/student/announcements/read', { id: item.id.slice('aviso:'.length) })");
    const announcement = (db.memory.announcements || []).find(item => item && item.id);
    assert.ok(announcement, 'o seed tem avisos');
    ok(await asStudent('/api/student/announcements/read').send({ email, id: announcement.id }), 'Avisos lido');
    ok(await asStudent('/api/student/announcements/read').send({ id: announcement.id }), 'sino lido');

    // NotificationBell: { keys, ids } com o contexto na query.
    screen('components/ui/NotificationBell.jsx', 'api.post(seenEndpoint, { keys, ids })');
    ok(await asStudent(`/api/student/notifications/seen?courseId=${COURSE_ID}&studentClass=${CLASS_NAME}`).send({ keys: ['aviso:1:0', 'nota:abc:0'], ids: ['aviso:1', 'nota:abc'] }), 'sino visto');

    screen('features/student/ProvasPage.jsx', "api.post('/api/student/my-submissions', { email, courseId, studentClass }, requestOptions)");
    ok(await asStudent('/api/student/my-submissions').send({ email, courseId: COURSE_ID, studentClass: CLASS_NAME }), 'minhas entregas');

    // StudentCourseGate: pedir e cancelar matrícula.
    screen('features/student/StudentCourseGate.jsx', "api.post('/api/student/enrollments/request', { courseId: request.courseId, studentClass: request.requestedClassName })");
    screen('features/student/StudentCourseGate.jsx', "api.post('/api/student/enrollments/cancel', { id: request.id })");
    const requested = await asStudent('/api/student/enrollments/request').send({ courseId: COURSE_ID, studentClass: CLASS_NAME });
    // O aluno de teste já está na turma: a rota recusa pela regra (409/400 com a mensagem
    // dela), nunca pelo schema.
    assert.ok(requested.status < 500, JSON.stringify(requested.body));
    if (requested.status === 400) assert.notEqual(requested.body.field, 'courseId', JSON.stringify(requested.body));
    const cancel = await asStudent('/api/student/enrollments/cancel').send({ id: 'pedido_que_nao_existe' });
    assert.ok([200, 404].includes(cancel.status), JSON.stringify(cancel.body));

    // /api/client-error (boundary): { area, message, path, build }.
    screen('lib/clientErrors.js', 'const body = { area, message, path: currentPath() }');
    const clientError = await asStudent('/api/client-error').send({ area: 'aluno', message: 'Cannot read properties of undefined (reading \'map\')', path: '/aluno/modulos', build: 'abc1234' });
    assert.equal(clientError.status, 204, JSON.stringify(clientError.body));

    // PasswordChangeForm: { currentPassword, newPassword } (sem aparar).
    screen('components/PasswordChangeForm.jsx', 'api.post(endpoint, { ...(showCurrent ? { currentPassword } : {}), newPassword })');
    ok(await asStudent('/api/student/change-password').send({ currentPassword: PASSWORD, newPassword: ' Nova senha 2026 ' }), 'troca de senha do aluno');
    const relogin = ok(await request(app).post('/api/student/login').send({ email, password: ' Nova senha 2026 ' }), 'login com a senha nova (espaços contam)');
    tokens.student = relogin.body.sessionToken;
});

// ------------------------------------------------------------------ aluno: prova

test('[UC-ERRO-003] contrato da tela da prova: start-attempt, autosave, teclas (lote de 500), atividade, aviso, questão e envio', async () => {
    const admin = DEMO_ACCOUNTS.admin.email;
    const email = DEMO_ACCOUNTS.student.email;
    const application = db.memory.examApplications.find(item => item.seedDemo === true && item.examKey === EXAM_KEY);
    assert.ok(application, 'aplicação semeada');
    ok(await asInstructor(`/api/admin/exam-applications/${application.id}/control`).send({ action: 'start' }), `start por ${admin}`);
    const applicationId = application.id;
    const studentClass = CLASS_NAME;
    const courseId = COURSE_ID;
    const examKey = EXAM_KEY;

    ok(await request(app).get('/api/student/sync').set('x-session-token', tokens.student)
        .query({ email, studentClass, courseId, examKey, applicationId, attemptId: '' }), 'sync');
    screen('features/student/exam/ExamRunner.jsx', 'api.post(`/api/student/exam-applications/${encodeURIComponent(applicationId)}/start-attempt`, {})');
    const started = ok(await asStudent(`/api/student/exam-applications/${encodeURIComponent(applicationId)}/start-attempt`).send({}), 'start-attempt');
    const attemptId = started.body.attemptId;
    assert.ok(attemptId, JSON.stringify(started.body));
    // A tela numera as questões como examUtils.normQuestion e marca { número: id }.
    screen('features/student/exam/examUtils.js', 'const number = Number(q.originalNumber ?? q.number ?? i + 1)')
    screen('features/student/exam/ExamRunner.jsx', 'onClick={() => setAnswers((a) => ({ ...a, [q.number]: alt.id }))}')
    const questions = (started.body.questions || []).map((question, index) => ({
        number: Number(question.originalNumber ?? question.number ?? index + 1),
        alternativeId: String(question.alternatives?.[0]?.id || '').toUpperCase(),
    }));
    const answers = {};
    for (const question of questions.slice(0, 2)) answers[question.number] = question.alternativeId;
    assert.equal(Object.keys(answers).length, 2, JSON.stringify(answers));

    screen('features/student/exam/ExamRunner.jsx', "api.post('/api/student/autosave-progress', { email, studentClass, courseId, examKey, applicationId, attemptId: currentAttemptId, answers: snapshot }");
    ok(await asStudent('/api/student/autosave-progress').send({ email, studentClass, courseId, examKey, applicationId, attemptId, answers }), 'autosave');

    // Teclas: o lote cheio de 500 com os eventos que o handler de keydown, copiar e o menu
    // do botão direito montam.
    screen('features/student/exam/ExamRunner.jsx', 'const base = { email, studentClass, courseId, examKey, applicationId, attemptId }');
    screen('features/student/exam/ExamRunner.jsx', 'const payload = { ...base, events }');
    // O registro passa pelo modo do teclado da aplicação (H8b, record() no ExamRunner);
    // com 'tudo' o servidor guarda o lote inteiro, que é o que este contrato confere.
    screen('features/student/exam/ExamRunner.jsx', "keyBufferRef.current.push({ seq: ++keySeqRef.current, clientTs: Date.now(), ...entry })");
    screen('features/student/exam/ExamRunner.jsx', "record(e, { key: 'copy', code: 'copy', mods: '', kind: 'clipboard', question: null, blocked: true, suspicious: true })");
    application.keystrokeMode = 'tudo';
    const now = Date.now();
    const events = Array.from({ length: 498 }, (_, index) => ({
        seq: index + 1, clientTs: now + index, key: index % 7 ? 'a' : 'Enter', code: index % 7 ? 'KeyA' : 'Enter',
        mods: index % 50 ? '' : 'ctrl', kind: index % 7 ? 'char' : 'key', question: null, blocked: false, suspicious: false,
    }));
    events.push({ seq: 499, clientTs: now + 499, key: 'copy', code: 'copy', mods: '', kind: 'clipboard', question: null, blocked: true, suspicious: true });
    events.push({ seq: 500, clientTs: now + 500, key: 'contextmenu', code: 'contextmenu', mods: '', kind: 'contextmenu', question: null, blocked: true, suspicious: true });
    const keys = ok(await asStudent('/api/student/log-keystrokes').send({ email, studentClass, courseId, examKey, applicationId, attemptId, events }), 'teclas');
    assert.equal(keys.body.inserted, 500);
    assert.equal(keys.body.dropped, 0);

    // Atividade: saída de aba, tela cheia, saída da página (pageExit) e erro de tela.
    screen('features/student/exam/ExamRunner.jsx', "api.post('/api/student/log-activity', { email, studentClass, courseId, examKey, applicationId, attemptId, eventType: 'fullscreen_unsupported', details: 'Dispositivo sem tela cheia: a prova seguiu sem ela' })");
    ok(await asStudent('/api/student/log-activity').send({ email, studentClass, courseId, examKey, applicationId, attemptId, eventType: 'fullscreen_unsupported', details: 'Dispositivo sem tela cheia: a prova seguiu sem ela' }), 'tela cheia');
    screen('features/student/exam/ExamRunner.jsx', "eventType: 'exam_render_error', details: `Erro técnico na tela da prova: ${String(renderError.message || '').slice(0, 400)}`");
    ok(await asStudent('/api/student/log-activity').send({ email, studentClass, courseId, examKey, applicationId, attemptId, eventType: 'exam_render_error', details: `Erro técnico na tela da prova: ${'e'.repeat(400)}` }), 'erro de tela');

    screen('features/student/exam/ExamRunner.jsx', "api.post('/api/student/acknowledge-message', { email, messageId: message.id })");
    const ack = await asStudent('/api/student/acknowledge-message').send({ email, messageId: 'msg_1731340000000_ab12cd' });
    assert.ok(ack.status < 500 && ack.body.field === undefined, JSON.stringify(ack.body));
    screen('features/student/exam/ExamRunner.jsx', "api.post('/api/student/message-history/delete', { email, messageId, studentClass, courseId, examKey, applicationId })");
    const hide = await asStudent('/api/student/message-history/delete').send({ email, messageId: 'msg_1731340000000_ab12cd', studentClass, courseId, examKey, applicationId });
    assert.ok(hide.status < 500 && hide.body.field === undefined, JSON.stringify(hide.body));

    screen('features/student/exam/ExamRunner.jsx', "api.post('/api/student/validate-exam-token', { email, studentClass, courseId, examKey, applicationId, attemptId, token: tokenInput })");
    const token = await asStudent('/api/student/validate-exam-token').send({ email, studentClass, courseId, examKey, applicationId, attemptId, token: 'AB12CD' });
    assert.ok(token.status < 500 && token.body.field === undefined, JSON.stringify(token.body));

    // "Reportar problema" na questão: motivo padrão e texto livre.
    screen('features/student/exam/ExamRunner.jsx', "useState({ reason: 'sem_resposta_correta', text: '' })");
    screen('features/student/exam/ExamRunner.jsx', 'questionNumber: reportQuestion.number, reason: reportForm.reason, text: reportForm.text,')
    ok(await asStudent('/api/student/report-question').send({ applicationId, attemptId, questionNumber: questions[0].number, reason: 'sem_resposta_correta', text: 'A alternativa C também parece certa.' }), 'reportar questão');

    // Envio pelo aluno (auto: false), com a versão da prova que o sync mandou.
    const examConfigVersion = started.body.examConfigVersion ?? started.body.state?.examConfigVersion ?? null;
    screen('features/student/exam/ExamRunner.jsx', 'answers: answersRef.current, examConfigVersion, auto,');
    const submitted = ok(await asStudent('/api/student/submit').send({ email, studentClass, courseId, examKey, applicationId, attemptId, answers, examConfigVersion, auto: false }), 'envio');
    assert.equal(submitted.body.success, true);

    // Saída da página: o corpo da tela de erro da prova (contexto + pageExit).
    screen('features/student/exam/ExamErrorScreen.jsx', "eventType: 'exam_left', details: 'Página da prova foi fechada ou recarregada (depois de um erro de tela)', pageExit: true,");
    const left = await asStudent('/api/student/log-activity').send({ email, studentClass, courseId, examKey, applicationId, attemptId, eventType: 'exam_left', details: 'Página da prova foi fechada ou recarregada (depois de um erro de tela)', pageExit: true });
    assert.ok(left.status < 500 && left.body.field === undefined, JSON.stringify(left.body));
});

// ------------------------------------------------------------------ professor

test('[UC-ERRO-003] contrato das telas do professor: preferências (modelos, adiados, favoritos), contas, escolas, identidade', async () => {
    // PreferencesProvider: { chave: valor } das alterações feitas na mesma espera (uma ou
    // mais chaves por pedido).
    screen('context/PreferencesProvider.jsx', 'pending.current = { ...pending.current, [key]: value }');
    screen('context/PreferencesProvider.jsx', "api.post('/api/admin/preferences', batch)");
    // ForumPage: modelos { id, title, text } com texto de até 5.000.
    screen('features/admin/ForumPage.jsx', "setPref('forum.templates', [...templates, { id: 'tpl_' + Date.now(), title: tplForm.title.trim(), text: tplForm.text.trim() }])");
    const templates = Array.from({ length: 5 }, (_, index) => ({ id: `tpl_${1731340000000 + index}`, title: `Modelo ${index + 1}`, text: 'Obrigado pela pergunta! '.repeat(200).slice(0, 5000) }));
    ok(await asInstructor('/api/admin/preferences', 'professor').send({ 'forum.templates': templates }), 'modelos do fórum');
    ok(await asInstructor('/api/admin/preferences', 'professor').send({ 'forum.lastSeen': new Date().toISOString() }), 'fórum lido');
    screen('features/admin/DashboardPage.jsx', "setPref('dashboard.snoozed', snoozedWith(pref('dashboard.snoozed', {}), item.id))");
    screen('features/admin/dashboard/snooze.js', 'kept[itemId] = now');
    ok(await asInstructor('/api/admin/preferences', 'professor').send({ 'dashboard.snoozed': { 'risco:aluno@teste.local': Date.now(), 'nota:Avaliacao_FUTEC_5': Date.now() } }), 'adiar item');
    ok(await asInstructor('/api/admin/preferences', 'professor').send({ 'dashboard.riskCount': 7 }), 'quantidade em risco');
    screen('features/admin/AdminCourseGate.jsx', "setPref('gate.recentContexts', [item.key, ...recent.filter(key => key !== item.key)].slice(0, 5))");
    ok(await asInstructor('/api/admin/preferences', 'professor').send({ 'gate.recentContexts': [`${COURSE_ID}::${CLASS_NAME}`] }), 'contextos recentes');
    ok(await asInstructor('/api/admin/preferences', 'professor').send({ 'gate.favorites': [`${COURSE_ID}::${CLASS_NAME}`] }), 'favoritos');
    ok(await asInstructor('/api/admin/preferences', 'professor').send({ 'forum.lastSeen': new Date().toISOString(), 'dashboard.riskCount': 5, 'forum.templates': templates }), 'várias chaves no mesmo pedido');

    // AdminEditPage: criar (o form inteiro), atualizar e remover a conta.
    screen('features/admin/AdminEditPage.jsx', "setForm({ name: '', email: '', password: '', requirePasswordChange: true, role: 'admin', assignedClasses: [], additionalPermissions: [] })");
    screen('features/admin/AdminEditPage.jsx', "api.post('/api/admin/accounts/create', form)");
    const newEmail = 'nova.professora@teste.local';
    ok(await asInstructor('/api/admin/accounts/create').send({ name: 'Nova Professora', email: newEmail, password: 'Senha-forte-2026', requirePasswordChange: true, role: 'professor', assignedClasses: [{ courseId: COURSE_ID, className: CLASS_NAME }], additionalPermissions: [] }), 'criar conta');
    screen('features/admin/AdminEditPage.jsx', "api.post('/api/admin/accounts/update', { email: form.email, name: form.name, role: form.role, assignedClasses: form.assignedClasses, additionalPermissions: form.additionalPermissions })");
    ok(await asInstructor('/api/admin/accounts/update').send({ email: newEmail, name: 'Nova Professora da Silva', role: 'professor', assignedClasses: [{ courseId: COURSE_ID, className: CLASS_NAME }], additionalPermissions: [] }), 'atualizar conta');
    screen('features/admin/AdminEditPage.jsx', "api.post('/api/admin/accounts/delete', { email: form.email })");
    ok(await asInstructor('/api/admin/accounts/delete').send({ email: newEmail }), 'remover conta');

    // EscolaEditPage: info com todos os campos (vazios ou não) e IdentidadePage: branding.
    screen('features/admin/EscolaEditPage.jsx', "api.post('/api/admin/schools/create', { name: form.name, info: form.info })");
    const info = { tradeName: 'Escola Técnica', legalName: 'Escola Técnica Ltda', registrationId: '', address: 'Rua A, 10', cityState: 'São Paulo/SP', zip: '', phone: '', email: '', website: '', directorName: '', directorRole: '', signatureUrl: '' };
    const created = ok(await asInstructor('/api/admin/schools/create').send({ name: 'Escola Técnica Nova', info }), 'criar escola');
    const schoolId = created.body.school?.id || (db.memory.schools || []).find(item => item.name === 'Escola Técnica Nova')?.id;
    assert.ok(schoolId, JSON.stringify(created.body));
    screen('features/admin/EscolaEditPage.jsx', "api.post('/api/admin/schools/update', { id: form.id, name: form.name, info: form.info })");
    ok(await asInstructor('/api/admin/schools/update').send({ id: schoolId, name: 'Escola Técnica Nova', info: { ...info, phone: '(11) 5555-0000' } }), 'editar escola');
    screen('features/admin/IdentidadePage.jsx', "api.post('/api/admin/schools/update', { id: schoolId, branding: form })");
    ok(await asInstructor('/api/admin/schools/update').send({ id: schoolId, branding: { displayName: 'Escola Nova', shortName: 'EN', themeMode: 'dark', primaryColor: '#ef4444', loginWelcome: 'Bem-vindo!' } }), 'identidade da escola');
    screen('features/admin/EscolaEditPage.jsx', "api.post('/api/admin/schools/delete', { id: form.id })");
    ok(await asInstructor('/api/admin/schools/delete').send({ id: schoolId }), 'remover escola');
});

test('[UC-ERRO-003] contrato das telas do professor: Alunos (certificado, observação, senha), Monitor e banco de questões', async () => {
    const student = DEMO_ACCOUNTS.student.email;

    // AlunosPage: observação com o formulário inteiro e texto de até 5.000.
    screen('features/admin/AlunosPage.jsx', "setObsForm({ category: 'Observação geral', visibility: 'Equipe pedagógica', text: '' })");
    screen('features/admin/AlunosPage.jsx', "api.post('/api/admin/student/observations/create', { email: obs.email, ...obsForm })");
    ok(await asInstructor('/api/admin/student/observations/create', 'professor').send({ email: student, category: 'Observação geral', visibility: 'Equipe pedagógica', text: 'o'.repeat(5000) }), 'observação');
    screen('features/admin/AlunosPage.jsx', "api.post('/api/admin/student/certificates/issue', { email: profile.email, courseName: profileCourseName })");
    const certificate = await asInstructor('/api/admin/student/certificates/issue').send({ email: student, courseName: 'Técnico em Desenvolvimento de Sistemas' });
    assert.ok(certificate.status < 500 && certificate.body.field === undefined, JSON.stringify(certificate.body));

    // StudentPasswordDialogs: senha digitada ou temporária.
    screen('features/admin/StudentPasswordDialogs.jsx', "api.post('/api/admin/reset-password', mode === 'typed' ? { email, newPassword: typed } : { email })");
    ok(await asInstructor('/api/admin/reset-password').send({ email: student, newPassword: 'Senha digitada 2026' }), 'redefinir digitada');
    ok(await asInstructor('/api/admin/reset-password').send({ email: student }), 'redefinir temporária');

    // MonitorPage: versão em maiúscula e liberar foco (a aplicação já foi encerrada pela
    // entrega; a rota responde pela regra, nunca pelo schema).
    const application = db.memory.examApplications.find(item => item.seedDemo === true && item.examKey === EXAM_KEY);
    screen('features/admin/MonitorPage.jsx', "api.post('/api/admin/assign-student-version', { studentEmail: email, examKey, applicationId, version: version.toUpperCase() })");
    const version = await asInstructor('/api/admin/assign-student-version').send({ studentEmail: student, examKey: EXAM_KEY, applicationId: application.id, version: 'B' });
    assert.ok(version.status < 500 && version.body.field === undefined, JSON.stringify(version.body));
    screen('features/admin/MonitorPage.jsx', "api.post('/api/admin/unlock-student-focus', { studentEmail: email, studentClass: className, courseId, examKey, applicationId })");
    const unlock = await asInstructor('/api/admin/unlock-student-focus').send({ studentEmail: student, studentClass: CLASS_NAME, courseId: COURSE_ID, examKey: EXAM_KEY, applicationId: application.id });
    assert.ok(unlock.status < 500 && unlock.body.field === undefined, JSON.stringify(unlock.body));

    // ProvasPage: salvar questão no banco (alternativas do editor, com isCorrect) e editar.
    screen('features/admin/ProvasPage.jsx', "category: editor.theme || activeModule?.name || 'Geral',");
    screen('features/admin/ProvasPage.jsx', "sourceExamKey: editor.key || null,");
    const alternatives = ['A', 'B', 'C', 'D'].map((letter, index) => ({ letter, text: `Alternativa ${letter} com acento é`, isCorrect: index === 2 }));
    const bank = ok(await asInstructor('/api/admin/question-bank/create').send({ category: 'Fundamentos de TI', questionText: 'Qual componente guarda a BIOS?\n\nEscolha uma.', alternatives, correctAnswer: 'C', sourceExamKey: null }), 'banco criar');
    const key = bank.body.question.key;
    screen('features/admin/ProvasPage.jsx', "api.post('/api/admin/question-bank/update', { key: bankEditor.key, category: bankEditor.category, questionText: bankEditor.questionText, alternatives: bankEditor.alternatives,");
    ok(await asInstructor('/api/admin/question-bank/update').send({ key, category: bank.body.question.category, questionText: bank.body.question.questionText, alternatives: bank.body.question.alternatives, correctAnswer: 'C' }), 'banco editar');
});

// ------------------------------------------------------------------ públicas e saída

test('[UC-ERRO-003] contrato das telas públicas: cadastro (com e sem responsável), recuperação, troca de senha do professor e Sair', async () => {
    // LoginPage: cadastro com o formulário inteiro; guardian só quando algo foi preenchido.
    screen('features/LoginPage.jsx', "const emptyGuardian = { name: '', phone: '', email: '', parentesco: '' }");
    // Desde o H8a-2 a tela manda a data de nascimento (obrigatória) e o id dos documentos
    // que mostrou (sem nada publicado, undefined, que o JSON não leva).
    screen('features/LoginPage.jsx', 'name, nomeSocial, email, password, phone, courseId, studentClass, birthDate,');
    screen('features/LoginPage.jsx', 'guardian: hasGuardian ? guardian : undefined,');
    screen('features/LoginPage.jsx', 'termsDocumentId: legalDocs?.terms?.documentId || undefined,');
    const register = body => request(app).post('/api/student/register').send(body);
    ok(await register({ name: 'Joana Lima', nomeSocial: '', email: 'joana.lima@teste.local', password: 'senha da Joana', phone: '', courseId: COURSE_ID, studentClass: CLASS_NAME, birthDate: '2000-03-15', acceptedTerms: true }), 'cadastro sem responsável');
    ok(await register({ name: 'Pedro Menor', nomeSocial: 'Pê', email: 'pedro.menor@teste.local', password: 'senha do Pedro', phone: '(11) 98888-7777', courseId: COURSE_ID, studentClass: CLASS_NAME, birthDate: '2012-05-10', guardian: { name: 'Maria Responsável', phone: '(11) 97777-6666', email: '', parentesco: 'Mãe' }, acceptedTerms: true }), 'cadastro com responsável');

    screen('features/LoginPage.jsx', "api.post('/api/student/recover', { email }, { auth: false })");
    ok(await request(app).post('/api/student/recover').send({ email: 'joana.lima@teste.local' }), 'recuperação');

    // Troca de senha do professor (PasswordChangeForm com a senha atual).
    ok(await asInstructor('/api/admin/change-password', 'professor').send({ currentPassword: PASSWORD, newPassword: 'Outra senha forte 2026' }), 'troca de senha do professor');

    // AuthProvider: Sair do aluno manda {} com keepalive.
    screen('context/AuthProvider.jsx', "api.post('/api/student/logout', {}, { keepalive: true })");
    // (com a conta recém-cadastrada: a do aluno de teste teve a senha redefinida acima.)
    screen('features/LoginPage.jsx', 'await loginStudent(email, password)');
    const joana = ok(await request(app).post('/api/student/login').send({ email: 'joana.lima@teste.local', password: 'senha da Joana' }), 'login depois do cadastro');
    ok(await request(app).post('/api/student/logout').set('x-session-token', joana.body.sessionToken).send({}), 'Sair do aluno');
});
