// Gerador da saída de hoje para o teste de igualdade da fundação C0b (sino, calendário,
// fila, Meus dados, Cadastros encerrados, troca de e-mail, anonimizar e apagar de vez).
//
// Uso: node test/backend/fixtures/igualdade-c0b.js <raiz do repositório>
// Monta sempre a mesma memória, chama as rotas e funções que os provedores
// (studentFeeds.js) e os handlers (studentDataHandlers.js) passaram a percorrer e
// escreve o resultado em JSON na saída. Usa só o que já existia antes do C0b, para rodar
// também numa cópia do código de antes: igualdade-c0b.json é a saída do código de antes
// (222dcae), e test/backend/student-data-handlers.test.js confere que o código de agora
// dá a mesma coisa.
//
// O que muda de uma execução para outra fica fixo ou é trocado por marcas: o sorteio
// (crypto e Math.random) vira uma sequência fixa; instantes do momento da execução
// (Date.now, horas de auditoria e de anonimização) viram '<agora>'; senhas e sessões
// ficam de fora.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// A saída é só o JSON: as mensagens do servidor (console.log) vão para o stderr.
console.log = (...args) => process.stderr.write(`${args.join(' ')}\n`);
console.info = console.log;

const root = path.resolve(process.argv[2] || path.join(__dirname, '../../..'));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-igualdade-c0b-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// Sorteio fixo (o pseudônimo da anonimização, ids de auditoria e de presença).
let counter = 0;
const nextBytes = size => {
    const out = Buffer.alloc(size);
    for (let i = 0; i < size; i++) { counter = (counter * 1103515245 + 12345) % 2147483648; out[i] = counter & 0xff; }
    return out;
};
const realRandomBytes = crypto.randomBytes;
crypto.randomBytes = (size, callback) => {
    const bytes = nextBytes(size);
    if (typeof callback === 'function') { process.nextTick(() => callback(null, bytes)); return undefined; }
    return bytes;
};
let seed = 42;
Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

const request = require(path.join(root, 'node_modules/supertest'));
const db = require(path.join(root, 'backend/database.js'));
const { createApp } = require(path.join(root, 'backend/server.js'));
const { createAdminSession, createStudentSession } = require(path.join(root, 'backend/utils/authSessions.js'));
const { computeQueue } = require(path.join(root, 'backend/utils/dashboardAggregates.js'));
const { buildStudentDataExport } = require(path.join(root, 'backend/utils/studentDataExport.js'));
const { closedStudentRows } = require(path.join(root, 'backend/utils/studentLifecycle.js'));

// Com ICLASS_IGUALDADE_COM_REGISTROS=1 (só no código de agora): provedores e handlers
// registrados que não acrescentam nada. Os laços novos rodam e a saída continua a mesma.
if (process.env.ICLASS_IGUALDADE_COM_REGISTROS === '1') {
    const feeds = require(path.join(root, 'backend/utils/studentFeeds.js'));
    const handlers = require(path.join(root, 'backend/utils/studentDataHandlers.js'));
    feeds.registerStudentNotificationProvider({ id: 'vazio', items: () => [] });
    feeds.registerStudentCalendarProvider({ id: 'vazio', events: () => [] });
    feeds.registerInstructorQueueProvider({ id: 'vazio', items: () => [] });
    const calls = [];
    handlers.registerStudentDataHandler({
        collection: 'colecaoVazia',
        label: 'Coleção vazia',
        rename: (memory, de, para) => { calls.push(['rename', de, para]); },
        anonymize: (memory, aluno, pseudonimo) => { calls.push(['anonymize', aluno.email, pseudonimo.email]); },
        purge: (memory, aluno) => { calls.push(['purge', aluno.email]); },
        merge: () => {},
        relink: () => false,
    });
    process.on('exit', () => process.stderr.write(`chamadas dos handlers: ${JSON.stringify(calls)}\n`));
}

const DAY = 86400000;
const BASE = Date.UTC(2026, 9, 20, 15, 0, 0); // 20/10/2026, 12:00 em São Paulo
const ADMIN = 'adm@igualdade.local';
const PROF = 'prof@igualdade.local';
const ANA = 'ana@igualdade.local';
const ANA_OLD = 'ana.antiga@igualdade.local';
const BIA = 'bia@igualdade.local';
const CAIO = 'caio@igualdade.local';
const DUDA = 'duda@igualdade.local';
const DUDA_NEW = 'duda.nova@igualdade.local';
const iso = ms => new Date(ms).toISOString();

function seedMemory() {
    const password = 'scrypt$fixo$fixo';
    db.memory.config = { ...(db.memory.config || {}), settings: { timezone: 'America/Sao_Paulo' } };
    db.memory.admins = [
        { email: ADMIN, name: 'Administração', role: 'admin', password },
        { email: PROF, name: 'Professora Paula', role: 'professor', password, assignedClasses: [{ courseId: 'DES', className: '1DES' }] },
    ];
    db.memory.schools = [{ id: 'escola_a', name: 'Escola Alfa', info: { dpoName: 'Encarregada Lia', dpoEmail: 'dpo@escola.local' }, branding: {} }];
    db.memory.courses = [{
        id: 'DES', name: 'Desenvolvimento', schoolId: 'escola_a',
        disciplinas: [{ id: 'prog', nome: 'Programação' }],
        structure: [{ id: 'm1', name: 'Módulo 1', units: [{ name: 'Unidade 1', apostilaKey: 'Apostila_1', avaliacaoKey: 'Prova_1', files: [] }] }],
    }];
    db.memory.classes = [
        {
            name: '1DES', courseId: 'DES', status: 'active', period: 'Manhã', releasedItems: {},
            studentReleasedItems: { [BIA]: { Apostila_9: true }, [DUDA]: { Apostila_8: true } },
            attendanceConfig: { grade: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map(dia => [dia, [{ ordem: 1, inicio: '08:00', disciplinaId: 'prog' }]])) },
        },
        { name: '2DES', courseId: 'DES', status: 'active', period: 'Tarde', releasedItems: {} },
    ];
    const enrolled = (name, email, extra = {}) => ({
        name, email, status: 'Ativo', password, matricula: '', classes: [{ name: '1DES', courseId: 'DES' }], studentClass: '1DES', period: 'Manhã', ...extra,
    });
    db.memory.students = [
        enrolled('Ana Souza', ANA, { matricula: '2026-001', phone: '11 98888-0000', notificationsSeenAt: BASE - 4 * DAY, notificationsSeenAtByContext: { 'DES::1DES': BASE - 3 * DAY } }),
        enrolled('Bia Lima', BIA, { matricula: '2026-002', status: 'Inativo', statusChangedAt: BASE - 30 * DAY, statusChangedBy: ADMIN, statusReason: 'Pedido da família da Bia Lima', guardian: { name: 'Rita Lima', phone: '11 9' } }),
        enrolled('Caio Prado', CAIO, { matricula: '2026-003', status: 'Transferido', statusChangedAt: BASE - 20 * DAY, statusChangedBy: ADMIN, statusReason: 'Mudou de escola' }),
        enrolled('Duda Reis', DUDA, { matricula: '2026-004' }),
        enrolled('Edu Novo', ANA_OLD, { createdAt: BASE - 5 * DAY }),
    ];
    const sub = (id, email, name, examKey, score, extra = {}) => ({
        id, student: { name, email, studentClass: '1DES', courseId: 'DES', period: 'Manhã' }, examKey, score, correctCount: 4, totalCount: 5,
        gradedAnswers: [{ questionNumber: 1, studentChoice: 'A', correctAnswer: 'A', isCorrect: true }], type: 'online', attemptNumber: 1,
        timestamp: iso(BASE - 10 * DAY), ...extra,
    });
    db.memory.submissions = [
        sub('sub_ana_pub', ANA, 'Ana Souza', 'Prova_1', 80, { gradePublished: true, gradePublishedAt: BASE - 2 * DAY, gradePublishedBy: PROF }),
        sub('sub_ana_rev', ANA, 'Ana Souza', 'Prova_2', 55, { gradePublished: false }),
        sub('sub_bia', BIA, 'Bia Lima', 'Prova_1', 70, { gradePublished: true, gradePublishedAt: BASE - 40 * DAY, studentMatricula: '2026-002' }),
        sub('sub_caio', CAIO, 'Caio Prado', 'Prova_1', 60, { gradePublished: true, gradePublishedAt: BASE - 25 * DAY }),
        sub('sub_duda', DUDA, 'Duda Reis', 'Prova_1', 90, { gradePublished: true, gradePublishedAt: BASE - 1 * DAY, recoveredAfterFinish: true }),
    ];
    db.memory.evaluations = { Prova_1: { title: 'Prova 1', questions: [] }, Prova_2: { title: 'Prova 2', questions: [] } };
    const att = (id, email, date, status, extra = {}) => ({
        id, studentEmail: email, studentClass: '1DES', courseId: 'DES', date, origin: 'chamada', concluida: true,
        aulas: [{ ordem: 1, status }], markedBy: PROF, timestamp: BASE - 15 * DAY, ...extra,
    });
    db.memory.attendance = [
        att('att_ana', ANA, '2026-10-01', 'presente'),
        att('att_bia', BIA, '2026-09-10', 'justificada', { justificativa: { tipo: 'atestado', texto: 'Consulta da Bia', arquivo: 'alunos/2026-002 - Bia Lima/atestados/a.pdf', abonado: true }, observacao: 'Chegou cedo', ip: '10.0.0.9' }),
        att('att_caio', CAIO, '2026-09-11', 'falta'),
        att('att_duda', DUDA, '2026-10-02', 'presente'),
    ];
    db.memory.certificates = [
        { id: 'cert_bia', studentEmail: BIA, courseId: 'DES', code: 'CERT-B', status: 'Emitido', issuedAt: BASE - 35 * DAY, issuedBy: ADMIN },
        { id: 'cert_caio', studentEmail: CAIO, courseId: 'DES', code: 'CERT-C', status: 'Emitido', issuedAt: BASE - 22 * DAY, issuedBy: ADMIN },
        { id: 'cert_duda', studentEmail: DUDA, courseId: 'DES', code: 'CERT-D', status: 'Emitido', issuedAt: BASE - 2 * DAY, issuedBy: ADMIN },
    ];
    db.memory.pedagogicalObservations = [
        { id: 'obs_ana', studentEmail: ANA, author: PROF, category: 'Participação', visibility: 'Compartilhada', text: 'Participa bem.', timestamp: BASE - 9 * DAY },
        { id: 'obs_ana_team', studentEmail: ANA, author: PROF, category: 'Participação', visibility: 'Equipe pedagógica', text: 'Conversar com a família.', timestamp: BASE - 8 * DAY },
        { id: 'obs_bia', studentEmail: BIA, author: PROF, category: 'Participação', visibility: 'Compartilhada', text: 'Bia ajudou.', timestamp: BASE - 40 * DAY },
        { id: 'obs_duda', studentEmail: DUDA, author: PROF, category: 'Participação', visibility: 'Compartilhada', text: 'Duda ótima.', timestamp: BASE - 4 * DAY },
    ];
    db.memory.progress = { [ANA]: { Apostila_1: true }, [BIA]: { Apostila_1: true }, [DUDA]: { Apostila_1: true } };
    db.memory.notes = { [ANA]: { geral: 'Minhas anotações.' }, [DUDA]: { geral: 'Da Duda.' } };
    db.memory.annotations = { [ANA]: { Apostila_1: [{ text: 'grifo' }] }, [CAIO]: { Apostila_1: [{ text: 'do Caio' }] } };
    db.memory.forum = [
        {
            id: 'f_ana', key: 'Apostila_1', courseId: 'DES', studentClass: '1DES', studentName: 'Ana Souza', studentEmail: ANA, text: 'Minha dúvida', timestamp: iso(BASE - 3 * DAY), status: 'respondida',
            replies: [{ id: 'r_prof', authorName: 'Professora Paula', authorEmail: PROF, authorRole: 'Instrutor', text: 'Resposta', timestamp: iso(BASE - 2 * DAY) }],
        },
        {
            id: 'f_bia', key: 'Apostila_1', courseId: 'DES', studentClass: '1DES', studentName: 'Bia Lima', studentEmail: BIA, text: 'Dúvida da Bia', timestamp: iso(BASE - 45 * DAY),
            replies: [{ id: 'r_duda', authorName: 'Duda Reis', authorEmail: DUDA, authorRole: 'Aluno', text: 'Palpite da Duda', timestamp: iso(BASE - 44 * DAY) }],
        },
        { id: 'f_caio', key: 'Apostila_1', courseId: 'DES', studentClass: '1DES', studentName: 'Caio Prado', studentEmail: CAIO, text: 'Parada', timestamp: iso(BASE - 25 * DAY), replies: [] },
    ];
    db.memory.moduleAccess = [
        { id: 'acc_ana', studentEmail: ANA, key: 'Apostila_1', courseId: 'DES', studentClass: '1DES', timestamp: BASE - DAY },
        { id: 'acc_bia', studentEmail: BIA, key: 'Apostila_1', courseId: 'DES', studentClass: '1DES', timestamp: BASE - 40 * DAY },
    ];
    db.memory.loginLogs = [
        { id: 'login_ana', email: ANA, role: 'student', status: 'success', timestamp: BASE - DAY, ip: '10.0.0.5' },
        { id: 'login_bia', email: BIA, role: 'student', status: 'success', timestamp: BASE - 40 * DAY, ip: '10.0.0.6' },
        { id: 'login_prof', email: PROF, role: 'professor', status: 'success', timestamp: BASE - DAY, ip: '10.0.0.1' },
    ];
    db.memory.proctoringLogs = [
        { id: 'pl_ana', studentEmail: ANA, examKey: 'Prova_1', type: 'tab_blur', timestamp: BASE - 10 * DAY },
        { id: 'pl_bia', studentEmail: BIA, examKey: 'Prova_1', type: 'tab_blur', timestamp: BASE - 40 * DAY },
    ];
    db.memory.broadcastMessages = [
        { id: 'msg_bia', studentClass: '1DES', courseId: 'DES', examKey: 'Prova_1', targetEmail: BIA, messageText: 'Bia, confira.', senderEmail: PROF, acknowledgedBy: [BIA], timestamp: BASE - 40 * DAY },
        { id: 'msg_all', studentClass: '1DES', courseId: 'DES', examKey: 'Prova_1', targetEmail: null, messageText: 'Para todos.', senderEmail: PROF, acknowledgedBy: [ANA, CAIO, DUDA], deletedFor: [CAIO], timestamp: BASE - 10 * DAY },
    ];
    db.memory.announcements = [
        { id: 'an_turma', title: 'Aviso da turma', message: 'Prova na sexta.', target: 'turma', targetValue: '1DES', courseId: 'DES', priority: 'normal', createdAt: BASE - 2 * DAY, readBy: [DUDA], authorName: 'Professora Paula' },
        { id: 'an_curso', title: 'Aviso do curso', message: 'Semana de provas.', target: 'curso', targetValue: 'DES', courseId: 'DES', priority: 'alta', pinned: true, createdAt: BASE - 5 * DAY, readBy: [ANA, BIA], expiresAt: '2099-12-31' },
        { id: 'an_velho', title: 'Aviso vencido', message: 'Já passou.', target: 'turma', targetValue: '1DES', courseId: 'DES', createdAt: BASE - 50 * DAY, expiresAt: '2020-01-01' },
        { id: 'an_bia', title: 'Só para a Bia', message: 'Traga o documento.', target: 'aluno', targetValue: BIA, courseId: 'DES', createdAt: BASE - 41 * DAY, readBy: [] },
        { id: 'an_duda', title: 'Só para a Duda', message: 'Parabéns.', target: 'aluno', targetValue: DUDA, courseId: 'DES', createdAt: BASE - DAY, readBy: [DUDA] },
        { id: 'ev_turma', kind: 'calendar', title: 'Feira de ciências', message: 'No pátio.', target: 'turma', targetValue: '1DES', courseId: 'DES', eventDate: '2026-11-05', startTime: '14:00', endTime: '17:00', eventType: 'evento', authorName: 'Professora Paula', createdAt: BASE - 6 * DAY },
        { id: 'ev_curso', kind: 'calendar', title: 'Prova final', target: 'curso', targetValue: 'DES', courseId: 'DES', eventDate: '2026-11-05', startTime: '08:00', eventType: 'prova', createdAt: BASE - 6 * DAY },
        { id: 'ev_outra', kind: 'calendar', title: 'Da outra turma', target: 'turma', targetValue: '2DES', courseId: 'DES', eventDate: '2026-10-30', createdAt: BASE - 6 * DAY },
    ];
    db.memory.examApplications = [
        { id: 'app_run', examKey: 'Prova_2', studentClass: '1DES', courseId: 'DES', status: 'running', startedAt: iso(BASE - 3600000), createdAt: iso(BASE - 7200000) },
        { id: 'app_prep', examKey: 'Prova_1', studentClass: '1DES', courseId: 'DES', status: 'prepared', startsAt: BASE + 2 * DAY, createdAt: iso(BASE - DAY) },
        {
            id: 'app_fim', examKey: 'Prova_1', studentClass: '1DES', courseId: 'DES', status: 'finished', createdAt: iso(BASE - 40 * DAY),
            questionReports: [{ id: 'rep_bia', studentEmail: BIA, studentName: 'Bia Lima', questionNumber: 2, text: 'A Bia Lima acha que tem duas certas.', createdAt: BASE - 40 * DAY }],
            studentAdjustments: { [BIA]: { extraMinutes: 10 }, [DUDA]: { extraMinutes: 5 } },
            studentVersions: { [BIA]: 'B', [DUDA]: 'A' },
            finishResolution: { discardedAttempts: [{ studentEmail: CAIO, attemptId: 'x' }] },
        },
    ];
    db.memory.studentExamState = {
        [`Prova_9::${DUDA}::1DES`]: { studentEmail: DUDA, status: 'in_progress' },
        [`Prova_9::${CAIO}::1DES`]: { studentEmail: CAIO, status: 'in_progress' },
    };
    db.memory.auditLogs = [
        { id: 'aud_email', action: 'update', category: 'student', actor: ADMIN, studentEmail: ANA, field: 'E-mail/login', oldValue: ANA_OLD, newValue: ANA, timestamp: BASE - 50 * DAY },
        { id: 'aud_bia', action: 'update', category: 'student', actor: PROF, studentEmail: BIA, field: 'Telefone', oldValue: '', newValue: '11 9', timestamp: BASE - 45 * DAY },
        { id: 'aud_bia_status', action: 'student_status_changed', category: 'student', actor: ADMIN, studentEmail: BIA, field: 'Situação', oldValue: 'Ativo', newValue: 'Inativo', reason: 'Pedido da família da Bia Lima', timestamp: BASE - 30 * DAY },
        { id: 'aud_caio_grade', action: 'grade_delete', category: 'grade', actor: PROF, studentEmail: CAIO, examKey: 'Prova_2', submissionId: 'sub_caio_old', timestamp: BASE - 24 * DAY,
            details: { deletedSubmission: { id: 'sub_caio_old', student: { name: 'Caio Prado', email: CAIO, studentClass: '1DES', courseId: 'DES' }, examKey: 'Prova_2', score: 40 } } },
        { id: 'aud_duda', action: 'grade_publish', category: 'grade', actor: PROF, studentEmail: DUDA, examKey: 'Prova_1', timestamp: BASE - DAY },
    ];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
}

// Instantes da execução viram '<agora>'; senha e sessões saem.
let windowStart = 0;
const SKIP_KEYS = new Set(['password', 'authSessions', 'sessions', 'adminSessions']);
const RANDOM_KEYS = new Set(['ref', 'anonymizedRef']);
function stable(value) {
    const now = Date.now() + 60000;
    const inWindow = number => number >= windowStart && number <= now;
    if (typeof value === 'number') return inWindow(value) ? '<agora>' : value;
    if (typeof value === 'string') {
        const parsed = /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
        if (Number.isFinite(parsed) && inWindow(parsed)) return '<agora>';
        return value
            .replace(/\d{13}/g, digits => (inWindow(Number(digits)) ? '<agora>' : digits))
            // Sorteios: o sufixo do id de auditoria e o pseudônimo da anonimização não
            // dependem de quantas vezes o código sorteou antes.
            .replace(/(_<agora>_)[0-9a-f]+/g, '$1<sorteio>')
            .replace(/anonimizado-[0-9a-f]{12}@anonimizado\.invalid/g, 'anonimizado-<ref>@anonimizado.invalid')
            .replace(/Aluno anonimizado [0-9A-F]{6}/g, 'Aluno anonimizado <REF>');
    }
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        const out = {};
        Object.keys(value).forEach(key => {
            if (SKIP_KEYS.has(key)) return;
            out[key] = RANDOM_KEYS.has(key) && typeof value[key] === 'string' ? '<sorteio>' : stable(value[key]);
        });
        return out;
    }
    return value;
}

const MEMORY_KEYS = ['students', 'submissions', 'attendance', 'certificates', 'pedagogicalObservations', 'progress', 'notes', 'annotations',
    'forum', 'moduleAccess', 'loginLogs', 'proctoringLogs', 'broadcastMessages', 'announcements', 'examApplications', 'studentExamState', 'classes', 'auditLogs'];
const memoryDump = () => {
    const out = {};
    MEMORY_KEYS.forEach(key => { out[key] = JSON.parse(JSON.stringify(db.memory[key] === undefined ? null : db.memory[key])); });
    return out;
};

async function main() {
    windowStart = Date.now() - 1000;
    await db.init();
    seedMemory();
    const app = createApp();
    const admin = { 'x-admin-session': createAdminSession(db.memory, ADMIN) };
    const ana = { 'x-session-token': createStudentSession(db.memory, ANA) };
    const out = {};
    const body = response => ({ status: response.status, body: response.body });
    const context = '?courseId=DES&studentClass=1DES';

    // Sino e calendário do aluno.
    out.sinoAluno = body(await request(app).get(`/api/student/notifications${context}`).set(ana));
    out.calendarioAluno = body(await request(app).get(`/api/student/calendar-events${context}`).set(ana));

    // Fila "Precisa de você" (função pura) e sino do instrutor (que reaproveita a fila).
    const cls = db.memory.classes[0];
    const course = db.memory.courses[0];
    const students = db.memory.students.filter(student => student.status === 'Ativo');
    out.fila = computeQueue({ memory: db.memory, cls, course, students, today: '2026-10-20', now: BASE, canSeeMatriculas: true },
        { storage: { freeBytes: 30 * 1024 * 1024, allocatedBytes: 100 * 1024 * 1024 }, security: { recoveryEmails: [ANA], delayedEmails: [], waitingEmails: [] } });
    out.filaSemTurma = computeQueue({ memory: db.memory, cls: null, course: null, students: [], today: '2026-10-20', now: BASE, canSeeMatriculas: false });
    out.sinoInstrutor = body(await request(app).get(`/api/admin/notifications${context}`).set(admin));

    // Meus dados (aluno e administrador) e Cadastros encerrados.
    out.meusDadosAluno = buildStudentDataExport(db.memory, ANA, { audience: 'aluno', now: BASE });
    out.meusDadosAdmin = buildStudentDataExport(db.memory, ANA, { audience: 'admin', now: BASE, generatedBy: ADMIN });
    out.encerrados = closedStudentRows(db.memory, { sinceOf: student => Number(student.statusChangedAt) || null });
    out.encerradosRota = body(await request(app).get('/api/admin/students/closed').set(admin));

    // Troca de e-mail (renameStudentEmailEverywhere).
    const duda = db.memory.students.find(student => student.email === DUDA);
    out.trocaEmail = body(await request(app).post('/api/admin/student/update').set(admin).send({
        originalEmail: DUDA, email: DUDA_NEW, name: duda.name, matricula: duda.matricula, status: 'Ativo',
        classes: [{ name: '1DES', courseId: 'DES' }], period: 'Manhã',
    }));
    out.memoriaDepoisDaTroca = memoryDump();

    // Anonimizar (Bia) e apagar de vez (Caio).
    out.anonimizar = body(await request(app).post('/api/admin/students/anonymize').set(admin).send({ email: BIA, confirm: 'ANONIMIZAR', reason: 'Pedido da Bia Lima pela LGPD' }));
    out.memoriaDepoisDeAnonimizar = memoryDump();
    out.apagar = body(await request(app).post('/api/admin/students/purge').set(admin).send({ email: CAIO, confirm: 'APAGAR', reason: 'Transferido há muito tempo' }));
    out.memoriaDepoisDeApagar = memoryDump();
    out.encerradosDepois = closedStudentRows(db.memory, { sinceOf: student => Number(student.statusChangedAt) || null });

    await new Promise(resolve => setTimeout(resolve, 200));
    process.stdout.write(`${JSON.stringify(stable(out), null, 1)}\n`);
}

main().then(() => {
    crypto.randomBytes = realRandomBytes;
    try { db.close && db.close(); } catch (error) { /* fim */ }
    setTimeout(() => process.exit(0), 50);
}).catch(error => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exit(1);
});
