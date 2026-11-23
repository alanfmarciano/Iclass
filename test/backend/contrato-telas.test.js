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
    // Fase 3 (P3-S2): o campo de cada tipo fica em QuestionAnswer.jsx; a uma correta manda
    // o identificador da alternativa e o ExamRunner guarda { número: resposta }.
    screen('features/student/exam/QuestionAnswer.jsx', 'onClick={() => onChange(alt.id)}')
    screen('features/student/exam/ExamRunner.jsx', 'onChange={(value) => setAnswer(q.number, value)}')
    screen('features/student/exam/ExamRunner.jsx', 'else next[number] = value')
    const questions = (started.body.questions || []).map((question, index) => ({
        number: Number(question.originalNumber ?? question.number ?? index + 1),
        alternativeId: String(question.alternatives?.[0]?.id || '').toUpperCase(),
    }));
    const answers = {};
    for (const question of questions.slice(0, 2)) answers[question.number] = question.alternativeId;
    assert.equal(Object.keys(answers).length, 2, JSON.stringify(answers));

    screen('features/student/exam/ExamRunner.jsx', 'const payload = { email, studentClass, courseId, examKey, applicationId, attemptId: currentAttemptId, answers: snapshot }');
    screen('features/student/exam/ExamRunner.jsx', "await api.post('/api/student/autosave-progress', payload,");
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
    // ForumPage: modelos { id, title, text } com texto de até 5.000. O formulário só se
    // limpa depois de o servidor gravar (decisões §12, sobra do H9b): a tela guarda o
    // formulário em form e espera a promessa do setPref.
    screen('features/admin/ForumPage.jsx', "const saved = await setPref('forum.templates', [...templates, { id: 'tpl_' + Date.now(), title: form.title.trim(), text: form.text.trim() }])");
    screen('features/admin/ForumPage.jsx', "if (saved) setTplForm((current) => (current === form ? { title: '', text: '' } : current))");
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

    // AdminEditPage (papéis, B1 da fase 3): o corpo comum (e-mail, nome, papel, extras e o
    // escopo do papel: turmas para professor, escolas para Secretaria e Coordenação), mais
    // a senha e a troca no primeiro acesso na criação.
    screen('features/admin/AdminEditPage.jsx', "setForm({ name: '', email: '', password: '', requirePasswordChange: true, role: 'admin', assignedClasses: [], assignedSchoolIds: [], additionalPermissions: [] })");
    screen('features/admin/AdminEditPage.jsx', "const scopeFields = scope === 'turmas' ? { assignedClasses: form.assignedClasses } : scope === 'escolas' ? { assignedSchoolIds: form.assignedSchoolIds } : {}");
    screen('features/admin/AdminEditPage.jsx', "const common = { email: form.email, name: form.name, role: form.role, additionalPermissions: form.role === 'admin' ? [] : form.additionalPermissions, ...scopeFields }");
    screen('features/admin/AdminEditPage.jsx', "api.post('/api/admin/accounts/create', { ...common, password: form.password, requirePasswordChange: form.requirePasswordChange })");
    const newEmail = 'nova.professora@teste.local';
    ok(await asInstructor('/api/admin/accounts/create').send({ email: newEmail, name: 'Nova Professora', role: 'professor', additionalPermissions: [], assignedClasses: [{ courseId: COURSE_ID, className: CLASS_NAME }], password: 'Senha-forte-2026', requirePasswordChange: true }), 'criar conta');
    screen('features/admin/AdminEditPage.jsx', "api.post('/api/admin/accounts/update', common)");
    ok(await asInstructor('/api/admin/accounts/update').send({ email: newEmail, name: 'Nova Professora da Silva', role: 'professor', additionalPermissions: [], assignedClasses: [{ courseId: COURSE_ID, className: CLASS_NAME }] }), 'atualizar conta');
    const schoolOfCourse = (db.memory.courses || []).find(course => course.id === COURSE_ID)?.schoolId || 'escola_default';
    ok(await asInstructor('/api/admin/accounts/update').send({ email: newEmail, name: 'Nova Professora da Silva', role: 'secretaria', additionalPermissions: [], assignedSchoolIds: [schoolOfCourse] }), 'trocar para Secretaria');
    // Redefinir senha de outra conta (UXI-07, AccountPasswordDialogs.jsx): gerada ou digitada.
    screen('features/admin/AccountPasswordDialogs.jsx', "api.post('/api/admin/accounts/reset-password', mode === 'typed' ? { email, newPassword: typed } : { email })");
    const reset = ok(await asInstructor('/api/admin/accounts/reset-password').send({ email: newEmail }), 'redefinir senha gerada');
    assert.match(reset.body.temporaryPassword, /^[a-z0-9]{5}-[a-z0-9]{5}$/i);
    ok(await asInstructor('/api/admin/accounts/reset-password').send({ email: newEmail, newPassword: 'Outra-senha-forte-2026' }), 'redefinir senha digitada');
    // Minha conta (MinhaContaPage.jsx): nome e "Sair dos outros aparelhos".
    screen('features/admin/MinhaContaPage.jsx', "api.post('/api/admin/account/profile', { name: trimmed })");
    ok(await asInstructor('/api/admin/account/profile', 'professor').send({ name: 'Professor Contrato' }), 'mudar o próprio nome');
    screen('features/admin/MinhaContaPage.jsx', "api.post('/api/admin/account/end-other-sessions', {})");
    ok(await asInstructor('/api/admin/account/end-other-sessions', 'professor').send({}), 'sair dos outros aparelhos');
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
    // A versão sai do diálogo já aparada e em maiúscula (normalizeVersionInput, fase 3 C0a).
    screen('features/admin/MonitorPage.jsx', "api.post('/api/admin/assign-student-version', { studentEmail: actionDialog.email, examKey, applicationId, version })");
    screen('features/admin/MonitorPage.jsx', "return String(value ?? '').trim().toUpperCase().slice(0, VERSION_MAX_CHARS)");
    const version = await asInstructor('/api/admin/assign-student-version').send({ studentEmail: student, examKey: EXAM_KEY, applicationId: application.id, version: 'B' });
    assert.ok(version.status < 500 && version.body.field === undefined, JSON.stringify(version.body));
    screen('features/admin/MonitorPage.jsx', "api.post('/api/admin/unlock-student-focus', { studentEmail: email, studentClass: className, courseId, examKey, applicationId })");
    const unlock = await asInstructor('/api/admin/unlock-student-focus').send({ studentEmail: student, studentClass: CLASS_NAME, courseId: COURSE_ID, examKey: EXAM_KEY, applicationId: application.id });
    assert.ok(unlock.status < 500 && unlock.body.field === undefined, JSON.stringify(unlock.body));

    // ProvasPage e QuestionBankPanel: salvar questão no banco (o corpo do editor pelo
    // bankItemPayload, com os seis tipos desde o P3-S9a) e editar o item do banco.
    screen('features/admin/ProvasPage.jsx', "...bankItemPayload(question, { category: String(editor.theme || activeModule?.name || 'Geral').slice(0, THEME_MAX_CHARS) }),");
    // O Tema e a Categoria deixam digitar 500 caracteres (decisões §12, sobra do H9b).
    screen('features/admin/ProvasPage.jsx', 'const THEME_MAX_CHARS = 500');
    screen('features/admin/ProvasPage.jsx', '<Input label="Tema" value={editor.theme} maxLength={THEME_MAX_CHARS}');
    screen('features/admin/questionBankModel.js', 'export const BANK_CATEGORY_MAX = 500');
    screen('features/admin/QuestionBankPanel.jsx', 'label="Categoria" value={editing.category} maxLength={BANK_CATEGORY_MAX}');
    screen('features/admin/ProvasPage.jsx', "sourceExamKey: editor.key || null,");
    screen('features/admin/QuestionBankPanel.jsx', "api.post('/api/admin/question-bank/update', { key: editing.key, ...payload })");
    screen('features/admin/QuestionBankPanel.jsx', "api.post('/api/admin/question-bank/create', payload)");
    screen('features/admin/QuestionBankPanel.jsx', "api.post('/api/admin/question-bank/archive', { key: item.key, archived: !item.archived })");
    // O corpo que bankItemPayload monta (editorQuestionPayload + dificuldade, habilidades,
    // etiquetas e categoria), para os seis tipos.
    const bankBodies = [
        { type: 'multiple_choice', points: 1, text: 'Qual componente guarda a BIOS?\n\nEscolha uma.', alternatives: ['A', 'B', 'C', 'D'].map((letter, index) => ({ letter, text: `Alternativa ${letter} com acento é`, isCorrect: index === 2 })), correctAnswer: 'C' },
        { type: 'multiple_answer', points: 2, text: 'Quais?', alternatives: [{ letter: 'A', text: 'a', isCorrect: true }, { letter: 'B', text: 'b', isCorrect: true }], correctAnswers: ['A', 'B'], partialCredit: true },
        { type: 'true_false', points: 1, text: 'V?', correctAnswer: 'A' },
        { type: 'numeric', points: 1, text: 'N?', numeric: { value: 2.5, tolerance: 0 }, review: 'auto' },
        { type: 'short_answer', points: 1, text: 'C?', acceptedAnswers: ['ls'], review: 'auto' },
        { type: 'essay', points: 2, text: 'D?', expectedAnswer: '', rubric: [{ nome: 'Ideia', pontos: 2 }] },
    ].map(question => ({ ...question, explanation: '', difficulty: '', skills: [], tags: [], category: 'Fundamentos de TI' }));
    const bankKeys = [];
    for (const bankBody of bankBodies) {
        const created = ok(await asInstructor('/api/admin/question-bank/create').send({ ...bankBody, sourceExamKey: null }), `banco criar ${bankBody.type}`);
        bankKeys.push(created.body.question.key);
    }
    ok(await asInstructor('/api/admin/question-bank/update').send({ key: bankKeys[0], ...bankBodies[0], difficulty: 'media', tags: ['bios'] }), 'banco editar');
    ok(await asInstructor('/api/admin/question-bank/archive').send({ key: bankKeys[1], archived: true }), 'banco arquivar');
    ok(await asInstructor('/api/admin/question-bank/archive').send({ key: bankKeys[1], archived: false }), 'banco desarquivar');
    // Tema com o máximo da tela (500) vira a categoria: aceito; 501 é recusado com o campo.
    const longTheme = 'T'.repeat(500);
    const longBank = ok(await asInstructor('/api/admin/question-bank/create').send({ ...bankBodies[2], category: longTheme, sourceExamKey: null }), 'banco com tema de 500');
    assert.equal(longBank.body.question.category, longTheme);
    ok(await asInstructor('/api/admin/question-bank/update').send({ key: longBank.body.question.key, ...bankBodies[2], category: longTheme }), 'banco editar com 500');
    const tooLong = await asInstructor('/api/admin/question-bank/create').send({ ...bankBodies[2], category: 'T'.repeat(501) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.field, 'category');
});

// ------------------------------------------------------------------ públicas e saída

test('[UC-CURSO-002] contrato das telas de Turmas: disciplinas, assistente de horários e turma sem o período letivo não apagam a carga horária nem o período', async () => {
    // DisciplinasModal (TurmaPresencaConfig.jsx), desde o B8 / P2-S8: a lista inteira com
    // carga horária, professor e módulos, como a tela os mostrou (o valor gravado volta
    // igual; vazio apaga, porque é o que a pessoa vê). O assistente de horários manda a
    // lista do curso com as novas no fim. A tela de antes (bundle velho no navegador)
    // mandava só id, nome e cor: o campo ausente não apaga (B5 / P2-S7).
    const course = db.memory.courses.find(item => item.id === COURSE_ID);
    course.disciplinas = [
        { id: 'FUTEC', nome: 'Fundamentos de TI', cor: '#4f9bf5', cargaHoraria: 80, professor: 'Profa. Ana', modulos: ['FUTEC'] },
        { id: 'FECOP', nome: 'Colaboração e Produtividade', cor: '#33c579' },
    ];
    screen('features/admin/TurmaPresencaConfig.jsx', `clean.push({
        id,
        nome,
        cor: d.cor || '',
        cargaHoraria: carga === '' || carga === null ? null : carga,
        professor: String(d.professor || '').trim(),
        modulos: [...new Set(d.modulos || [])],
      })`);
    screen('features/admin/TurmasPage.jsx', "api.post('/api/admin/course/disciplinas', { courseId: selectedCourse.id, disciplinas })");
    const fromScreen = ok(await asInstructor('/api/admin/course/disciplinas').send({ courseId: COURSE_ID, disciplinas: [
        { id: 'FUTEC', nome: 'Fundamentos de TI', cor: '#4f9bf5', cargaHoraria: 80, professor: 'Profa. Ana', modulos: ['FUTEC'] },
        { id: 'FECOP', nome: 'Colaboração e Produtividade', cor: '#33c579', cargaHoraria: null, professor: '', modulos: ['FECOP'] },
        { id: 'IRCOM', nome: 'Instalação de Rec. Comp.', cor: '', cargaHoraria: 2000, professor: 'P'.repeat(80), modulos: [] },
    ] }), 'disciplinas pela tela de Turmas');
    assert.deepEqual(fromScreen.body.disciplinas[0], { id: 'FUTEC', nome: 'Fundamentos de TI', cor: '#4f9bf5', cargaHoraria: 80, professor: 'Profa. Ana', modulos: ['FUTEC'] });
    assert.deepEqual(fromScreen.body.disciplinas[1], { id: 'FECOP', nome: 'Colaboração e Produtividade', cor: '#33c579', modulos: ['FECOP'] });
    assert.deepEqual(fromScreen.body.disciplinas[2], { id: 'IRCOM', nome: 'Instalação de Rec. Comp.', cor: '', cargaHoraria: 2000, professor: 'P'.repeat(80) });
    const saved = ok(await asInstructor('/api/admin/course/disciplinas').send({ courseId: COURSE_ID, disciplinas: [
        { id: 'FUTEC', nome: 'Fundamentos de TI', cor: '#4f9bf5' },
        { id: 'FECOP', nome: 'Colaboração e Produtividade', cor: '#33c579' },
        { id: 'IRCOM', nome: 'Instalação de Rec. Comp.', cor: '' },
    ] }), 'disciplinas pela tela antiga');
    assert.deepEqual(saved.body.disciplinas[0], { id: 'FUTEC', nome: 'Fundamentos de TI', cor: '#4f9bf5', cargaHoraria: 80, professor: 'Profa. Ana', modulos: ['FUTEC'] });
    assert.deepEqual(saved.body.disciplinas[2], { id: 'IRCOM', nome: 'Instalação de Rec. Comp.', cor: '', cargaHoraria: 2000, professor: 'P'.repeat(80) });
    screen('features/admin/AssistenteHorariosPage.jsx', "api.post('/api/admin/course/disciplinas', { courseId: course.id, disciplinas: [...(course.disciplinas || []), ...newDisciplinas] })");
    const wizard = ok(await asInstructor('/api/admin/course/disciplinas').send({ courseId: COURSE_ID, disciplinas: [...saved.body.disciplinas, { id: 'LOGICA', nome: 'Lógica', cor: '' }] }), 'disciplinas pelo assistente');
    assert.equal(wizard.body.disciplinas[0].cargaHoraria, 80);
    assert.deepEqual(wizard.body.disciplinas[0].modulos, ['FUTEC']);

    // Formulário da turma (TurmasPage.jsx) sem periodoLetivoId: a turma fica no período.
    db.memory.academicTerms = [{ id: 'per_contrato', schemaVersion: 1, nome: '2027 · 1º semestre', inicio: '2027-02-01', fim: '2027-07-09', schoolId: null, etapas: [], situacao: 'aberto' }];
    const cls = db.memory.classes.find(item => item.name === CLASS_NAME && item.courseId === COURSE_ID);
    cls.periodoLetivoId = 'per_contrato';
    // Desde o B8 a tela só manda periodoLetivoId quando o seletor mudou (term vazio = sem o campo).
    screen('features/admin/TurmasPage.jsx', "const term = (classForm.periodoLetivoId || '') !== (classForm.periodoLetivoInicial || '') ? { periodoLetivoId: classForm.periodoLetivoId || null } : {}");
    screen('features/admin/TurmasPage.jsx', "api.post('/api/admin/class/update', { name: classForm.name, period: classForm.period, registrationEnabled: classForm.registrationEnabled, courseId: selectedCourse.id, attendanceConfig, ...term })");
    ok(await asInstructor('/api/admin/class/update').send({ name: CLASS_NAME, period: cls.period || 'Manhã', registrationEnabled: true, courseId: COURSE_ID, attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} } }), 'turma pela tela');
    assert.equal(db.memory.classes.find(item => item.name === CLASS_NAME && item.courseId === COURSE_ID).periodoLetivoId, 'per_contrato');
    screen('features/admin/AssistenteHorariosPage.jsx', "api.post('/api/admin/class/update', { name: turma.name, courseId: course.id, attendanceConfig })");
    ok(await asInstructor('/api/admin/class/update').send({ name: CLASS_NAME, courseId: COURSE_ID, attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} } }), 'grade pelo assistente');
    assert.equal(db.memory.classes.find(item => item.name === CLASS_NAME && item.courseId === COURSE_ID).periodoLetivoId, 'per_contrato');
    screen('features/admin/TurmasPage.jsx', "api.post('/api/admin/class/create', { name: classForm.name, period: classForm.period, courseId: selectedCourse.id, attendanceConfig, ...term })");
    ok(await asInstructor('/api/admin/class/create').send({ name: '9CTR', period: 'Noite', courseId: COURSE_ID, attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} } }), 'turma nova pela tela');
    assert.equal('periodoLetivoId' in db.memory.classes.find(item => item.name === '9CTR'), false, 'turma nova sem período, como sempre');
    // Com o período escolhido no seletor (o id do período, ou null para tirar).
    ok(await asInstructor('/api/admin/class/create').send({ name: '9CTS', period: 'Noite', courseId: COURSE_ID, attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} }, periodoLetivoId: 'per_contrato' }), 'turma nova no período pela tela');
    assert.equal(db.memory.classes.find(item => item.name === '9CTS').periodoLetivoId, 'per_contrato');
    ok(await asInstructor('/api/admin/class/update').send({ name: '9CTS', period: 'Noite', registrationEnabled: true, courseId: COURSE_ID, attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} }, periodoLetivoId: null }), 'tirar do período pela tela');
    assert.equal('periodoLetivoId' in db.memory.classes.find(item => item.name === '9CTS'), false);
    // A seção Períodos letivos (AcademicTermsSection.jsx) cria e altera com o formulário inteiro.
    screen('features/admin/AcademicTermsSection.jsx', "etapas: form.etapas.map((stage, index) => ({ ordem: index + 1, nome: stage.nome.trim(), inicio: stage.inicio, fim: stage.fim })),");
    screen('features/admin/AcademicTermsSection.jsx', "await api.post('/api/admin/academic/terms/create', payload)");
    const term = ok(await asInstructor('/api/admin/academic/terms/create').send({ nome: 'N'.repeat(80), inicio: '2027-08-02', fim: '2027-12-17', schoolId: null, etapas: [
        { ordem: 1, nome: 'E'.repeat(40), inicio: '2027-08-02', fim: '2027-10-08' },
        { ordem: 2, nome: '', inicio: '2027-10-11', fim: '2027-12-17' },
    ] }), 'período pela tela');
    assert.equal(term.body.periodo.etapas[1].nome, '2ª etapa', 'etapa sem nome ganha o nome padrão');
    screen('features/admin/AcademicTermsSection.jsx', "await api.post('/api/admin/academic/terms/update', { id: form.id, ...payload })");
    ok(await asInstructor('/api/admin/academic/terms/update').send({ id: term.body.periodo.id, nome: 'N'.repeat(80), inicio: '2027-08-02', fim: '2027-12-17', schoolId: null, etapas: [] }), 'alterar período pela tela');
    screen('features/admin/AcademicTermsSection.jsx', "await api.post('/api/admin/academic/terms/close', { id: closing.id, ...(reason ? { reason } : {}) })");
    ok(await asInstructor('/api/admin/academic/terms/close').send({ id: term.body.periodo.id, reason: 'R'.repeat(500) }), 'encerrar pela tela');
    screen('features/admin/AcademicTermsSection.jsx', "await api.post('/api/admin/academic/terms/reopen', { id: reopening.id, reason })");
    ok(await asInstructor('/api/admin/academic/terms/reopen').send({ id: term.body.periodo.id, reason: 'R'.repeat(500) }), 'reabrir pela tela');
});

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

// ------------------------------------------------------------------ guardas do código das telas (fase 3, C0a)

// Arquivos de código das telas (sem os testes), com o caminho relativo a web/src.
function screenSources(dir) {
    const root = path.join(WEB_SRC, dir);
    const out = [];
    const walk = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(?:js|jsx)$/.test(entry.name) && !/\.test\.(?:js|jsx)$/.test(entry.name)) {
                out.push({ file: path.relative(WEB_SRC, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') });
            }
        }
    };
    walk(root);
    return out;
}

function lineOf(text, index) {
    return text.slice(0, index).split('\n').length;
}

// Argumentos de uma chamada a partir do '(' (conta parênteses, ignora o que está entre aspas).
function callArguments(text, openIndex) {
    let depth = 0;
    let quote = null;
    for (let i = openIndex; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') { i += 1; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '(') depth += 1;
        else if (ch === ')') {
            depth -= 1;
            if (depth === 0) return text.slice(openIndex + 1, i);
        }
    }
    return text.slice(openIndex + 1);
}

// Busca que diferencia acento e ordem que não é a do português (CRIT-07).
function textSearchViolations({ file, text }) {
    const found = [];
    const lowerIncludes = /\.to(?:Locale)?LowerCase\([^()]*\)\s*\.includes\(/g;
    let match;
    while ((match = lowerIncludes.exec(text))) found.push(`${file}:${lineOf(text, match.index)} busca com toLowerCase().includes (use matchesSearch)`);
    const locale = /\.localeCompare\s*\(/g;
    while ((match = locale.exec(text))) {
        const args = callArguments(text, match.index + match[0].length - 1);
        if (!/['"]pt-BR['"]/.test(args)) found.push(`${file}:${lineOf(text, match.index)} localeCompare sem 'pt-BR' (use compareText)`);
    }
    return found;
}

test('[UC-BUSCA-002] guarda: nenhuma busca com toLowerCase().includes nem localeCompare sem pt-BR em web/src/features', () => {
    // A guarda pega os padrões antigos (para não passar por não achar nada).
    assert.equal(textSearchViolations({ file: 't.jsx', text: "rows.filter((x) => String(x[k]).toLowerCase().includes(q.toLowerCase()))" }).length, 1);
    assert.equal(textSearchViolations({ file: 't.jsx', text: "`${a} ${b}`.toLocaleLowerCase('pt-BR').includes(query)" }).length, 1);
    assert.equal(textSearchViolations({ file: 't.jsx', text: 'list.sort((a, b) => a.letter.localeCompare(b.letter))' }).length, 1);
    assert.equal(textSearchViolations({ file: 't.jsx', text: "list.sort((a, b) => String(a.x || '').localeCompare(String(b.x || '')))" }).length, 1);
    assert.equal(textSearchViolations({ file: 't.jsx', text: "list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))" }).length, 0);
    assert.equal(textSearchViolations({ file: 't.jsx', text: 'matchesSearch([a.name, a.email], query)' }).length, 0);

    const violations = screenSources('features').flatMap(textSearchViolations);
    assert.deepEqual(violations, [], `use web/src/lib/textSearch.js (normalizeSearch, matchesSearch, compareText):\n${violations.join('\n')}`);

    // A tabela padrão busca e ordena pela regra única.
    const table = fs.readFileSync(path.join(WEB_SRC, 'components', 'ui', 'Table.jsx'), 'utf8');
    assert.match(table, /import \{[^}]*\bcompareText\b[^}]*\bmatchesSearch\b[^}]*\} from '..\/..\/lib\/textSearch'/);
    assert.deepEqual(textSearchViolations({ file: 'components/ui/Table.jsx', text: table }), []);
});

// Caixas do navegador (window.confirm, prompt e alert) congelam a página (o polling para)
// e não dizem o que vai acontecer: tela tocada na fase 3 usa o ConfirmDialog
// (web/src/components/ui/ConfirmDialog.jsx, contrato C12 do P3). As que ainda existem
// estão na lista abaixo, com quantas há em cada arquivo; a lista só diminui (a Biblioteca,
// o Fórum, o Monitor e Provas do professor saíram no C0a; Resultados, no P3-S8; o
// assistente de horários, em TurmaPresencaConfig.jsx, no B8). Arquivo novo ou chamada nova
// reprova. E, onde há o histórico do git, arquivo da lista que mudou desde o começo da
// fase 3 (PHASE3_BASE) também reprova: quem toca a tela troca as caixas dela.
const NATIVE_DIALOGS_LEFT = {
    'features/admin/EditorPage.jsx': 2,
};
// Exceções combinadas no plano (a tela muda antes de quem troca a caixa dela).
// A K15 (ResultadosPage até o P3-S8) acabou: o confirm das questões em branco virou o
// ConfirmDialog no P3-S8.
const NATIVE_DIALOGS_TOUCH_EXCEPTIONS = {};
// Main de onde a fase 3 partiu (281029f, 18/11/2026).
const PHASE3_BASE = '281029f1846543c2b33b181f6d9a9bb304aa6f0a';

// Arquivos da lista que mudaram desde PHASE3_BASE (conteúdo da pasta, com o que ainda não
// foi para commit). null quando não há git ou o commit não está no clone (pacote de
// release, clone raso): aí vale só a lista.
function filesChangedSincePhase3(files) {
    const repo = path.join(__dirname, '..', '..');
    const { spawnSync } = require('node:child_process');
    const known = spawnSync('git', ['-C', repo, 'cat-file', '-e', `${PHASE3_BASE}^{commit}`], { encoding: 'utf8' });
    if (known.error || known.status !== 0) return null;
    const diff = spawnSync('git', ['-C', repo, 'diff', '--name-only', PHASE3_BASE, '--', ...files.map(file => `web/src/${file}`)], { encoding: 'utf8' });
    if (diff.error || diff.status !== 0) return null;
    return diff.stdout.split(/\r?\n/).filter(Boolean).map(file => file.replace(/^web\/src\//, ''));
}

function nativeDialogCalls({ text }) {
    const calls = [];
    const pattern = /(^|[^\w.$])(window\.)?(confirm|prompt|alert)\s*\(/g;
    let match;
    while ((match = pattern.exec(text))) {
        const name = match[3];
        const start = match.index + match[1].length;
        if (!match[2]) {
            // 'function confirm(' é uma função da própria tela, não a caixa do navegador;
            // e, se a tela tem a sua, a chamada sem 'window.' é dela.
            if (/function\s+$/.test(text.slice(Math.max(0, start - 20), start))) continue;
            if (new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`).test(text)) continue;
        }
        calls.push(lineOf(text, start));
    }
    return calls;
}

test('[UC-CONFIRMACAO-001] guarda: nenhuma caixa nova do navegador (confirm, prompt, alert) nas telas', () => {
    assert.deepEqual(nativeDialogCalls({ text: "if (!confirm('Excluir?')) return" }).length, 1);
    assert.deepEqual(nativeDialogCalls({ text: "const t = window.prompt('Texto')" }).length, 1);
    assert.deepEqual(nativeDialogCalls({ text: "window.alert('x')" }).length, 1);
    assert.deepEqual(nativeDialogCalls({ text: 'async function confirm() {}\n<Button onClick={() => confirm()} />' }).length, 0);
    assert.deepEqual(nativeDialogCalls({ text: 'dialog.confirm(); onConfirm(); setConfirm(null)' }).length, 0);

    const problems = [];
    for (const source of screenSources('')) {
        const lines = nativeDialogCalls(source);
        const allowed = NATIVE_DIALOGS_LEFT[source.file] || 0;
        if (lines.length > allowed) problems.push(`${source.file}: ${lines.length} (linhas ${lines.join(', ')}); o máximo é ${allowed}`);
    }
    assert.deepEqual(problems, [], `use o ConfirmDialog (web/src/components/ui/ConfirmDialog.jsx):\n${problems.join('\n')}`);
    // As telas tocadas no C0a não usam mais as caixas do navegador.
    for (const file of ['features/admin/BibliotecaPage.jsx', 'features/admin/ForumPage.jsx', 'features/admin/MonitorPage.jsx', 'features/admin/ProvasPage.jsx', 'features/admin/QuestionEditor.jsx', 'features/admin/QuestionBankPanel.jsx', 'features/admin/ResultadosPage.jsx']) {
        assert.equal(nativeDialogCalls({ text: fs.readFileSync(path.join(WEB_SRC, file), 'utf8') }).length, 0, file);
        assert.equal(NATIVE_DIALOGS_LEFT[file], undefined, file);
    }
});

test('[UC-CONFIRMACAO-001] guarda: tela com caixa do navegador que mudou na fase 3 troca as caixas pelo ConfirmDialog', (t) => {
    for (const file of Object.keys(NATIVE_DIALOGS_TOUCH_EXCEPTIONS)) assert.ok(NATIVE_DIALOGS_LEFT[file], file);
    const changed = filesChangedSincePhase3(Object.keys(NATIVE_DIALOGS_LEFT));
    if (changed === null) {
        t.diagnostic(`sem o histórico do git até ${PHASE3_BASE.slice(0, 7)}: vale só a lista NATIVE_DIALOGS_LEFT`);
        return;
    }
    const problems = changed
        .filter(file => !NATIVE_DIALOGS_TOUCH_EXCEPTIONS[file])
        .map(file => ({ file, lines: nativeDialogCalls({ text: fs.readFileSync(path.join(WEB_SRC, file), 'utf8') }) }))
        .filter(item => item.lines.length > 0)
        .map(item => `${item.file}: mudou na fase 3 e ainda tem ${item.lines.length} (linhas ${item.lines.join(', ')}); troque pelo ConfirmDialog e tire o arquivo de NATIVE_DIALOGS_LEFT`);
    assert.deepEqual(problems, []);
});
