// Turma encerrada: o portão único das gravações de nota e presença (fundação C0b da
// fase 3; X4 do plano, contrato de backend/utils/academicCalendar.js).
//
// assertClassOpen nasceu sem efeito na fundação C0b para as rotas de hoje já o chamarem
// antes de gravar; o B10 (P2-S9) ligou o efeito: turma encerrada (classes[].encerramento
// com 'em' e sem reabertura) responde 409 class_closed. Este teste:
// 1) 'rota que grava nota ou presença chama assertClassOpen': cada rota da lista chama a
//    função antes da primeira gravação; e nenhuma outra rota de backend/routes grava nota
//    (submissions) ou presença (attendance) sem chamar, a não ser as de FORA_DO_PORTAO,
//    cada uma com o motivo. Vale também a gravação por função auxiliar: o teste acha
//    sozinho as funções de backend/utils e de fora das rotas em backend/routes que gravam
//    (direto ou chamando outra que grava) e trata a chamada delas como gravação. Rota nova
//    que grava nota, presença, diário, correção, gabarito, anulação, importação de notas
//    ou tarefa ganha linha em ROTAS_QUE_GRAVAM e no PERCURSO do teste de 409;
// 2) com efeito: a função recusa a turma encerrada e deixa a aberta e a reaberta;
// 3) o percurso: cada rota de ROTAS_QUE_GRAVAM, numa turma encerrada de verdade, responde
//    409 class_closed sem gravar nada; reabrir a turma (com motivo) libera.
//
// Revisão da lista FORA_DO_PORTAO no B10 (pendência da J2): as rotas que gravam nota de
// forma indireta, ao entregar a tentativa vencida ou encerrar a prova em andamento, foram
// decididas uma a uma (também em docs/API.md, "Turma encerrada"):
// - passaram a chamar o portão: control e server-exam-control (só abrir, retomar, pausar e
//   mexer na sala de espera; encerrar e cancelar passam, porque entregam o que os alunos
//   já fizeram e recusar deixaria a prova aberta), time-adjustment e adjust-student-time
//   (tempo a mais devolve entrega à prova) e start-attempt (a prova não aceita tentativa);
// - continuam fora, com o motivo abaixo: access-token, monitor-status, reset, sync,
//   validate-exam-token, submit, login e ping. O encerramento recusa turma com prova
//   aberta ou agendada (class/close), e com o portão em control e start-attempt a turma
//   encerrada não tem aplicação aberta: essas rotas só entregam o que já estava em
//   andamento, e recusar perderia as respostas do aluno.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-class-open-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const calendar = require('../../backend/utils/academicCalendar.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');
const assignments = require('../../backend/utils/assignments.js');

const ROUTES_DIR = path.join(__dirname, '../../backend/routes');

// Rotas que gravam nota ou presença e chamam assertClassOpen antes de gravar.
// [arquivo, método, caminho]
const ROTAS_QUE_GRAVAM = [
    ['admin.js', 'POST', '/api/admin/submissions/result-control'],
    ['admin.js', 'POST', '/api/admin/submissions/publish'],
    ['admin.js', 'POST', '/api/admin/submissions/delete'],
    ['admin.js', 'POST', '/api/admin/submissions/restore'],
    ['admin.js', 'POST', '/api/admin/submissions/create'],
    ['admin.js', 'POST', '/api/admin/student/attendance/mark'],
    ['admin.js', 'POST', '/api/admin/attendance/bulk'],
    // Recorrigem as entregas da aplicação (regradeApplicationSubmissions).
    ['adminExamConfig.js', 'POST', '/api/admin/correct-live-question'],
    ['adminExamConfig.js', 'POST', '/api/admin/annul-question'],
    ['adminExamConfig.js', 'POST', '/api/admin/replace-question'],
    // Ações por aluno do Monitor (A4, P3-S8): recolher e reabrir mexem em entrega e nota.
    ['adminExamConfig.js', 'POST', '/api/admin/exam-applications/:applicationId/attempt-action'],
    // Corrigir o gabarito depois da prova (A8, P3-S6) recorrige as entregas da aplicação.
    ['adminExamConfig.js', 'POST', '/api/admin/exam-applications/:applicationId/answer-key-correction'],
    // Controle da aplicação (B10): abrir, retomar, pausar e a sala de espera passam pelo
    // portão; encerrar e cancelar não (entregam o que os alunos fizeram: controlActionCloses).
    ['adminExamConfig.js', 'POST', '/api/admin/exam-applications/:applicationId/control'],
    ['admin.js', 'POST', '/api/admin/server-exam-control'],
    // Tempo a mais (B10): devolve à prova a entrega do fim do tempo (mexe em nota).
    ['adminExamConfig.js', 'POST', '/api/admin/exam-applications/:applicationId/time-adjustment'],
    ['admin.js', 'POST', '/api/admin/adjust-student-time'],
    // Começar a tentativa (B10): a prova da turma encerrada não aceita tentativa ("Esta
    // turma foi encerrada: a prova não aceita mais tentativas.").
    ['student.js', 'POST', '/api/student/exam-applications/:applicationId/start-attempt'],
    // Correção manual no servidor (A9, P3-S4a): grava pontos, comentários e a conclusão
    // da correção e recalcula a nota da entrega.
    ['adminCorrections.js', 'POST', '/api/admin/submissions/:id/correction'],
    // Dias não letivos (B3 / P2-S5): o dia de uma turma marca a presença do login dela
    // (naoLetivoId); a turma do dia (de antes e de depois, no update) passa pelo portão.
    // O dia de curso, escola ou instituição chama com null (vale para muitas turmas; a
    // encerrada fica de fora da marca, syncNonSchoolDayMarks olha isClassClosed).
    ['adminAcademic.js', 'POST', '/api/admin/calendar/non-school-days/create'],
    ['adminAcademic.js', 'POST', '/api/admin/calendar/non-school-days/update'],
    ['adminAcademic.js', 'POST', '/api/admin/calendar/non-school-days/delete'],
    // Feriados nacionais: dia de instituição, passa pelo portão sem turma (dayClass null).
    ['adminAcademic.js', 'POST', '/api/admin/calendar/non-school-days/national-holidays'],
    // Tarefas (fase 3, C5 / P1-c): o envio do aluno grava a versão da entrega; turma
    // encerrada recusa com 409 class_closed ("O envio não é mais aceito.").
    ['studentAssignments.js', 'POST', '/api/student/assignments/:id/submit'],
    // Tarefas (fase 3, C6 / P1-d): nota (salvar, devolver e refazer), "devolver todas",
    // entrega em mãos e prorrogação gravam a entrega; turma encerrada recusa com 409.
    ['adminAssignments.js', 'POST', '/api/admin/assignments/:id/grade'],
    ['adminAssignments.js', 'POST', '/api/admin/assignments/:id/return-all'],
    ['adminAssignments.js', 'POST', '/api/admin/assignments/:id/manual-entry'],
    ['adminAssignments.js', 'POST', '/api/admin/assignments/:id/extension'],
    // Plano de avaliação e avaliações manuais (B6 / P2-S3): etapa, peso, recuperação e
    // "fora da média" mudam a média; arquivar tira a nota da média (saveClassPlan).
    ['adminGrading.js', 'POST', '/api/admin/grading/plan'],
    ['adminGrading.js', 'POST', '/api/admin/grading/manual-items/create'],
    ['adminGrading.js', 'POST', '/api/admin/grading/manual-items/update'],
    ['adminGrading.js', 'POST', '/api/admin/grading/manual-items/archive'],
    ['adminGrading.js', 'POST', '/api/admin/grading/manual-items/restore'],
    // Diário de classe (B11 / P4-S7): o conteúdo de cada aula do dia da turma.
    ['adminDiary.js', 'POST', '/api/admin/attendance/diary'],
];

// Rotas que gravam entregas ou presença e não passam pelo portão, com o motivo (revisto no
// B10, ver o começo do arquivo).
// [arquivo, método, caminho, motivo]
const FORA_DO_PORTAO = [
    ['student.js', 'POST', '/api/student/login', 'presença automática do login: é o aluno entrando, não lançamento do professor; desde o B10 a turma encerrada fica de fora (ensureDailyLoginAttendance olha isClassClosed), sem recusar o login'],
    ['student.js', 'GET', '/api/ping', 'mesma presença automática do login, para a sessão que já estava aberta; a turma encerrada fica de fora sem recusar o ping'],
    ['student.js', 'POST', '/api/student/submit', 'entrega da prova pelo aluno: só existe com aplicação aberta, e o encerramento da turma não deixa aplicação aberta (class/close recusa e control recusa abrir); recusar perderia as respostas. O único caminho que muda nota depois do fim, o envio automático atrasado que troca a entrega do servidor (replaceServerFinalization, dentro de LATE_AUTO_SUBMIT_TOLERANCE_MS), não troca na turma encerrada: o aluno recebe a confirmação de sempre e a entrega do servidor fica (teste em exam-attempt-lifecycle.test.js)'],
    ['adminExamConfig.js', 'POST', '/api/admin/exam-applications/:applicationId/access-token', 'token novo da aplicação em andamento: a gravação parcial do Monitor leva as entregas na lista, mas a rota não mexe em nota; turma encerrada não tem aplicação em andamento'],
    ['admin.js', 'GET', '/api/admin/monitor-status/:class/:examKey', 'entrega automática da tentativa vencida pelo fim do tempo (settleExpiredAttempts), como o envio do aluno; só existe com aplicação aberta, e recusar a leitura do Monitor deixaria a tentativa sem entregar'],
    ['adminSystem.js', 'POST', '/api/admin/reset', 'o reset da sala encerra a prova em andamento entregando o que os alunos fizeram (com backup antes); recusar deixaria a prova aberta'],
    ['proctoring.js', 'POST', '/api/student/validate-exam-token', 'entrega automática da tentativa vencida pelo fim do tempo antes de validar o token; só existe com aplicação aberta, e a tentativa nova é recusada depois pelo start-attempt'],
    ['student.js', 'GET', '/api/student/sync', 'entrega automática da tentativa vencida pelo fim do tempo (settleStudentAttempt), como o envio do aluno; recusar perderia as respostas'],
    ['adminStudentRecords.js', 'POST', '/api/admin/students/anonymize', 'anonimizar o aluno encerrado troca o nome nas notas e na presença pelo pseudônimo; não muda nota nem presença'],
    ['adminStudentRecords.js', 'POST', '/api/admin/students/purge', 'apagar de vez o aluno encerrado (decisão do administrador, com motivo) tira o que é dele; não é mudança de nota da turma'],
    ['testmode.js', 'POST', '/api/test/seed', 'dados de demonstração do TEST_MODE; não existe no computador da escola'],
    ['adminArchive.js', 'POST', '/api/admin/courses/:id/purge', 'arquivar o curso inteiro leva as notas para o pacote do curso; não é mudança de nota'],
    ['adminArchive.js', 'POST', '/api/admin/archived-courses/restore', 'restaurar o curso arquivado devolve as notas como estavam'],
];

// Sinais de gravação de nota ou presença feita ali mesmo (no corpo de uma rota ou de uma
// função auxiliar).
const DIRECT_WRITE_MARKERS = [
    /writeJSON\(\s*DB_SUBMISSIONS_FILE/,
    /\.submissions\.push\(/,
    /\.submissions\s*=\s*(?!\s*\[\s*\])/,
    /\.attendance\.push\(/,
    /\.attendance\s*=\s*(?!\s*\[\s*\])/,
    /\.(?:submissions|attendance)\.splice\(/,
    /only:\s*\[[^\]]*['"](?:submissions|attendance)['"]/,
    // Linha antiga de coleção que só cresce gravada pela lista de mudadas (changed).
    /changed\s*[:=]\s*\{\s*['"]?(?:submissions|attendance)\b/,
    /saveApplicationAction\(/,
    // Nota mudada no registro da entrega (recorreção, troca da finalização do servidor).
    /\bsubmission\.score\s*=(?!=)/,
    // Entregas de tarefa (fase 3, P1): versão do aluno, nota, devolução, refazer e entrega
    // em mãos gravam em assignmentSubmissions.
    /\.assignmentSubmissions\.(?:push|splice)\(/,
    /only:\s*\[[^\]]*['"]assignmentSubmissions['"]/,
    // Plano de avaliação da turma e avaliações manuais (B6): gravam classes[].avaliacao.
    /\bsaveClassPlan\(/,
    // Diário de classe (B11): o documento do dia da turma em classDiary.
    /\.classDiary\.(?:push|splice)\(/,
    /only:\s*\[[^\]]*['"]classDiary['"]/,
];

const UTILS_DIR = path.join(__dirname, '../../backend/utils');

// Funções de nível de topo de um arquivo: do 'function nome(' até a primeira '}' na
// coluna 0.
function topLevelFunctions(file) {
    const text = fs.readFileSync(file, 'utf8');
    const out = [];
    const start = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;
    let match;
    while ((match = start.exec(text))) {
        const close = text.indexOf('\n}', match.index);
        out.push({ file, name: match[1], body: text.slice(match.index, close === -1 ? text.length : close + 2) });
    }
    return out;
}

const hasDirectWrite = body => DIRECT_WRITE_MARKERS.some(marker => marker.test(body));
const callsName = (body, name) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\(|\\.${name.replace(/\$/g, '\\$')}\\(`).test(body);

// Funções auxiliares (backend/utils e as de fora das rotas em backend/routes) que gravam
// nota ou presença, direto ou chamando outra que grava (fecho transitivo). Assim uma rota
// que grava por função auxiliar (encerrar a aplicação, recorrigir, entregar a tentativa
// vencida) também aparece, sem lista escrita à mão.
function writerHelpers() {
    const files = [
        ...fs.readdirSync(UTILS_DIR).filter(name => name.endsWith('.js')).map(name => path.join(UTILS_DIR, name)),
        ...fs.readdirSync(ROUTES_DIR).filter(name => name.endsWith('.js')).map(name => path.join(ROUTES_DIR, name)),
    ];
    // A fábrica de rotas (createXRouter) é o arquivo inteiro de rotas, não uma auxiliar.
    const functions = files.flatMap(topLevelFunctions).filter(fn => !/^[ \t]*router\.(get|post|put|patch|delete)\(/m.test(fn.body));
    const writers = new Set(functions.filter(fn => hasDirectWrite(fn.body)).map(fn => fn.name));
    let grew = true;
    while (grew) {
        grew = false;
        functions.forEach(fn => {
            if (writers.has(fn.name)) return;
            if ([...writers].some(name => callsName(fn.body, name))) { writers.add(fn.name); grew = true; }
        });
    }
    return writers;
}

const WRITER_HELPERS = writerHelpers();

const ROUTE_START = /^[ \t]*router\.(get|post|put|patch|delete)\(\s*(?:\[\s*)?['"]([^'"]+)['"]/gm;

// Corpo de cada rota: do router.<método>('<caminho>' até a próxima rota do arquivo ou a
// próxima função de nível de topo (a função auxiliar entre duas rotas não é da rota).
function routeHandlers() {
    const out = [];
    fs.readdirSync(ROUTES_DIR).filter(name => name.endsWith('.js')).sort().forEach(file => {
        const text = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
        const starts = [...text.matchAll(ROUTE_START)];
        starts.forEach((match, index) => {
            let end = index + 1 < starts.length ? starts[index + 1].index : text.length;
            const helper = /^(?:async\s+)?function\s/m.exec(text.slice(match.index, end));
            if (helper) end = match.index + helper.index;
            out.push({ file, method: match[1].toUpperCase(), path: match[2], body: text.slice(match.index, end) });
        });
    });
    return out;
}

const routeKey = (file, method, route) => `${file} ${method} ${route}`;

// Primeira gravação de nota ou presença no corpo da rota: direta ou chamada de uma função
// de WRITER_HELPERS.
function firstWriteIndex(body) {
    const markers = [
        ...DIRECT_WRITE_MARKERS,
        ...[...WRITER_HELPERS].map(name => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\(|\\.${name.replace(/\$/g, '\\$')}\\(`)),
    ];
    const found = markers.map(marker => {
        const match = marker.exec(body);
        return match ? match.index : -1;
    }).filter(index => index >= 0);
    return found.length ? Math.min(...found) : -1;
}

test('[UC-FUNDACAO-004] rota que grava nota ou presença chama assertClassOpen', () => {
    const handlers = routeHandlers();
    const byKey = new Map(handlers.map(handler => [routeKey(handler.file, handler.method, handler.path), handler]));
    const required = new Set(ROTAS_QUE_GRAVAM.map(([file, method, route]) => routeKey(file, method, route)));
    const exempt = new Map(FORA_DO_PORTAO.map(([file, method, route, reason]) => [routeKey(file, method, route), reason]));

    ROTAS_QUE_GRAVAM.forEach(([file, method, route]) => {
        const handler = byKey.get(routeKey(file, method, route));
        assert.ok(handler, `rota da lista não encontrada: ${routeKey(file, method, route)}`);
        const call = handler.body.search(/assertClassOpen\(/);
        assert.ok(call >= 0, `${routeKey(file, method, route)} não chama assertClassOpen`);
        const write = firstWriteIndex(handler.body);
        assert.ok(write === -1 || call < write, `${routeKey(file, method, route)} grava antes de chamar assertClassOpen`);
    });

    FORA_DO_PORTAO.forEach(([file, method, route, reason]) => {
        assert.ok(byKey.has(routeKey(file, method, route)), `rota de FORA_DO_PORTAO não encontrada: ${routeKey(file, method, route)}`);
        assert.ok(String(reason || '').length >= 20, `rota de FORA_DO_PORTAO sem motivo: ${routeKey(file, method, route)}`);
        assert.ok(!required.has(routeKey(file, method, route)), `rota nas duas listas: ${routeKey(file, method, route)}`);
    });

    // Rota que grava e não está em nenhuma das listas: ou chama, ou entra com motivo.
    const missing = handlers
        .filter(handler => firstWriteIndex(handler.body) >= 0)
        .map(handler => routeKey(handler.file, handler.method, handler.path))
        .filter(key => !required.has(key) && !exempt.has(key));
    assert.deepEqual(missing, [], 'rotas que gravam nota ou presença sem assertClassOpen e fora das listas');
});

test('o teste de guarda enxerga gravação por função auxiliar (encerrar, recorrigir, entregar a tentativa vencida)', () => {
    ['resolveInProgressAttempts', 'settleExpiredAttempts', 'settleStudentAttempt', 'reopenDeadlineDeliveries', 'finishApplication',
        'restoreReopenedDelivery', 'regradeSubmission', 'regradeApplicationSubmissions', 'replaceServerFinalization', 'saveApplicationAction']
        .forEach(name => assert.ok(WRITER_HELPERS.has(name), `${name} grava nota e o teste não viu`));
    // A fábrica do arquivo de rotas não conta como função auxiliar.
    assert.ok(![...WRITER_HELPERS].some(name => /^create\w*Router$/.test(name)), [...WRITER_HELPERS].join(', '));
    // Uma rota nova que grava só por uma auxiliar é achada (e cairia na lista de faltando).
    const body = "router.post('/api/admin/nova', (req, res) => { const ok = finishApplication(db.memory, {}); res.json({ ok }); });";
    assert.ok(firstWriteIndex(body) >= 0);
    assert.equal(firstWriteIndex("router.get('/api/x', (req, res) => res.json(listApplications()));"), -1);
    // A auxiliar escrita entre duas rotas não entra no corpo da rota de cima.
    const text = "router.get('/a', (req, res) => res.json({}));\nfunction ajuda() { memory.submissions.push(1); }\n";
    assert.equal(firstWriteIndex(text.slice(0, /^(?:async\s+)?function\s/m.exec(text).index)), -1);
});

test('o teste de guarda enxerga as gravações (a lista de sinais não ficou cega)', () => {
    const handlers = routeHandlers();
    const writers = handlers.filter(handler => firstWriteIndex(handler.body) >= 0).map(handler => routeKey(handler.file, handler.method, handler.path));
    // As rotas das duas listas gravam de verdade (o sinal está no corpo de cada uma):
    // rota que deixou de gravar sai da lista.
    [...ROTAS_QUE_GRAVAM, ...FORA_DO_PORTAO].forEach(([file, method, route]) => assert.ok(writers.includes(routeKey(file, method, route)), `sem sinal de gravação: ${routeKey(file, method, route)}`));
});

test('[UC-CURSO-003] assertClassOpen com efeito: recusa a turma encerrada, deixa a aberta e a reaberta', () => {
    const closedClass = { name: '1DES', courseId: 'DES', encerramento: { schemaVersion: 1, situacao: 'encerrada', em: Date.now(), por: 'adm@x.local', criterios: {} } };
    const openClass = { name: '2DES', courseId: 'DES' };
    const reopened = { name: '3DES', courseId: 'DES', encerramento: { ...closedClass.encerramento, situacao: 'reaberta', reabertaEm: Date.now() } };
    const sent = [];
    const res = { status(code) { sent.push(code); return this; }, json(body) { sent.push(body); return this; } };
    assert.equal(calendar.isClassClosed(closedClass), true);
    assert.equal(calendar.isClassClosed(openClass), false);
    assert.equal(calendar.isClassClosed(reopened), false);
    // Registro editado à mão sem 'situacao' vale como encerrado; sem 'em', não.
    assert.equal(calendar.isClassClosed({ name: 'X', encerramento: { em: 1 } }), true);
    assert.equal(calendar.isClassClosed({ name: 'X', encerramento: { por: 'a' } }), false);
    assert.equal(calendar.isClassClosed({ name: 'X', encerramento: [] }), false);
    assert.equal(calendar.assertClassOpen(openClass, { res }), true);
    assert.equal(calendar.assertClassOpen(reopened, { res }), true);
    assert.equal(calendar.assertClassOpen(null, { res }), true);
    assert.equal(calendar.assertClassOpen(undefined), true);
    assert.equal(calendar.assertClassOpen([]), true);
    assert.deepEqual(sent, [], 'nada foi respondido para a turma aberta');
    assert.throws(() => calendar.assertClassOpen(closedClass), error => error instanceof calendar.ClassClosedError && error.status === 409 && error.studentClass === '1DES');
    assert.equal(calendar.assertClassOpen([openClass, closedClass], { res }), false);
    assert.deepEqual(sent, [409, { success: false, error: calendar.CLASS_CLOSED_MESSAGE, code: 'class_closed' }]);
    sent.length = 0;
    assert.equal(calendar.assertClassOpen(closedClass, { res, message: calendar.CLASS_CLOSED_ATTEMPT_MESSAGE }), false);
    assert.deepEqual(sent, [409, { success: false, error: 'Esta turma foi encerrada: a prova não aceita mais tentativas.', code: 'class_closed' }]);
    // A cópia dos critérios só vale com a turma encerrada.
    assert.deepEqual(calendar.frozenGradingCriteria(closedClass), {});
    assert.equal(calendar.frozenGradingCriteria(reopened), null);
    assert.equal(calendar.classClosureView(openClass), null);
    assert.equal(calendar.classClosureView(closedClass).encerrada, true);
    assert.equal(calendar.classClosureView(reopened).situacao, 'reaberta');
    assert.equal('criterios' in calendar.classClosureView(closedClass), false);
});

test('recusa da turma encerrada: 409, code class_closed e mensagem em português', () => {
    const error = new calendar.ClassClosedError({ name: '1DES', courseId: 'DES' });
    assert.equal(error.status, 409);
    assert.equal(error.code, 'class_closed');
    assert.equal(error.studentClass, '1DES');
    assert.equal(error.courseId, 'DES');
    assert.match(error.message, /turma foi encerrada/);
    assert.deepEqual(calendar.classClosedBody(error), { success: false, error: calendar.CLASS_CLOSED_MESSAGE, code: 'class_closed' });
});

test('turma da entrega: pelo curso e turma da entrega, do cadastro copiado ou só pelo nome', () => {
    const memory = { classes: [{ name: '1DES', courseId: 'DES' }, { name: '1DES', courseId: 'ADM' }, { name: '2ADM', courseId: 'ADM' }] };
    assert.equal(calendar.classOfSubmission(memory, { student: { studentClass: '1DES', courseId: 'ADM' } }), memory.classes[1]);
    assert.equal(calendar.classOfSubmission(memory, { studentClass: '2ADM', courseId: 'ADM', student: {} }), memory.classes[2]);
    assert.equal(calendar.classOfSubmission(memory, { student: { studentClass: '1DES' } }), memory.classes[0]);
    // Entrega antiga sem curso, com duas turmas do mesmo nome: vale o curso da matrícula do
    // aluno naquela turma (publish e delete passam a entrega crua).
    memory.students = [{ email: 'bia@x.local', classes: [{ name: '1DES', courseId: 'ADM' }] }];
    assert.equal(calendar.classOfSubmission(memory, { student: { studentClass: '1DES', email: 'BIA@x.local' } }), memory.classes[1]);
    assert.equal(calendar.classOfSubmission(memory, { student: { studentClass: '1DES', email: 'ninguem@x.local' } }), memory.classes[0]);
    delete memory.students;
    assert.equal(calendar.classOfSubmission(memory, { student: { studentClass: '9X', courseId: 'DES' } }), null);
    assert.equal(calendar.classOfSubmission(memory, { student: {} }), null);
    assert.equal(calendar.classOfSubmission(memory, null), null);
    assert.deepEqual(calendar.classesOfSubmissions(memory, [
        { student: { studentClass: '1DES', courseId: 'DES' } },
        { student: { studentClass: '1DES', courseId: 'DES' } },
        { student: { studentClass: '2ADM', courseId: 'ADM' } },
        { student: {} },
    ]), [memory.classes[0], memory.classes[2]]);
});

// Percurso do 409 (B10): cada rota de ROTAS_QUE_GRAVAM numa turma encerrada de verdade.
// expect 'passa': a rota chama o portão sem turma (o dia de toda a instituição vale para
// muitas turmas), então responde como sempre e a turma encerrada só fica de fora da marca.
const ADM = 'adm@turma.local';
const ANA = 'ana@turma.local';
const PERCURSO = {
    'admin.js POST /api/admin/submissions/result-control': () => ({ url: '/api/admin/submissions/result-control', body: { submissionId: 'sub_guarda', action: 'archive' } }),
    'admin.js POST /api/admin/submissions/publish': () => ({ url: '/api/admin/submissions/publish', body: { ids: ['sub_guarda'], published: true } }),
    'admin.js POST /api/admin/submissions/delete': () => ({ url: '/api/admin/submissions/delete', body: { id: 'sub_guarda' } }),
    'admin.js POST /api/admin/submissions/restore': ctx => ({ url: '/api/admin/submissions/restore', body: { auditId: ctx.deletedAuditId } }),
    'admin.js POST /api/admin/submissions/create': () => ({ url: '/api/admin/submissions/create', body: { studentEmail: ANA, examKey: 'Prova_1', studentClass: '1DES', courseId: 'DES', grade: '8,5', type: 'manual' } }),
    'admin.js POST /api/admin/student/attendance/mark': () => ({ url: '/api/admin/student/attendance/mark', body: { email: ANA, date: '2026-11-11', studentClass: '1DES', courseId: 'DES' } }),
    'admin.js POST /api/admin/attendance/bulk': () => ({ url: '/api/admin/attendance/bulk', body: { courseId: 'DES', studentClass: '1DES', date: '2026-11-10', concluida: true, entries: [{ email: ANA, aulas: [{ ordem: 1, status: 'presente' }] }] } }),
    'adminExamConfig.js POST /api/admin/correct-live-question': () => ({ url: '/api/admin/correct-live-question', body: { applicationId: 'app_run', questionNumber: 1 } }),
    'adminExamConfig.js POST /api/admin/annul-question': () => ({ url: '/api/admin/annul-question', body: { applicationId: 'app_fin', questionNumber: 1, mode: 'ponto_para_todos', reason: 'enunciado ambíguo' } }),
    'adminExamConfig.js POST /api/admin/replace-question': () => ({ url: '/api/admin/replace-question', body: { applicationId: 'app_run', questionNumber: 1 } }),
    'adminExamConfig.js POST /api/admin/exam-applications/:applicationId/attempt-action': () => ({ url: '/api/admin/exam-applications/app_run/attempt-action', body: { action: 'recolher', studentEmail: ANA } }),
    'adminExamConfig.js POST /api/admin/exam-applications/:applicationId/answer-key-correction': () => ({ url: '/api/admin/exam-applications/app_fin/answer-key-correction', body: { questionNumber: 1, correctAnswer: 'B', motivo: 'gabarito trocado' } }),
    'adminExamConfig.js POST /api/admin/exam-applications/:applicationId/control': () => ({ url: '/api/admin/exam-applications/app_pause/control', body: { action: 'resume' } }),
    'admin.js POST /api/admin/server-exam-control': () => ({ url: '/api/admin/server-exam-control', body: { studentClass: '1DES', courseId: 'DES', examKey: 'Prova_1', applicationId: 'app_pause', action: 'resume' } }),
    'adminExamConfig.js POST /api/admin/exam-applications/:applicationId/time-adjustment': () => ({ url: '/api/admin/exam-applications/app_run/time-adjustment', body: { adjustmentMinutes: 5 } }),
    'admin.js POST /api/admin/adjust-student-time': () => ({ url: '/api/admin/adjust-student-time', body: { studentClass: '1DES', courseId: 'DES', examKey: 'Prova_1', applicationId: 'app_run', adjustmentMinutes: 5 } }),
    'student.js POST /api/student/exam-applications/:applicationId/start-attempt': () => ({ student: true, url: '/api/student/exam-applications/app_run/start-attempt', body: {}, message: 'Esta turma foi encerrada: a prova não aceita mais tentativas.' }),
    'adminCorrections.js POST /api/admin/submissions/:id/correction': () => ({ url: '/api/admin/submissions/sub_guarda/correction', body: { versao: 0, itens: { 1: { pontos: 1 } } } }),
    'adminAcademic.js POST /api/admin/calendar/non-school-days/create': () => ({ url: '/api/admin/calendar/non-school-days/create', body: { inicio: '2026-11-20', tipo: 'evento_escolar', nome: 'Feira', escopo: 'turma', courseId: 'DES', studentClass: '1DES' } }),
    'adminAcademic.js POST /api/admin/calendar/non-school-days/update': () => ({ url: '/api/admin/calendar/non-school-days/update', body: { id: 'nl_turma', inicio: '2026-11-19', tipo: 'evento_escolar', nome: 'Feira (outro dia)', escopo: 'turma', courseId: 'DES', studentClass: '1DES' } }),
    'adminAcademic.js POST /api/admin/calendar/non-school-days/delete': () => ({ url: '/api/admin/calendar/non-school-days/delete', body: { id: 'nl_turma' } }),
    'adminAcademic.js POST /api/admin/calendar/non-school-days/national-holidays': () => ({ url: '/api/admin/calendar/non-school-days/national-holidays', body: { ano: 2026, incluir: ['proclamacao-da-republica'] }, expect: 'passa' }),
    'studentAssignments.js POST /api/student/assignments/:id/submit': ctx => ({ student: true, multipart: true, url: `/api/student/assignments/${ctx.taskId}/submit`, message: 'Esta turma foi encerrada. O envio não é mais aceito.' }),
    'adminAssignments.js POST /api/admin/assignments/:id/grade': ctx => ({ url: `/api/admin/assignments/${ctx.taskId}/grade`, body: { studentEmail: ANA, grade: '5', action: 'salvar' } }),
    'adminAssignments.js POST /api/admin/assignments/:id/return-all': ctx => ({ url: `/api/admin/assignments/${ctx.taskId}/return-all`, body: {} }),
    'adminAssignments.js POST /api/admin/assignments/:id/manual-entry': ctx => ({ url: `/api/admin/assignments/${ctx.taskId}/manual-entry`, body: { studentEmail: ANA, note: 'impresso' } }),
    'adminAssignments.js POST /api/admin/assignments/:id/extension': ctx => ({ url: `/api/admin/assignments/${ctx.taskId}/extension`, body: { studentEmail: ANA, dueDate: ctx.tomorrow, reason: 'Atestado' } }),
    'adminGrading.js POST /api/admin/grading/plan': () => ({ url: '/api/admin/grading/plan', body: { courseId: 'DES', studentClass: '1DES', itens: { man_ativa: { peso: 3 } } } }),
    'adminGrading.js POST /api/admin/grading/manual-items/create': () => ({ url: '/api/admin/grading/manual-items/create', body: { courseId: 'DES', studentClass: '1DES', titulo: 'Seminário', tipo: 'seminario' } }),
    'adminGrading.js POST /api/admin/grading/manual-items/update': () => ({ url: '/api/admin/grading/manual-items/update', body: { courseId: 'DES', studentClass: '1DES', id: 'man_ativa', titulo: 'Trabalho final (revisto)' } }),
    'adminGrading.js POST /api/admin/grading/manual-items/archive': () => ({ url: '/api/admin/grading/manual-items/archive', body: { courseId: 'DES', studentClass: '1DES', id: 'man_ativa', reason: 'não aconteceu' } }),
    'adminGrading.js POST /api/admin/grading/manual-items/restore': () => ({ url: '/api/admin/grading/manual-items/restore', body: { courseId: 'DES', studentClass: '1DES', id: 'man_arquivada', reason: 'aconteceu sim' } }),
    'adminDiary.js POST /api/admin/attendance/diary': () => ({ url: '/api/admin/attendance/diary', body: { courseId: 'DES', studentClass: '1DES', date: '2026-11-10', versao: null, aulas: [{ ordem: 1, conteudo: 'Revisão de laços' }] } }),
};

function seedWalk() {
    const now = Date.now();
    db.memory.config = { ...(db.memory.config || {}), settings: { timezone: 'America/Sao_Paulo', entregas: { maxMbPorArquivo: 5, maxMbPorEnvio: 10, discoLivreMinimoMb: 0 } } };
    db.memory.admins = [{ email: ADM, name: 'Administração', role: 'admin', password: db.hashPassword('Painel-Seguro-2026') }];
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento', structure: [] }];
    db.memory.classes = [{
        name: '1DES', courseId: 'DES', status: 'active', releasedItems: {}, onlineExamConfigs: { Prova_1: { applicationId: 'app_run', onlineActive: true } },
        avaliacao: { schemaVersion: 1, itens: {}, manuais: [
            { id: 'man_ativa', titulo: 'Trabalho final', tipo: 'trabalho', criadoEm: now - 5000, criadoPor: ADM },
            { id: 'man_arquivada', titulo: 'Prática', tipo: 'pratica', criadoEm: now - 5000, criadoPor: ADM, arquivadoEm: now - 4000, arquivadoPor: ADM },
        ] },
    }];
    db.memory.students = [{ id: 'alu_00000000000000a1', name: 'Ana Souza', email: ANA, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: 'DES' }], studentClass: '1DES' }];
    db.memory.attendance = [];
    db.memory.classDiary = [];
    db.memory.auditLogs = [];
    db.memory.nonSchoolDays = [{ id: 'nl_turma', inicio: '2026-11-18', fim: '2026-11-18', tipo: 'evento_escolar', nome: 'Feira', escopo: 'turma', courseId: 'DES', studentClass: '1DES', criadoEm: now, criadoPor: ADM }];
    const questions = [{ number: 1, questionText: 'Q1', alternatives: { A: 'a', B: 'b' }, correctAnswer: 'A' }];
    db.memory.evaluations = { Prova_1: { title: 'Prova 1', questions } };
    const snapshot = [{ version: 'A', questions: questions.map(item => ({ ...item })) }];
    const app = (id, status) => ({ id, examKey: 'Prova_1', studentClass: '1DES', courseId: 'DES', status, createdAt: '2026-11-01T10:00:00.000Z', versionSnapshots: snapshot, durationMinutes: 60, timerMode: 'collective', maxAttempts: 1, studentAdjustments: {} });
    db.memory.examApplications = [app('app_fin', 'finished'), { ...app('app_run', 'running'), startsAt: now - 60000, startedAt: new Date(now - 60000).toISOString() }, app('app_pause', 'paused')];
    db.memory.studentExamState = {};
    db.memory.submissions = [
        { id: 'sub_guarda', examKey: 'Prova_1', applicationId: 'app_fin', score: 0, correctCount: 0, totalCount: 1, assignedVersion: 'A', gradePublished: false,
            gradedAnswers: [{ questionNumber: 1, studentChoice: 'B' }], timestamp: '2026-11-01T11:00:00.000Z', student: { name: 'Ana Souza', email: ANA, studentClass: '1DES', courseId: 'DES' } },
        { id: 'sub_apagar', examKey: 'Prova_1', applicationId: 'app_fin', score: 100, correctCount: 1, totalCount: 1, assignedVersion: 'A', gradePublished: false,
            gradedAnswers: [{ questionNumber: 1, studentChoice: 'A' }], timestamp: '2026-11-01T11:30:00.000Z', student: { name: 'Ana Souza', email: ANA, studentClass: '1DES', courseId: 'DES' } },
    ];
    const task = assignments.newAssignmentRecord({
        courseId: 'DES', studentClass: '1DES', title: 'Relatório', response: { files: false, text: true, link: false },
        dueAt: now + 3 * 86400000, status: 'publicada',
    }, { actor: ADM, now: now - 86400000 });
    db.memory.assignments = [task];
    db.memory.assignmentSubmissions = [];
    return { taskId: task.id, tomorrow: new Date(now + 86400000 + 3 * 3600000).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }) };
}

const closeRecord = () => ({ schemaVersion: 1, situacao: 'encerrada', em: Date.now() - 1000, por: ADM, criterios: { curso: null, turma: JSON.parse(JSON.stringify(db.memory.classes[0].avaliacao)), disciplinas: [] }, historico: [{ acao: 'encerrada', em: Date.now() - 1000, por: ADM }] });

test('[UC-CURSO-003] turma encerrada: toda rota de ROTAS_QUE_GRAVAM responde 409 class_closed sem gravar; reabrir libera', async () => {
    await db.init();
    const ctx = seedWalk();
    const app = createApp();
    const headers = { 'x-admin-session': createAdminSession(db.memory, ADM) };
    const studentToken = createStudentSession(db.memory, ANA);

    // Uma nota na lixeira (para o restore), apagada com a turma ainda aberta.
    const deleted = await request(app).post('/api/admin/submissions/delete').set(headers).send({ id: 'sub_apagar' });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    ctx.deletedAuditId = db.memory.auditLogs.find(entry => entry.action === 'grade_delete').id;

    db.memory.classes[0].encerramento = closeRecord();
    const snapshot = () => JSON.stringify({
        submissions: db.memory.submissions,
        attendance: db.memory.attendance,
        avaliacao: db.memory.classes[0].avaliacao,
        nonSchoolDays: db.memory.nonSchoolDays.filter(day => day.escopo !== 'instituicao'),
        assignmentSubmissions: db.memory.assignmentSubmissions,
        classDiary: db.memory.classDiary || [],
        apps: db.memory.examApplications.map(item => [item.id, item.status, item.globalTimeAdjustment || 0]),
        states: db.memory.studentExamState,
    });
    const before = snapshot();

    const keys = ROTAS_QUE_GRAVAM.map(([file, method, route]) => routeKey(file, method, route));
    assert.deepEqual(keys.filter(key => !PERCURSO[key]), [], 'rota de ROTAS_QUE_GRAVAM sem passo no percurso do 409');
    assert.deepEqual(Object.keys(PERCURSO).filter(key => !keys.includes(key)), [], 'passo do percurso sem rota na lista');
    for (const key of keys) {
        const step = PERCURSO[key](ctx);
        let req = request(app).post(step.url);
        req = step.student ? req.set('x-session-token', studentToken) : req.set(headers);
        const res = step.multipart ? await req.field('text', 'minha resposta') : await req.send(step.body);
        if (step.expect === 'passa') {
            assert.equal(res.status, 200, `${key}: ${JSON.stringify(res.body)}`);
            continue;
        }
        assert.equal(res.status, 409, `${key}: ${res.status} ${JSON.stringify(res.body)}`);
        assert.equal(res.body.code, 'class_closed', `${key}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.success, false);
        assert.match(res.body.error, step.message ? new RegExp(step.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : /turma foi encerrada/, key);
    }
    assert.equal(snapshot(), before, 'nada mudou na turma encerrada');
    // O feriado nacional (dia de toda a instituição) entrou, e a presença da turma
    // encerrada não ganhou marca.
    assert.ok(db.memory.nonSchoolDays.some(day => day.escopo === 'instituicao'));

    // Encerrar e cancelar a aplicação passam (entregam o que os alunos já fizeram).
    const finished = await request(app).post('/api/admin/exam-applications/app_pause/control').set(headers).send({ action: 'finish', inProgressPolicy: 'submit' });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.equal(db.memory.examApplications.find(item => item.id === 'app_pause').status, 'finished');

    // Reabrir pede motivo; com motivo, a turma volta a receber chamada e nota.
    const noReason = await request(app).post('/api/admin/class/reopen').set(headers).send({ courseId: 'DES', name: '1DES' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.field, 'reason');
    const reopened = await request(app).post('/api/admin/class/reopen').set(headers).send({ courseId: 'DES', name: '1DES', reason: 'nota lançada errada' });
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    assert.equal(reopened.body.encerramento.situacao, 'reaberta');
    const mark = await request(app).post('/api/admin/student/attendance/mark').set(headers).send({ email: ANA, date: '2026-11-11', studentClass: '1DES', courseId: 'DES' });
    assert.equal(mark.status, 200, JSON.stringify(mark.body));
    const created = await request(app).post('/api/admin/submissions/create').set(headers).send({ studentEmail: ANA, examKey: 'Prova_1', studentClass: '1DES', courseId: 'DES', grade: '8,5', type: 'manual' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const audit = db.memory.auditLogs.find(entry => entry.action === 'class_reopened');
    assert.ok(audit, 'reabertura auditada');
    assert.equal(audit.reason, 'nota lançada errada');
});
