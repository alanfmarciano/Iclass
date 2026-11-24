// Provedores do sino do aluno, do calendário do aluno e da fila "Precisa de você"
// (backend/utils/studentFeeds.js, fundação C0b da fase 3; K13 do plano). Cada grupo da
// fase 3 registra o seu provedor no próprio módulo, e os três pontos juntam os itens
// depois dos de hoje: aqui, com provedores de teste. A saída sem provedor é a de antes
// (igualdade-c0b.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-student-feeds-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const feeds = require('../../backend/utils/studentFeeds.js');
const { computeQueue } = require('../../backend/utils/dashboardAggregates.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');
const { crashLogPath } = require('../../backend/utils/errorLog.js');

const ADMIN = 'adm@feeds.local';
const PROF = 'prof@feeds.local';
const ANA = 'ana@feeds.local';
const NOW = Date.now();
const DAY = 86400000;
let app;
const cleanups = [];
const keep = unregister => { cleanups.push(unregister); return unregister; };

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: ADMIN, name: 'Administração', role: 'admin', password: 'x' },
        { email: PROF, name: 'Professora Paula', role: 'professor', password: 'x', assignedClasses: [{ courseId: 'DES', className: '1DES' }] },
    ];
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento', structure: [] }];
    db.memory.classes = [{ name: '1DES', courseId: 'DES', status: 'active', releasedItems: {} }, { name: '2DES', courseId: 'DES', status: 'active', releasedItems: {} }];
    db.memory.students = [{ name: 'Ana Souza', email: ANA, status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }], studentClass: '1DES', notificationsSeenAt: NOW - 2 * DAY }];
    db.memory.announcements = [
        { id: 'an_1', title: 'Aviso da turma', message: 'Prova na sexta.', target: 'turma', targetValue: '1DES', courseId: 'DES', createdAt: NOW - DAY, readBy: [] },
        { id: 'ev_1', kind: 'calendar', title: 'Feira', target: 'turma', targetValue: '1DES', courseId: 'DES', eventDate: '2026-11-05', startTime: '14:00' },
        { id: 'ev_2', kind: 'calendar', title: 'Prova final', target: 'curso', targetValue: 'DES', courseId: 'DES', eventDate: '2026-11-20', startTime: '08:00' },
    ];
    db.memory.forum = [];
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.attendance = [];
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => seed());
test.afterEach(() => { while (cleanups.length) cleanups.pop()(); });

const studentHeaders = () => ({ 'x-session-token': createStudentSession(db.memory, ANA) });
const adminHeaders = (email = ADMIN) => ({ 'x-admin-session': createAdminSession(db.memory, email) });
const CONTEXT = '?courseId=DES&studentClass=1DES';

test('[UC-FUNDACAO-001] registro: id e função obrigatórios, mesmo id troca e a função devolvida retira', () => {
    assert.throws(() => feeds.registerStudentNotificationProvider({ items: () => [] }), /sem id/);
    assert.throws(() => feeds.registerStudentNotificationProvider({ id: 'x' }), /items\(ctx\)/);
    assert.throws(() => feeds.registerStudentCalendarProvider({ id: 'x', items: () => [] }), /events\(ctx\)/);
    assert.throws(() => feeds.registerInstructorQueueProvider(null), /inválido/);
    // Os provedores de verdade já registrados pelo createApp (as tarefas do C6, 'tarefas',
    // e as provas aguardando correção do P3-S4a, 'correcoes-de-prova', que sem turma no
    // contexto não trazem item, os agendamentos de prova e material do P3-S12,
    // 'agendamentos', as mensagens do C13, 'mensagens', que sem turma ou sem quem vê no
    // contexto não trazem item, e os pedidos de revisão do A19, 'revisoes-de-nota') ficam
    // de fora da conta.
    const ownIds = () => feeds.providerIds('queue').filter(id => !['tarefas', 'correcoes-de-prova', 'agendamentos', 'mensagens', 'revisoes-de-nota'].includes(id));
    const first = feeds.registerInstructorQueueProvider({ id: 'teste', items: () => [{ id: 'a', titulo: 'A' }] });
    feeds.registerInstructorQueueProvider({ id: 'teste', items: () => [{ id: 'b', titulo: 'B' }] });
    assert.deepEqual(ownIds(), ['teste']);
    assert.deepEqual(feeds.collectInstructorQueue({}).map(item => item.id), ['b']);
    first(); // a função do registro trocado não retira o novo
    assert.deepEqual(ownIds(), ['teste']);
    keep(feeds.registerInstructorQueueProvider({ id: 'teste', items: () => [] }))();
    assert.deepEqual(ownIds(), []);
});

test('[UC-FUNDACAO-001] sino do aluno: itens do provedor entram na mesma ordem e no limite de 30, com o contexto da turma', async () => {
    const seen = [];
    keep(feeds.registerStudentNotificationProvider({
        id: 'tarefas',
        items: ctx => {
            seen.push(ctx);
            return [
                { id: 'tarefa:1', type: 'tarefa', title: 'Tarefa nova', text: 'x'.repeat(300), at: NOW - 12 * 3600000, href: '/aluno/tarefas', unread: true },
                { id: 'tarefa:2', type: 'tarefa', title: 'Prazo em 24 h', at: NOW - 3 * DAY, unread: false },
                { title: 'sem id' },
                { id: 'sem-titulo' },
                'texto solto',
            ];
        },
    }));
    const response = await request(app).get(`/api/student/notifications${CONTEXT}`).set(studentHeaders());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.items.map(item => item.id), ['tarefa:1', 'aviso:an_1', 'tarefa:2']);
    const item = response.body.items[0];
    assert.deepEqual(Object.keys(item), ['id', 'type', 'title', 'text', 'at', 'href', 'unread']);
    assert.equal(item.text.length, 140);
    assert.equal(response.body.unread, 2);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].email, ANA);
    assert.equal(seen[0].cls.name, '1DES');
    assert.equal(seen[0].courseId, 'DES');
    assert.equal(seen[0].studentClass, '1DES');
    assert.equal(seen[0].seenAt, NOW - 2 * DAY);
    assert.equal(seen[0].memory, db.memory);
    assert.match(seen[0].today, /^\d{4}-\d{2}-\d{2}$/);

    // 40 itens do provedor: o sino continua com os 30 mais novos.
    keep(feeds.registerStudentNotificationProvider({
        id: 'muitos',
        items: () => Array.from({ length: 40 }, (_, index) => ({ id: `muitos:${index}`, title: `Item ${index}`, at: NOW - index * 1000, unread: true })),
    }));
    const many = await request(app).get(`/api/student/notifications${CONTEXT}`).set(studentHeaders());
    assert.equal(many.body.items.length, 30);
    assert.equal(many.body.items[0].id, 'muitos:0');
});

test('[UC-FUNDACAO-001] provedor que falha não derruba o sino: fica de fora e vai para o crash.log', async () => {
    keep(feeds.registerStudentNotificationProvider({ id: 'quebrado', items: () => { throw new Error('falha de teste do provedor'); } }));
    keep(feeds.registerStudentNotificationProvider({ id: 'bom', items: () => [{ id: 'bom:1', title: 'Funciona', at: NOW, unread: true }] }));
    const response = await request(app).get(`/api/student/notifications${CONTEXT}`).set(studentHeaders());
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.items.map(item => item.id), ['bom:1', 'aviso:an_1']);
    assert.match(fs.readFileSync(crashLogPath(), 'utf8'), /provedor 'quebrado' \(notifications\)[\s\S]*falha de teste do provedor/);
});

test('[UC-FUNDACAO-001] calendário do aluno: eventos do provedor na ordem por data e hora, inválidos fora', async () => {
    const seen = [];
    keep(feeds.registerStudentCalendarProvider({
        id: 'tarefas',
        events: ctx => {
            seen.push(ctx);
            return [
                { id: 'tarefa:1', title: 'Entrega do trabalho', eventDate: '2026-11-05', startTime: '23:59', eventType: 'tarefa', href: '/aluno/tarefas/1' },
                { id: 'tarefa:2', title: 'Antes de tudo', eventDate: '2026-11-01' },
                { id: 'tarefa:3', title: 'Data errada', eventDate: '05/11/2026' },
                { id: 'tarefa:4', title: 'Hora errada', eventDate: '2026-11-06', startTime: '25h' },
            ];
        },
    }));
    const response = await request(app).get(`/api/student/calendar-events${CONTEXT}`).set(studentHeaders());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.map(item => item.id), ['tarefa:2', 'ev_1', 'tarefa:1', 'tarefa:4', 'ev_2']);
    const task = response.body.find(item => item.id === 'tarefa:1');
    assert.equal(task.source, 'tarefas');
    assert.equal(task.href, '/aluno/tarefas/1');
    assert.equal(response.body.find(item => item.id === 'tarefa:4').startTime, '');
    assert.equal(seen[0].cls.name, '1DES');
    assert.equal(seen[0].email, ANA);
    // Turma que não é do aluno continua recusada antes de qualquer provedor.
    const other = await request(app).get('/api/student/calendar-events?courseId=DES&studentClass=2DES').set(studentHeaders());
    assert.equal(other.status, 403);
    assert.equal(seen.length, 1);
});

test('[UC-FUNDACAO-001] fila "Precisa de você": pendências do provedor no fim, no escopo de quem vê', () => {
    const seen = [];
    keep(feeds.registerInstructorQueueProvider({
        id: 'correcoes',
        items: ctx => {
            seen.push(ctx);
            return [
                { id: 'entregas_para_corrigir', titulo: 'Entregas para corrigir', detalhe: '3 entregas · Tarefas', count: 3.7, tone: 'warning', href: '/tarefas', permissao: 'page.assignments', at: NOW - DAY },
                { id: 'sem_permissao', titulo: 'Sem permissão informada', tone: 'roxo' },
                { id: 'nao_adia', titulo: 'Não se adia', adiavel: false },
                { titulo: 'sem id' },
            ];
        },
    }));
    const memory = db.memory;
    const items = computeQueue({ memory, cls: memory.classes[0], course: memory.courses[0], students: memory.students, today: '2026-11-18', now: NOW, canSeeMatriculas: true });
    const tail = items.slice(-3);
    assert.deepEqual(tail.map(item => item.id), ['entregas_para_corrigir', 'sem_permissao', 'nao_adia']);
    assert.deepEqual(tail[0], { id: 'entregas_para_corrigir', tipo: 'entregas_para_corrigir', titulo: 'Entregas para corrigir', detalhe: '3 entregas · Tarefas', count: 3, tone: 'warning', href: '/tarefas', permissao: 'page.assignments', at: NOW - DAY });
    assert.equal(tail[1].permissao, 'page.dashboard');
    assert.equal(tail[1].tone, 'info');
    assert.equal(tail[2].adiavel, false);
    assert.deepEqual([...seen[0].emails], [ANA]);
    assert.equal(seen[0].cls.name, '1DES');
    assert.equal(seen[0].canSeeMatriculas, true);
    assert.equal(seen[0].now, NOW);
});

test('[UC-FUNDACAO-001] sino do instrutor reaproveita a fila: o item do provedor aparece por turma e respeita a permissão', async () => {
    keep(feeds.registerInstructorQueueProvider({
        id: 'correcoes',
        items: ctx => (ctx.cls ? [
            { id: 'entregas_para_corrigir', titulo: 'Entregas para corrigir', count: 2, tone: 'warning', href: '/tarefas', permissao: 'page.dashboard' },
            { id: 'so_admin', titulo: 'Só para quem cuida das contas', count: 1, href: '/admins', permissao: 'page.accounts' },
        ] : []),
    }));
    const admin = await request(app).get(`/api/admin/notifications${CONTEXT}`).set(adminHeaders());
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    const adminIds = admin.body.items.map(item => item.id);
    assert.ok(adminIds.includes('entregas_para_corrigir@DES::1DES'), adminIds.join(', '));
    assert.ok(adminIds.includes('so_admin@DES::1DES'));
    const prof = await request(app).get(`/api/admin/notifications${CONTEXT}`).set(adminHeaders(PROF));
    assert.equal(prof.status, 200, JSON.stringify(prof.body));
    const profIds = prof.body.items.map(item => item.id);
    assert.ok(profIds.includes('entregas_para_corrigir@DES::1DES'), profIds.join(', '));
    assert.ok(!profIds.includes('so_admin@DES::1DES'));
    // A fila do painel também traz o item, e o adiamento de 24 h vale para ele.
    const queue = await request(app).get(`/api/admin/dashboard/queue${CONTEXT}`).set(adminHeaders());
    assert.equal(queue.status, 200);
    assert.ok(queue.body.some(item => item.id === 'entregas_para_corrigir'));
});

test('[UC-FUNDACAO-001] fila "Precisa de você": o item do provedor só aparece para quem tem a permissão dele', async () => {
    keep(feeds.registerInstructorQueueProvider({
        id: 'mensagens',
        items: ctx => (ctx.cls ? [
            { id: 'entregas_para_corrigir', titulo: 'Entregas para corrigir', count: 2, tone: 'warning', href: '/tarefas', permissao: 'page.dashboard' },
            { id: 'so_admin', titulo: 'Só para quem cuida das contas', count: 1, href: '/admins', permissao: 'page.accounts' },
        ] : []),
    }));
    const admin = await request(app).get(`/api/admin/dashboard/queue${CONTEXT}`).set(adminHeaders());
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    const adminIds = admin.body.map(item => item.id);
    assert.ok(adminIds.includes('entregas_para_corrigir'), adminIds.join(', '));
    assert.ok(adminIds.includes('so_admin'), adminIds.join(', '));
    const prof = await request(app).get(`/api/admin/dashboard/queue${CONTEXT}`).set(adminHeaders(PROF));
    assert.equal(prof.status, 200, JSON.stringify(prof.body));
    const profIds = prof.body.map(item => item.id);
    assert.ok(profIds.includes('entregas_para_corrigir'), profIds.join(', '));
    assert.ok(!profIds.includes('so_admin'), 'o professor não vê o item de permissão que não tem');
    // Sem canAccess (chamada direta), computeQueue devolve tudo, como antes.
    const memory = db.memory;
    const all = computeQueue({ memory, cls: memory.classes[0], course: memory.courses[0], students: memory.students, today: '2026-11-18', now: NOW, canSeeMatriculas: false });
    assert.ok(all.some(item => item.id === 'so_admin'));
    const filtered = computeQueue({ memory, cls: memory.classes[0], course: memory.courses[0], students: memory.students, today: '2026-11-18', now: NOW, canSeeMatriculas: false }, { canAccess: permissao => permissao !== 'page.accounts' });
    assert.ok(!filtered.some(item => item.id === 'so_admin'));
    assert.ok(filtered.some(item => item.id === 'entregas_para_corrigir'));
});

test('[UC-FUNDACAO-001] item do provedor com permissão em lista: qualquer uma basta, na fila e no sino (permissoes_compostas)', async () => {
    keep(feeds.registerInstructorQueueProvider({
        id: 'lista',
        items: ctx => (ctx.cls ? [
            { id: 'gabarito', titulo: 'Gabarito para corrigir', count: 1, tone: 'warning', href: '/resultados', permissao: ['page.results', 'page.monitor'] },
            { id: 'contas_ou_sistema', titulo: 'Só contas ou sistema', count: 1, href: '/admins', permissao: ['page.accounts', ' system.manage ', ''] },
            { id: 'lista_vazia', titulo: 'Lista vazia', count: 1, href: '/', permissao: [] },
        ] : []),
    }));
    // A lista continua lista depois de normalizada (antes virava 'page.results,page.monitor').
    const memory = db.memory;
    const raw = computeQueue({ memory, cls: memory.classes[0], course: memory.courses[0], students: memory.students, today: '2026-11-18', now: NOW, canSeeMatriculas: false });
    assert.deepEqual(raw.find(item => item.id === 'gabarito').permissao, ['page.results', 'page.monitor']);
    assert.deepEqual(raw.find(item => item.id === 'contas_ou_sistema').permissao, ['page.accounts', 'system.manage']);
    assert.equal(raw.find(item => item.id === 'lista_vazia').permissao, 'page.dashboard');
    const admin = await request(app).get(`/api/admin/dashboard/queue${CONTEXT}`).set(adminHeaders());
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    const adminIds = admin.body.map(item => item.id);
    assert.ok(adminIds.includes('gabarito'), adminIds.join(', '));
    assert.ok(adminIds.includes('contas_ou_sistema'), adminIds.join(', '));
    const prof = await request(app).get(`/api/admin/dashboard/queue${CONTEXT}`).set(adminHeaders(PROF));
    assert.equal(prof.status, 200, JSON.stringify(prof.body));
    const profIds = prof.body.map(item => item.id);
    assert.ok(profIds.includes('gabarito'), profIds.join(', '));
    assert.ok(!profIds.includes('contas_ou_sistema'), profIds.join(', '));
    const bell = await request(app).get(`/api/admin/notifications${CONTEXT}`).set(adminHeaders());
    assert.equal(bell.status, 200, JSON.stringify(bell.body));
    assert.ok(bell.body.items.some(item => item.id === 'gabarito@DES::1DES'), bell.body.items.map(item => item.id).join(', '));
    const profBell = await request(app).get(`/api/admin/notifications${CONTEXT}`).set(adminHeaders(PROF));
    assert.ok(profBell.body.items.some(item => item.id === 'gabarito@DES::1DES'));
    assert.ok(!profBell.body.items.some(item => item.id === 'contas_ou_sistema@DES::1DES'));
});
