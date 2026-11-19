// Tarefas com envio de arquivo, modelo e regras (fase 3, C3 / P1-a: FUN-01). Pasta das
// entregas (data/entregas e .recebendo), leitura tolerante das duas coleções, prazos em
// ms pelo relógio da escola (schoolTime.deadlineFromLocal), janela efetiva com
// prorrogação, aceite do envio pelo requestAt, desconto de atraso, situação do aluno e do
// professor, contagens, notas para o quadro, catálogo de tipos com assinatura, gravação
// "tudo ou nada" em data/entregas, espaço em disco, limpeza de .recebendo no boot,
// cabeçalhos de download, lixeira só do administrador, settings.entregas e data/entregas
// fora do backup. Antes deste caso nada disso existia (utils/assignments.js e
// utils/assignmentFiles.js não existiam, runtimePaths não tinha a pasta).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-assignments-model-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');

const runtimePaths = require('../../backend/runtimePaths.js');
const db = require('../../backend/database.js');
const settingsUtil = require('../../backend/utils/settings.js');
const schoolTime = require('../../backend/utils/schoolTime.js');
const storage = require('../../backend/utils/storage.js');
const backupArchive = require('../../backend/utils/backupArchive.js');
const assignments = require('../../backend/utils/assignments.js');
const files = require('../../backend/utils/assignmentFiles.js');
const proc = require('./fixtures/server-process.js');

const SP = 'America/Sao_Paulo';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const due = schoolTime.deadlineFromLocal('2026-11-20', '23:59', SP);

test.before(async () => { await db.init(); });
test.after(async () => {
    proc.killAll();
    try { await db.close(); } catch (e) { /* já fechado */ }
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function task(extra = {}) {
    return assignments.newAssignmentRecord({
        courseId: 'DES', studentClass: '1DES', title: 'Relatório da visita', dueAt: due, status: 'publicada', ...extra,
    }, { actor: 'Prof@Escola.local', now: due - 10 * DAY });
}

function version(n, requestAt, extra = {}) {
    return { n, requestAt, receivedAt: requestAt + 1000, late: requestAt > due, lateMs: Math.max(0, requestAt - due), text: '', link: '', files: [], ...extra };
}

function writeReceiving(name, content) {
    files.ensureReceivingDir();
    const abs = path.join(runtimePaths.ASSIGNMENT_RECEIVING_DIR, name);
    fs.writeFileSync(abs, content);
    return abs;
}

test('pasta das entregas dentro da pasta de dados, com .recebendo dentro dela', () => {
    assert.equal(runtimePaths.ASSIGNMENT_FILES_DIR, path.join(tempRoot, 'entregas'));
    assert.equal(runtimePaths.ASSIGNMENT_RECEIVING_DIR, path.join(tempRoot, 'entregas', '.recebendo'));
    // As três coleções do registro (fundação A0) existem na memória, vazias.
    assert.deepEqual([db.memory.assignments, db.memory.assignmentSubmissions, db.memory.assignmentFileTombstones], [[], [], []]);
});

test('leitura tolerante: linha incompleta ganha os padrões sem mudar a linha, e normalizar de novo não muda nada', () => {
    const raw = { id: 'asg_1795000000000_abcdef', courseId: ' DES ', studentClass: '1DES', title: 'Tarefa antiga', dueAt: '2026-11-21T02:59:00.000Z', files: { types: ['PDF', 'exe', 'code'], extraExtensions: ['PKT', '.exe', 'bad ext'] }, response: { files: false, text: false } };
    const before = JSON.stringify(raw);
    const task1 = assignments.normalizeAssignment(raw);
    assert.equal(JSON.stringify(raw), before, 'a linha gravada não muda');
    assert.equal(task1.schemaVersion, 1);
    assert.equal(task1.courseId, 'DES');
    assert.equal(task1.dueAt, due, 'data ISO de leitura vira ms');
    assert.equal(task1.status, 'rascunho');
    assert.deepEqual(task1.response, { files: true, text: false, link: false }, 'nenhum modo marcado vale o padrão');
    assert.deepEqual(task1.files, { maxFiles: 5, maxSizeMb: 10, types: ['pdf', 'code'], extraExtensions: ['.pkt'] });
    assert.deepEqual(task1.latePolicy, { mode: 'aceitar', penaltyPerDayPct: 10, penaltyMaxPct: 50 });
    assert.equal(task1.countsInAverage, true);
    assert.equal(Object.prototype.hasOwnProperty.call(task1, 'weight'), false, 'sem o weight reservado (K1 do plano)');
    assert.deepEqual(assignments.normalizeAssignment(task1), task1);

    const sub = assignments.normalizeSubmission({ id: 'asub_1795000000000_abcdef', assignmentId: raw.id, studentEmail: ' Ana@Escola.Local ', versions: [version(2, due - HOUR), version(1, due - DAY)], grade: { score: '85', penaltyPct: 20 } });
    assert.equal(sub.studentEmail, 'ana@escola.local');
    assert.equal(sub.studentId, null);
    assert.equal(sub.groupId, null);
    assert.deepEqual(sub.versions.map(item => item.n), [1, 2], 'versões em ordem');
    assert.equal(sub.grade.finalScore, 68, '85 com 20% de desconto');
    assert.equal(sub.status, 'corrigida', 'situação ausente sai dos outros campos');
    assert.deepEqual(assignments.normalizeSubmission(sub), sub);
    assert.equal(assignments.normalizeAssignment(null), null);
});

test('ids no formato do plano e registro novo de entrega com studentId do cadastro', () => {
    const id = assignments.newAssignmentId(1795000000000);
    assert.match(id, /^asg_1795000000000_[0-9a-f]{6}$/);
    assert.equal(assignments.isAssignmentId(id), true);
    assert.equal(assignments.isAssignmentId('asg_../x'), false);
    assert.match(assignments.newSubmissionId(), /^asub_\d+_[0-9a-f]{6}$/);
    const t = task();
    const withId = assignments.newSubmissionRecord(t, { email: 'Ana@Escola.local', id: 'alu_0123456789abcdef' }, { now: 5 });
    assert.equal(withId.studentEmail, 'ana@escola.local');
    assert.equal(withId.studentId, 'alu_0123456789abcdef');
    assert.equal(withId.courseId, 'DES');
    assert.equal(withId.status, 'pendente');
    assert.equal(assignments.newSubmissionRecord(t, { email: 'bia@escola.local', id: 'foo' }).studentId, null);
    assert.equal(t.createdBy, 'prof@escola.local');
    assert.equal(t.publishedAt, t.createdAt);
});

test('prazos em ms pelo relógio da escola: deadlineFields, a ordem das datas e a janela efetiva', () => {
    assert.equal(assignments.deadlineFromLocal('2026-11-20', '23:59', SP), schoolTime.deadlineFromLocal('2026-11-20', '23:59', SP));
    assert.deepEqual(assignments.deadlineFields({ dueDate: '2026-11-20', dueTime: '23:59' }, 'due', { timezone: SP }), { value: due });
    assert.deepEqual(assignments.deadlineFields({ dueDate: '2026-11-20' }, 'due', { timezone: SP }), { value: due }, 'sem hora vale 23:59');
    assert.deepEqual(assignments.deadlineFields({}, 'close', { timezone: SP }), { value: null });
    assert.equal(assignments.deadlineFields({}, 'due', { required: true }).field, 'dueDate');
    assert.match(assignments.deadlineFields({ dueDate: '2026-02-30' }, 'due').error, /Data do prazo inválida/);
    assert.equal(assignments.deadlineFields({ dueDate: '2026-11-20', dueTime: '24:00' }, 'due').field, 'dueTime');
    assert.equal(assignments.windowOrderError({ opensAt: due + 1, dueAt: due }).field, 'opensDate');
    assert.equal(assignments.windowOrderError({ dueAt: due, closeAt: due - 1 }).field, 'closeDate');
    assert.equal(assignments.windowOrderError({ dueAt: due, closeAt: due }), null);

    const t = task({ closeAt: due + 2 * DAY });
    assert.deepEqual(assignments.effectiveWindow(t, null), { opensAt: null, dueAt: due, closeAt: due + 2 * DAY, individual: false });
    const ext = { extension: { dueAt: due + DAY, closeAt: null, by: 'prof@escola.local', at: due, reason: 'Atestado' } };
    assert.deepEqual(assignments.effectiveWindow(t, ext), { opensAt: null, dueAt: due + DAY, closeAt: due + 2 * DAY, individual: true }, 'prorrogação não fecha antes da tarefa');
    const longer = { extension: { dueAt: due + 5 * DAY, closeAt: null } };
    assert.equal(assignments.effectiveWindow(t, longer).closeAt, null, 'prorrogação depois do encerramento da tarefa não herda o encerramento');
});

test('aceite do envio: situação da tarefa, abertura, devolvida, 20 versões, encerramento e regra de atraso pelo requestAt', () => {
    const t = task();
    const accept = (assignment, sub, now) => assignments.submissionAcceptance(assignment, sub, { now });
    assert.equal(accept(task({ status: 'rascunho' }), null, due - DAY).code, 'nao_publicada');
    assert.equal(accept(task({ status: 'arquivada' }), null, due - DAY).code, 'nao_publicada');
    assert.equal(accept(task({ opensAt: due - HOUR }), null, due - DAY).code, 'nao_aberta');
    assert.deepEqual(accept(t, null, due), { accepts: true, code: 'ok', message: '', late: false, lateMs: 0, window: { opensAt: null, dueAt: due, closeAt: null, individual: false } }, 'chegou no último milissegundo: no prazo');
    const late = accept(t, null, due + 1);
    assert.equal(late.accepts, true, "'aceitar' recebe depois do prazo");
    assert.equal(late.late, true);
    assert.equal(late.lateMs, 1);
    assert.equal(accept(task({ latePolicy: { mode: 'bloquear' } }), null, due + 1).code, 'prazo_encerrado');
    assert.equal(accept(task({ latePolicy: { mode: 'bloquear' } }), null, due).accepts, true);
    assert.equal(accept(task({ closeAt: due + DAY }), null, due + DAY + 1).code, 'encerrada', 'o encerramento sempre fecha');
    assert.equal(accept(task({ closeAt: due + DAY, latePolicy: { mode: 'desconto' } }), null, due + DAY).accepts, true);
    assert.equal(accept(t, { status: 'devolvida', returnedAt: due, grade: { score: 90 } }, due - HOUR).code, 'devolvida');
    const twenty = { status: 'enviada', versions: Array.from({ length: 20 }, (_, i) => version(i + 1, due - DAY + i)) };
    assert.equal(accept(t, twenty, due - HOUR).code, 'limite_versoes');
    assert.match(accept(t, twenty, due - HOUR).message, /20 versões/);
    // Refazer: prazo individual reabre o envio só para aquele aluno, mesmo com 'bloquear'.
    const redo = { status: 'refazer', versions: [version(1, due - DAY)], grade: { score: 40, versionGraded: 1 }, extension: { dueAt: due + 3 * DAY } };
    const blocked = task({ latePolicy: { mode: 'bloquear' } });
    assert.equal(accept(blocked, redo, due + 2 * DAY).accepts, true);
    assert.equal(accept(blocked, redo, due + 2 * DAY).late, false);
    assert.equal(accept(blocked, null, due + 2 * DAY).accepts, false, 'o resto da turma continua fechado');
});

test('desconto por dia iniciado com teto, nota final e correção da versão escolhida', () => {
    const t = task({ latePolicy: { mode: 'desconto', penaltyPerDayPct: 10, penaltyMaxPct: 30 } });
    assert.equal(assignments.latePenaltyPct(t, 0), 0);
    assert.equal(assignments.latePenaltyPct(t, 60 * 1000), 10, '1 minuto de atraso já é um dia');
    assert.equal(assignments.latePenaltyPct(t, DAY), 10);
    assert.equal(assignments.latePenaltyPct(t, DAY + 1), 20);
    assert.equal(assignments.latePenaltyPct(t, 10 * DAY), 30, 'teto');
    assert.equal(assignments.latePenaltyPct(task(), 10 * DAY), 0, "'aceitar' não desconta");
    assert.equal(assignments.finalScoreFor(85, 20), 68);
    assert.equal(assignments.finalScoreFor(75, 10), 68, '67,5 arredonda para 68');
    assert.equal(assignments.finalScoreFor(null, 10), null);
    const sub = { versions: [version(1, due - HOUR), version(2, due + DAY + HOUR)] };
    assert.deepEqual(assignments.gradeWithPenalty(t, sub, { score: 90 }), { score: 90, penaltyPct: 20, finalScore: 72, versionGraded: 2, penaltyWaived: false });
    assert.deepEqual(assignments.gradeWithPenalty(t, sub, { score: 90, versionN: 1 }), { score: 90, penaltyPct: 0, finalScore: 90, versionGraded: 1, penaltyWaived: false });
    assert.deepEqual(assignments.gradeWithPenalty(t, sub, { score: 90, waivePenalty: true }), { score: 90, penaltyPct: 0, finalScore: 90, versionGraded: 2, penaltyWaived: true });
    assert.equal(assignments.gradeWithPenalty(t, { manualEntry: { note: 'Em papel' } }, { score: 70 }).versionGraded, 0);
});

test('situação do aluno e do professor', () => {
    const t = task({ closeAt: due + DAY });
    const at = now => sub => assignments.studentSituation(t, sub, { now, timezone: SP });
    assert.equal(at(due - DAY)(null).code, 'a_fazer');
    assert.equal(at(due - DAY)(null).label, 'A fazer');
    assert.deepEqual([at(due + HOUR)(null).code, at(due + HOUR)(null).label], ['atrasada', 'Atrasada']);
    assert.equal(at(due + 2 * DAY)(null).code, 'encerrada_sem_envio');
    assert.equal(at(due + 2 * DAY)(null).label, 'Encerrada sem envio');
    const sent = { versions: [version(1, due + HOUR)] };
    assert.deepEqual([at(due + 2 * HOUR)(sent).code, at(due + 2 * HOUR)(sent).label, at(due + 2 * HOUR)(sent).atrasada], ['enviada', 'Enviada com atraso', true]);
    const saved = { versions: [version(1, due - HOUR)], grade: { score: 80, versionGraded: 1 } };
    assert.equal(at(due)(saved).code, 'enviada', 'correção salva e não devolvida: o aluno não sabe');
    const returned = { ...saved, status: 'devolvida', returnedAt: due + HOUR };
    assert.equal(at(due + 2 * HOUR)(returned).label, 'Devolvida');
    const redo = { status: 'refazer', versions: [version(1, due - HOUR)], grade: { score: 40, versionGraded: 1 }, extension: { dueAt: schoolTime.deadlineFromLocal('2026-11-25', '18:00', SP) } };
    assert.equal(at(due + 2 * DAY)(redo).label, 'Refazer até 25/11 às 18:00');
    assert.equal(at(due + 2 * DAY)(redo).aceitaEnvio, true);
    assert.equal(at(due)( { manualEntry: { note: 'Maquete' } }).label, 'Entregue em mãos');
    assert.equal(assignments.studentSituation(task({ opensAt: schoolTime.deadlineFromLocal('2026-11-18', '07:30', SP) }), null, { now: due - 5 * DAY, timezone: SP }).label, 'Abre em 18/11 às 07:30');

    assert.equal(assignments.instructorStatus(null), 'nao_entregue');
    assert.equal(assignments.instructorStatus({ versions: [] }), 'nao_entregue');
    assert.equal(assignments.instructorStatus(sent), 'para_corrigir');
    assert.equal(assignments.instructorStatus(saved), 'corrigida');
    assert.equal(assignments.instructorStatus({ ...saved, versions: [...saved.versions, version(2, due)] }), 'para_corrigir', 'versão nova depois da correção');
    assert.equal(assignments.instructorStatus(returned), 'devolvida');
    assert.equal(assignments.instructorStatus(redo), 'refazer');
    assert.equal(assignments.instructorStatus({ ...redo, versions: [...redo.versions, version(2, due + DAY)] }), 'para_corrigir');
    assert.equal(assignments.instructorStatus({ manualEntry: { note: 'x' } }), 'para_corrigir');
    assert.equal(assignments.needsGrading({ manualEntry: { note: 'x' }, grade: { score: 70 } }), false);
});

function seedClass(memory) {
    const t = task();
    const other = task({ studentClass: '2DES', title: 'Outra turma' });
    const draft = task({ status: 'rascunho', title: 'Rascunho' });
    const archived = task({ status: 'arquivada', title: 'Arquivada' });
    memory.students = [
        { name: 'Bruno Lima', email: 'bruno@escola.local', id: 'alu_000000000000000b', status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }] },
        { name: 'Ana Souza', email: 'ana@escola.local', id: 'alu_000000000000000a', status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }] },
        { name: 'Carla Dias', email: 'carla@escola.local', status: 'Transferido', classes: [{ name: '1DES', courseId: 'DES' }] },
        { name: 'Davi Reis', email: 'davi@escola.local', status: 'Inativo', classes: [{ name: '1DES', courseId: 'DES' }] },
        { name: 'Eva Prado', email: 'eva@escola.local', status: 'Ativo', classes: [{ name: '2DES', courseId: 'DES' }] },
        { name: 'Fábio Melo', email: 'fabio@escola.local', status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }] },
    ];
    memory.assignments = [t, other, draft, archived];
    const sub = (assignment, email, extra) => ({ ...assignments.newSubmissionRecord(assignment, { email }), ...extra });
    memory.assignmentSubmissions = [
        sub(t, 'Ana@Escola.local', { status: 'devolvida', versions: [version(1, due - HOUR)], grade: { score: 90, penaltyPct: 0, finalScore: 90, versionGraded: 1 }, returnedAt: due + DAY }),
        sub(t, 'bruno@escola.local', { status: 'corrigida', versions: [version(1, due + HOUR)], grade: { score: 70, penaltyPct: 0, finalScore: 70, versionGraded: 1 } }),
        // Desligada depois de entregar: continua na lista do professor com o que entregou.
        sub(t, 'carla@escola.local', { status: 'enviada', versions: [version(1, due + 2 * HOUR)] }),
        sub(draft, 'ana@escola.local', { status: 'devolvida', versions: [version(1, due)], grade: { score: 50, finalScore: 50, versionGraded: 1 }, returnedAt: due }),
        sub(archived, 'ana@escola.local', { status: 'devolvida', versions: [version(1, due)], grade: { score: 60, finalScore: 60, versionGraded: 1 }, returnedAt: due }),
        sub(other, 'eva@escola.local', { status: 'devolvida', versions: [version(1, due)], grade: { score: 100, finalScore: 100, versionGraded: 1 }, returnedAt: due }),
    ];
    return { t, other, draft, archived };
}

test('lista da turma, contagens da tarefa (contrato C4) e donos da entrega', () => {
    const memory = {};
    const { t } = seedClass(memory);
    const roster = assignments.assignmentRoster(memory, t);
    assert.deepEqual(roster.map(row => row.studentEmail), ['ana@escola.local', 'bruno@escola.local', 'carla@escola.local', 'fabio@escola.local'], 'ativos da turma + quem entregou, em ordem alfabética; Davi (Inativo, sem entrega) e Eva (outra turma) fora');
    assert.equal(roster[0].studentId, 'alu_000000000000000a');
    assert.equal(roster[3].submission, null);
    assert.deepEqual(assignments.assignmentStatusSummary(memory, t), { alunos: 4, enviadas: 3, paraCorrigir: 1, atrasadas: 2, naoEntregues: 1, devolvidas: 1, corrigidas: 1, refazer: 0 });
    assert.deepEqual(assignments.assignmentStatusSummary(memory, t.id), assignments.assignmentStatusSummary(memory, t));
    assert.deepEqual(assignments.assignmentStatusSummary(memory, 'asg_inexistente').alunos, 0);
    assert.deepEqual(assignments.submissionOwners({ studentEmail: ' Ana@Escola.local ' }), ['ana@escola.local']);
    assert.deepEqual(assignments.submissionOwners({}), []);
    assert.equal(assignments.findSubmission(memory, t.id, 'ANA@escola.local').studentEmail, 'ana@escola.local');
    assert.equal(assignments.findSubmission(memory, t.id, 'fabio@escola.local'), null);
    assert.deepEqual(assignments.assignmentsForClass(memory, { courseId: 'DES', studentClass: '1DES', statuses: ['publicada'] }).map(item => item.id), [t.id]);
});

test('notas de tarefa para o quadro (contrato C1, K1): só devolvidas, das publicadas da turma, com desconto', () => {
    const memory = {};
    const { t, archived } = seedClass(memory);
    assert.deepEqual(assignments.assignmentGradeEntries(memory, { courseId: 'DES', studentClass: '1DES' }), [{
        email: 'ana@escola.local', studentId: null, columnId: `tarefa:${t.id}`, assignmentId: t.id, title: 'Relatório da visita', moduleId: '', score: 90, countsInAverage: true, returnedAt: due + DAY,
    }]);
    const all = assignments.assignmentGradeEntries(memory, { courseId: 'DES', studentClass: '1DES', published: false });
    assert.deepEqual(all.map(entry => [entry.email, entry.score]), [['ana@escola.local', 90], ['bruno@escola.local', 70]], 'professor vê também a correção salva');
    assert.deepEqual(assignments.assignmentGradeEntries(memory, { courseId: 'DES', studentClass: '1DES', includeArchived: true }).map(entry => entry.assignmentId), [t.id, archived.id]);
    assert.deepEqual(assignments.assignmentGradeEntries(memory, { courseId: 'DES', studentClass: '1DES', students: ['bruno@escola.local'] }), []);
    assert.deepEqual(assignments.assignmentGradeEntries({}, { courseId: 'DES', studentClass: '1DES' }), [], 'banco sem tarefas: nada');
});

test('regras do envio: tetos globais de settings.entregas e accept do navegador', () => {
    const t = task({ files: { maxFiles: 3, maxSizeMb: 30, types: ['image', 'code'], extraExtensions: ['.pkt'] } });
    const rules = assignments.submissionRules(t, { maxMbPorArquivo: 20, maxMbPorEnvio: 50 });
    assert.equal(rules.maxSizeMb, 20, 'o teto global vale sobre o da tarefa');
    assert.equal(rules.maxTotalMb, 50);
    assert.equal(rules.maxFiles, 3);
    assert.ok(rules.accept.startsWith('image/*,'), 'imagem abre câmera e galeria no celular');
    assert.ok(rules.accept.includes('.py') && rules.accept.includes('.pkt') && rules.accept.includes('.heic'));
    assert.equal(rules.accept.includes('.pdf'), false);
    assert.equal(assignments.nextVersionNumber(null), 1);
    assert.equal(assignments.nextVersionNumber({ versions: [version(1, 1), version(4, 2)] }), 5);
});

test('catálogo de tipos: executável sempre recusado, formato do curso pela extensão, código quando a tarefa aceita', () => {
    const rules = { types: ['pdf', 'code'], extraExtensions: ['.pkt'] };
    assert.deepEqual(files.classifyFileName('Relatório final.PDF', rules), { ok: true, ext: '.pdf', category: 'pdf', name: 'Relatório final.PDF' });
    assert.equal(files.classifyFileName('rede.pkt', rules).category, files.COURSE_FORMAT_CATEGORY);
    assert.equal(files.classifyFileName('main.py', rules).category, 'code');
    assert.equal(files.classifyFileName('index.html', rules).ok, true, 'HTML é código de aluno (sai só como download)');
    for (const name of ['jogo.exe', 'trabalho.pdf.exe', 'atalho.lnk', 'script.ps1', 'app.apk', 'macro.vbs']) {
        const result = files.classifyFileName(name, { types: ['pdf'], extraExtensions: ['.exe', '.lnk'] });
        assert.equal(result.code, 'file_blocked', name);
        assert.match(result.message, /executáveis/);
    }
    assert.equal(files.classifyFileName('foto.jpg', rules).code, 'file_type');
    assert.match(files.classifyFileName('foto.jpg', rules).message, /não é aceito nesta tarefa. Formatos aceitos: \.pdf, /);
    assert.equal(files.classifyFileName('LEIAME', rules).code, 'file_type');
    assert.equal(files.classifyFileName('', rules).code, 'file_name');
    assert.equal(files.classifyFileName('a\0.pdf', rules).code, 'file_name');
    // Extensão do catálogo digitada como formato do curso: vale a categoria do catálogo.
    assert.equal(files.classifyFileName('main.py', { types: ['pdf'], extraExtensions: ['.py'] }).category, 'code');
    assert.equal(files.classifyFileName('C:\\Users\\ana\\Área de Trabalho\\trabalho.pdf', rules).name, 'trabalho.pdf');

    assert.deepEqual(files.normalizeExtraExtensions(['PKT', ' .fzz ', '.pkt', 'dwg']), ['.pkt', '.fzz', '.dwg']);
    assert.match(files.normalizeExtraExtensions(['.exe'], { strict: true }).error, /executáveis/);
    assert.match(files.normalizeExtraExtensions(['.muito-longa'], { strict: true }).error, /inválido/);
    assert.match(files.normalizeExtraExtensions(Array.from({ length: 11 }, (_, i) => `.x${i}`), { strict: true }).error, /no máximo 10/);
    assert.deepEqual(files.normalizeExtraExtensions(['.pkt'], { strict: true }), { value: ['.pkt'] });
    assert.deepEqual(files.normalizeFileTypes(['code', 'pdf', 'pdf', 'video']), ['pdf', 'code']);
    const longName = `${'a'.repeat(200)}.docx`;
    assert.equal(files.sanitizeOriginalName(longName).length, 120);
    assert.ok(files.sanitizeOriginalName(longName).endsWith('.docx'));
    assert.equal(files.sanitizeOriginalName('re<la>tó:rio?.pdf'), 'relatório.pdf');
});

test('arquivo recebido: assinatura, texto, tamanho, sha256 em streaming e nada fora de .recebendo', async () => {
    const rules = { types: ['pdf', 'image', 'doc', 'archive', 'code'], extraExtensions: ['.pkt'], maxSizeMb: 1 };
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(2000)]);
    const pdfPath = writeReceiving('a.part', pdf);
    const ok = await files.validateReceivedFile({ path: pdfPath, originalname: 'Relatório.pdf' }, rules);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.file.sha256, crypto.createHash('sha256').update(pdf).digest('hex'));
    assert.equal(ok.file.size, pdf.length);
    assert.equal(ok.file.mime, 'application/pdf');
    assert.match(ok.file.id, /^f_[0-9a-f]{16}$/);
    assert.equal(files.isFileId(ok.file.id), true);

    const check = async (name, content, originalname) => files.validateReceivedFile({ path: writeReceiving(name, content), originalname }, rules);
    assert.equal((await check('b.part', 'MZ\x90\x00 não é pdf', 'trabalho.pdf')).code, 'file_signature');
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(40)]);
    assert.equal((await check('c.part', heic, 'IMG_0001.HEIC')).ok, true);
    assert.equal((await check('c2.part', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(40)]), 'video.heic')).code, 'file_signature');
    assert.equal((await check('d.part', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), 'projeto.7z')).ok, true);
    assert.equal((await check('e.part', Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1'), 'projeto.rar')).ok, true);
    assert.equal((await check('f.part', '{\\rtf1\\ansi Olá}', 'carta.rtf')).ok, true);
    assert.equal((await check('g.part', 'print("olá")\n', 'main.py')).ok, true);
    assert.equal((await check('h.part', Buffer.from('/* Configuração */\nint a;\n', 'latin1'), 'antigo.c')).ok, true, 'texto antigo em Latin-1 passa');
    assert.equal((await check('i.part', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]), 'main.py')).code, 'file_signature', 'binário com nome de código');
    assert.equal((await check('j.part', crypto.randomBytes(300), 'rede.pkt')).ok, true, 'formato do curso só pela extensão');
    assert.equal((await check('k.part', '', 'vazio.txt')).code, 'file_empty');
    const big = await check('l.part', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(1024 * 1024)]), 'grande.pdf');
    assert.equal(big.code, 'file_too_large');
    assert.equal(big.status, 413);
    assert.match(big.message, /limite desta tarefa é 1 MB/);
    assert.equal((await check('m.part', 'x', 'jogo.exe')).code, 'file_blocked');

    const outside = path.join(tempRoot, 'fora.pdf');
    fs.writeFileSync(outside, pdf);
    assert.equal((await files.validateReceivedFile({ path: outside, originalname: 'fora.pdf' }, rules)).code, 'file_read', 'arquivo fora de .recebendo não é lido');
    assert.equal((await files.validateReceivedFile(null, rules)).code, 'file_missing');
});

test('gravação da versão: tudo ou nada em data/entregas/<tarefa>/<entrega>, com renameWithRetry', async () => {
    const asg = 'asg_1795000000000_aaaaaa';
    const asub = 'asub_1795000000000_bbbbbb';
    const first = { tempPath: writeReceiving('ok1.part', '%PDF-1'), file: { id: 'f_0000000000000001', ext: '.pdf', originalName: 'um.pdf' } };
    const second = { tempPath: writeReceiving('ok2.part', 'texto'), file: { id: 'f_0000000000000002', ext: '.txt', originalName: 'dois.txt' } };
    const stored = await files.commitReceivedFiles([first, second], { assignmentId: asg, submissionId: asub });
    assert.deepEqual(stored.map(item => item.storedRel), [`entregas/${asg}/${asub}/f_0000000000000001.pdf`, `entregas/${asg}/${asub}/f_0000000000000002.txt`]);
    assert.equal(fs.readFileSync(files.absFromStoredRel(stored[0].storedRel), 'utf8'), '%PDF-1');
    assert.equal(fs.existsSync(first.tempPath), false);

    // O segundo rename falha (antivírus segurando): o primeiro volta a não existir, os
    // temporários saem, e o erro é 503 com retryable.
    const a = { tempPath: writeReceiving('x1.part', '%PDF-2'), file: { id: 'f_0000000000000003', ext: '.pdf' } };
    const b = { tempPath: writeReceiving('x2.part', '%PDF-3'), file: { id: 'f_0000000000000004', ext: '.pdf' } };
    let calls = 0;
    const flaky = async (from, to) => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error('preso'), { code: 'EBUSY' });
        await fs.promises.rename(from, to);
    };
    await assert.rejects(files.commitReceivedFiles([a, b], { assignmentId: asg, submissionId: 'asub_1795000000000_cccccc', rename: flaky }), err => err.retryable === true && err.status === 503 && /Tente de novo/.test(err.message));
    assert.equal(fs.existsSync(path.join(runtimePaths.ASSIGNMENT_FILES_DIR, asg, 'asub_1795000000000_cccccc', 'f_0000000000000003.pdf')), false, 'nada pela metade');
    assert.equal(fs.existsSync(a.tempPath) || fs.existsSync(b.tempPath), false);

    // Nunca sobrescreve um arquivo gravado.
    const again = { tempPath: writeReceiving('dup.part', 'novo'), file: { id: 'f_0000000000000001', ext: '.pdf' } };
    await assert.rejects(files.commitReceivedFiles([again], { assignmentId: asg, submissionId: asub }));
    assert.equal(fs.readFileSync(files.absFromStoredRel(stored[0].storedRel), 'utf8'), '%PDF-1');

    for (const bad of ['../database.db', 'entregas/../database.db', 'entregas/.recebendo/x.part', 'uploads/a.pdf', '/etc/passwd', 'entregas/a/../../../x']) {
        assert.throws(() => files.absFromStoredRel(bad), /inválido|fora/, bad);
    }
    assert.throws(() => files.storedRelFor('../x', asub, 'f_1', '.pdf'), /inválido/);
    assert.throws(() => files.storedRelFor(asg, asub, 'f_1', '.p/df'), /inválida/);
    await files.discardReceivedFiles([outsideFile()]);
    assert.equal(fs.existsSync(outsideFile()), true, 'descartar só apaga dentro de .recebendo');
});

function outsideFile() {
    const abs = path.join(tempRoot, 'nao-apagar.txt');
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, 'fica');
    return abs;
}

test('espaço em disco: abaixo do mínimo recusa; sem como medir, não recusa por palpite', async () => {
    const MB = 1024 * 1024;
    const statfs = async () => ({ bavail: 3000, bsize: MB });
    assert.equal((await files.checkFreeSpace({ minFreeMb: 2048, incomingBytes: 10 * MB, statfs })).ok, true);
    assert.equal((await files.checkFreeSpace({ minFreeMb: 2048, incomingBytes: 1000 * MB, statfs })).ok, false);
    assert.equal((await files.checkFreeSpace({ minFreeMb: 4096, statfs })).ok, false);
    const unknown = await files.checkFreeSpace({ minFreeMb: 2048, statfs: async () => { throw new Error('sem statfs'); } });
    assert.deepEqual([unknown.ok, unknown.freeBytes], [true, null]);
    assert.match(files.DISK_FULL_MESSAGE, /sem espaço/);
});

test('limpeza de .recebendo: só o que tem mais de 1 h sai', async () => {
    const old = writeReceiving('velho.part', 'x');
    const fresh = writeReceiving('novo.part', 'y');
    const twoHoursAgo = (Date.now() - 2 * HOUR) / 1000;
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
    const removed = await files.cleanupReceivingDir();
    assert.ok(removed >= 1);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
    fs.rmSync(runtimePaths.ASSIGNMENT_RECEIVING_DIR, { recursive: true, force: true });
    assert.equal(await files.cleanupReceivingDir(), 0, 'sem a pasta: nada a fazer');
});

test('download: sempre attachment com o nome acentuado, nosniff e CSP sandbox; inline só imagem e PDF', () => {
    const headers = files.downloadHeaders({ originalName: 'Relatório final.pdf', ext: '.pdf' });
    assert.equal(headers['Content-Type'], 'application/pdf');
    assert.equal(headers['Content-Disposition'], `attachment; filename="Relatorio final.pdf"; filename*=UTF-8''${encodeURIComponent('Relatório final.pdf')}`);
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['Content-Security-Policy'], 'sandbox');
    assert.equal(files.downloadHeaders({ originalName: 'foto.png', ext: '.png' }, { inline: true })['Content-Disposition'].startsWith('inline;'), true);
    const html = files.downloadHeaders({ originalName: 'index.html', ext: '.html' }, { inline: true });
    assert.equal(html['Content-Type'], 'text/plain; charset=utf-8', 'HTML entregue nunca sai como text/html');
    assert.ok(html['Content-Disposition'].startsWith('attachment;'));
    assert.equal(files.downloadHeaders({ originalName: 'rede.pkt', ext: '.pkt' })['Content-Type'], 'application/octet-stream');
    assert.ok(files.downloadHeaders({ originalName: 'IMG.heic', ext: '.heic' }, { inline: true })['Content-Disposition'].startsWith('attachment;'), 'HEIC sem prévia');
    assert.ok(files.downloadHeaders({ originalName: 'Ação "final".txt', ext: '.txt' })['Content-Disposition'].startsWith('attachment; filename="Acao final.txt"; filename*=UTF-8\'\'A%C3%A7%C3%A3o%20final.txt'));
});

test('lixeira: arquivo de entrega é só do administrador', () => {
    assert.equal(storage.isAdminOnlyTrashEntry({ originalRel: 'entregas/asg_1/asub_1/f_1.pdf', courseId: 'DES', studentClass: '1DES' }), true);
    assert.equal(storage.isAdminOnlyTrashEntry({ originalRel: 'entregas' }), true);
    assert.equal(storage.isAdminOnlyTrashEntry({ originalRel: 'uploads/material.pdf', courseId: 'DES' }), false);
});

test('data/entregas nunca entra no backup (contrato C7)', async () => {
    assert.deepEqual(backupArchive.FOLDER_PREFIXES, ['content', 'data/alunos', 'cursos_arquivados', 'data/uploads']);
    assert.equal(backupArchive.folderSources().some(source => path.resolve(source.dir).startsWith(path.resolve(runtimePaths.ASSIGNMENT_FILES_DIR))), false);
    assert.equal(backupArchive.excludedDirs().has(path.resolve(runtimePaths.ASSIGNMENT_FILES_DIR)), true);
    // Mesmo com uma pasta de origem por cima de data (ICLASS_CONTENT_DIR na pasta de
    // dados), os arquivos das entregas ficam de fora.
    fs.mkdirSync(path.join(runtimePaths.ASSIGNMENT_FILES_DIR, 'asg_x'), { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.ASSIGNMENT_FILES_DIR, 'asg_x', 'f.pdf'), '%PDF-');
    const listed = await backupArchive.listFolderFiles(runtimePaths.DATA_DIR);
    assert.equal(listed.some(file => file.rel.startsWith('entregas/')), false);
});

test('settings.entregas: padrões no banco antigo, teto pelo upload.maxSizeMb e gravação pelo mergeSettings', () => {
    db.memory.config = db.memory.config || {};
    db.memory.config.settings = { timezone: SP };
    assert.deepEqual(settingsUtil.getSettings().entregas, { maxMbPorArquivo: 20, maxMbPorEnvio: 50, discoLivreMinimoMb: 2048 });
    db.memory.config.settings = { upload: { maxSizeMb: 8 }, entregas: { maxMbPorArquivo: 30, maxMbPorEnvio: 5, discoLivreMinimoMb: 'muito' } };
    assert.deepEqual(settingsUtil.getSettings().entregas, { maxMbPorArquivo: 8, maxMbPorEnvio: 8, discoLivreMinimoMb: 2048 });
    db.memory.config.settings = settingsUtil.mergeSettings({ upload: { maxSizeMb: 8 }, entregas: { maxMbPorArquivo: '25', maxMbPorEnvio: 100, discoLivreMinimoMb: true } });
    assert.deepEqual(db.memory.config.settings.entregas, { maxMbPorArquivo: 25, maxMbPorEnvio: 100, discoLivreMinimoMb: 2048 }, 'grava a escolha sem o teto do upload');
    assert.equal(settingsUtil.getSettings().entregas.maxMbPorArquivo, 8);
    db.memory.config.settings = settingsUtil.mergeSettings({ upload: { maxSizeMb: 50 } });
    assert.equal(settingsUtil.getSettings().entregas.maxMbPorArquivo, 25, 'subir o teto do servidor não perde a escolha');
    db.memory.config.settings = settingsUtil.mergeSettings({ entregas: { maxMbPorArquivo: 99999, discoLivreMinimoMb: -5 } });
    assert.deepEqual(db.memory.config.settings.entregas, { maxMbPorArquivo: 1024, maxMbPorEnvio: 100, discoLivreMinimoMb: 0 });
    assert.deepEqual(settingsUtil.getSettings().entregas, { maxMbPorArquivo: 50, maxMbPorEnvio: 100, discoLivreMinimoMb: 0 });
    db.memory.config.settings = {};
});

test('boot: o servidor de verdade limpa os envios interrompidos de .recebendo e não toca nas entregas gravadas', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-assignments-boot-'));
    try {
        const receiving = path.join(dataDir, 'entregas', '.recebendo');
        const storedDir = path.join(dataDir, 'entregas', 'asg_1795000000000_aaaaaa', 'asub_1795000000000_bbbbbb');
        fs.mkdirSync(receiving, { recursive: true });
        fs.mkdirSync(storedDir, { recursive: true });
        const old = path.join(receiving, 'velho.part');
        const fresh = path.join(receiving, 'novo.part');
        const stored = path.join(storedDir, 'f_0000000000000001.pdf');
        [old, fresh, stored].forEach(file => fs.writeFileSync(file, '%PDF-'));
        const longAgo = (Date.now() - 3 * HOUR) / 1000;
        fs.utimesSync(old, longAgo, longAgo);
        fs.utimesSync(stored, longAgo, longAgo);
        const server = proc.launch(path.join(__dirname, 'fixtures', 'server-main-child.js'), { dataDir, port: await proc.freePort() });
        await proc.waitForHealth(server.base, { exited: server.exited });
        assert.equal(fs.existsSync(old), false, 'envio interrompido há mais de 1 h sai');
        assert.equal(fs.existsSync(fresh), true, 'envio recente fica (pode estar chegando)');
        assert.equal(fs.readFileSync(stored, 'utf8'), '%PDF-', 'entrega gravada intacta');
        server.child.kill('SIGTERM');
        await server.exited;
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
