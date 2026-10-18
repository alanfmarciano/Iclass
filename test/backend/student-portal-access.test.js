// Fase 1, grupo G6: imagens das apostilas para o aluno (UXA-09, UXA-X2), presença
// automática só na janela das aulas (FUN-X2, CRIT-02), sinos do instrutor e do aluno
// (UXI-X2, UXA-X3), registros da prova presos à matrícula e gabarito do professor fora
// da apostila. Cada teste falha no comportamento antigo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-g6-portal-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const settingsUtil = require('../../backend/utils/settings.js');
const attendanceUtil = require('../../backend/utils/attendance.js');
const { stripAnswerKeyBlocks, stripStoredAccessTokens } = require('../../backend/utils/contentAccess.js');
const { createApp } = require('../../backend/server.js');

let app;
const adminToken = 'admin-token-portal';
const courseA = 'curso-portal-a';
const courseB = 'curso-portal-b';
const CONTENT_DIR = process.env.ICLASS_CONTENT_DIR;
const UPLOADS_DIR = runtimePaths.UPLOADS_DIR;
const tokens = { ana: 'token-ana', bia: 'token-bia', pendente: 'token-pendente', caio: 'token-caio' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function writeFiles() {
    fs.mkdirSync(path.join(CONTENT_DIR, 'imagens', 'fecop', 'cap1'), { recursive: true });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONTENT_DIR, 'imagens', 'fecop', 'cap1', 'diagrama.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>');
    fs.writeFileSync(path.join(CONTENT_DIR, 'imagens', 'capa.png'), PNG);
    fs.writeFileSync(path.join(UPLOADS_DIR, 'editor-img.png'), PNG);
    fs.writeFileSync(path.join(UPLOADS_DIR, 'bloqueada.png'), PNG);
    fs.writeFileSync(path.join(UPLOADS_DIR, 'solta.png'), PNG);
    fs.writeFileSync(path.join(UPLOADS_DIR, 'enviada.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    fs.writeFileSync(path.join(CONTENT_DIR, 'Apostila_POR_1.md'),
        '# Unidade 1\n\n![Figura do editor](/uploads/editor-img.png?access=sessao-antiga-do-prof)\n\n![Diagrama](imagens/fecop/cap1/diagrama.svg)\n');
    fs.writeFileSync(path.join(CONTENT_DIR, 'Apostila_POR_2.md'), '# Unidade 2\n\n![Ainda bloqueada](/uploads/bloqueada.png)\n');
}

function weekdayOf(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function hhmm(minutes) {
    const value = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function nowMinutes() {
    return attendanceUtil.hhmmToMin(settingsUtil.nowHHMM(settingsUtil.getSettings().timezone));
}

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: { attendance: { autoOnLogin: true, windowStart: '', windowEnd: '' } } };
    db.memory.admins = [
        { email: 'admin@portal.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        { email: 'prof@portal.local', name: 'Professor', role: 'professor', password: db.hashPassword('x'),
            assignedClasses: [{ courseId: courseA, className: 'TURMA A' }, { courseId: courseA, className: 'TURMA C' }] },
    ];
    db.memory.adminSessions = { [adminToken]: { email: 'admin@portal.local', createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.courses = [
        { id: courseA, name: 'Curso A', structure: [{ id: 'POR', name: 'Módulo', units: [
            { id: '1', name: 'Unidade 1', apostilaKey: 'Apostila_POR_1' },
            { id: '2', name: 'Unidade 2', apostilaKey: 'Apostila_POR_2' },
        ] }] },
        { id: courseB, name: 'Curso B', structure: [] },
    ];
    db.memory.classes = [
        { name: 'TURMA A', courseId: courseA, period: 'Manhã', releasedItems: { Apostila_POR_2: false }, onlineExamConfigs: {} },
        { name: 'TURMA C', courseId: courseA, period: 'Tarde', releasedItems: {}, onlineExamConfigs: {} },
        { name: 'TURMA B', courseId: courseB, period: 'Noite', releasedItems: {}, onlineExamConfigs: {} },
    ];
    db.memory.students = [
        { name: 'Ana', email: 'ana@portal.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: 'TURMA A', courseId: courseA }], studentClass: 'TURMA A' },
        { name: 'Caio', email: 'caio@portal.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: 'TURMA C', courseId: courseA }], studentClass: 'TURMA C' },
        { name: 'Bia', email: 'bia@portal.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: 'TURMA B', courseId: courseB }], studentClass: 'TURMA B' },
        { name: 'Pendente', email: 'pendente@portal.local', status: 'Ativo', password: db.hashPassword('123'), classes: [],
            enrollmentRequests: [{ id: 'req-p', status: 'pending', courseId: courseA, requestedClassName: 'TURMA A', createdAt: Date.now() }] },
    ];
    db.memory.sessions = {};
    for (const [name, token] of Object.entries(tokens)) {
        db.memory.sessions[`${name}@portal.local`] = { token, lastSeen: Date.now(), createdAt: Date.now(), ip: '::ffff:127.0.0.1' };
    }
    db.memory.library = [];
    db.memory.branding = {};
    db.memory.forum = [];
    db.memory.announcements = [];
    db.memory.submissions = [];
    db.memory.attendance = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
    db.memory.examKeystrokes = [];
    db.memory.examApplications = [];
    db.memory.auditLogs = [];
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { writeFiles(); seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- UXA-09

test('[UC-IMAGENS-001] SVG em subpasta das imagens da apostila carrega para o aluno matriculado, em sandbox', async () => {
    const url = '/imagens/fecop/cap1/diagrama.svg';
    await request(app).get(url).expect(401);
    const res = await request(app).get(`${url}?access=${tokens.ana}`);
    assert.equal(res.status, 200, 'a rota antiga só aceitava um nome sem subpasta e recusava SVG');
    assert.match(res.headers['content-type'], /^image\/svg\+xml/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-security-policy'], /\bsandbox\b/);
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(res.headers['content-disposition'], undefined, 'imagem abre inline');

    const png = await request(app).get(`/imagens/capa.png?access=${tokens.ana}`);
    assert.equal(png.status, 200);
    await request(app).get(url).set('x-admin-session', adminToken).expect(200);
    await request(app).get(`${url}?access=${tokens.pendente}`).expect(403);
});

// Pedido HTTP cru: o supertest resolve '..' e '%2e%2e' no cliente antes de enviar.
function rawGet(urlPath) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app).listen(0, '127.0.0.1', () => {
            const req = http.get({ host: '127.0.0.1', port: server.address().port, path: urlPath, headers: { 'x-admin-session': adminToken } }, res => {
                res.resume();
                res.on('end', () => server.close(() => resolve({ status: res.statusCode, type: res.headers['content-type'] || '' })));
            });
            req.on('error', error => server.close(() => reject(error)));
        });
    });
}

test('[UC-IMAGENS-001] caminho das imagens não sai da pasta e SVG enviado por upload continua bloqueado', async () => {
    fs.writeFileSync(path.join(tempRoot, 'segredo.png'), PNG);
    for (const evil of ['/imagens/fecop/..%2F..%2F..%2Fsegredo.png', '/imagens/fecop/%2e%2e/%2e%2e/%2e%2e/segredo.png', '/imagens/fecop/../../../segredo.png', '/imagens/..%5C..%5Csegredo.png']) {
        const res = await rawGet(evil);
        assert.ok([400, 404].includes(res.status), `${evil} respondeu ${res.status}`);
        assert.doesNotMatch(res.type, /image\/png/);
    }
    await request(app).get('/uploads/enviada.svg').set('x-admin-session', adminToken).expect(415);
});

// ---------------------------------------------------------------- UXA-X2

test('[UC-IMAGENS-001] imagem inserida pelo editor carrega para o aluno quando está numa apostila liberada da turma dele', async () => {
    const ok = await request(app).get(`/uploads/editor-img.png?access=${tokens.ana}`);
    assert.equal(ok.status, 200, 'antes: 403 "Arquivo não disponível para alunos" (sem item de biblioteca)');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    // Link antigo com a sessão do professor gravada + a do aluno: vale a do aluno.
    await request(app).get(`/uploads/editor-img.png?access=sessao-antiga-do-prof&access=${tokens.ana}`).expect(200);

    await request(app).get(`/uploads/bloqueada.png?access=${tokens.ana}`).expect(403);
    await request(app).get(`/uploads/solta.png?access=${tokens.ana}`).expect(403);
    await request(app).get(`/uploads/editor-img.png?access=${tokens.bia}`).expect(403);
    await request(app).get(`/uploads/editor-img.png?access=${tokens.pendente}`).expect(403);
    // Liberou a unidade 2: a imagem dela abre.
    db.memory.classes[0].releasedItems = {};
    await request(app).get(`/uploads/bloqueada.png?access=${tokens.ana}`).expect(200);
});

test('[UC-IMAGENS-001] a sessão do instrutor não fica gravada na apostila nem chega ao aluno', async () => {
    const studentView = await request(app).get('/Apostila_POR_1.md').set('x-session-token', tokens.ana);
    assert.equal(studentView.status, 200);
    assert.doesNotMatch(studentView.text, /sessao-antiga-do-prof/);
    assert.match(studentView.text, /\/uploads\/editor-img\.png\)/);

    const saved = await request(app).put('/api/admin/material/Apostila_POR_1').set('x-admin-session', adminToken)
        .send({ markdownText: '# Unidade 1\n\n![Nova](/uploads/editor-img.png?access=sessao-nova-do-admin)\n\n<img src="/imagens/capa.png?v=2&access=outra">\n' });
    assert.equal(saved.status, 200, saved.body && saved.body.error);
    const stored = fs.readFileSync(path.join(CONTENT_DIR, 'Apostila_POR_1.md'), 'utf8');
    assert.doesNotMatch(stored, /access=/);
    assert.match(stored, /\/uploads\/editor-img\.png\)/);
    assert.match(stored, /\/imagens\/capa\.png\?v=2"/);
});

test('[UC-IMAGENS-001] só links do próprio site perdem o access=; link externo com /uploads/ no caminho fica intacto', async () => {
    const markdown = [
        '[Apostila no Drive](https://drive.example.com/uploads/doc.pdf?access=chave-do-drive)',
        '<img src="//cdn.example.org/imagens/capa.png?access=chave-cdn">',
        '![Editor](/uploads/editor-img.png?access=sessao-1)',
        '![Rede](http://192.168.0.10:3000/uploads/rede.png?v=1&access=sessao-2)',
        '![Máquina](http://PC-PROFESSOR:3000/imagens/capa.png?access=sessao-3)',
        '![Própria](https://escola.example.com/uploads/propria.png?access=sessao-4)',
    ].join('\n');
    const out = stripStoredAccessTokens(markdown, { ownHosts: ['escola.example.com'] });
    // Antes o access= do Drive e do CDN também saía e o link externo quebrava.
    assert.ok(out.includes('https://drive.example.com/uploads/doc.pdf?access=chave-do-drive'));
    assert.ok(out.includes('//cdn.example.org/imagens/capa.png?access=chave-cdn'));
    assert.doesNotMatch(out, /sessao-\d/);
    assert.ok(out.includes('(/uploads/editor-img.png)'));
    assert.ok(out.includes('(http://192.168.0.10:3000/uploads/rede.png?v=1)'));
    assert.ok(out.includes('(http://PC-PROFESSOR:3000/imagens/capa.png)'));
    assert.ok(out.includes('(https://escola.example.com/uploads/propria.png)'));

    // Pelo editor: o Host da requisição conta como o próprio site.
    const saved = await request(app).put('/api/admin/material/Apostila_POR_1').set('x-admin-session', adminToken).set('Host', 'escola.example.com')
        .send({ markdownText: `# Unidade 1\n\n${markdown}\n` });
    assert.equal(saved.status, 200, saved.body && saved.body.error);
    const stored = fs.readFileSync(path.join(CONTENT_DIR, 'Apostila_POR_1.md'), 'utf8');
    assert.ok(stored.includes('https://drive.example.com/uploads/doc.pdf?access=chave-do-drive'));
    assert.doesNotMatch(stored, /sessao-\d/);
    const studentView = await request(app).get('/Apostila_POR_1.md').set('x-session-token', tokens.ana);
    assert.equal(studentView.status, 200);
    assert.ok(studentView.text.includes('https://drive.example.com/uploads/doc.pdf?access=chave-do-drive'));
});

test('[UC-IMAGENS-001] access= sai de link relativo (../uploads), do nome do próprio servidor no caminho do aluno e de sessão de instrutor válida em qualquer endereço', async () => {
    const relative = stripStoredAccessTokens('![a](../uploads/a.png?access=TOK) ![b](uploads/b.png?v=1&access=TOK) <img src="./imagens/c.svg?access=TOK">');
    // Antes do ajuste anterior a regex removia o token do ../uploads; depois deixou de remover.
    assert.equal(relative, '![a](../uploads/a.png) ![b](uploads/b.png?v=1) <img src="./imagens/c.svg">');

    // Apostila gravada pelo editor antigo, com o nome do próprio servidor (com pontos) e a sessão.
    fs.writeFileSync(path.join(CONTENT_DIR, 'Apostila_POR_1.md'), [
        '# Unidade 1',
        '![Própria](https://iclass.escola.com.br/uploads/editor-img.png?access=sessao-velha)',
        `![Sessão viva](https://outro-nome.escola.com.br/uploads/editor-img.png?access=${adminToken})`,
        '[Drive](https://drive.example.com/uploads/doc.pdf?access=chave-do-drive)',
        '![Relativa](../uploads/editor-img.png?access=sessao-velha-2)',
    ].join('\n\n'));
    const viaOwnName = await request(app).get('/Apostila_POR_1.md').set('x-session-token', tokens.ana).set('Host', 'iclass.escola.com.br');
    assert.equal(viaOwnName.status, 200);
    assert.ok(viaOwnName.text.includes('(https://iclass.escola.com.br/uploads/editor-img.png)'), 'o aluno recebia o token do instrutor no link com o nome do servidor');
    assert.doesNotMatch(viaOwnName.text, new RegExp(adminToken));
    assert.doesNotMatch(viaOwnName.text, /sessao-velha/);
    assert.ok(viaOwnName.text.includes('https://drive.example.com/uploads/doc.pdf?access=chave-do-drive'), 'link externo fica intacto');

    // Também pelo /api/data.js (mesmo leitor de apostila do aluno).
    const data = await request(app).get(`/api/data.js?courseId=${courseA}&studentClass=TURMA%20A`).set('x-session-token', tokens.ana).set('Host', 'iclass.escola.com.br');
    assert.equal(data.status, 200);
    assert.doesNotMatch(data.text, new RegExp(adminToken));
    assert.doesNotMatch(data.text, /sessao-velha/);

    // Pelo IP da sala o nome com pontos não é reconhecido, mas a sessão viva sai mesmo assim.
    const viaIp = await request(app).get('/Apostila_POR_1.md').set('x-session-token', tokens.ana).set('Host', '192.168.0.10:3000');
    assert.doesNotMatch(viaIp.text, new RegExp(adminToken));
    assert.ok(viaIp.text.includes('https://drive.example.com/uploads/doc.pdf?access=chave-do-drive'));

});

test('[UC-IMAGENS-001] /uploads/ dentro da query de um link externo é parte do link externo: o access= dele fica', () => {
    const tokens = new Set(['sessao-viva']);
    const external = '[Drive](https://drive.example.com/view?u=/uploads/doc.pdf?access=chave-do-drive)';
    assert.equal(stripStoredAccessTokens(external, { sessionTokens: tokens }), external, 'antes perdia o access= do Drive');
    // Sessão de instrutor válida sai em qualquer endereço.
    assert.equal(
        stripStoredAccessTokens('[Drive](https://drive.example.com/view?u=/uploads/doc.pdf?access=sessao-viva)', { sessionTokens: tokens }),
        '[Drive](https://drive.example.com/view?u=/uploads/doc.pdf)',
    );
    // Atributo HTML sem aspas e links do próprio site continuam limpos.
    assert.equal(stripStoredAccessTokens('<img src=/uploads/x.png?access=velha> ![a](/uploads/a.png?access=velha)', { sessionTokens: tokens }), '<img src=/uploads/x.png> ![a](/uploads/a.png)');
});

// ---------------------------------------------------------------- FUN-X2 / CRIT-02

function setTodayGrade(className, startMinutes) {
    const today = settingsUtil.today();
    const cls = db.memory.classes.find(c => c.name === className);
    cls.attendanceConfig = { toleranciaMin: 10, grade: { [String(weekdayOf(today))]: [{ ordem: 1, disciplinaId: 'd1', inicio: hhmm(startMinutes) }] } };
    return today;
}

test('[UC-PRESENCA-003] janela das aulas do dia: início da primeira menos a tolerância até o fim da última', () => {
    const grade = [{ inicio: '08:00' }, { inicio: '08:50' }, { inicio: '09:50' }, { inicio: '10:40' }];
    assert.deepEqual(attendanceUtil.classDayWindow(grade, 10), { inicioMin: 470, fimMin: 690 });
    assert.equal(attendanceUtil.withinClassDayWindow(grade, 10, '07:50'), true);
    assert.equal(attendanceUtil.withinClassDayWindow(grade, 10, '11:30'), true);
    assert.equal(attendanceUtil.withinClassDayWindow(grade, 10, '11:31'), false);
    assert.equal(attendanceUtil.withinClassDayWindow(grade, 10, '18:12'), false, 'acesso à noite para estudar não é presença da manhã');
    assert.equal(attendanceUtil.withinClassDayWindow([{ inicio: '' }], 10, '08:00'), false, 'sem horário não há janela');
    assert.equal(attendanceUtil.classDayWindow([{ inicio: '19:00' }], 5).fimMin, 19 * 60 + 50);
});

test('[UC-PRESENCA-003] acesso fora da janela das aulas não cria registro nem falta', async () => {
    // A aula de hoje começou há 3 h: o acesso de agora está fora da janela.
    setTodayGrade('TURMA A', nowMinutes() - 180);
    const login = await request(app).post('/api/student/login').send({ email: 'ana@portal.local', password: '123' });
    assert.equal(login.status, 200, login.body && login.body.error);
    await request(app).get('/api/ping?email=ana@portal.local').set('x-session-token', login.body.sessionToken).expect(200);
    assert.deepEqual(db.memory.attendance, [], 'antes o login fora de hora gravava falta em todas as aulas');
});

test('[UC-PRESENCA-003] acesso dentro da janela marca presença automática com hora, IP e origem, e a Chamada mostra', async () => {
    const today = setTodayGrade('TURMA A', Math.max(0, nowMinutes() - 5));
    const login = await request(app).post('/api/student/login').set('User-Agent', 'NavegadorTeste/1.0').send({ email: 'ana@portal.local', password: '123' });
    assert.equal(login.status, 200, login.body && login.body.error);
    assert.equal(db.memory.attendance.length, 1);
    const rec = db.memory.attendance[0];
    assert.equal(rec.origin, 'login');
    assert.equal(rec.source, 'login');
    assert.equal(rec.studentClass, 'TURMA A');
    assert.equal(rec.courseId, courseA);
    assert.equal(rec.ip, '127.0.0.1');
    assert.match(rec.horaAcesso, /^\d{2}:\d{2}$/);
    assert.equal(rec.userAgent, 'NavegadorTeste/1.0');
    assert.deepEqual(rec.aulas.map(a => a.status), ['presente']);

    // Heartbeat no mesmo dia não duplica.
    await request(app).get('/api/ping?email=ana@portal.local').set('x-session-token', login.body.sessionToken).expect(200);
    assert.equal(db.memory.attendance.length, 1);

    const roster = await request(app).get(`/api/admin/attendance/roster?courseId=${courseA}&studentClass=TURMA%20A&date=${today}`).set('x-admin-session', adminToken);
    assert.equal(roster.status, 200);
    const row = (roster.body.roster || roster.body.students || []).find(item => item.email === 'ana@portal.local');
    assert.ok(row, JSON.stringify(roster.body).slice(0, 300));
    assert.deepEqual(row.acessoAutomatico, { hora: rec.horaAcesso, ip: '127.0.0.1', via: 'login' });

    const csv = await request(app).get(`/api/admin/attendance/export?courseId=${courseA}&studentClass=TURMA%20A`).set('x-admin-session', adminToken);
    assert.equal(csv.status, 200);
    assert.match(csv.text, /Automática \(acesso do aluno\)/);
});

test('[UC-PRESENCA-003] sessão já aberta (heartbeat) marca presença dentro da janela com a origem "sessão aberta"', async () => {
    setTodayGrade('TURMA A', Math.max(0, nowMinutes() - 5));
    await request(app).get('/api/ping?email=ana@portal.local').set('x-session-token', tokens.ana).expect(200);
    assert.equal(db.memory.attendance.length, 1);
    assert.equal(db.memory.attendance[0].source, 'heartbeat');
    // Conta pendente não ganha presença de turma em que não está.
    await request(app).get('/api/ping?email=pendente@portal.local').set('x-session-token', tokens.pendente).expect(200);
    assert.equal(db.memory.attendance.length, 1);
});

// ---------------------------------------------------------------- UXI-X2

function adminNotifications(query = '') {
    return request(app).get(`/api/admin/notifications${query}`).set('x-admin-session', adminToken);
}

test('[UC-NOTIF-001] "lido" no sino do instrutor vale para o curso + turma, com descrição e destino de cada pendência', async () => {
    const inA = await adminNotifications(`?courseId=${courseA}&studentClass=TURMA%20A`);
    assert.equal(inA.status, 200);
    const pendingA = inA.body.items.find(item => item.type === 'sem_avaliacao');
    assert.ok(pendingA, JSON.stringify(inA.body));
    assert.equal(pendingA.text, 'nunca entregaram prova neste curso · Resultados', 'antes vinha vazio (lia `descricao`)');
    assert.equal(pendingA.courseId, courseA);
    assert.equal(pendingA.studentClass, 'TURMA A');
    assert.equal(pendingA.unread, true);

    // Mesmo envio do sino: a chave que veio do servidor.
    await request(app).post('/api/admin/notifications/seen').set('x-admin-session', adminToken)
        .send({ keys: inA.body.items.map(item => item.key || `${item.id}:${item.count || 0}`) }).expect(200);
    const againA = await adminNotifications(`?courseId=${courseA}&studentClass=TURMA%20A`);
    assert.equal(againA.body.items.find(item => item.type === 'sem_avaliacao').unread, false);

    const inC = await adminNotifications(`?courseId=${courseA}&studentClass=TURMA%20C`);
    const pendingC = inC.body.items.find(item => item.type === 'sem_avaliacao');
    assert.equal(pendingC.unread, true, 'marcar a TURMA A não pode marcar a TURMA C (mesmo id e contagem)');

    // Marcar a TURMA C não "desmarca" a A.
    await request(app).post('/api/admin/notifications/seen').set('x-admin-session', adminToken).send({ keys: [pendingC.key] }).expect(200);
    const finalA = await adminNotifications(`?courseId=${courseA}&studentClass=TURMA%20A`);
    assert.equal(finalA.body.items.find(item => item.type === 'sem_avaliacao').unread, false);
});

test('[UC-NOTIF-001] fora de turma (modo instituição) cada pendência diz de que curso e turma é', async () => {
    db.memory.students[3].enrollmentRequests.push({ id: 'req-q', status: 'pending', courseId: courseA, requestedClassName: 'TURMA C', createdAt: Date.now() });
    const res = await adminNotifications('');
    assert.equal(res.status, 200);
    const semAvaliacao = res.body.items.filter(item => item.type === 'sem_avaliacao');
    assert.deepEqual(semAvaliacao.map(item => `${item.courseId}/${item.studentClass}`).sort(),
        [`${courseA}/TURMA A`, `${courseA}/TURMA C`, `${courseB}/TURMA B`]);
    semAvaliacao.forEach(item => {
        assert.equal(item.href, '/resultados');
        assert.ok(item.courseName);
        // Curso e turma vêm em campo próprio; a descrição da pendência fica inteira.
        assert.equal(item.context, `${item.courseName} · ${item.studentClass}`);
        assert.equal(item.text, 'nunca entregaram prova neste curso · Resultados');
    });
    const matriculas = res.body.items.filter(item => item.type === 'matriculas');
    assert.deepEqual(matriculas.map(item => [item.studentClass, item.count]).sort(), [['TURMA A', 1], ['TURMA C', 1]]);
});

// ---------------------------------------------------------------- UXA-X3

test('[UC-NOTIF-001] "Marcar como lidas" do aluno marca os avisos e o contador não volta', async () => {
    db.memory.announcements = [
        { id: 'av1', title: 'Prova adiada', message: 'Nova data', target: 'turma', targetValue: 'TURMA A', courseId: courseA, createdAt: Date.now(), readBy: [] },
        { id: 'av-outro', title: 'Aviso da TURMA B', message: 'x', target: 'turma', targetValue: 'TURMA B', courseId: courseB, createdAt: Date.now(), readBy: [] },
    ];
    const url = `/api/student/notifications?courseId=${courseA}&studentClass=TURMA%20A`;
    const before = await request(app).get(url).set('x-session-token', tokens.ana);
    assert.equal(before.status, 200);
    assert.equal(before.body.unread, 1);
    const seen = await request(app).post('/api/student/notifications/seen').set('x-session-token', tokens.ana)
        .send({ keys: before.body.items.map(item => `${item.id}:0`), ids: [...before.body.items.map(item => item.id), 'aviso:av-outro'] });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.announcementsMarked, 1, 'aviso de outra turma não é marcado');
    const after = await request(app).get(url).set('x-session-token', tokens.ana);
    assert.equal(after.body.unread, 0, 'antes o aviso voltava no próximo polling');
    assert.deepEqual(db.memory.announcements[0].readBy, ['ana@portal.local']);
    assert.deepEqual(db.memory.announcements[1].readBy, []);
});

test('[UC-NOTIF-001] sino do aluno: "Nota publicada" só com nota válida e "Marcar como lidas" só na turma/curso do sino', async () => {
    const ana = db.memory.students.find(student => student.email === 'ana@portal.local');
    ana.classes = [{ name: 'TURMA A', courseId: courseA }, { name: 'TURMA B', courseId: courseB }];
    const grade = (id, courseId, studentClass, score) => ({
        id, examKey: `Avaliacao_${id}`, score, gradePublished: true, gradePublishedAt: Date.now() - 1000, timestamp: new Date().toISOString(),
        student: { name: 'Ana', email: 'ana@portal.local', courseId, studentClass },
    });
    db.memory.submissions = [
        grade('A1', courseA, 'TURMA A', 80),
        // Nota inválida antiga (fora de 0 a 100): Notas e boletim não mostram, o sino também não.
        grade('A2', courseA, 'TURMA A', 150),
        grade('A3', courseA, 'TURMA A', null),
        grade('B1', courseB, 'TURMA B', 70),
    ];
    const urlA = `/api/student/notifications?courseId=${courseA}&studentClass=TURMA%20A`;
    const urlB = `/api/student/notifications?courseId=${courseB}&studentClass=TURMA%20B`;
    const before = await request(app).get(urlA).set('x-session-token', tokens.ana).expect(200);
    assert.deepEqual(before.body.items.filter(item => item.type === 'nota').map(item => item.id), ['nota:A1']);
    assert.equal(before.body.unread, 1);
    assert.equal((await request(app).get(urlB).set('x-session-token', tokens.ana).expect(200)).body.unread, 1);

    // Marcou como lidas no sino da TURMA A: a TURMA B continua com o item novo.
    await request(app).post(`/api/student/notifications/seen?courseId=${courseA}&studentClass=TURMA%20A`).set('x-session-token', tokens.ana)
        .send({ keys: [], ids: before.body.items.map(item => item.id) }).expect(200);
    assert.equal((await request(app).get(urlA).set('x-session-token', tokens.ana)).body.unread, 0);
    assert.equal((await request(app).get(urlB).set('x-session-token', tokens.ana)).body.unread, 1, 'antes o carimbo era um só e zerava a outra turma');
    // Turma em que não está matriculada: recusado.
    await request(app).post(`/api/student/notifications/seen?courseId=${courseA}&studentClass=TURMA%20C`).set('x-session-token', tokens.ana).send({}).expect(403);
    // Navegador antigo (sem turma): vale para todas, como antes.
    await request(app).post('/api/student/notifications/seen').set('x-session-token', tokens.ana).send({}).expect(200);
    assert.equal((await request(app).get(urlB).set('x-session-token', tokens.ana)).body.unread, 0);
});

test('[UC-NOTIF-001] marcar aviso como lido confere a matrícula do aluno', async () => {
    db.memory.announcements = [
        { id: 'av-a', title: 'A', message: 'a', target: 'turma', targetValue: 'TURMA A', courseId: courseA, createdAt: Date.now(), readBy: [] },
        { id: 'av-b', title: 'B', message: 'b', target: 'turma', targetValue: 'TURMA B', courseId: courseB, createdAt: Date.now(), readBy: [] },
    ];
    await request(app).post('/api/student/announcements/read').set('x-session-token', tokens.ana).send({ id: 'av-a' }).expect(200);
    await request(app).post('/api/student/announcements/read').set('x-session-token', tokens.ana).send({ id: 'av-b' }).expect(404);
    await request(app).post('/api/student/announcements/read').set('x-session-token', tokens.pendente).send({ id: 'av-a' }).expect(404);
    await request(app).post('/api/student/announcements/read').set('x-session-token', tokens.ana).send({ id: 'nao-existe' }).expect(404);
    assert.deepEqual(db.memory.announcements[0].readBy, ['ana@portal.local']);
    assert.deepEqual(db.memory.announcements[1].readBy, []);
});

// ---------------------------------------------------------------- proctoring

test('[UC-SIGILO-001] eventos, digitação e rascunho da prova exigem turma resolvida e matrícula aprovada', async () => {
    const examKey = 'Avaliacao_POR_1';
    const activity = (token, email, studentClass) => request(app).post('/api/student/log-activity').set('x-session-token', token)
        .send({ email, studentClass, courseId: courseA, examKey, eventType: 'blur', details: 'saiu da aba' });

    const ok = await activity(tokens.ana, 'ana@portal.local', 'turma a');
    assert.equal(ok.status, 200, ok.body && ok.body.error);
    assert.equal(db.memory.proctoringLogs.length, 1);
    assert.equal(db.memory.proctoringLogs[0].studentClass, 'TURMA A', 'grava a turma canônica');

    await activity(tokens.pendente, 'pendente@portal.local', 'turma a').expect(403);
    await activity(tokens.ana, 'ana@portal.local', 'TURMA INEXISTENTE').expect(403);
    await activity(tokens.ana, 'ana@portal.local', '').expect(403);
    await activity(tokens.caio, 'caio@portal.local', 'turma a').expect(403);
    assert.equal(db.memory.proctoringLogs.length, 1, 'nenhum log de conta sem matrícula na turma');

    await request(app).post('/api/student/log-keystrokes').set('x-session-token', tokens.pendente)
        .send({ studentClass: 'turma a', courseId: courseA, examKey, events: [{ key: 'a', at: Date.now() }] }).expect(403);
    assert.equal((db.memory.examKeystrokes || []).length, 0);
    await request(app).post('/api/student/autosave-progress').set('x-session-token', tokens.pendente)
        .send({ studentClass: 'turma a', courseId: courseA, examKey, answers: { 1: 'A' } }).expect(403);
    assert.deepEqual(db.memory.studentExamState, {});
});

// ---------------------------------------------------------------- gabarito na apostila

test('[UC-SIGILO-001] gabarito do professor sai da apostila em todas as grafias, sem levar a autocorreção do aluno', () => {
    const markdown = [
        '# Unidade',
        '<details><summary>GABARITO&nbsp;OFICIAL</summary>\n\n1. B (segredo-1)\n</details>',
        '<details><summary>Gabarito do prof.</summary>segredo-2</details>',
        '<details>\n<summary><b>GABARITO EXCLUSIVO DO PROFESSOR</b></summary>\n<details><summary>Questão 1</summary>B</details>\nsegredo-3 depois do aninhado\n</details>',
        '<details><summary>Gabarito dos exercícios</summary>resposta do aluno</details>',
        '<details><summary>Ver Resposta</summary>42</details>',
        '## GABARITO EXCLUSIVO DO PROFESSOR',
        'segredo-4',
        '### Questão 1',
        'segredo-5',
        '## Próxima seção',
        'continua visível',
        '## Gabarito dos exercícios',
        'autocorreção visível',
        '```',
        '## GABARITO DO PROFESSOR dentro de código fica',
        '```',
    ].join('\n\n');
    const out = stripAnswerKeyBlocks(markdown);
    assert.doesNotMatch(out, /segredo-\d/);
    assert.match(out, /Gabarito dos exercícios<\/summary>resposta do aluno/);
    assert.match(out, /Ver Resposta<\/summary>42/);
    assert.match(out, /## Próxima seção\n\ncontinua visível/);
    assert.match(out, /## Gabarito dos exercícios\n\nautocorreção visível/);
    assert.match(out, /dentro de código fica/);
    assert.equal(stripAnswerKeyBlocks(out), out, 'idempotente');
});

// As regras fixas (o que sai e o que fica) estão na tabela de answer-key-rules.test.js;
// aqui, o caminho do aluno usa as mesmas regras.
test('[UC-SIGILO-001] apostila lida pelo aluno (/:key.md e /api/data.js) perde o gabarito do professor pelas regras fixas e mantém o resto', async () => {
    const markdown = [
        '# Unidade 1',
        '',
        // Material do aluno que a regra antiga (resposta/solução + professor) apagava.
        '## Perguntas e respostas com o professor', 'VISIVEL_1',
        '## Solução proposta pelo instrutor', 'VISIVEL_2',
        '### Resposta do professor à dúvida da turma', 'VISIVEL_3',
        '<details><summary>Resposta do professor</summary>VISIVEL_4</details>',
        '',
        // Regra 3: rótulo em negrito sozinho vale como título.
        '**GABARITO DO PROFESSOR**', '', '1. B SEGREDO_1', '',
        '# Exercícios', 'VISIVEL_5',
        // Regra 2: <h2> e título dentro de citação.
        '<h2>GABARITO DO PROFESSOR</h2>', 'SEGREDO_2', '<h3>Questão 1</h3>', 'SEGREDO_3',
        '<h2>Leitura complementar</h2>', 'VISIVEL_6',
        '',
        '> ## GABARITO DO PROFESSOR', '> 1. B SEGREDO_4', '',
        'VISIVEL_7 depois da citação',
        '',
        // Regra 4: rótulo com as respostas na mesma linha também abre seção, até o próximo
        // título de nível igual ou menor (antes saía só o parágrafo e SEGREDO_7 vazava).
        '**GABARITO DO PROFESSOR:** 1-B SEGREDO_5', '',
        'Questão 2: C SEGREDO_7', '',
        '## Glossário',
        'VISIVEL_8',
        '',
        // Regra 1: <details> do professor.
        '<details><summary>GABARITO&nbsp;OFICIAL</summary>SEGREDO_6</details>',
        '',
        // Aviso, glossário e autocorreção do aluno ficam.
        '**Atenção: o gabarito oficial será divulgado pelo professor após a prova.**', '',
        '**Gabarito oficial**: documento com as respostas corretas usado pelo professor na correção. VISIVEL_9', '',
        '<details><summary>Gabarito dos exercícios</summary>VISIVEL_10</details>',
    ].join('\n');
    const expected = stripAnswerKeyBlocks(markdown);
    assert.doesNotMatch(expected, /SEGREDO_\d/);
    for (let index = 1; index <= 10; index += 1) assert.ok(expected.includes(`VISIVEL_${index}`), `sumiu: VISIVEL_${index}`);
    assert.ok(expected.includes('**Atenção: o gabarito oficial será divulgado pelo professor após a prova.**'));

    const saved = await request(app).put('/api/admin/material/Apostila_POR_1').set('x-admin-session', adminToken).send({ markdownText: markdown });
    assert.equal(saved.status, 200, saved.body && saved.body.error);
    const studentView = await request(app).get('/Apostila_POR_1.md').set('x-session-token', tokens.ana);
    assert.equal(studentView.status, 200);
    assert.equal(studentView.text, expected);
    const data = await request(app).get(`/api/data.js?courseId=${courseA}&studentClass=TURMA%20A`).set('x-session-token', tokens.ana);
    assert.equal(data.status, 200);
    assert.doesNotMatch(data.text, /SEGREDO_\d/);
    assert.match(data.text, /VISIVEL_9/);
    // O instrutor vê o arquivo como foi salvo.
    const asAdmin = await request(app).get('/Apostila_POR_1.md').set('x-admin-session', adminToken);
    assert.match(asAdmin.text, /SEGREDO_1/);
});
