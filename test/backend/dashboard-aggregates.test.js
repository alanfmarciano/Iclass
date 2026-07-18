const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-dashboard-v3-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const { computeNow, computeQueue, computeTrends } = require('../../backend/utils/dashboardAggregates.js');

// ---------------------------------------------------------------------------
// Cenário base: turma com grade hoje, uma aplicação futura e histórico de 60 dias.
// `now` fixo: quarta-feira 2026-07-15 às 09:00 (grade cobre qualquer weekday).
// ---------------------------------------------------------------------------
const NOW = Date.parse('2026-07-15T12:00:00Z'); // 09:00 em America/Sao_Paulo
const TODAY = '2026-07-15';
const NOW_MIN = 9 * 60; // 09:00 local

const grade = {};
for (let wd = 0; wd <= 6; wd++) grade[String(wd)] = [
    { ordem: 1, inicio: '08:00', disciplinaId: 'LOG' },
    { ordem: 2, inicio: '08:50', disciplinaId: 'BD' },
    { ordem: 3, inicio: '10:00', disciplinaId: 'RED' },
];

function baseMemory() {
    const students = [
        { email: 'a@t.local', name: 'Aluno A', classes: [{ name: '1DES', courseId: 'TI' }], enrollmentRequests: [{ id: 'r1', status: 'pending' }] },
        { email: 'b@t.local', name: 'Aluno B', classes: [{ name: '1DES', courseId: 'TI' }] },
        { email: 'c@t.local', name: 'Aluno C', classes: [{ name: '1DES', courseId: 'TI' }], lastLoginAt: NOW - 20 * 86400000 },
    ];
    const dias = (n) => {
        const d = new Date(NOW - n * 86400000);
        return d.toISOString().slice(0, 10);
    };
    return {
        students,
        classes: [{
            name: '1DES', courseId: 'TI', releasedItems: { 'Apostila_TI_1': true },
            attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade },
        }],
        courses: [{
            id: 'TI',
            disciplinas: [{ id: 'LOG', nome: 'Lógica de Programação' }, { id: 'BD', nome: 'Banco de Dados' }, { id: 'RED', nome: 'Redes' }],
            structure: [{ name: 'Módulo 1', units: [
                { id: '1', name: 'Unidade 1', apostilaKey: 'Apostila_TI_1', avaliacaoKey: 'Avaliacao_TI_1', files: [] },
                { id: '2', name: 'Unidade 2', apostilaKey: 'Apostila_TI_2', avaliacaoKey: 'Avaliacao_TI_2', files: [] },
            ] }],
        }],
        evaluations: { 'Avaliacao_TI_2': { title: 'Avaliação — Unidade 2' } },
        examApplications: [
            { id: 'app_fut', examKey: 'Avaliacao_TI_2', studentClass: '1DES', courseId: 'TI', status: 'prepared', startsAt: NOW + 3 * 86400000, endsAt: null },
        ],
        submissions: [
            { id: 's1', examKey: 'Avaliacao_TI_1', score: 80, timestamp: new Date(NOW - 5 * 86400000).toISOString(), student: { email: 'a@t.local', courseId: 'TI' } },
            { id: 's2', examKey: 'Avaliacao_TI_1', score: 60, timestamp: new Date(NOW - 40 * 86400000).toISOString(), student: { email: 'a@t.local', courseId: 'TI' } },
        ],
        attendance: [
            { id: 'd1', studentEmail: 'a@t.local', courseId: 'TI', studentClass: '1DES', date: dias(3), origin: 'chamada', concluida: true, aulas: [{ ordem: 1, disciplinaId: 'LOG', status: 'presente' }] },
            { id: 'd2', studentEmail: 'a@t.local', courseId: 'TI', studentClass: '1DES', date: dias(40), origin: 'chamada', concluida: true, aulas: [{ ordem: 1, disciplinaId: 'LOG', status: 'falta' }] },
        ],
        forum: [
            { id: 'f1', key: 'geral', studentEmail: 'a@t.local', courseId: 'TI', studentClass: '1DES', text: 'dúvida parada', timestamp: new Date(NOW - 2 * 86400000).toISOString(), replies: [] },
            { id: 'f2', key: 'geral', studentEmail: 'b@t.local', courseId: 'TI', studentClass: '1DES', text: 'respondida', timestamp: new Date(NOW - 2 * 86400000).toISOString(), status: 'respondida', replies: [{ id: 'r', authorRole: 'Instrutor', timestamp: new Date(NOW).toISOString() }] },
            { id: 'f3', key: 'geral', studentEmail: 'a@t.local', courseId: 'TI', studentClass: '1DES', text: 'recente', timestamp: new Date(NOW - 3600000).toISOString(), replies: [] },
        ],
        moduleAccess: [
            { id: 'm1', studentEmail: 'a@t.local', timestamp: NOW - 2 * 86400000 },
            { id: 'm2', studentEmail: 'b@t.local', timestamp: NOW - 10 * 86400000 },
        ],
        sessions: { 'a@t.local': { lastSeen: NOW - 60000 }, 'b@t.local': { lastSeen: NOW - 3 * 3600000 } },
        admins: [],
    };
}
function scopeOf(memory) {
    return {
        memory, cls: memory.classes[0], course: memory.courses[0], students: memory.students,
        today: TODAY, nowMin: NOW_MIN, now: NOW,
    };
}

test('[UC-DASH-001] now: aula corrente da grade com estado da chamada', () => {
    const now = computeNow(scopeOf(baseMemory()));
    assert.ok(now.aula, 'às 09:00 a 2ª aula (08:50–10:00) está em curso');
    assert.equal(now.aula.ordem, 2);
    assert.equal(now.aula.nome, 'Banco de Dados');
    assert.equal(now.aula.fim, '10:00'); // fim = início da próxima
    assert.equal(now.aula.chamadaStatus, 'nao_lancada');
    assert.equal(now.proximaAula, null); // há aula em curso
});

test('[UC-DASH-001] now: fora de horário devolve aula null e a próxima aula', () => {
    const scope = scopeOf(baseMemory());
    scope.nowMin = 22 * 60; // 22:00 — depois da última aula
    const now = computeNow(scope);
    assert.equal(now.aula, null);
    assert.ok(now.proximaAula, 'deve apontar a primeira aula do dia seguinte');
    assert.equal(now.proximaAula.inicio, '08:00');
});

test('[UC-DASH-001] now: aplicação futura vem de startsAt, e online tem janela e última leitura', () => {
    const now = computeNow(scopeOf(baseMemory()));
    assert.equal(now.aplicacao, null);
    assert.ok(now.proximaAplicacao);
    assert.equal(now.proximaAplicacao.titulo, 'Avaliação — Unidade 2');
    assert.equal(now.online.count, 1); // só a@ nos últimos 5 min
    assert.equal(now.online.janelaMin, 5);
    assert.equal(now.online.ultimoAcessoAt, NOW - 60000);
});

test('[UC-DASH-002] queue: chamada pendente, dúvidas >24h, sem avaliação e conteúdo bloqueado', () => {
    const memory = baseMemory();
    const items = computeQueue({ ...scopeOf(memory), canSeeMatriculas: true });
    const ids = items.map(i => i.id);
    assert.ok(ids.includes('chamada_pendente'), 'hoje é dia letivo sem chamada concluída');
    const duvidas = items.find(i => i.id === 'duvidas_paradas');
    assert.equal(duvidas.count, 1, 'só f1 está parada: f2 respondida, f3 tem menos de 24h');
    const semAval = items.find(i => i.id === 'sem_avaliacao');
    assert.equal(semAval.count, 2, 'b@ e c@ nunca entregaram prova');
    const bloqueado = items.find(i => i.id === 'conteudo_bloqueado');
    assert.equal(bloqueado.count, 1, 'Apostila_TI_2 bloqueada com prova em 3 dias');
    assert.ok(items.every(i => i.href && i.titulo && i.tone), 'todo item tem destino clicável');
});

test('[UC-DASH-002] queue: matrículas só aparecem para administrador pleno', () => {
    const memory = baseMemory();
    const admin = computeQueue({ ...scopeOf(memory), canSeeMatriculas: true });
    const professor = computeQueue({ ...scopeOf(memory), canSeeMatriculas: false });
    assert.ok(admin.some(i => i.id === 'matriculas'));
    assert.ok(!professor.some(i => i.id === 'matriculas'));
});

test('[UC-DASH-002] queue: chamada concluída não gera pendência', () => {
    const memory = baseMemory();
    memory.attendance.push({ id: 'hoje', studentEmail: 'a@t.local', courseId: 'TI', studentClass: '1DES', date: TODAY, origin: 'chamada', concluida: true, aulas: [{ ordem: 1, disciplinaId: 'LOG', status: 'presente' }] });
    const items = computeQueue({ ...scopeOf(memory), canSeeMatriculas: false });
    assert.ok(!items.some(i => i.id === 'chamada_pendente'));
});

test('[UC-DASH-003] trends: janelas móveis de 30 dias e "sem dado" nunca vira zero', () => {
    const memory = baseMemory();
    const t = computeTrends({ memory, students: memory.students, course: memory.courses[0], now: NOW });
    assert.equal(t.media.atual, 8, 'só s1 (80) está na janela atual');
    assert.equal(t.media.anterior, 6, 's2 (60) está na janela anterior');
    assert.equal(t.media.delta, 2);
    assert.equal(t.frequencia.atual, 100, 'presença única na janela atual');
    assert.equal(t.frequencia.anterior, 0, 'falta única na janela anterior');
    assert.equal(t.frequencia.base.total, 3);
    assert.equal(t.engajamento.atual, 1, 'só a@ acessou nos últimos 7 dias');
    assert.equal(t.engajamento.semAcessoMais14d, 1, 'c@ está sem acesso há 20 dias');
    assert.equal(t.frequencia.serie.length, 6);
    assert.equal(t.media.serie.length, 6);
});

test('[UC-DASH-003] trends: turma sem histórico devolve null, não zero', () => {
    const memory = baseMemory();
    memory.attendance = []; memory.submissions = []; memory.moduleAccess = [];
    const t = computeTrends({ memory, students: memory.students, course: memory.courses[0], now: NOW });
    assert.equal(t.frequencia.atual, null);
    assert.equal(t.media.atual, null);
    assert.equal(t.media.delta, null);
    assert.equal(t.engajamento.atual, 0); // contagem de alunos é contagem, não média
});

// ---------------------------------------------------------------------------
// Escopo e permissão nas rotas reais (supertest): professor de outra turma
// recebe fila sem matrículas e trends de base vazia.
// ---------------------------------------------------------------------------
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

let app;
const adminToken = 'admin-token-dash-v3';
const profToken = 'prof-token-dash-v3';
const profForaToken = 'prof-fora-token-dash-v3';

test.before(async () => {
    await db.init();
    app = createApp();
    const memory = baseMemory();
    Object.assign(db.memory, memory);
    db.memory.admins = [
        { email: 'root@dash.local', name: 'Root', role: 'admin', password: db.hashPassword('senha-raiz-ok') },
        { email: 'prof@dash.local', name: 'Prof', role: 'professor', password: db.hashPassword('senha-prof-ok'), assignedClasses: [{ courseId: 'TI', className: '1DES' }] },
        { email: 'prof.fora@dash.local', name: 'Prof Fora', role: 'professor', password: db.hashPassword('senha-prof-2'), assignedClasses: [{ courseId: 'OUTRO', className: 'X' }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'root@dash.local', createdAt: Date.now(), lastSeen: Date.now() },
        [profToken]: { email: 'prof@dash.local', createdAt: Date.now(), lastSeen: Date.now() },
        [profForaToken]: { email: 'prof.fora@dash.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
});

test('[UC-DASH-004] rotas exigem admin e aplicam escopo de professor', async () => {
    const anon = await request(app).get('/api/admin/dashboard/queue?courseId=TI&studentClass=1DES');
    assert.equal(anon.status, 401);

    const admin = await request(app).get('/api/admin/dashboard/queue?courseId=TI&studentClass=1DES')
        .set('x-admin-session', adminToken);
    assert.equal(admin.status, 200);
    assert.ok(admin.body.some(i => i.id === 'matriculas'), 'admin pleno vê matrículas');

    // Professor DA turma: fila normal, mas nunca vê matrículas.
    const prof = await request(app).get('/api/admin/dashboard/queue?courseId=TI&studentClass=1DES')
        .set('x-admin-session', profToken);
    assert.equal(prof.status, 200);
    assert.ok(!prof.body.some(i => i.id === 'matriculas'), 'professor não vê matrículas');
    assert.ok(prof.body.some(i => i.id === 'sem_avaliacao'), 'pendências da própria turma aparecem');

    // Professor de OUTRO curso: o guarda global de escopo bloqueia a requisição.
    const fora = await request(app).get('/api/admin/dashboard/queue?courseId=TI&studentClass=1DES')
        .set('x-admin-session', profForaToken);
    assert.equal(fora.status, 403, 'curso fora das atribuições → 403 (convenção do app)');

    const now = await request(app).get('/api/admin/dashboard/now?courseId=TI&studentClass=1DES')
        .set('x-admin-session', adminToken);
    assert.equal(now.status, 200);
    assert.ok('aula' in now.body && 'online' in now.body);

    const trends = await request(app).get('/api/admin/dashboard/trends?courseId=TI&studentClass=1DES')
        .set('x-admin-session', adminToken);
    assert.equal(trends.status, 200);
    assert.ok(trends.body.frequencia && trends.body.media && trends.body.engajamento);
});

test('[UC-DASH-002] queue: item adiado (snooze < 24h) não aparece; expirado volta', async () => {
    const account = db.memory.admins.find(a => a.email === 'root@dash.local');
    account.preferences = { 'dashboard.snoozed': { sem_avaliacao: Date.now() - 3600000, duvidas_paradas: Date.now() - 25 * 3600000 } };
    const res = await request(app).get('/api/admin/dashboard/queue?courseId=TI&studentClass=1DES')
        .set('x-admin-session', adminToken);
    assert.equal(res.status, 200);
    assert.ok(!res.body.some(i => i.id === 'sem_avaliacao'), 'adiado há 1h continua oculto');
    assert.ok(res.body.some(i => i.id === 'duvidas_paradas'), 'snooze de 25h já expirou');
});
